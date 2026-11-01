import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { jobRunRefusal, type JobRunRead } from "@/lib/caps/jobs/run-check";
import { createHash } from "node:crypto";
import {
  KEY_NAME,
  matchCall,
  matchFetch,
  SERVICES,
  serviceForChannel,
  pickSample,
  type FetchTarget,
  type SendChannel,
  type Service,
} from "@/lib/caps/connect/allowlist";
import type { ConnectBrief } from "@/lib/caps/connect/brief";
import { CONNECT_LIMITS } from "@/lib/caps/connect/limits";
import { API_SAMPLES, SERVICE_SAMPLES, type Sample } from "@/lib/caps/connect/samples";
import type { ConnectStore } from "@/lib/caps/connect/store";
import {
  capError,
  dayWindow,
  readJsonBody,
  runCapGate,
  unknownEndpoint,
  unknownKeys,
  type CapContext,
  type CapGateDeps,
  type CapLimit,
  type CapProduct,
  type CapRoute,
  type CapStage,
  type CapToken,
} from "@/lib/caps/gate";
import { subjectKey } from "@/lib/caps/principal";
import { buildNamespace } from "@/lib/caps/proof";
import { openSecret, sealSecret, type BoxKeyring } from "@/lib/secrets/box";
import { checkApproval, mac, mintApproval, randomId } from "@/lib/tools/sign";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage } from "@/lib/types";

/**
 * {GATEWAY_URL}/fetch, /vault and /send (docs/CAPABILITIES.md, section 11), behind the cap gate (lib/caps/gate.ts).
 *
 * - /fetch calls one keyless public API from lib/caps/connect/apis.json, cached for everyone. A build gets the API's
 *   recorded sample and never reaches out.
 * - /vault keeps the product owner's own keys, sealed (lib/secrets/box.ts). No route returns a value. /vault/call adds
 *   one to a call to its service's own host, only to the methods and paths services.json lists. A build gets the
 *   service's sample.
 * - /send answers needs_confirmation first, then sends once with that exact approval, with the owner's own key. Off on
 *   production unless the owner turns it on (decision 8). A build's confirmed send is recorded as simulated and goes
 *   nowhere.
 */

export interface ConnectDeps extends CapGateDeps {
  store: ConnectStore;
  /** CONNECT_VAULT. */
  vaultOn(): boolean;
  /** CONNECT_SENDS, with production's own switch (env.connectSends). */
  sendsOn(): boolean;
  /** CONNECT_VAULT_KEY as a key ring, or null when it isn't set. Read only by the vault routes. */
  keyring(): BoxKeyring | null;
  /**
   * What the product may reach: a build's from its own brief, a live product's from the brief it shipped with, narrowed
   * by its manifest's `connect` block. Null when there is none: then nothing is allowed.
   */
  rules(token: CapToken, product: CapProduct): Promise<ConnectBrief | null>;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  /** The outside world. Tests pass a fake; nothing else calls out. */
  fetch: typeof fetch;
  /** What every outside call says it is, with a contact (the APIs' terms ask for one). */
  userAgent: string;
  /** Unit 6: a job's send becomes a notice the owner confirms later. Unset while the jobs cap isn't served. */
  holdSend?(input: { productId: string; namespace: string; send: SendArgs; lines: string[]; title: string }): Promise<string>;
  /** Unit 6: a job's run, so a token only works while it's running. Unset while the jobs cap isn't served, and then a job is refused. */
  jobRun?: JobRunRead;
}

const isBuild = (token: CapToken) => token.scope === "build";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const minuteLimit = (key: string, limit: number, who: string): CapLimit => ({ key, limit, window: "minute", who });
const dayLimit = (key: string, limit: number, who: string): CapLimit => ({ key, limit, window: "day", who });

function usage(ctx: CapContext<unknown>, source: "fetch" | "vault" | "sends", endpoint: string, model: string): [UsageContext, ModelUsage[]] {
  return [
    { source, endpoint, productId: ctx.token.productId, buildId: ctx.token.buildId, tokenId: ctx.token.id },
    [{ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 }],
  ];
}

/** Reads a body of at most `max` bytes, up to the cap, or null when it is bigger. Never buffers more than that. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const JSON_TYPE = /^application\/([a-z.+-]*\+)?json\b/i;

function parseBody(contentType: string | null, body: Buffer): unknown {
  const text = body.toString("utf8");
  if (contentType && JSON_TYPE.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------------------------------------------
// /fetch

interface FetchArgs {
  target: FetchTarget;
}

/** Serves POST {GATEWAY_URL}/fetch. */
export async function handleFetch(req: Request, deps: ConnectDeps): Promise<Response> {
  if (req.method !== "POST") return unknownEndpoint("/fetch");
  return runCapGate(req, deps, fetchRoute(deps));
}

function fetchRoute(deps: ConnectDeps): CapRoute<FetchArgs> {
  return {
    cap: "connect",
    what: "/fetch",
    async args(stage) {
      const body = await readJsonBody(stage.req, CONNECT_LIMITS.fetchBodyMaxBytes);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["api", "path", "query"]);
      if (extra) return extra;
      if (body.query !== undefined && (typeof body.query !== "object" || body.query === null || Array.isArray(body.query))) return capError("invalid_arguments", "query is an object of names and values.");
      const query = (body.query ?? {}) as Record<string, unknown>;
      if (Object.values(query).some((v) => v !== null && v !== undefined && !["string", "number", "boolean"].includes(typeof v))) return capError("invalid_arguments", "Each query value is a string, a number or true or false.");
      const target = matchFetch({ api: body.api as string, path: body.path as string, query: query as Record<string, string> });
      if (typeof target === "string") return capError("invalid_arguments", target);
      const rules = await deps.rules(stage.token, stage.product);
      if (!rules?.publicApis.includes(target.api.id)) return capError("cap_not_allowed", `This product wasn't built to use ${target.api.label}.`);
      return { target };
    },
    limits(stage) {
      const pid = stage.token.productId;
      const limits = [minuteLimit(`fetch:product:${pid}`, CONNECT_LIMITS.fetchPerProductPerMinute, "this product")];
      if (stage.caller.ip) limits.push(minuteLimit(`fetch:ip:${pid}:${stage.caller.ip}`, CONNECT_LIMITS.fetchPerIpPerMinute, "this user"));
      limits.push(
        isBuild(stage.token)
          ? dayLimit(`fetch:build:${stage.token.buildId}`, CONNECT_LIMITS.fetchPerBuildPerDay, "this build's outside calls")
          : dayLimit(`fetch:day:${pid}`, CONNECT_LIMITS.fetchPerProductPerDay, "this product's outside calls"),
      );
      return limits;
    },
    async work(ctx) {
      const { target } = ctx.args;
      const answer = (status: number, data: unknown, extra: Record<string, unknown>) =>
        json({ ok: true, api: target.api.id, route: target.route.id, status, data, credit: target.api.attribution, ...extra });
      if (isBuild(ctx.token)) {
        const list = API_SAMPLES[target.api.id]?.[target.route.id] ?? [];
        const index = list.length ? list.indexOf(pickSample(list, target.normalized)!) : -1;
        const sample: Sample = list[index] ?? { status: 200, data: null };
        await deps.recordUsage(...usage(ctx as CapContext<unknown>, "fetch", "fetch", `fetch:${target.api.id}`));
        return answer(sample.status, sample.data, { cached: false, simulated: true, sample: `${target.api.id}:${target.route.id}:${Math.max(0, index)}` });
      }
      const cached = await deps.store.cacheGet(target.cacheKey, ctx.now);
      if (cached) return answer(cached.status, parseBody(cached.contentType, cached.body), { cached: true, fetchedAt: cached.fetchedAt.toISOString() });
      // The API's own rate, across every product. Only calls that really go out count.
      const apiKey = `fetch-api:${target.api.id}`;
      const counts = await deps.hitRateLimits([apiKey], new Date(Math.floor(ctx.now.getTime() / 60_000) * 60_000));
      if ((counts[apiKey] ?? 0) > target.api.perMinute) return capError("rate_limited", `${target.api.label} is busy right now. Try again in a minute.`, { "retry-after": "30" });
      const got = await callPublicApi(target, deps);
      if (got instanceof Response) return got;
      await deps.recordUsage(...usage(ctx as CapContext<unknown>, "fetch", "fetch", `fetch:${target.api.id}`));
      const ok = got.status >= 200 && got.status < 300;
      if (ok || got.status === 404) {
        const seconds = ok ? target.route.cacheSeconds : CONNECT_LIMITS.notFoundCacheSeconds;
        await deps.store.cachePut({ key: target.cacheKey, api: target.api.id, status: got.status, contentType: got.contentType, body: got.body, fetchedAt: ctx.now, expiresAt: new Date(ctx.now.getTime() + seconds * 1000) });
      }
      return answer(got.status, parseBody(got.contentType, got.body), { cached: false, fetchedAt: ctx.now.toISOString() });
    },
  };
}

/** One call to the API, following at most two redirects that stay on its host and on an allowed path. */
async function callPublicApi(first: FetchTarget, deps: ConnectDeps): Promise<{ status: number; contentType: string | null; body: Buffer } | Response> {
  let target = first;
  for (let hop = 0; hop <= CONNECT_LIMITS.maxRedirects; hop++) {
    let res: Response;
    try {
      res = await deps.fetch(target.url, {
        method: "GET",
        headers: { accept: "application/json", ...(target.api.headers ?? {}), "user-agent": deps.userAgent },
        redirect: "manual",
        signal: AbortSignal.timeout(CONNECT_LIMITS.fetchTimeoutMs),
      });
    } catch {
      return capError("cap_failed", `${target.api.label} didn't answer. Try again in a minute.`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      const next = location ? new URL(location, target.url) : null;
      const base = new URL(target.api.base);
      if (!next || next.origin !== base.origin) return capError("cap_failed", `${target.api.label} sent the request somewhere else, which products can't follow.`);
      const query = Object.fromEntries([...next.searchParams].filter(([k]) => !(k in (target.route.fixed ?? {}))));
      const matched = matchFetch({ api: target.api.id, path: next.pathname, query });
      if (typeof matched === "string") return capError("cap_failed", `${target.api.label} sent the request to a path products can't use.`);
      target = matched;
      continue;
    }
    const contentType = res.headers.get("content-type");
    const body = await readCapped(res, CONNECT_LIMITS.responseMaxBytes);
    if (!body) return capError("cap_failed", `${target.api.label}'s answer was over 1 MB. Ask for less, such as a smaller limit.`);
    if (contentType && !JSON_TYPE.test(contentType) && res.ok) return capError("cap_failed", `${target.api.label} didn't answer with data.`);
    return { status: res.status, contentType, body };
  }
  return capError("cap_failed", `${first.api.label} redirected too many times.`);
}

// ---------------------------------------------------------------------------------------------------------------
// /vault

/** Serves everything under {GATEWAY_URL}/vault. With CONNECT_VAULT off, every path answers 404. */
export async function handleVault(req: Request, path: readonly string[], deps: ConnectDeps): Promise<Response> {
  const route = `${req.method} ${path.length}`;
  if (route === "GET 0") return runCapGate(req, deps, listKeysRoute(deps));
  if (route === "POST 0") return runCapGate(req, deps, saveKeyRoute(deps));
  if (route === "POST 1" && path[0] === "call") return runCapGate(req, deps, callRoute(deps));
  if (route === "DELETE 1" && path[0] && path[0] !== "call") return runCapGate(req, deps, revokeKeyRoute(deps, path[0]));
  return unknownEndpoint("/vault");
}

const ownerOnly = (what: string) => (stage: CapStage) => (stage.caller.owner ? null : capError("sign_in_required", `Only the product's owner can ${what}. Open it as the owner from Muse Muse.`));

const vaultLimits = (stage: CapStage): CapLimit[] => [minuteLimit(`vault:token:${stage.token.id}`, CONNECT_LIMITS.vaultPerTokenPerMinute, "this product")];

const paused = () => capError("caps_paused", "The key vault isn't set up on Muse Muse yet.");

/** The vault's additional data: a sealed key opens only for this product, namespace and name. */
const vaultAad = (productId: string, namespace: string, name: string) => `vault:${productId}:${namespace}:${name}`;

function serviceView(s: Service) {
  return { service: s.id, label: s.label, keyHint: s.keyHint, docs: s.docs };
}

function listKeysRoute(deps: ConnectDeps): CapRoute<Record<string, never>> {
  return {
    cap: "connect",
    what: "/vault",
    enabled: deps.vaultOn,
    allow: ownerOnly("see its keys"),
    async args() {
      return {};
    },
    limits: vaultLimits,
    async work(ctx) {
      const rules = await deps.rules(ctx.token, ctx.product);
      const keys = await deps.store.listKeys(ctx.token.productId, ctx.namespace);
      const wanted = (rules?.keys ?? []).flatMap((k) => (Object.hasOwn(SERVICES, k.service) ? [{ ...serviceView(SERVICES[k.service]!), why: k.why }] : []));
      const sends = (rules?.sends ?? []).flatMap((s) => serviceForChannel(s.channel).map((svc) => ({ ...serviceView(svc), why: s.why })));
      // Names, services and dates only. A value never leaves the gateway.
      return json({
        keys: keys.map((k) => ({ name: k.name, service: k.service, label: SERVICES[k.service]?.label ?? k.service, savedAt: k.createdAt.toISOString() })),
        services: [...wanted, ...sends],
        ...(isBuild(ctx.token) ? { simulated: true } : {}),
      });
    },
  };
}

interface SaveArgs {
  name: string;
  service: Service;
  value: string;
}

/** A key's text as the service takes it, or why not. Never says anything about the value itself. */
function keyProblem(service: Service, value: string): string | null {
  if (value.length < CONNECT_LIMITS.keyMinChars || value.length > CONNECT_LIMITS.keyMaxChars) return `A key is ${CONNECT_LIMITS.keyMinChars} to ${CONNECT_LIMITS.keyMaxChars} characters.`;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A key has no spaces or line breaks. Copy it again.";
  if (service.auth.type === "url") {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (!url || !value.startsWith(service.auth.prefix) || !service.hosts.includes(url.host) || url.username || url.password) return `This needs ${service.label}'s address, starting ${service.auth.prefix}.`;
  }
  return null;
}

function saveKeyRoute(deps: ConnectDeps): CapRoute<SaveArgs> {
  return {
    cap: "connect",
    what: "/vault",
    enabled: deps.vaultOn,
    allow: ownerOnly("save a key"),
    async args(stage) {
      const body = await readJsonBody(stage.req, CONNECT_LIMITS.vaultBodyMaxBytes);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["name", "service", "value"]);
      if (extra) return extra;
      const serviceId = typeof body.service === "string" ? body.service : "";
      const service = Object.hasOwn(SERVICES, serviceId) ? SERVICES[serviceId]! : null;
      if (!service) return capError("invalid_arguments", "service is one of the services products can use.");
      const name = body.name === undefined || body.name === null ? service.id : body.name;
      if (typeof name !== "string" || !KEY_NAME.test(name)) return capError("invalid_arguments", "A key's name is lowercase letters, digits and underscores, up to 40, and not call.");
      if (typeof body.value !== "string") return capError("invalid_arguments", "value is the key, as text.");
      const problem = keyProblem(service, body.value);
      if (problem) return capError("invalid_arguments", problem);
      const rules = await deps.rules(stage.token, stage.product);
      const listed = (rules?.keys ?? []).some((k) => k.service === service.id) || (rules?.sends ?? []).some((s) => service.send === s.channel);
      if (!listed) return capError("cap_not_allowed", `This product wasn't built to use ${service.label}.`);
      return { name, service, value: body.value };
    },
    limits: vaultLimits,
    async work(ctx) {
      const ring = deps.keyring();
      if (!ring) return paused();
      const { name, service, value } = ctx.args;
      const sealed = sealSecret(value, ring, vaultAad(ctx.token.productId, ctx.namespace, name));
      // A build's test key is made up by its test; its hash lets verify look for it in the build's pages and files.
      const testHash = isBuild(ctx.token) ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
      const createdBy = ctx.caller.owner ? subjectKey("owner", ctx.token.productId, ctx.caller.owner) : null;
      const saved = await deps.store.putKey({ productId: ctx.token.productId, namespace: ctx.namespace, name, service: service.id, sealed, createdBy, testHash }, CONNECT_LIMITS.keysPerProduct, ctx.now);
      if (!saved) return capError("quota_exceeded", `This product already keeps ${CONNECT_LIMITS.keysPerProduct} keys. Remove one first.`);
      return json({ ok: true, name, service: service.id, label: service.label, savedAt: ctx.now.toISOString() }, 201);
    },
  };
}

function revokeKeyRoute(deps: ConnectDeps, name: string): CapRoute<{ name: string }> {
  return {
    cap: "connect",
    what: "/vault",
    enabled: deps.vaultOn,
    allow: ownerOnly("remove a key"),
    async args() {
      return KEY_NAME.test(name) ? { name } : capError("invalid_arguments", "A key's name is lowercase letters, digits and underscores, up to 40.");
    },
    limits: vaultLimits,
    async work(ctx) {
      const gone = await deps.store.revokeKey(ctx.token.productId, ctx.namespace, ctx.args.name, ctx.now);
      return gone ? json({ ok: true, name: ctx.args.name, removed: true }) : json({ error: { type: "not_found_error", code: "not_found", message: "There's no key with that name.", param: null } }, 404);
    },
  };
}

interface CallArgs {
  name: string;
  target: Exclude<ReturnType<typeof matchCall>, string>;
  body: unknown;
}

function needsKey(service: Service, canAdd: boolean): Response {
  return json({ ok: false, code: "needs_key", service: service.id, label: service.label, canAdd });
}

function callRoute(deps: ConnectDeps): CapRoute<CallArgs> {
  return {
    cap: "connect",
    what: "/vault",
    enabled: deps.vaultOn,
    async args(stage) {
      const body = await readJsonBody(stage.req, CONNECT_LIMITS.callBodyMaxBytes);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["name", "method", "path", "body"]);
      if (extra) return extra;
      if (typeof body.name !== "string" || !KEY_NAME.test(body.name)) return capError("invalid_arguments", "name is the key's name, which is its service unless the owner chose another.");
      const rules = await deps.rules(stage.token, stage.product);
      // The saved key's service decides what may be called. With no key saved yet, the name is taken as the service, so
      // the answer can say which key to add.
      const namespace = isBuild(stage.token) ? buildNamespace(stage.token.buildId!) : "live";
      const service = (await deps.store.sealedKey(stage.token.productId, namespace, body.name))?.service ?? body.name;
      if (!(rules?.keys ?? []).some((k) => k.service === service)) return capError("cap_not_allowed", "This product wasn't built to call that service.");
      const target = matchCall(service, typeof body.method === "string" ? body.method : "GET", body.path as string);
      if (typeof target === "string") return capError("invalid_arguments", target);
      if (!target.service.visitors && !stage.caller.owner) return capError("sign_in_required", `Only the product's owner can use ${target.service.label} here.`);
      // Unit 6: jobs read and notify. A write to the outside waits for a person.
      if (stage.caller.job && target.method !== "GET") return capError("cap_not_allowed", "A background job can only read from outside services. A write needs a person.");
      { const ended = await jobRunRefusal(stage, deps.jobRun); if (ended) return ended; }
      if (target.method === "GET" && body.body !== undefined && body.body !== null) return capError("invalid_arguments", "A GET call has no body.");
      if (body.body !== undefined && body.body !== null && (typeof body.body !== "object" || Array.isArray(body.body))) return capError("invalid_arguments", "body is a JSON object.");
      return { name: body.name, target, body: body.body ?? null };
    },
    limits(stage) {
      const pid = stage.token.productId;
      const limits = [minuteLimit(`vault-call:token:${stage.token.id}`, CONNECT_LIMITS.callsPerTokenPerMinute, "this product")];
      if (stage.caller.ip) limits.push(minuteLimit(`vault-call:ip:${pid}:${stage.caller.ip}`, CONNECT_LIMITS.callsPerIpPerMinute, "this user"));
      limits.push(dayLimit(`vault-call:day:${isBuild(stage.token) ? stage.token.buildId : pid}`, CONNECT_LIMITS.callsPerProductPerDay, "this product's calls with its owner's keys"));
      return limits;
    },
    async work(ctx) {
      const { target } = ctx.args;
      const pattern = `${target.call.method} ${target.call.path}`;
      if (isBuild(ctx.token)) {
        const sealed = await deps.store.sealedKey(ctx.token.productId, ctx.namespace, ctx.args.name);
        if (!sealed) return needsKey(target.service, Boolean(ctx.caller.owner));
        const list = SERVICE_SAMPLES[target.service.id]?.[pattern] ?? [];
        const sample = pickSample(list, { method: target.method, path: target.url.pathname + target.url.search, body: ctx.args.body }) ?? { status: 200, data: null };
        await deps.recordUsage(...usage(ctx as CapContext<unknown>, "vault", "vault/call", `vault:${target.service.id}`));
        return json({ ok: true, service: target.service.id, status: sample.status, data: sample.data, simulated: true });
      }
      const ring = deps.keyring();
      if (!ring) return paused();
      const sealed = await deps.store.sealedKey(ctx.token.productId, ctx.namespace, ctx.args.name);
      if (!sealed || sealed.service !== target.service.id) return needsKey(target.service, Boolean(ctx.caller.owner));
      const key = openSecret(sealed, ring, vaultAad(ctx.token.productId, ctx.namespace, ctx.args.name));
      const url = new URL(target.url);
      const headers: Record<string, string> = { accept: "application/json", ...(target.service.headers ?? {}), "user-agent": deps.userAgent };
      if (target.service.auth.type === "bearer") headers.authorization = `Bearer ${key}`;
      if (target.service.auth.type === "query") url.searchParams.set(target.service.auth.param, key);
      if (ctx.args.body !== null) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await deps.fetch(url, {
          method: target.method,
          headers,
          ...(ctx.args.body !== null ? { body: JSON.stringify(ctx.args.body) } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(CONNECT_LIMITS.callTimeoutMs),
        });
      } catch {
        return capError("cap_failed", `${target.service.label} didn't answer. Try again in a minute.`);
      }
      await deps.recordUsage(...usage(ctx as CapContext<unknown>, "vault", "vault/call", `vault:${target.service.id}`));
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        return capError("cap_failed", `${target.service.label} sent the call somewhere else, which the platform doesn't follow with a key.`);
      }
      const raw = await readCapped(res, CONNECT_LIMITS.responseMaxBytes);
      if (!raw) return capError("cap_failed", `${target.service.label}'s answer was over 1 MB. Ask for less.`);
      // A service that echoes the key back never gets it to the product.
      const text = raw.toString("utf8").split(key).join("[key hidden]");
      const contentType = res.headers.get("content-type");
      return json({ ok: true, service: target.service.id, status: res.status, data: parseBody(contentType, Buffer.from(text, "utf8")) });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// /send

const EMAIL = /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
const FROM = /^([^<>"\r\n]{1,80} )?<?([^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+)>?$/;

/** What one send says, exactly. The approval is for these values only. */
export interface SendArgs {
  channel: SendChannel;
  to: string[];
  subject: string | null;
  body: string;
  from: string | null;
}

interface SendWork {
  send: SendArgs;
  approval: string | null;
}

const SEND_TITLES: Record<SendChannel, string> = {
  email: "Send this email?",
  chat: "Post this message to Slack?",
  sms: "Send this text?",
  social: "Post this?",
  payment: "Send this payment request?",
};

/**
 * What the card shows, the same way the tool gateway's approvalLines does (lib/tools/handler.ts): whole, never cut,
 * whitespace collapsed so blank lines can't push text out of view or start a line that looks like a field, and anything
 * invisible or that reorders text shown as �. The approval covers exactly these values, so the owner sees all of it.
 */
export function shownSendText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\p{Cc}\p{Cf}]/gu, "�");
}

export function confirmationLines(s: SendArgs): string[] {
  return [
    ...(s.channel === "chat" ? ["To: the Slack channel your webhook posts to"] : [`To: ${shownSendText(s.to.join(", "))}`]),
    ...(s.from ? [`From: ${shownSendText(s.from)}`] : []),
    ...(s.subject ? [`Subject: ${shownSendText(s.subject)}`] : []),
    `Message: ${shownSendText(s.body)}`,
  ];
}

/** Serves POST {GATEWAY_URL}/send. With CONNECT_SENDS off, or on production without the owner's switch, it is a 404. */
export async function handleSend(req: Request, deps: ConnectDeps): Promise<Response> {
  if (req.method !== "POST") return unknownEndpoint("/send");
  return runCapGate(req, deps, sendRoute(deps));
}

function cleanSend(body: Record<string, unknown>): SendArgs | string {
  const channel = body.channel;
  if (channel !== "email" && channel !== "chat") {
    return typeof channel === "string" && ["sms", "social", "payment"].includes(channel) ? "Products can't send that kind of message yet." : "channel is email or chat.";
  }
  const text = typeof body.body === "string" ? body.body.replace(/\r\n/g, "\n").trim() : "";
  const max = channel === "email" ? CONNECT_LIMITS.emailBodyMaxChars : CONNECT_LIMITS.chatBodyMaxChars;
  if (!text || text.length > max) return `body is the message, 1 to ${max.toLocaleString("en-US")} characters.`;
  if (channel === "chat") {
    if (body.to !== undefined && body.to !== null && !(Array.isArray(body.to) && body.to.length === 0)) return "A chat message goes to the channel the owner's webhook posts to, so leave out to.";
    if (body.subject !== undefined && body.subject !== null) return "A chat message has no subject.";
    if (body.from !== undefined && body.from !== null) return "A chat message has no from.";
    return { channel, to: [], subject: null, body: text, from: null };
  }
  const list = typeof body.to === "string" ? [body.to] : Array.isArray(body.to) ? body.to : [];
  const to = [...new Set(list.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : "")))].sort();
  if (!to.length || to.some((x) => !EMAIL.test(x))) return "to is one to five email addresses.";
  if (to.length > CONNECT_LIMITS.recipientsMax) return `A message goes to at most ${CONNECT_LIMITS.recipientsMax} people.`;
  const subject = typeof body.subject === "string" ? body.subject.replace(/[\r\n]+/g, " ").trim() : "";
  if (!subject || subject.length > CONNECT_LIMITS.subjectMaxChars) return `subject is 1 to ${CONNECT_LIMITS.subjectMaxChars} characters.`;
  const from = typeof body.from === "string" ? body.from.trim() : null;
  if (from !== null && !FROM.test(from)) return "from is an address on a domain you verified with Resend, like \"Garden Club <hello@example.com>\".";
  return { channel, to, subject, body: text, from };
}

function sendRoute(deps: ConnectDeps): CapRoute<SendWork> {
  return {
    cap: "connect",
    what: "/send",
    enabled: deps.sendsOn,
    // Every send is the owner's (Meta's Acceptable Use Policy: a person confirms anything consequential).
    // Unit 6: a job can't send. Its send waits for the owner, in work below.
    allow: (stage) => (stage.caller.job && deps.holdSend ? null : ownerOnly("send messages")(stage)),
    async args(stage) {
      const body = await readJsonBody(stage.req, CONNECT_LIMITS.sendBodyMaxBytes);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["channel", "to", "subject", "body", "from", "approval"]);
      if (extra) return extra;
      if (body.approval !== undefined && body.approval !== null && typeof body.approval !== "string") return capError("invalid_arguments", "approval is the id from the confirmation.");
      const send = cleanSend(body);
      if (typeof send === "string") return capError("invalid_arguments", send);
      const rules = await deps.rules(stage.token, stage.product);
      if (!(rules?.sends ?? []).some((s) => s.channel === send.channel)) return capError("cap_not_allowed", `This product wasn't built to send ${send.channel === "chat" ? "chat messages" : "email"}.`);
      return { send, approval: (body.approval as string | undefined) ?? null };
    },
    limits: (stage) => [
      minuteLimit(`send:token:${stage.token.id}`, CONNECT_LIMITS.sendsPerTokenPerMinute, "this product"),
      // Unit 6: a job's drafts wait on the owner's page, so a flood can't hide the ones that matter.
      ...(stage.caller.job ? [dayLimit(`jobs-held:${stage.token.buildId ?? stage.token.productId}`, JOBS_LIMITS.heldPerProductPerDay, "this product's drafted messages")] : []),
    ],
    async work(ctx) {
      const { send } = ctx.args;
      // ---------- Wave 3, unit 6: a job's send never goes. The whole message waits for the owner (docs/CAPABILITIES.md, section 12) ----------
      if (ctx.caller.job && deps.holdSend) {
        { const ended = await jobRunRefusal(ctx, deps.jobRun); if (ended) return ended; }
        const id = await deps.holdSend({ productId: ctx.token.productId, namespace: ctx.namespace, send, lines: confirmationLines(send), title: SEND_TITLES[send.channel] });
        return json({ ok: false, code: "held_for_owner", id, ...(isBuild(ctx.token) ? { simulated: true } : {}) });
      }
      // ---------- end Wave 3, unit 6 ----------
      const scope = { productId: ctx.token.productId, subject: ctx.caller.owner ?? "owner", slug: `send:${send.channel}`, args: send };
      const confirm = (stale: boolean) =>
        json({ ok: false, code: "needs_confirmation", confirmation: { id: mintApproval(scope, ctx.now), title: SEND_TITLES[send.channel], lines: confirmationLines(send), args: send }, ...(stale ? { stale: true } : {}) });
      const approved = ctx.args.approval ? checkApproval(ctx.args.approval, scope, ctx.now) : null;
      if (!approved) return confirm(Boolean(ctx.args.approval));
      // A live send needs the owner's own key for this channel before anything is spent.
      const services = serviceForChannel(send.channel);
      let key: { service: Service; value: string; name: string } | null = null;
      if (!isBuild(ctx.token)) {
        const ring = deps.keyring();
        if (!ring) return paused();
        for (const service of services) {
          const sealed = await deps.store.sealedKey(ctx.token.productId, ctx.namespace, service.id);
          if (sealed && sealed.service === service.id) {
            key = { service, name: service.id, value: openSecret(sealed, ring, vaultAad(ctx.token.productId, ctx.namespace, service.id)) };
            break;
          }
        }
        if (!key) return needsKey(services[0]!, true);
      }
      // The day's count first, so hitting the limit doesn't burn the owner's confirmation; then the approval is spent,
      // once, right before the send. A spent approval gives its day slot back.
      const dayKey = `sends-day:${ctx.token.productId}:${ctx.namespace}`;
      const dayStart = dayWindow(ctx.now);
      if ((await deps.reserveCounter(dayKey, dayStart, 1, CONNECT_LIMITS.sendsPerProductPerDay)) === null) {
        return capError("rate_limited", `This product has sent its ${CONNECT_LIMITS.sendsPerProductPerDay} messages for today. It resets at 00:00 UTC.`);
      }
      if ((await deps.reserveCounter(`send-approval:${approved.nonce}`, approved.exp, 1, 1)) === null) {
        await deps.reserveCounter(dayKey, dayStart, -1, CONNECT_LIMITS.sendsPerProductPerDay);
        return confirm(true);
      }
      const record = {
        productId: ctx.token.productId,
        namespace: ctx.namespace,
        channel: send.channel,
        recipientHash: mac("send-recipients", [ctx.token.productId, ...send.to]).slice(0, 32),
        recipients: Math.max(1, send.to.length),
        approvalNonce: approved.nonce,
      };
      if (isBuild(ctx.token)) {
        const id = `sim_${randomId()}`;
        await deps.store.recordSend({ ...record, status: "simulated", providerId: id });
        await deps.recordUsage(...usage(ctx as CapContext<unknown>, "sends", "send", `send:${send.channel}`));
        return json({ ok: true, status: "sent", id, simulated: true });
      }
      const sent = await deliver(send, key!, deps);
      await deps.store.recordSend({ ...record, status: sent.ok ? "sent" : "failed", providerId: sent.ok ? sent.id : null });
      await deps.recordUsage(...usage(ctx as CapContext<unknown>, "sends", "send", `send:${send.channel}`));
      return sent.ok ? json({ ok: true, status: "sent", id: sent.id }) : capError("cap_failed", sent.message);
    },
  };
}

/** One message out, with the owner's own key. Never retried: a send that timed out may still have gone. */
async function deliver(send: SendArgs, key: { service: Service; value: string }, deps: ConnectDeps): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const signal = AbortSignal.timeout(CONNECT_LIMITS.sendTimeoutMs);
  try {
    if (key.service.id === "resend") {
      const res = await deps.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key.value}`, "content-type": "application/json", "user-agent": deps.userAgent },
        body: JSON.stringify({ from: send.from ?? "onboarding@resend.dev", to: send.to, subject: send.subject, text: send.body }),
        redirect: "manual",
        signal,
      });
      const reply = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (res.ok && typeof reply?.id === "string") return { ok: true, id: reply.id.slice(0, 80) };
      return { ok: false, message: res.status === 401 || res.status === 403 ? "Resend refused the owner's key. Check it in the key settings." : "Resend didn't send it. Nothing was sent." };
    }
    if (key.service.id === "slack_webhook") {
      const res = await deps.fetch(key.value, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": deps.userAgent },
        body: JSON.stringify({ text: send.body }),
        redirect: "manual",
        signal,
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok ? { ok: true, id: `slack_${randomId()}` } : { ok: false, message: res.status === 404 || res.status === 403 ? "Slack refused the webhook. Check it in the key settings." : "Slack didn't post it." };
    }
  } catch {
    return { ok: false, message: "The service didn't answer, so the message may not have gone. Check before sending it again." };
  }
  return { ok: false, message: "Products can't send that kind of message yet." };
}

// ---------- Wave 3, unit 6: a send a job left for the owner, confirmed on Muse Muse (docs/CAPABILITIES.md, section 12) ----------

/** What the owner's confirmation needs. The sends and vault switches, the owner's key and the day's count all still apply. */
export type HeldSendDeps = Pick<ConnectDeps, "store" | "sendsOn" | "keyring" | "reserveCounter" | "recordUsage" | "fetch" | "userAgent">;

export type HeldSendResult = { ok: true; id: string } | { ok: false; code: "sends_off" | "needs_key" | "day_limit" | "failed"; message: string; mayHaveGone?: boolean };

/**
 * Sends one held message, for the signed-in owner who just read it and pressed Confirm. `nonce` is the notice's id, so
 * product_sends' unique nonce holds it to one. Called once a notice is claimed.
 */
export async function deliverHeldSend(input: { productId: string; send: SendArgs; nonce: string; now: Date }, deps: HeldSendDeps): Promise<HeldSendResult> {
  const { productId, send, now } = input;
  if (!deps.sendsOn()) return { ok: false, code: "sends_off", message: "Sending is switched off on Muse Muse right now." };
  const ring = deps.keyring();
  if (!ring) return { ok: false, code: "sends_off", message: "The key vault is paused, so nothing can send right now." };
  const services = serviceForChannel(send.channel);
  let key: { service: Service; value: string; name: string } | null = null;
  for (const service of services) {
    const sealed = await deps.store.sealedKey(productId, "live", service.id);
    if (sealed && sealed.service === service.id) {
      key = { service, name: service.id, value: openSecret(sealed, ring, vaultAad(productId, "live", service.id)) };
      break;
    }
  }
  if (!key) return { ok: false, code: "needs_key", message: `Add a ${services[0]?.label ?? "sending"} key in the product's settings first.` };
  if ((await deps.reserveCounter(`sends-day:${productId}:live`, dayWindow(now), 1, CONNECT_LIMITS.sendsPerProductPerDay)) === null) {
    return { ok: false, code: "day_limit", message: `This product has sent its ${CONNECT_LIMITS.sendsPerProductPerDay} messages for today. Try again after 00:00 UTC.` };
  }
  const sent = await deliver(send, key, deps as ConnectDeps);
  await deps.store.recordSend({
    productId,
    namespace: "live",
    channel: send.channel,
    recipientHash: mac("send-recipients", [productId, ...send.to]).slice(0, 32),
    recipients: Math.max(1, send.to.length),
    approvalNonce: input.nonce,
    status: sent.ok ? "sent" : "failed",
    providerId: sent.ok ? sent.id : null,
  });
  await deps.recordUsage({ source: "sends", endpoint: "send", productId, buildId: null, tokenId: null } as UsageContext, [{ model: `send:${send.channel}`, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 }]);
  return sent.ok ? { ok: true, id: sent.id } : { ok: false, code: "failed", message: sent.message, mayHaveGone: true };
}
// ---------- end Wave 3, unit 6 ----------
