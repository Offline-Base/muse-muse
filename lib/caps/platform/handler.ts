import { randomBytes, randomUUID } from "node:crypto";
import { capError, dayWindow, readJsonBody, runCapGate, unknownEndpoint, unknownKeys, type CapContext, type CapGateDeps, type CapLimit, type CapRoute, type CapStage, type CapToken } from "@/lib/caps/gate";
import { handleCodeSessions, type MuseCodeDeps } from "@/lib/caps/code/musecode/handler";
import { MUSE_CODE_LIMITS, sessionSandboxWorstUsd } from "@/lib/caps/code/musecode/limits";
import { capMarker } from "@/lib/caps/ids";
import { POWER_LIMITS } from "@/lib/caps/platform/limits";
import type { PlatformBrief, Power } from "@/lib/caps/platform/brief";

/**
 * Platform powers (docs/PLATFORM_POWERS.md), behind the cap gate (lib/caps/gate.ts). A product built with a platform block
 * can act for its owner:
 *
 *   GET  {GATEWAY_URL}/platform                         its powers, today's limit and what it has committed
 *   POST {GATEWAY_URL}/platform/sandboxes               {task, files?}: a build task in a sandbox of its own
 *   ANY  {GATEWAY_URL}/platform/sandboxes/:id/:action   events, steer, stop, result
 *   POST {GATEWAY_URL}/platform/keys                    {label, budgetUsd, hours}: a metered model key, shown once
 *   POST {GATEWAY_URL}/platform/keys/:id/revoke
 *   POST {GATEWAY_URL}/platform/products                {note}: builds and publishes a product of its owner's
 *   GET  {GATEWAY_URL}/platform/products/:buildId       where that build is
 *
 * The limit is hard because each start commits its worst case, in one atomic counter, before anything happens: a session
 * ends at its budget, a key at its budget, and a build at its token's. Nothing is settled down later, so the day's
 * total can't be passed by calls racing or by a run going long. A product holds no platform secret at any point: it
 * sends its own PRODUCT_TOKEN, and the platform's keys stay on this side. Only the owner's signed pass gets in, a guest's
 * product is refused by the gate, and a product a power started can't use powers at all.
 *
 * A build's tests get `simulated: true` answers: no spend, no sandbox, no new product.
 */

const CENTS = 100;
const noStore = { "cache-control": "no-store" };
const json = (status: number, body: unknown) => Response.json(body, { status, headers: noStore });

export interface PlatformDeps extends CapGateDeps {
  briefPowers(token: CapToken): Promise<PlatformBrief | null>;
  /** True when this product was started by a power, so it has none itself. */
  isChildProduct(productId: string): Promise<boolean>;
  productDailyUsd: number;
  allDailyUsd: number;
  keyMaxUsd: number;
  buildUsd: number;
  /** lib/gateway/store.ts reserveCounter: adds only when the total stays within the limit, or null. */
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  counterValue(key: string, windowStart: Date): Promise<number>;
  /** Muse Code sessions' wiring, for the sandboxes power. */
  sessions(): MuseCodeDeps;
  /** The model a key may call. */
  keyModel(): string;
  storeKey(opts: { token: string; productId: string; model: string; budgetUsd: number; expiresAt: Date }): Promise<{ id: string }>;
  /** Revokes a key if it's this product's. False when it isn't. */
  revokeKey(productId: string, id: string, now: Date): Promise<boolean>;
  /** Queues and starts a build owned by the product's owner. An ok: false says why, in the build quota's words. */
  startBuild(input: { ownerId: string; productId: string; note: string }): Promise<{ ok: true; buildId: string } | { ok: false; status: number; error: string }>;
  /** A build this product started. Null for any other. */
  childBuild(productId: string, buildId: string): Promise<{ status: string; liveUrl: string | null; costUsd: number; error: string | null } | null>;
}

const usdKey = (productId: string) => `power:usd:${productId}`;
const ALL_USD_KEY = "power:usd:all";

interface Held {
  give(): Promise<void>;
}

/** Commits `usd` against the product's day and everyone's, or answers the refusal. Both or neither. */
async function commit(deps: PlatformDeps, productId: string, usd: number, now: Date): Promise<Held | Response> {
  const window = dayWindow(now);
  const cents = Math.ceil(usd * CENTS);
  if (deps.productDailyUsd <= 0 || deps.allDailyUsd <= 0) return capError("caps_paused", "Platform powers are paused on Muse Muse today.");
  const product = await deps.reserveCounter(usdKey(productId), window, cents, Math.floor(deps.productDailyUsd * CENTS));
  if (product === null) return capError("budget_exceeded", `This product has reached its $${deps.productDailyUsd} daily limit for platform powers. It resets at 00:00 UTC.`);
  const all = await deps.reserveCounter(ALL_USD_KEY, window, cents, Math.floor(deps.allDailyUsd * CENTS));
  if (all === null) {
    await deps.adjustCounter(usdKey(productId), window, -cents);
    return capError("budget_exceeded", "Muse Muse has reached today's limit for platform powers. It resets at 00:00 UTC.");
  }
  // The platform's own daily cap holds over powers too.
  if (deps.platformSpendToday && deps.dailySpendCapUsd !== undefined && (await deps.platformSpendToday()) + usd > deps.dailySpendCapUsd) {
    await deps.adjustCounter(usdKey(productId), window, -cents);
    await deps.adjustCounter(ALL_USD_KEY, window, -cents);
    return capError("budget_exceeded", "Muse Muse has reached its daily budget. Try again tomorrow.");
  }
  return {
    give: async () => {
      await deps.adjustCounter(usdKey(productId), window, -cents);
      await deps.adjustCounter(ALL_USD_KEY, window, -cents);
    },
  };
}

type Action =
  | { kind: "status" }
  | { kind: "sandbox_start" }
  | { kind: "sandbox_act"; path: string[] }
  | { kind: "key"; label: string; budgetUsd: number; hours: number }
  | { kind: "key_revoke"; id: string }
  | { kind: "product"; note: string }
  | { kind: "product_status"; buildId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which power a call needs, or null for the status call. */
function powerOf(action: Action): Power | null {
  if (action.kind === "sandbox_start" || action.kind === "sandbox_act") return "sandboxes";
  if (action.kind === "key" || action.kind === "key_revoke") return "gateway";
  if (action.kind === "product" || action.kind === "product_status") return "publish";
  return null;
}

async function readAction(req: Request, path: readonly string[], keyMaxUsd: number): Promise<Action | Response | null> {
  const [head, id, verb] = path;
  const method = req.method;
  if (path.length === 0) return method === "GET" ? { kind: "status" } : capError("invalid_arguments", "Use GET.");
  if (head === "sandboxes") {
    if (path.length === 1) return method === "POST" ? { kind: "sandbox_start" } : capError("invalid_arguments", "Use POST to start a sandbox.");
    return path.length === 3 ? { kind: "sandbox_act", path: [id!, verb!] } : null;
  }
  if (head === "keys") {
    if (path.length === 3 && verb === "revoke") {
      if (method !== "POST") return capError("invalid_arguments", "Use POST.");
      return id && UUID.test(id) ? { kind: "key_revoke", id } : capError("invalid_arguments", "That isn't a key's id.");
    }
    if (path.length !== 1) return null;
    if (method !== "POST") return capError("invalid_arguments", "Use POST to make a key.");
    const body = await readJsonBody(req, POWER_LIMITS.bodyMaxBytes);
    if (body instanceof Response) return body;
    const extra = unknownKeys(body, ["label", "budgetUsd", "hours"]);
    if (extra) return extra;
    const { label, budgetUsd, hours } = body;
    if (typeof label !== "string" || !label.trim() || label.length > POWER_LIMITS.labelMaxChars) return capError("invalid_arguments", `Send a label of at most ${POWER_LIMITS.labelMaxChars} characters.`);
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < POWER_LIMITS.keyMinUsd || budgetUsd > keyMaxUsd) return capError("invalid_arguments", `budgetUsd is a number from ${POWER_LIMITS.keyMinUsd} to ${keyMaxUsd}.`);
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > POWER_LIMITS.keyMaxHours) return capError("invalid_arguments", `hours is a number up to ${POWER_LIMITS.keyMaxHours}.`);
    return { kind: "key", label: label.trim(), budgetUsd, hours };
  }
  if (head === "products") {
    if (path.length === 2) {
      if (method !== "GET") return capError("invalid_arguments", "Use GET.");
      return id && UUID.test(id) ? { kind: "product_status", buildId: id } : capError("invalid_arguments", "That isn't a build's id.");
    }
    if (path.length !== 1) return null;
    if (method !== "POST") return capError("invalid_arguments", "Use POST to start a product.");
    const body = await readJsonBody(req, POWER_LIMITS.bodyMaxBytes);
    if (body instanceof Response) return body;
    const extra = unknownKeys(body, ["note"]);
    if (extra) return extra;
    if (typeof body.note !== "string" || !body.note.trim() || body.note.length > POWER_LIMITS.noteMaxChars) return capError("invalid_arguments", `Send what to build as text in \`note\`, at most ${POWER_LIMITS.noteMaxChars} characters.`);
    return { kind: "product", note: body.note.trim() };
  }
  return null;
}

export const POWER_KEY_PREFIX = "mm_pk_";

/** A random key. Only its hash is stored, as for every gateway token. */
function newKey(): string {
  return `${POWER_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The worst a sandbox can cost: its Meta budget and its sandbox's whole time. */
const sandboxWorstUsd = () => MUSE_CODE_LIMITS.sessionUsd + sessionSandboxWorstUsd(MUSE_CODE_LIMITS.sessionMs);

/**
 * The Muse Code sessions' deps for a product with the sandboxes power, which has no code block: the power's gate has
 * already held it to its brief, its owner and its limit, and the sessions' own gate then applies every other check.
 */
function sessionDepsFor(base: MuseCodeDeps): MuseCodeDeps {
  return {
    ...base,
    servedCaps: () => [...new Set([...base.servedCaps(), "code" as const])],
    findToken: async (raw) => {
      const token = await base.findToken(raw);
      return token ? { ...token, allowedModels: [...token.allowedModels, capMarker("code")] } : null;
    },
    product: async (id) => {
      const product = await base.product(id);
      return product ? { ...product, manifest: null } : null;
    },
    briefAllows: async () => true,
  };
}

async function simulated(action: Action): Promise<Response> {
  const id = randomUUID();
  switch (action.kind) {
    case "sandbox_start":
      return json(200, { simulated: true, id, status: "running" });
    case "sandbox_act":
      return json(200, { simulated: true, id: action.path[0], status: "completed", events: [], next: 0, costUsd: 0, worked: true, files: [] });
    case "key":
      return json(200, { simulated: true, id, key: "simulated-key", label: action.label, budgetUsd: action.budgetUsd, expiresAt: new Date(Date.now() + action.hours * 3_600_000).toISOString() });
    case "key_revoke":
      return json(200, { simulated: true, revoked: true });
    case "product":
      return json(200, { simulated: true, buildId: id, status: "queued" });
    case "product_status":
      return json(200, { simulated: true, buildId: action.buildId, status: "live", liveUrl: null, costUsd: 0, error: null });
    default:
      return unknownEndpoint("/platform");
  }
}

async function work(ctx: CapContext<Action>, deps: PlatformDeps, powers: PlatformBrief | null): Promise<Response> {
  const { args: action, token, now } = ctx;
  const window = dayWindow(now);
  if (action.kind === "status") {
    const committed = await deps.counterValue(usdKey(token.productId), window);
    return json(200, { powers, spentTodayUsd: committed / CENTS, dailyLimitUsd: deps.productDailyUsd, keyMaxUsd: deps.keyMaxUsd, simulated: token.scope === "build" });
  }
  if (token.scope === "build") return simulated(action);
  switch (action.kind) {
    case "sandbox_start": {
      const held = await commit(deps, token.productId, sandboxWorstUsd(), now);
      if (held instanceof Response) return held;
      const answer = await handleCodeSessions(ctx.req, [], sessionDepsFor(deps.sessions()));
      if (!answer.ok) await held.give();
      return answer;
    }
    case "sandbox_act":
      return handleCodeSessions(ctx.req, action.path, sessionDepsFor(deps.sessions()));
    case "key": {
      const held = await commit(deps, token.productId, action.budgetUsd, now);
      if (held instanceof Response) return held;
      const key = newKey();
      const expiresAt = new Date(now.getTime() + action.hours * 3_600_000);
      try {
        const { id } = await deps.storeKey({ token: key, productId: token.productId, model: deps.keyModel(), budgetUsd: action.budgetUsd, expiresAt });
        return json(200, { id, key, label: action.label, model: deps.keyModel(), budgetUsd: action.budgetUsd, expiresAt: expiresAt.toISOString() });
      } catch (err) {
        await held.give();
        throw err;
      }
    }
    case "key_revoke": {
      const revoked = await deps.revokeKey(token.productId, action.id, now);
      // What a revoked key had left stays counted for the day: its spending isn't known here, and the limit must hold.
      return revoked ? json(200, { revoked: true }) : capError("invalid_arguments", "There's no such key for this product.");
    }
    case "product": {
      const held = await commit(deps, token.productId, deps.buildUsd, now);
      if (held instanceof Response) return held;
      const started = await deps.startBuild({ ownerId: ctx.product.ownerId, productId: token.productId, note: action.note }).catch(async (err: unknown) => {
        await held.give();
        throw err;
      });
      if (!started.ok) {
        await held.give();
        return capError(started.status === 429 ? "quota_exceeded" : "caps_paused", started.status === 429 ? "The owner has reached today's build limit." : "New builds are paused on Muse Muse right now.");
      }
      return json(200, { buildId: started.buildId, status: "queued" });
    }
    case "product_status": {
      const build = await deps.childBuild(token.productId, action.buildId);
      return build ? json(200, { buildId: action.buildId, ...build }) : capError("invalid_arguments", "This product didn't start that build.");
    }
    default:
      return unknownEndpoint("/platform");
  }
}

/** Routes one call. A wrong path, or anything with the cap off, answers 404 and touches nothing. */
export function handlePlatform(req: Request, path: readonly string[], deps: PlatformDeps): Promise<Response> {
  let powers: PlatformBrief | null = null;
  // A sandbox call is read again by the sessions' own gate, so this gate reads a copy.
  const route: CapRoute<Action> = {
    cap: "platform",
    what: `/platform${path.length ? `/${path.join("/")}` : ""}`,
    scopes: ["build", "live"],
    allow: (stage: CapStage) => (stage.token.scope === "build" || (stage.caller.kind === "owner" && stage.caller.owner) ? null : capError("sign_in_required", "Only the product's owner can use this. Open the product as its owner from Muse Muse.")),
    async args({ req: r, token }) {
      const action = await readAction(r.clone(), path, deps.keyMaxUsd);
      if (action === null) return unknownEndpoint(`/platform/${path.join("/")}`);
      if (action instanceof Response) return action;
      powers = await deps.briefPowers(token);
      const need = powerOf(action);
      if (!powers || (need && !powers[need])) return capError("cap_not_allowed", need ? `This product wasn't built with the ${need} power.` : "This product wasn't built with platform powers.");
      return action;
    },
    limits(stage): CapLimit[] {
      const out: CapLimit[] = [{ key: `power:token:${stage.token.id}`, limit: POWER_LIMITS.perTokenPerMinute * (stage.args.kind === "sandbox_act" ? 24 : 1), window: "minute", who: "this product" }];
      if (stage.token.scope === "build") return out;
      const id = stage.token.productId;
      if (stage.args.kind === "sandbox_start") out.push({ key: `power:sandboxes:${id}`, limit: POWER_LIMITS.sandboxesPerDay, window: "day", who: "this product's sandboxes" });
      if (stage.args.kind === "key") out.push({ key: `power:keys:${id}`, limit: POWER_LIMITS.keysPerDay, window: "day", who: "this product's keys" });
      if (stage.args.kind === "product") out.push({ key: `power:products:${id}`, limit: POWER_LIMITS.productsPerDay, window: "day", who: "this product's new products" });
      return out;
    },
    async quota(ctx) {
      // A product a power started can't start more: powers never recurse.
      return (await deps.isChildProduct(ctx.token.productId)) ? capError("cap_not_allowed", "A product started by another product can't use platform powers.") : null;
    },
    work: (ctx) => work(ctx, deps, powers),
  };
  return runCapGate(req, deps, route);
}
