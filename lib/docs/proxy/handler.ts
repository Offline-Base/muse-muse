import { isCrossSite } from "@/lib/auth";
import { AskInputError, ASK_BODY_MAX_BYTES, buildAskRequest, parseAskBody } from "@/lib/docs/proxy/ask";
import { ASSISTANT_BODY_MAX_BYTES, buildAssistantRequest, parseAssistantBody } from "@/lib/docs/proxy/assistant";
import {
  backgroundRefusal,
  finalResponseOf,
  isBackgroundReply,
  isRunning,
  settleFinished,
  showsUsage,
  TERMINAL_STATUSES,
} from "@/lib/docs/proxy/background";
import { matchEndpoint, type DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import { docsError, docsErrors } from "@/lib/docs/proxy/errors";
import { estimateDocsCost } from "@/lib/docs/proxy/estimate";
import {
  checkModelLimit,
  checkRequestLimits,
  checkUploadLimit,
  dayWindow,
  DOCS_KEYS,
  docsClientIp,
  holdSpend,
  withInFlightSlot,
  type SpendHold,
} from "@/lib/docs/proxy/limits";
import { docsMinimalUsage, docsStreamMeter, docsUsageFromJson, readMetered, usageShown } from "@/lib/docs/proxy/meter";
import {
  DOCS_MAX_BODY_BYTES,
  DOCS_MODEL_HEADER,
  DOCS_MODELS,
  DOCS_NOTE_HEADER,
  type DocsLimits,
} from "@/lib/docs/proxy/policy";
import {
  bodyReferences,
  formReferences,
  FormRewriteError,
  rewriteForm,
  rewriteJson,
  SPARK_NOTE,
  type BodyReferences,
} from "@/lib/docs/proxy/rewrite";
import type { DocsConfig, DocsDeps, DocsHoldState } from "@/lib/docs/proxy/types";
import { isHttps, safetyIdentifier, visitorCookie, visitorOf, type DocsVisitor } from "@/lib/docs/proxy/visitor";
import { parseWav, WavError } from "@/lib/docs/proxy/wav";
import { isJsonContentType, isMultipartContentType } from "@/lib/gateway/extract";
import { DEFAULT_LIMITS, UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import { HttpError, readJson } from "@/lib/http";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

/**
 * The docs playground proxy: /api/docs/v1/<path> mirrors https://api.meta.ai/v1/<path> for the endpoints in
 * lib/docs/proxy/endpoints.ts, with Muse Muse's key added on the server (docs/DOCS_MIRROR.md, "Proxy"). In order:
 *   1. A mirrored method and path, else 404 unknown_endpoint.
 *   2. Same origin for POST and DELETE (403 cross_site), and DOCS_LIVE (503 docs_paused).
 *   3. The body: 4.5 MB at most (413), parsed, the model checked, then rewritten (lib/docs/proxy/rewrite.ts).
 *   4. The IP's runs a minute and a day (429).
 *   5. Ownership: ids in the path or the body must be this visitor's (404).
 *   6. Every reader's runs a minute on the model, or uploads an hour (429), since Meta's limits are per team.
 *   7. An in-flight slot (429), then the budgets: the IP's dollars, the docs' daily cap, the platform's.
 *   8. Forward; stream the reply back as is, plus x-docs-model and x-docs-note.
 *   9. Record what the visitor created, replace the estimate with the metered usage, give the slot back. A reply that
 *      doesn't show all it used (a cut-off stream, a reply without usage) keeps the estimate instead, and a background
 *      response keeps its worst case until it finishes (lib/docs/proxy/background.ts).
 * Ask (/api/docs/ask) builds its Responses request on the server and joins at step 4.
 */

type Json = Record<string, unknown>;

/** A live call, ready to forward. */
interface LiveCall {
  endpoint: DocsEndpoint;
  /** The usage row's endpoint: Meta's path, or "ask". */
  usageEndpoint: string;
  /** The model actually called, after the Spark 1.3 swap. */
  model: string | null;
  body: BodyInit | null;
  /** Null for FormData, whose boundary fetch sets. */
  contentType: string | null;
  query: string;
  headers: Record<string, string>;
  estimate: number;
  notes: string[];
  /** Ids the body points at, which must be this visitor's. */
  references: BodyReferences | null;
  /** The JSON body as sent, for its store flag. */
  json: Json | null;
  /** A Responses call with background: true, which holds its worst case until it is settled from the finished run. */
  background: boolean;
  /** A transcription's WAV length, for its estimate and as the meter's fallback. */
  audioMs: number | null;
}

/** Reply headers worth passing back. Never the upstream's cookies or auth. */
const PASS_HEADERS = [
  "content-type",
  "content-disposition",
  "retry-after",
  "x-request-id",
  "request-id",
  "openai-processing-ms",
];
/**
 * Meta's rate-limit headers (pricing-rate-limits, "Read rate-limit headers": x-ratelimit-limit-requests,
 * x-ratelimit-remaining-tokens and the rest), in any of the spellings APIs use (x-ratelimit-*, x-rate-limit-*,
 * ratelimit-*, anthropic-ratelimit-*), so the demos can show them. They report the team's limits, which every docs
 * reader shares, and carry numbers and times only.
 */
const RATE_LIMIT_HEADER = /^(x-|anthropic-)?rate-?limit(-[a-z0-9-]+)?$/;
/** Never passed back, whatever the name looks like: the upstream's cookies, and anything about its auth or keys. */
const NEVER_PASS = /cookie|auth|key|secret|session/;
/** Request headers passed on to Meta. Never the visitor's cookies, auth or key headers. */
const FORWARD_HEADERS = ["accept"];
const ANTHROPIC_HEADERS = ["anthropic-version", "anthropic-beta"];
/**
 * The newest files GET /v1/files looks up for a visitor, each with its own upstream call. Uploads last an hour, so a
 * reader rarely has this many, and one list stays a handful of calls on the team's key.
 */
const LIST_MAX = 20;
/** Ids one body may point at. Each is looked up, so a body can't turn into one enormous query. */
const MAX_REFERENCES = 64;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === "text/event-stream";
}

function label(endpoint: DocsEndpoint): string {
  return `${endpoint.method} /v1/${endpoint.upstreamPath}`;
}

const logged = (what: string) => (err: unknown) =>
  console.error(`[docs] ${what} failed:`, err instanceof Error ? err.message : err);

/** Adds the visitor cookie when this request had none. */
function finalize(res: Response, visitor: DocsVisitor, req: Request): Response {
  if (!visitor.isNew) return res;
  const cookie = visitorCookie(visitor.id, isHttps(req));
  try {
    res.headers.append("set-cookie", cookie);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.append("set-cookie", cookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/** x-docs-note: the notes as one line of printable ASCII, as a header value must be. */
function noteHeader(notes: string[]): string | null {
  const text = notes.join(" ").replace(/[^\x20-\x7e]/g, " ").trim();
  return text ? text.slice(0, 1000) : null;
}

function replyHeaders(upstream: Response, call: Pick<LiveCall, "model" | "notes">): Headers {
  const out = new Headers({ "cache-control": "no-store" });
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  upstream.headers.forEach((value, name) => {
    if (RATE_LIMIT_HEADER.test(name) && !NEVER_PASS.test(name) && value) out.set(name, value.slice(0, 200));
  });
  if (call.model) out.set(DOCS_MODEL_HEADER, call.model);
  const note = noteHeader(call.notes);
  if (note) out.set(DOCS_NOTE_HEADER, note);
  return out;
}

function upstreamUrl(deps: DocsDeps, path: string, query: string): string {
  return `${deps.upstreamBaseUrl ?? UPSTREAM_BASE_URL}/${path}${query ? `?${query}` : ""}`;
}

/** The query parameters the endpoint passes on, in their order. */
function forwardedQuery(req: Request, endpoint: DocsEndpoint): string {
  if (!endpoint.query.length) return "";
  const out = new URLSearchParams();
  for (const [name, value] of new URL(req.url).searchParams) if (endpoint.query.includes(name)) out.append(name, value);
  return out.toString();
}

function forwardedHeaders(req: Request, endpoint: DocsEndpoint): Record<string, string> {
  const out: Record<string, string> = {};
  const anthropic = endpoint.meter === "messages" || endpoint.id === "messages.count_tokens";
  const names = anthropic ? [...FORWARD_HEADERS, ...ANTHROPIC_HEADERS] : FORWARD_HEADERS;
  for (const name of names) {
    const value = req.headers.get(name);
    if (value) out[name] = value.slice(0, 200);
  }
  return out;
}

type Body =
  | { kind: "none" }
  | { kind: "json"; json: Json }
  | { kind: "multipart"; form: FormData; raw: Uint8Array<ArrayBuffer>; contentType: string };

/** Reads the body: at most 4.5 MB, JSON or multipart as the endpoint takes. */
async function readBody(req: Request, endpoint: DocsEndpoint): Promise<Body | Response> {
  if (endpoint.body === "none") return { kind: "none" };
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOCS_MAX_BODY_BYTES) return docsErrors.tooLarge(DOCS_MAX_BODY_BYTES);
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > DOCS_MAX_BODY_BYTES) return docsErrors.tooLarge(DOCS_MAX_BODY_BYTES);
  const contentType = req.headers.get("content-type");
  const multipart = isMultipartContentType(contentType);

  if (endpoint.body === "multipart" || (endpoint.body === "json_or_multipart" && multipart)) {
    if (!multipart || !contentType) {
      return docsErrors.invalidBody(`${label(endpoint)} takes a multipart/form-data body.`);
    }
    try {
      const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
      return { kind: "multipart", form, raw, contentType };
    } catch {
      return docsErrors.invalidBody("The multipart body could not be parsed.");
    }
  }
  if (multipart) return docsErrors.invalidBody(`${label(endpoint)} takes a JSON body.`);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    const message = raw.byteLength ? "The request body is not valid JSON." : `${label(endpoint)} needs a JSON body.`;
    return docsErrors.invalidBody(message);
  }
  if (!isObject(json)) return docsErrors.invalidBody("The request body must be a JSON object.");
  return { kind: "json", json };
}

/** 400 or 404 when the model is missing or not one the endpoint runs in the docs, else null. */
function checkModel(endpoint: DocsEndpoint, model: string | null): Response | null {
  if (!endpoint.models) return null;
  if (!model) return docsErrors.missingModel(label(endpoint));
  const allowed: readonly string[] = DOCS_MODELS[endpoint.models];
  return allowed.includes(model) ? null : docsErrors.modelNotFound(model, label(endpoint), allowed);
}

/** Parses, checks and rewrites the request into a call. */
async function prepare(
  req: Request,
  endpoint: DocsEndpoint,
  visitor: DocsVisitor,
  config: DocsConfig,
): Promise<LiveCall | Response> {
  const body = await readBody(req, endpoint);
  if (body instanceof Response) return body;
  const call: LiveCall = {
    endpoint,
    // Only metered endpoints record usage, and their paths hold no ids.
    usageEndpoint: endpoint.meter ? endpoint.upstreamPath : endpoint.id,
    model: null,
    body: null,
    contentType: null,
    query: forwardedQuery(req, endpoint),
    headers: forwardedHeaders(req, endpoint),
    estimate: 0,
    notes: [],
    references: null,
    json: null,
    background: false,
    audioMs: null,
  };
  if (body.kind === "none") return call;

  if (body.kind === "json") {
    const rewrite = rewriteJson(endpoint, body.json, safetyIdentifier(visitor));
    const refused = checkModel(endpoint, rewrite.model);
    if (refused) return refused;
    const background = backgroundRefusal(endpoint, rewrite.body, rewrite.model, config.perIpDailyUsd);
    if (background) return docsErrors.unsupportedBackground(background);
    const text = JSON.stringify(rewrite.body);
    return {
      ...call,
      model: rewrite.model,
      body: text,
      contentType: "application/json",
      notes: rewrite.notes,
      references: bodyReferences(endpoint, rewrite.body),
      json: rewrite.body,
      background: endpoint.id === "responses.create" && rewrite.body.background === true,
      estimate: estimateDocsCost(endpoint, { kind: "json", json: rewrite.body, model: rewrite.model }, text.length),
    };
  }

  let rewrite;
  try {
    rewrite = await rewriteForm(endpoint, body.form);
  } catch (err) {
    if (err instanceof FormRewriteError) return docsErrors.invalidBody(err.message);
    throw err;
  }
  const refused = checkModel(endpoint, rewrite.model);
  if (refused) return refused;

  let audioMs: number | null = null;
  if (endpoint.id === "asr.transcribe") {
    const audio = body.form.get("audio");
    if (!(audio instanceof File)) {
      return docsErrors.invalidBody('Send the recording in an "audio" part, as a WAV file.');
    }
    try {
      audioMs = parseWav(new Uint8Array(await audio.arrayBuffer())).durationMs;
    } catch (err) {
      if (err instanceof WavError) return docsErrors.invalidAudio(err.message);
      throw err;
    }
  }
  return {
    ...call,
    model: rewrite.model,
    // Unchanged forms go byte for byte; changed ones are re-encoded by fetch with a new boundary.
    body: rewrite.changed ? rewrite.body : body.raw,
    contentType: rewrite.changed ? null : body.contentType,
    notes: rewrite.notes,
    references: formReferences(rewrite.body),
    audioMs,
    estimate: estimateDocsCost(
      endpoint,
      { kind: "multipart", form: rewrite.body, model: rewrite.model },
      body.raw.byteLength,
      audioMs,
    ),
  };
}

/** 404 when the path's id, or an id the body points at, isn't one this visitor created; 400 for refused references. */
async function checkOwnership(call: LiveCall, visitor: DocsVisitor, deps: DocsDeps): Promise<Response | null> {
  const refs = call.references;
  if (refs?.refused) return docsErrors.refusedReference(refs.refused);
  const wanted: Array<{ id: string; kind: "file" | "response" }> = [
    ...(call.endpoint.owned ? [call.endpoint.owned] : []),
    ...(refs?.fileIds ?? []).map((id) => ({ id, kind: "file" as const })),
    ...(refs?.responseIds ?? []).map((id) => ({ id, kind: "response" as const })),
  ];
  if (!wanted.length) return null;
  const ids = [...new Set(wanted.map((w) => w.id))];
  if (ids.length > MAX_REFERENCES) {
    return docsErrors.refusedReference(`Live demos take at most ${MAX_REFERENCES} file and response ids in one request.`);
  }
  const owned = await deps.ownedIds(visitor.hash, ids);
  const missing = wanted.find((w) => !owned.some((o) => o.id === w.id && o.kind === w.kind));
  return missing ? docsErrors.notOwned(missing.kind, missing.id) : null;
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * GET /v1/files for one visitor: the account holds every Muse Muse file, so instead of listing them all, each of the
 * visitor's own files is looked up by id. Answers in Meta's list shape, with purpose, order, after and limit applied.
 */
async function listFiles(req: Request, visitor: DocsVisitor, deps: DocsDeps): Promise<Response> {
  const ids = await deps.visitorObjects(visitor.hash, "file", LIST_MAX);
  const files: Json[] = [];
  let failures = 0;
  await mapLimit(ids, 6, async (id) => {
    try {
      const res = await deps.fetch(upstreamUrl(deps, `files/${encodeURIComponent(id)}`, ""), {
        headers: { authorization: `Bearer ${deps.upstreamKey()}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        await deps.forgetObject(id).catch(logged("forgetting a deleted file"));
        return;
      }
      if (!res.ok) {
        failures++;
        await res.body?.cancel().catch(() => {});
        return;
      }
      const file = (await res.json()) as unknown;
      if (isObject(file) && typeof file.id === "string") files.push(file);
    } catch {
      failures++;
    }
  });
  if (failures && !files.length) return docsErrors.upstreamUnreachable();

  const q = new URL(req.url).searchParams;
  const purpose = q.get("purpose");
  const direction = q.get("order") === "asc" ? 1 : -1;
  const created = (f: Json) => (typeof f.created_at === "number" ? f.created_at : 0);
  let list = files
    .filter((f) => !purpose || f.purpose === purpose)
    .sort((a, b) => (created(a) - created(b)) * direction || String(a.id).localeCompare(String(b.id)) * direction);
  const after = q.get("after");
  if (after) {
    const at = list.findIndex((f) => f.id === after);
    list = at >= 0 ? list.slice(at + 1) : [];
  }
  const limit = Number(q.get("limit"));
  const page = list.slice(0, Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 10_000) : 10_000);
  const headers = new Headers({ "cache-control": "no-store" });
  headers.set(DOCS_NOTE_HEADER, "Lists only the files uploaded from this browser in the last hour.");
  const body = {
    object: "list",
    data: page,
    first_id: page[0]?.id ?? null,
    last_id: page.at(-1)?.id ?? null,
    has_more: list.length > page.length,
  };
  return Response.json(body, { headers });
}

/**
 * Settles a call at what its reply showed, unless the reply didn't show everything (a stream cut off before its final
 * usage) and the estimate is more: then the estimate stays as the charge. What a cut-off stream saw undercounts its
 * input, which Meta reports only at the end, and Meta bills the input of a call it accepted.
 */
function settleOrKeep(hold: SpendHold, estimate: number, items: ModelUsage[], complete: boolean): Promise<void> {
  const used = items.reduce((n, i) => n + i.costUsd, 0);
  return complete || used >= estimate ? hold.settle(items) : Promise.resolve();
}

/** A background response's held spend, for the calls on a stored response: retrieve, cancel and delete. */
async function pendingHoldFor(endpoint: DocsEndpoint, deps: DocsDeps): Promise<DocsHoldState | null> {
  if (endpoint.owned?.kind !== "response" || !endpoint.id.startsWith("responses.")) return null;
  return deps.pendingHold(endpoint.owned.id).catch((err) => {
    logged("reading a background hold")(err);
    return null;
  });
}

/**
 * What reading a held response back did: "settled" its hold, found it "gone" (another caller settled it), found it
 * still "running" (queued or in progress), or left it "pending" (it finished without saying what it used, or couldn't
 * be read). The hold stays on its row unless it was settled.
 */
type ReadBack = "settled" | "gone" | "running" | "pending";

/** Reads a stored response at Meta and settles its held spend from it (settleFinished). */
async function readAndSettle(deps: DocsDeps, id: string, hold: DocsHoldState): Promise<ReadBack> {
  try {
    const res = await deps.fetch(upstreamUrl(deps, `responses/${encodeURIComponent(id)}`, ""), {
      headers: { authorization: `Bearer ${deps.upstreamKey()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return "pending";
    }
    const response = (await res.json()) as unknown;
    const outcome = await settleFinished(deps, id, hold, response);
    return outcome === "pending" && isRunning(response) ? "running" : outcome;
  } catch (err) {
    logged("settling a background response")(err);
    return "pending";
  }
}

/** Reads after a cancel before a delete, while the cancel takes hold. */
const CANCEL_SETTLE_READS = 3;
const CANCEL_SETTLE_GAP_MS = 1_000;

/**
 * Before a background response is deleted, its hold is settled from what it used: the delete's own reply says nothing
 * about usage, and afterwards there's nothing left to read. A run still going is cancelled first, since no one could
 * read it once it's deleted, then read until the cancel takes hold. Returns the outcome and whether it cancelled; a
 * hold still unsettled keeps its worst case, made final once the delete goes through.
 */
async function settleBeforeDelete(deps: DocsDeps, id: string, hold: DocsHoldState): Promise<{ outcome: ReadBack; cancelled: boolean }> {
  let outcome = await readAndSettle(deps, id, hold);
  if (outcome !== "running") return { outcome, cancelled: false };
  try {
    const res = await deps.fetch(upstreamUrl(deps, `responses/${encodeURIComponent(id)}/cancel`, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${deps.upstreamKey()}` },
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel().catch(() => {});
  } catch (err) {
    logged("cancelling a background response before its delete")(err);
  }
  for (let read = 0; read < CANCEL_SETTLE_READS && outcome === "running"; read++) {
    if (read) await new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_GAP_MS));
    outcome = await readAndSettle(deps, id, hold);
  }
  return { outcome, cancelled: true };
}

/** Holds the spend, forwards, and meters. `metering` is set while usage is still being read. */
async function forward(
  call: LiveCall,
  visitor: DocsVisitor,
  ip: string,
  deps: DocsDeps,
  now: Date,
  startedAt: number,
): Promise<{ response: Response; metering: Promise<void> | null }> {
  const done = (response: Response) => ({ response, metering: null });
  const { endpoint, model } = call;
  const ctx: UsageContext = { source: "docs", endpoint: call.usageEndpoint };
  // The key is read before any spend is held, so a deploy without one fails without charging anything.
  const headers: Record<string, string> = { ...call.headers };
  if (!endpoint.noKey) headers.authorization = `Bearer ${deps.upstreamKey()}`;
  if (call.contentType) headers["content-type"] = call.contentType;
  const pending = await pendingHoldFor(endpoint, deps);
  let unsettledDelete = false;
  if (pending && endpoint.id === "responses.delete" && endpoint.owned) {
    const before = await settleBeforeDelete(deps, endpoint.owned.id, pending);
    unsettledDelete = before.outcome === "running" || before.outcome === "pending";
    if (before.cancelled) call.notes.push("The background response was still running, so it was cancelled before the delete.");
  }
  const hold = await holdSpend(deps, ctx, model, call.estimate, ip, now);
  if (hold instanceof Response) return done(hold);

  // One deadline for the call, inside the route's maxDuration, so after() still has time to meter a cut-off stream.
  // The reader leaving doesn't abort it: Meta finishes (and bills) a stored response anyway, so the meter reads the
  // reply to its end to record what it really cost.
  const timeoutMs = Math.max(1_000, startedAt + DEFAULT_LIMITS.upstreamTimeoutMs - Date.now());
  let upstream: Response;
  try {
    upstream = await deps.fetch(upstreamUrl(deps, endpoint.upstreamPath, call.query), {
      method: endpoint.method,
      headers,
      body: call.body ?? undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.error(`[docs] upstream ${label(endpoint)} failed:`, err instanceof Error ? err.message : err);
    await hold.cancel();
    return done(docsErrors.upstreamUnreachable());
  }

  const out = replyHeaders(upstream, call);
  if (!upstream.ok) {
    await hold.cancel();
    // Meta's own errors teach as much as its answers, so they pass through, except a refused key, which is ours.
    if (upstream.status === 401 && !endpoint.noKey) {
      await upstream.body?.cancel().catch(() => {});
      return done(docsErrors.keyRefused());
    }
    return done(new Response(upstream.body, { status: upstream.status, headers: out }));
  }

  if ((endpoint.id === "files.delete" || endpoint.id === "responses.delete") && endpoint.owned) {
    if (unsettledDelete) {
      // Nothing is left to read: the worst case stays as the charge, taken off the row so its settle is final.
      const kept = await deps.claimHold(endpoint.owned.id).catch((err) => {
        logged("closing a deleted background response's hold")(err);
        return null;
      });
      if (kept) console.warn(`[docs] ${endpoint.owned.id} was deleted before Meta reported its usage: its worst case stays as the charge`);
    }
    await deps.forgetObject(endpoint.owned.id).catch(logged("forgetting a deleted object"));
  }
  const type = upstream.headers.get("content-type");
  const stores = endpoint.creates === "file" || (endpoint.creates === "response" && call.json?.store !== false);
  const record = async (id: string, held: DocsHoldState | null = null) => {
    if (!endpoint.creates) return;
    const object = { id, kind: endpoint.creates, visitor: visitor.hash, hold: held };
    await deps.recordObject(object).catch(logged("recording a created object"));
  };
  // A retrieval or cancel of a background response still holding its spend: its reply may show the run finished.
  const settling =
    pending && endpoint.owned && endpoint.id !== "responses.delete" ? { id: endpoint.owned.id, hold: pending } : null;

  if (upstream.body && isEventStream(type)) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
    if (settling) {
      // A streamed retrieval ends with the finished response, which settles the hold (the retrieval itself is free).
      await hold.cancel();
      const [toClient, toMeter] = upstream.body.tee();
      const metering = finalResponseOf(toMeter)
        .then((response) => settleFinished(deps, settling.id, settling.hold, response))
        .then(() => undefined)
        .catch(logged("settling a background response"));
      return { response: new Response(toClient, { status: upstream.status, headers: out }), metering };
    }
    if (!endpoint.meter) {
      await hold.cancel();
      return done(new Response(upstream.body, { status: upstream.status, headers: out }));
    }
    // One branch streams to the reader untouched; the other is read for usage and for the response id, which is
    // recorded as soon as response.created arrives, without waiting for the stream to end.
    const [toClient, toMeter] = upstream.body.tee();
    const recordings: Promise<unknown>[] = [];
    const meter = docsStreamMeter(endpoint, model, {
      audioMs: call.audioMs,
      onResponseId: stores ? (id) => void recordings.push(record(id)) : undefined,
    });
    const metering = readMetered(meter, toMeter)
      .then(({ items, complete }) => settleOrKeep(hold, call.estimate, items, complete))
      .catch(logged(`metering ${label(endpoint)}`))
      .then(() => Promise.all(recordings))
      .then(() => undefined);
    return { response: new Response(toClient, { status: upstream.status, headers: out }), metering };
  }

  if (!upstream.body || (!endpoint.meter && !endpoint.creates && !settling)) {
    await hold.cancel();
    return done(new Response(upstream.body, { status: upstream.status, headers: out }));
  }

  // A JSON reply is read whole: its id is recorded before the reader can use it, and its usage read from it.
  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch (err) {
    console.error(`[docs] reading ${label(endpoint)} failed:`, err instanceof Error ? err.message : err);
    const metering = settleOrKeep(hold, call.estimate, docsMinimalUsage(endpoint, model, call.audioMs), false).catch(
      logged("metering a cut-off reply"),
    );
    return { response: docsErrors.upstreamUnreachable(), metering };
  }
  let json: Json | null = null;
  if (isJsonContentType(type)) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      json = isObject(parsed) ? parsed : null;
    } catch {
      json = null;
    }
  }
  // Background is read from the reply too: a request Meta ran in the background shows no usage yet.
  const background = endpoint.meter === "responses" && (call.background || isBackgroundReply(json));
  if (stores && typeof json?.id === "string" && json.id) await record(json.id, background ? hold.state : null);
  let metering: Promise<void> | null = null;
  if (settling) {
    await hold.cancel();
    // A cancel's reply has the lifecycle fields only: unless it shows usage (a late cancel returns the completed
    // response), a finished run is read back for what it used, and one still stopping is left to the next read.
    const settle =
      endpoint.id === "responses.cancel" && !showsUsage(json)
        ? TERMINAL_STATUSES.has(String(json?.status))
          ? readAndSettle(deps, settling.id, settling.hold)
          : Promise.resolve()
        : settleFinished(deps, settling.id, settling.hold, json);
    metering = settle.then(() => undefined).catch(logged("settling a background response"));
  } else if (!endpoint.meter) {
    await hold.cancel();
  } else if (background) {
    // The run goes on at Meta: the hold stays, at its worst case for a background request, until the finished
    // response is read (the reader's retrieve or cancel, or the hourly sweep).
  } else if (!json) {
    metering = settleOrKeep(hold, call.estimate, docsMinimalUsage(endpoint, model, call.audioMs), false).catch(
      logged(`metering ${label(endpoint)}`),
    );
  } else if (usageShown(endpoint, json)) {
    metering = hold.settle(docsUsageFromJson(endpoint, model, json)).catch(logged(`metering ${label(endpoint)}`));
  }
  // Otherwise the reply doesn't say what it used, and the estimate stays as the charge rather than nothing.
  return { response: new Response(bytes, { status: upstream.status, headers: out }), metering };
}

/** The docs proxy for /api/docs/v1/<path>. Never throws: an unexpected failure is a 500 in the gateway's shape. */
export async function handleDocsProxy(req: Request, path: readonly string[], deps: DocsDeps): Promise<Response> {
  try {
    return await proxy(req, path, deps);
  } catch (err) {
    console.error("[docs] unexpected error:", err instanceof Error ? err.message : err);
    return docsErrors.unexpected();
  }
}

async function proxy(req: Request, path: readonly string[], deps: DocsDeps): Promise<Response> {
  const startedAt = Date.now();
  const endpoint = matchEndpoint(req.method, path);
  if (!endpoint) return docsErrors.unknownEndpoint(req.method, path);
  const visitor = visitorOf(req, deps.newVisitorId);
  const reply = (res: Response) => finalize(res, visitor, req);
  if (endpoint.method !== "GET" && isCrossSite(req.headers)) return reply(docsErrors.crossSite());
  if (!deps.config.live) return reply(docsErrors.paused());

  const call = await prepare(req, endpoint, visitor, deps.config);
  if (call instanceof Response) return reply(call);

  const ip = docsClientIp(req.headers);
  const now = deps.now?.() ?? new Date();
  const limited = await checkRequestLimits(ip, deps, now);
  if (limited) return reply(limited);
  const notOwned = await checkOwnership(call, visitor, deps);
  if (notOwned) return reply(notOwned);
  const busy =
    endpoint.id === "files.create" ? await checkUploadLimit(deps, now) : await checkModelLimit(call.model, deps, now);
  if (busy) return reply(busy);

  return reply(
    await withInFlightSlot(ip, deps, now, async () =>
      endpoint.id === "files.list"
        ? { response: await listFiles(req, visitor, deps), metering: null }
        : forward(call, visitor, ip, deps, now, startedAt),
    ),
  );
}

/** Where Ask reads a page: its title and Markdown, or null for a slug that isn't mirrored. */
export interface DocsPages {
  page(slug: string): { title: string; markdown: string } | null;
  /** Every page as "slug: title", one a line, for the assistant. */
  catalog?(): string;
}

/**
 * POST /api/docs/ask {slug, messages, model?}: streams a Responses call grounded in the page (lib/docs/proxy/ask.ts),
 * under the same limits and metering as the proxy. Never throws.
 */
export async function handleDocsAsk(req: Request, deps: DocsDeps, pages: DocsPages): Promise<Response> {
  try {
    return await ask(req, deps, pages);
  } catch (err) {
    console.error("[docs] ask failed:", err instanceof Error ? err.message : err);
    return docsErrors.unexpected();
  }
}

/**
 * POST /api/docs/assistant {slug, input}: one round of the docs sidebar's loop, a streamed Responses call with the
 * assistant's tools, under the same limits and metering as the proxy. Never throws.
 */
export async function handleDocsAssistant(req: Request, deps: DocsDeps, pages: DocsPages): Promise<Response> {
  try {
    return await grounded(req, deps, pages, ASSISTANT_BODY_MAX_BYTES, (body) => {
      const input = parseAssistantBody(body);
      return {
        slug: input.slug,
        model: input.model,
        swappedSpark: false,
        build: (page, safetyId) => buildAssistantRequest(input, { slug: input.slug, ...page }, pages.catalog?.() ?? "", safetyId),
      };
    });
  } catch (err) {
    console.error("[docs] assistant failed:", err instanceof Error ? err.message : err);
    return docsErrors.unexpected();
  }
}

/** What a server-built call needs from its parsed body: the page it's about, the model, and the request itself. */
interface GroundedCall {
  slug: string;
  model: string;
  swappedSpark: boolean;
  build(page: { title: string; markdown: string }, safetyId: string): Record<string, unknown>;
}

function ask(req: Request, deps: DocsDeps, pages: DocsPages): Promise<Response> {
  return grounded(req, deps, pages, ASK_BODY_MAX_BYTES, (body) => {
    const input = parseAskBody(body);
    return {
      slug: input.slug,
      model: input.model,
      swappedSpark: input.swappedSpark,
      build: (page, safetyId) => buildAskRequest(input, { slug: input.slug, ...page }, safetyId),
    };
  });
}

async function grounded(req: Request, deps: DocsDeps, pages: DocsPages, maxBytes: number, parse: (body: Record<string, unknown>) => GroundedCall): Promise<Response> {
  const startedAt = Date.now();
  const visitor = visitorOf(req, deps.newVisitorId);
  const reply = (res: Response) => finalize(res, visitor, req);
  if (isCrossSite(req.headers)) return reply(docsErrors.crossSite());
  if (!deps.config.live) return reply(docsErrors.paused());

  let input;
  let page;
  try {
    input = parse(await readJson(req, maxBytes));
    page = pages.page(input.slug);
  } catch (err) {
    if (err instanceof HttpError) {
      return reply(err.status === 413 ? docsErrors.tooLarge(maxBytes) : docsErrors.invalidBody(err.code));
    }
    if (err instanceof AskInputError) {
      return reply(docsError(err.status, "invalid_request_error", err.code, err.message, { retry: false }));
    }
    throw err;
  }
  if (!page) {
    const message = `No mirrored docs page "${input.slug.slice(0, 120)}".`;
    return reply(docsError(404, "not_found_error", "page_not_found", message, { retry: false }));
  }

  const endpoint = matchEndpoint("POST", ["responses"]) as DocsEndpoint;
  const json = input.build(page, safetyIdentifier(visitor));
  const text = JSON.stringify(json);
  const call: LiveCall = {
    endpoint,
    usageEndpoint: "ask",
    model: input.model,
    body: text,
    contentType: "application/json",
    query: "",
    headers: { accept: "text/event-stream" },
    estimate: estimateDocsCost(endpoint, { kind: "json", json, model: input.model }, text.length),
    notes: input.swappedSpark ? [SPARK_NOTE] : [],
    references: null,
    json,
    background: false,
    audioMs: null,
  };

  const ip = docsClientIp(req.headers);
  const now = deps.now?.() ?? new Date();
  const limited = (await checkRequestLimits(ip, deps, now)) ?? (await checkModelLimit(input.model, deps, now));
  if (limited) return reply(limited);
  return reply(await withInFlightSlot(ip, deps, now, () => forward(call, visitor, ip, deps, now, startedAt)));
}

/** GET /api/docs/limits: the limits and today's spend for the UI, and the visitor cookie for a first-time visitor. */
export async function handleDocsLimits(req: Request, deps: DocsDeps): Promise<Response> {
  const visitor = visitorOf(req, deps.newVisitorId);
  const cfg = deps.config;
  const now = deps.now?.() ?? new Date();
  const day = dayWindow(now);
  const [ipMicros, docsSpent] = await Promise.all([
    deps.counterValue(DOCS_KEYS.usd(docsClientIp(req.headers)), day).catch(() => null),
    deps.docsSpendToday().catch(() => null),
  ]);
  const body: DocsLimits = {
    live: cfg.live,
    models: {
      text: [...DOCS_MODELS.text],
      responses: [...DOCS_MODELS.responses],
      images: [...DOCS_MODELS.images],
      voice: [...DOCS_MODELS.voice],
    },
    maxBodyBytes: DOCS_MAX_BODY_BYTES,
    perIpDailyUsd: cfg.perIpDailyUsd,
    ipSpentUsd: ipMicros === null ? null : Math.round(ipMicros) / 1_000_000,
    docsDailyCapUsd: cfg.docsDailyCapUsd,
    docsSpentUsd: docsSpent === null ? null : Math.round(docsSpent * 1_000_000) / 1_000_000,
    perIpRequestsPerMinute: cfg.perIpRequestsPerMinute,
    perIpRequestsPerDay: cfg.perIpRequestsPerDay,
    perIpInFlight: cfg.perIpInFlight,
    resetsAt: day.toISOString(),
  };
  return finalize(Response.json(body, { headers: { "cache-control": "no-store" } }), visitor, req);
}
