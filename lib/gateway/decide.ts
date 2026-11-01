import { DESCRIPTION_MAX_CHARS, NONE_OPTION, OPTION_MAX_CHARS, decidePrompt, labelId, standInDecision, stateText } from "@/lib/decide/format";
import { serveRenderings, servePick, type DecisionModel, type DecisionSide } from "@/lib/decide/serving";
import type { DecideBackend, DecideReply, DecisionLabel } from "@/lib/decide/types";
import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import type { GatewayToken } from "@/lib/gateway/handler";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import type { ModelUsage, ProductStatus } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

/**
 * Decisions for products (docs/DECISION_MODELS.md, "The gateway route"): POST {GATEWAY_URL}/decide {state, question?,
 * options?, model?, none?} picks one option for the state, with a probability for each. A product may call it only when
 * its brief picked `muse-decide`, which puts that id in its tokens' allowedModels the way muse-gadget does.
 *
 * The model is "muse-decide" (the product's own options, 2 to 4 a call) or a person's decision model by its training
 * job id (its own labels and question). Build tokens always get the word-overlap stand-in (standInDecision in
 * lib/decide/format.ts), so a build's tests are steady and spend no GPU time. Live tokens reach a GPU only while a
 * serving window for that model is open (deps.backend, null when none is: 503 decide_offline). Until Muse Decide is
 * trained, muse-decide is base Muse Glimmer 30B zero-shot, read from any open decision model's window with its adapter
 * off, and the reply says so. Each call is metered at $0. The state is never logged.
 */

/** The permission id, in the brief's capabilities and in a token's allowedModels; also the general model's id. */
export const DECIDE_ID = "muse-decide";

/** What a muse-decide reply's model says until Muse Decide is trained: base Glimmer answered, zero-shot. */
export const DECIDE_ZERO_SHOT_MODEL = "muse-glimmer-30b-zero-shot";

export const DECIDE_LIMITS = {
  perTokenPerMinute: 60,
  perIpPerMinute: 20,
  windowMs: 60_000,
  /** The largest body read: a 3,000-character state, JSON escaped at worst, and 12 options with descriptions. */
  bodyBytes: 64 * 1024,
  /** How long a call waits for the GPU's scores, the GPU's one-at-a-time slot included. */
  timeoutMs: 30_000,
} as const;

/** Muse Decide's options a call: its training range, 2 to 4, with `none` the fifth. */
export const DECIDE_GENERAL_OPTIONS = { min: 2, max: 4 } as const;
/** A person's model may be sent other options, 2 to 12 as its own labels were. */
export const DECIDE_CUSTOM_OPTIONS = { min: 2, max: 12 } as const;

/**
 * Why a backend didn't score: "busy", the window's GPU stayed on another request (429 rate_limited); "offline", the
 * window closed under the call (503 decide_offline); "timeout", it didn't answer in time (504); "too_long", the GPU
 * refused a prompt over the model's 2,048 tokens (400 invalid_task). Anything else a backend throws is 502
 * decide_unavailable.
 */
export class DecideBackendError extends Error {
  constructor(
    readonly code: "busy" | "offline" | "timeout" | "too_long",
    message: string,
  ) {
    super(message);
    this.name = "DecideBackendError";
  }
}

export interface DecideDeps {
  findToken(token: string): Promise<GatewayToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** A person's decision model by its training job id (getDecisionModel), or null when there is none to serve. */
  findModel(id: string): Promise<DecisionModel | null>;
  /**
   * The open serving window that scores for this adapter (a decision model's job id), or for base Glimmer (null), or
   * null when none is open: 503 decide_offline. Wave 3 unit 11's shared endpoint plugs in here.
   */
  backend(adapter: string | null): Promise<DecideBackend | null>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  now?(): Date;
  /** DECIDE_LIMITS.timeoutMs unless a test says otherwise. */
  timeoutMs?: number;
}

const OFFLINE = "The decision model isn't running right now. Show the person a manual choice, and try again later.";

async function authorize(req: Request, deps: DecideDeps): Promise<GatewayToken | Response> {
  const bearer = parseBearer(req.headers.get("authorization"));
  const token = bearer ? await deps.findToken(bearer) : null;
  if (!token) return gatewayError(401, "authentication_error", "invalid_token", "Send the product's token as \"Authorization: Bearer <PRODUCT_TOKEN>\".", { retry: false });
  const status = await deps.productStatus(token.productId);
  if (!status || status === "disabled" || status === "failed") {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
  }
  if (!token.allowedModels.includes(DECIDE_ID)) {
    return gatewayError(403, "permission_error", "decide_not_allowed", "This product's brief doesn't use muse-decide, so it can't ask for a decision.", { retry: false });
  }
  return token;
}

async function rateLimited(req: Request, token: GatewayToken, deps: DecideDeps): Promise<Response | null> {
  const now = deps.now?.() ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / DECIDE_LIMITS.windowMs) * DECIDE_LIMITS.windowMs);
  const limits: Record<string, number> = { [`decide:token:${token.id}`]: DECIDE_LIMITS.perTokenPerMinute };
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) limits[`decide:ip:${token.productId}:${ip}`] = DECIDE_LIMITS.perIpPerMinute;
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  if (!over) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + DECIDE_LIMITS.windowMs - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `Too many decisions: the limit is ${over[1]} a minute. Try again in ${retryAfter} s.`, {
    headers: { "retry-after": String(retryAfter) },
  });
}

const bad = (code: string, message: string) => gatewayError(400, "invalid_request_error", code, message, { retry: false });

/** A flat object's values: text, numbers, true or false, or null. */
function isFlat(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
}

/** The product's options as labels, in order, or the 400 to answer. */
function optionsAsLabels(raw: unknown, range: { min: number; max: number }, general: boolean): DecisionLabel[] | Response {
  if (!Array.isArray(raw)) return bad("invalid_options", "options must be a list of option names, or {option, description} objects.");
  if (raw.length < range.min || raw.length > range.max) {
    return bad(
      "invalid_options",
      general
        ? `Muse Decide takes ${range.min} to ${range.max} options a call, its training range ("${NONE_OPTION}" is added as the last). Split a longer list, or train a decision model on your own labels.`
        : `Send ${range.min} to ${range.max} options.`,
    );
  }
  const labels: DecisionLabel[] = [];
  const ids = new Set<string>();
  for (const [i, o] of raw.entries()) {
    const name = typeof o === "string" ? o : o && typeof o === "object" ? (o as { option?: unknown }).option : undefined;
    const description = o && typeof o === "object" ? (o as { description?: unknown }).description : undefined;
    if (typeof name !== "string" || !name.trim() || [...name.trim()].length > OPTION_MAX_CHARS) {
      return bad("invalid_options", `Option ${i + 1} must be a name of 1 to ${OPTION_MAX_CHARS} characters.`);
    }
    if (description !== undefined && description !== null && (typeof description !== "string" || [...description.trim()].length > DESCRIPTION_MAX_CHARS)) {
      return bad("invalid_options", `Option ${i + 1}'s description must be text of up to ${DESCRIPTION_MAX_CHARS} characters.`);
    }
    const text = name.trim();
    if (text.toLowerCase() === NONE_OPTION.toLowerCase()) {
      return bad("invalid_options", `"${NONE_OPTION}" is added for you; leave it out of options.`);
    }
    const id = labelId(text);
    if (!id) return bad("invalid_options", `Option ${i + 1} needs at least one letter or digit.`);
    if (ids.has(id)) return bad("invalid_options", `Option ${i + 1} repeats another option.`);
    ids.add(id);
    labels.push({ id, name: text, description: typeof description === "string" ? description.trim() : "" });
  }
  return labels;
}

/** Whether two label lists are the same options, in the same order, ignoring case and spacing. */
function sameLabels(a: readonly DecisionLabel[], b: readonly DecisionLabel[]): boolean {
  return a.length === b.length && a.every((l, i) => l.id === b[i]!.id);
}

/** What one call asks for, once checked. */
interface DecideCall {
  state: string | Record<string, unknown>;
  question: string;
  labels: DecisionLabel[];
  none: boolean;
  /** The model id the reply names when live. */
  model: string;
  /** The adapter to score with, or null for base Glimmer. */
  adapter: string | null;
  side: DecisionSide;
  note: string | null;
}

async function readCall(req: Request, deps: DecideDeps): Promise<DecideCall | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return bad("invalid_body", "The request body couldn't be read.");
  }
  if (Buffer.byteLength(text) > DECIDE_LIMITS.bodyBytes) {
    return gatewayError(413, "invalid_request_error", "too_large", `Keep the request under ${DECIDE_LIMITS.bodyBytes / 1024} KB.`, { retry: false });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("invalid_body", "The request body is not a JSON object.");
  }
  const raw = body.state;
  if (typeof raw !== "string" && !isFlat(raw)) {
    return bad("invalid_state", "state must be text, or a flat object of text, numbers and true or false.");
  }
  const state = typeof raw === "string" ? raw.trim() : raw;
  if (body.question !== undefined && typeof body.question !== "string") return bad("invalid_question", "question must be text.");
  if (body.none !== undefined && typeof body.none !== "boolean") return bad("invalid_none", "none must be true or false.");
  if (body.model !== undefined && typeof body.model !== "string") return bad("invalid_model", "model must be \"muse-decide\" or a decision model's id.");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().toLowerCase() : DECIDE_ID;
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (model === DECIDE_ID) {
    if (!question) return bad("invalid_question", "Send the question to decide, 5 to 300 characters.");
    if (body.options === undefined) return bad("invalid_options", "Send the options to pick from: 2 to 4 names.");
    const labels = optionsAsLabels(body.options, DECIDE_GENERAL_OPTIONS, true);
    if (labels instanceof Response) return labels;
    return {
      state,
      question,
      labels,
      none: body.none ?? true,
      model: DECIDE_ZERO_SHOT_MODEL,
      adapter: null,
      side: { T: 1, calibrated: false },
      note: "Muse Decide isn't trained yet, so base Muse Glimmer 30B picked zero-shot. Its confidence is its own probability, not calibrated.",
    };
  }

  const found = await deps.findModel(model);
  if (!found || !found.public) {
    return gatewayError(404, "not_found_error", "unknown_model", `No decision model has the id "${model.slice(0, 80)}". Use "${DECIDE_ID}", or a decision model's id from its result page.`, { retry: false });
  }
  if (body.none === false) {
    return bad("invalid_none", `A trained decision model always shows "${NONE_OPTION}", as it learned to, so none can't be turned off.`);
  }
  let labels = found.labels;
  const notes: string[] = [];
  if (body.options !== undefined) {
    const given = optionsAsLabels(body.options, DECIDE_CUSTOM_OPTIONS, false);
    if (given instanceof Response) return given;
    if (!sameLabels(given, found.labels)) {
      labels = given;
      notes.push("These options aren't the labels this model learned, so its pick and its confidence are less reliable.");
    }
  }
  let ask = found.question;
  if (question && question !== found.question) {
    ask = question;
    notes.push("This question isn't the one this model learned, so its pick and its confidence are less reliable.");
  }
  const own = notes.length === 0;
  return {
    state,
    question: ask,
    labels,
    none: true,
    model: found.id,
    adapter: found.id,
    side: own ? found.tuned : { T: 1, calibrated: false },
    note: notes.length ? notes.join(" ") : null,
  };
}

function meter(token: GatewayToken, deps: DecideDeps): void {
  const ctx: UsageContext = { source: "gateway", productId: token.productId, tokenId: token.id, endpoint: "/decide" };
  // No Meta spend: a decision is metered as one unit at $0. The window's GPU time is billed to its own job.
  deps.recordUsage(ctx, [{ model: DECIDE_ID, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 }]).catch((err) =>
    console.error("[decide] metering failed:", err instanceof Error ? err.message : err),
  );
}

/** Resolves when the signal aborts. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DecideBackendError("timeout", "aborted"));
    else signal.addEventListener("abort", () => reject(new DecideBackendError("timeout", "aborted")), { once: true });
  });
}

/** POST: one decision. */
export async function handleDecide(req: Request, deps: DecideDeps): Promise<Response> {
  const token = await authorize(req, deps);
  if (token instanceof Response) return token;
  const call = await readCall(req, deps);
  if (call instanceof Response) return call;
  const rendered = serveRenderings({ state: call.state, question: call.question, labels: call.labels, none: call.none });
  if (!rendered.ok) return bad("invalid_task", rendered.error);
  const limited = await rateLimited(req, token, deps);
  if (limited) return limited;

  if (token.scope === "build") {
    meter(token, deps);
    const decision = standInDecision({ state: stateText(call.state), labels: call.labels, none: call.none });
    const reply: DecideReply = {
      ...decision,
      model: "stand-in",
      calibrated: false,
      simulated: true,
      ms: 0,
      note: "The build-time stand-in: the option whose words overlap the state's most. It is not a model; live, the decision model answers.",
    };
    return Response.json(reply);
  }

  const backend = await deps.backend(call.adapter);
  if (!backend) return gatewayError(503, "server_error", "decide_offline", OFFLINE, { retry: false });
  const prompts = rendered.renderings.map((r) => decidePrompt(r));
  // A timer of its own rather than AbortSignal.timeout, whose timer doesn't keep the process waiting for it.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? DECIDE_LIMITS.timeoutMs);
  const signal = ac.signal;
  let scores: { logprobs: number[][]; ms: number };
  try {
    const scoring = backend.score({ prompts, letters: rendered.renderings.map((r) => [...r.letters]), adapter: call.adapter, signal });
    scoring.catch(() => {});
    scores = await Promise.race([scoring, aborted(signal)]);
  } catch (err) {
    const code = err instanceof DecideBackendError ? err.code : null;
    // Only the code and the backend's own sentence: never the state.
    console.error("[decide]", call.model, code ?? "unavailable", err instanceof Error ? err.message.slice(0, 200) : "");
    if (signal.aborted || code === "timeout") {
      return gatewayError(504, "server_error", "timeout", "The decision model didn't answer in time. Try again.");
    }
    if (code === "busy") {
      return gatewayError(429, "rate_limit_error", "rate_limited", "The decision model is answering another request, one at a time. Try again in a few seconds.", {
        headers: { "retry-after": "2" },
      });
    }
    if (code === "offline") return gatewayError(503, "server_error", "decide_offline", OFFLINE, { retry: false });
    if (code === "too_long") return bad("invalid_task", "The task is too long for the model once rendered (over 2,048 tokens). Send a shorter state.");
    return gatewayError(502, "server_error", "decide_unavailable", "The decision model didn't answer. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
  let reply: DecideReply;
  try {
    const pick = servePick(call.labels, rendered.renderings, scores.logprobs, call.side);
    const { mass: _mass, calibrated, ...decision } = pick;
    void _mass;
    const ms = typeof scores.ms === "number" && Number.isFinite(scores.ms) && scores.ms >= 0 ? Math.round(scores.ms) : 0;
    reply = { ...decision, model: call.model, calibrated, simulated: false, ms, note: call.note };
  } catch (err) {
    console.error("[decide]", call.model, "unusable scores:", err instanceof Error ? err.message.slice(0, 200) : err);
    return gatewayError(502, "server_error", "decide_unavailable", "The decision model's answer couldn't be read. Try again in a moment.");
  }
  meter(token, deps);
  return Response.json(reply);
}
