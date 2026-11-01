import { createHash, timingSafeEqual } from "node:crypto";
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
  type CapRoute,
  type CapStage,
  type CapToken,
} from "@/lib/caps/gate";
import { allowedCapIds } from "@/lib/caps/manifest";
import { CAP_NEEDS_BUILDER } from "@/lib/caps/ids";
import { JOB_NAME, JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { JOB_HEADER } from "@/lib/caps/principal";
import { jobNotRunning, jobRunRefusal } from "@/lib/caps/jobs/run-check";
import type { JobRun, JobsStore } from "@/lib/caps/jobs/store";
import { mintJobToken, readJobToken } from "@/lib/caps/jobs/token";
import { gatewayError } from "@/lib/gateway/errors";
import { randomId } from "@/lib/tools/sign";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";

/**
 * {GATEWAY_URL}/jobs/* and /hooks/* (docs/CAPABILITIES.md, section 12), behind the cap gate (lib/caps/gate.ts).
 *
 * - /jobs/verify and /jobs/checkpoint: the product's handler proving the call came from the platform, and closing a tick.
 * - /jobs/notify: an owner notice, from a job.
 * - /jobs/enqueue: a run for the next tick, asked for by the owner or a job. Decision 10 keeps visitors off, so a
 *   visitor's or a signed-in person's call is refused, whatever the product's code does.
 * - /jobs/test-fire: a build's job token for the test to call the product's own route.
 * - /hooks/<productId>/<name>?k=<secret>: anyone with the secret stores a payload and queues the named job.
 *
 * Cron-started ticks are in lib/caps/jobs/cron.ts, model calls' dollars in lib/caps/jobs/budget.ts, and a job's held send
 * in lib/caps/connect/handler.ts.
 */

export interface JobsDeps extends CapGateDeps {
  store: JobsStore;
  /** JOBS_WEBHOOKS. */
  webhooksOn(): boolean;
  /** JOBS_RUN_USD, at most $0.50. */
  runUsd(): number;
  /** JOBS_PAUSE_DAYS: past this with no visit from the owner, a job can't queue more. */
  pauseDays(): number;
  /** The public {GATEWAY_URL}, for a build's test hook address. */
  gatewayUrl: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const dayLimit = (key: string, limit: number, who: string): CapLimit => ({ key, limit, window: "day", who });
const notRunning = jobNotRunning;
const ownerAwayRefusal = () => capError("cap_not_allowed", "This product's background jobs are paused until its owner visits it on Muse Muse.");
const queueFull = () => capError("rate_limited", `This product has ${JOBS_LIMITS.queuedPerProduct} background jobs waiting already. Try again later.`, { "retry-after": "300" });
const tickOver = () => gatewayError(409, "invalid_request_error", "job_not_running", "This tick of the job is over, so nothing changed.", { retry: false });
const jobOnly = (stage: CapStage) => (stage.caller.job ? null : capError("sign_in_required", "Only the platform's call to a job can do this. It needs the x-musemuse-job header."));

/** The run a job token names, on this namespace and product. A build's runs are never a live token's. */
async function runOf(ctx: CapContext<unknown>, deps: JobsDeps): Promise<JobRun | Response> {
  const run = await deps.store.getRun(ctx.caller.job!);
  if (!run || run.productId !== ctx.token.productId || run.namespace !== ctx.namespace) return capError("cap_not_allowed", "That job token isn't for this product.");
  return run;
}

/** Serves everything under {GATEWAY_URL}/jobs. */
export async function handleJobs(req: Request, path: readonly string[], deps: JobsDeps): Promise<Response> {
  const [what, extra] = path;
  if (extra !== undefined || req.method !== "POST") return unknownEndpoint(`/jobs${path.length ? `/${path.join("/")}` : ""}`);
  switch (what) {
    case "verify":
      return runCapGate(req, deps, verifyRoute(deps));
    case "checkpoint":
      return runCapGate(req, deps, checkpointRoute(deps));
    case "enqueue":
      return runCapGate(req, deps, enqueueRoute(deps));
    case "notify":
      return runCapGate(req, deps, notifyRoute(deps));
    case "test-fire":
      return runCapGate(req, deps, testFireRoute(deps));
    default:
      return unknownEndpoint("/jobs");
  }
}

function verifyRoute(deps: JobsDeps): CapRoute<Record<string, never>> {
  return {
    cap: "jobs",
    what: "/jobs/verify",
    allow: jobOnly,
    async args(stage) {
      const body = await readJsonBody(stage.req, 1024);
      if (body instanceof Response) return body;
      return unknownKeys(body, []) ?? {};
    },
    async work(ctx) {
      const run = await runOf(ctx as CapContext<unknown>, deps);
      if (run instanceof Response) return run;
      if (run.status !== "running") return notRunning(run.status);
      if (run.costUsd >= run.budgetUsd) return capError("run_limit", "This run has used its dollars.");
      return json({ runId: run.id, name: run.name, tick: run.tick, input: run.input ?? null, checkpoint: run.checkpoint ?? null, budgetUsd: run.budgetUsd, ...(run.namespace === "live" ? {} : { simulated: true }) });
    },
  };
}

interface CheckpointArgs {
  state: unknown;
  done: boolean;
  error: string | null;
}

function checkpointRoute(deps: JobsDeps): CapRoute<CheckpointArgs> {
  return {
    cap: "jobs",
    what: "/jobs/checkpoint",
    allow: jobOnly,
    async args(stage) {
      const body = await readJsonBody(stage.req, JOBS_LIMITS.checkpointMaxBytes + 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["state", "done", "error"]);
      if (extra) return extra;
      if (body.state !== undefined && Buffer.byteLength(JSON.stringify(body.state)) > JOBS_LIMITS.checkpointMaxBytes) return capError("invalid_arguments", "A checkpoint holds at most 64 KB. Save big things with data() and keep their ids here.");
      if (typeof body.done !== "boolean") return capError("invalid_arguments", "done is true when the run has finished, or false for the next tick to go on.");
      if (body.error !== undefined && body.error !== null && typeof body.error !== "string") return capError("invalid_arguments", "error is one line of plain text.");
      return { state: body.state ?? null, done: body.done, error: typeof body.error === "string" ? body.error.replace(/\s+/g, " ").trim().slice(0, 300) || "It failed." : null };
    },
    async work(ctx) {
      const run = await runOf(ctx as CapContext<unknown>, deps);
      if (run instanceof Response) return run;
      // The tick and try this token was minted for: a late answer from an earlier one changes nothing.
      const held = readJobToken(ctx.req.headers.get(JOB_HEADER), ctx.token, ctx.now);
      if (!held) return capError("cap_not_allowed", "That job token isn't for this product.");
      const status = await deps.store.closeTick(run.id, { tick: held.tick, attempt: held.attempt, state: ctx.args.state, done: ctx.args.done, error: ctx.args.error, maxTicks: JOBS_LIMITS.ticksPerRun }, ctx.now);
      if (status === "stale") return tickOver();
      if (status === "failed" && run.namespace === "live") {
        await deps.store.addNotice({ productId: run.productId, namespace: run.namespace, kind: "job_failed", title: `Job ${run.name} failed`, body: ctx.args.error ?? `It used all of its ${JOBS_LIMITS.ticksPerRun} ticks.` });
      }
      return json({ ok: true, status, tick: run.tick });
    },
  };
}

interface EnqueueArgs {
  name: string;
  input: unknown;
}

function enqueueRoute(deps: JobsDeps): CapRoute<EnqueueArgs> {
  return {
    cap: "jobs",
    what: "/jobs/enqueue",
    // Decision 10: owner products only, and visitors stay off until the Meta terms question is answered.
    allow: ({ caller }) => (caller.owner || caller.job ? null : capError("sign_in_required", "Only the product's owner can start a background job.")),
    async args(stage) {
      const body = await readJsonBody(stage.req, JOBS_LIMITS.inputMaxBytes + 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["name", "input"]);
      if (extra) return extra;
      if (typeof body.name !== "string" || !JOB_NAME.test(body.name)) return capError("invalid_arguments", "name is the job's route: lowercase letters, digits and dashes.");
      if (body.input !== undefined && Buffer.byteLength(JSON.stringify(body.input)) > JOBS_LIMITS.inputMaxBytes) return capError("invalid_arguments", "A job's input holds at most 64 KB.");
      return { name: body.name, input: body.input ?? null };
    },
    limits: (stage) => [dayLimit(`jobs-enqueue:${stage.token.buildId ?? stage.token.productId}`, JOBS_LIMITS.enqueuePerProductPerDay, "this product's background jobs")],
    async work(ctx) {
      const ended = await jobRunRefusal(ctx, deps.store.getRun);
      if (ended) return ended;
      if (deps.runUsd() === 0) return capError("caps_paused", "Background jobs are paused on Muse Muse today.");
      // Nobody present: a job can't keep itself going past the owner's 14 days. An owner's pass means they came.
      if (ctx.caller.job && ctx.namespace === "live" && (await deps.store.ownerAway(ctx.token.productId, deps.pauseDays(), ctx.now))) return ownerAwayRefusal();
      if ((await deps.store.queuedCount(ctx.token.productId, ctx.namespace)) >= JOBS_LIMITS.queuedPerProduct) return queueFull();
      const runId = await deps.store.queueRun({ productId: ctx.token.productId, namespace: ctx.namespace, name: ctx.args.name, trigger: "enqueue", input: ctx.args.input, budgetUsd: deps.runUsd() });
      return json({ ok: true, runId, status: "queued" }, 202);
    },
  };
}

interface NotifyArgs {
  title: string;
  body: string;
}

const line = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

function notifyRoute(deps: JobsDeps): CapRoute<NotifyArgs> {
  return {
    cap: "jobs",
    what: "/jobs/notify",
    allow: jobOnly,
    async args(stage) {
      const body = await readJsonBody(stage.req, 8 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["title", "body"]);
      if (extra) return extra;
      if (typeof body.title !== "string" || !line(body.title, JOBS_LIMITS.noticeTitleMax)) return capError("invalid_arguments", "A notice needs a title.");
      if (body.body !== undefined && typeof body.body !== "string") return capError("invalid_arguments", "A notice's body is text.");
      return { title: line(body.title, JOBS_LIMITS.noticeTitleMax), body: typeof body.body === "string" ? body.body.trim().slice(0, JOBS_LIMITS.noticeBodyMax) : "" };
    },
    limits: (stage) => [dayLimit(`jobs-notify:${stage.token.buildId ?? stage.token.productId}`, JOBS_LIMITS.notifyPerProductPerDay, "this product's notices to its owner")],
    async work(ctx) {
      const run = await runOf(ctx as CapContext<unknown>, deps);
      if (run instanceof Response) return run;
      if (run.status !== "running") return notRunning(run.status);
      const id = await deps.store.addNotice({ productId: run.productId, namespace: run.namespace, kind: "job", title: ctx.args.title, body: ctx.args.body });
      return json({ ok: true, id, ...(run.namespace === "live" ? {} : { simulated: true }) });
    },
  };
}

type TestFireArgs = { name: string; input: unknown; hook: boolean };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function testFireRoute(deps: JobsDeps): CapRoute<TestFireArgs> {
  return {
    cap: "jobs",
    what: "/jobs/test-fire",
    scopes: ["build"],
    async args(stage) {
      const body = await readJsonBody(stage.req, JOBS_LIMITS.inputMaxBytes + 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["name", "input", "hook"]);
      if (extra) return extra;
      if (typeof body.name !== "string" || !JOB_NAME.test(body.name)) return capError("invalid_arguments", "name is the job's route: lowercase letters, digits and dashes.");
      if (body.input !== undefined && Buffer.byteLength(JSON.stringify(body.input)) > JOBS_LIMITS.inputMaxBytes) return capError("invalid_arguments", "A job's input holds at most 64 KB.");
      return { name: body.name, input: body.input ?? null, hook: body.hook === true };
    },
    limits: (stage) => [dayLimit(`jobs-test-fire:${stage.token.buildId}`, JOBS_LIMITS.testFiresPerBuild, "this build's test jobs")],
    async work(ctx) {
      if (ctx.args.hook) {
        if (!deps.webhooksOn()) return capError("cap_not_allowed", "Webhooks are switched off on Muse Muse right now.");
        const secret = randomId();
        await deps.store.saveTestWebhook(ctx.token.productId, ctx.namespace, ctx.args.name, sha256(secret));
        return json({ hook: { url: `${deps.gatewayUrl.replace(/\/+$/, "")}/hooks/${ctx.token.productId}/${ctx.args.name}?k=${secret}&b=${ctx.token.buildId}` }, simulated: true });
      }
      const run = await deps.store.fireTest({ productId: ctx.token.productId, namespace: ctx.namespace, name: ctx.args.name, input: ctx.args.input, budgetUsd: Math.max(deps.runUsd(), 0.01) }, ctx.now);
      const token = mintJobToken({ productId: ctx.token.productId, runId: run.id, tick: run.tick, attempt: run.attempt, buildId: ctx.token.buildId, expiresAt: new Date(ctx.now.getTime() + JOBS_LIMITS.tokenMs) });
      return json({ token, runId: run.id, tick: run.tick, simulated: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks

export interface HookDeps extends Pick<CapGateDeps, "servedCaps" | "product" | "hitRateLimits" | "adminEmails" | "now"> {
  store: Pick<JobsStore, "findWebhook" | "findTestWebhook" | "queueRun" | "ownerAway" | "queuedCount">;
  webhooksOn(): boolean;
  runUsd(): number;
  pauseDays(): number;
  /** The live token's markers, for "this product was built with jobs". */
  liveToken(productId: string): Promise<Pick<CapToken, "scope" | "allowedModels"> | null>;
}

const sameHash = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

const wrongHook = () => gatewayError(401, "authentication_error", "invalid_hook", "That webhook address isn't right, or it was replaced.", { retry: false });

async function readCappedBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Serves POST {GATEWAY_URL}/hooks/<productId>/<name>?k=<secret>. */
export async function handleHook(req: Request, path: readonly string[], deps: HookDeps): Promise<Response> {
  if (!deps.servedCaps().includes("jobs") || !deps.webhooksOn()) return unknownEndpoint("/hooks");
  const [productId, name, extra] = path;
  if (req.method !== "POST" || !productId || !name || extra !== undefined || !JOB_NAME.test(name)) return unknownEndpoint("/hooks");
  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get("k") ?? "";
    const buildId = url.searchParams.get("b");
    const hook = buildId ? await deps.store.findTestWebhook(productId, buildId, name) : await deps.store.findWebhook(productId, name);
    if (!secret || !hook || !sameHash(hook.secretHash, sha256(secret))) return wrongHook();
    const product = await deps.product(productId);
    if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) {
      return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
    }
    const tier = builderTier({ email: product.ownerEmail, isAdmin: product.ownerIsAdmin && deps.adminEmails.includes(product.ownerEmail), bannedAt: product.ownerBannedAt });
    if (CAP_NEEDS_BUILDER.jobs && !tierMayUseBuilderCaps(tier)) return capError("sign_in_required", "This service needs a product made by someone signed in to Muse Muse.");
    if (!buildId) {
      const token = await deps.liveToken(productId);
      if (!token || !allowedCapIds(token, product.manifest).includes("jobs")) return capError("cap_not_allowed", "This product wasn't built with background jobs.");
    }
    const now = deps.now?.() ?? new Date();
    if (!buildId && (await deps.store.ownerAway(productId, deps.pauseDays(), now))) return ownerAwayRefusal();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const inMinute = await deps.hitRateLimits([`hook:${hook.id}`], minute);
    if ((inMinute[`hook:${hook.id}`] ?? 0) > JOBS_LIMITS.hookPerMinute) return capError("rate_limited", `This webhook takes ${JOBS_LIMITS.hookPerMinute} calls a minute. Try again in a minute.`, { "retry-after": "60" });
    const inDay = await deps.hitRateLimits([`hook-day:${hook.id}`], dayWindow(now));
    if ((inDay[`hook-day:${hook.id}`] ?? 0) > JOBS_LIMITS.hookPerDay) return capError("rate_limited", `This webhook takes ${JOBS_LIMITS.hookPerDay} calls a day. It resets at 00:00 UTC.`);
    if ((await deps.store.queuedCount(productId, hook.namespace)) >= JOBS_LIMITS.queuedPerProduct) return queueFull();
    const raw = await readCappedBody(req, JOBS_LIMITS.hookBodyMaxBytes);
    if (raw === null) return capError("invalid_arguments", "A webhook's payload is at most 64 KB.");
    const text = new TextDecoder().decode(raw);
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the job gets the text.
    }
    if (deps.runUsd() === 0) return capError("caps_paused", "Background jobs are paused on Muse Muse today.");
    await deps.store.queueRun({ productId, namespace: hook.namespace, name, trigger: "webhook", webhookId: hook.id, input: { payload, receivedAt: now.toISOString() }, budgetUsd: Math.max(deps.runUsd(), 0.01) });
    return json({ ok: true, queued: true }, 202);
  } catch (err) {
    console.error("[jobs] hook failed:", err instanceof Error ? err.message : "unknown");
    return capError("cap_failed", "The platform service hit an unexpected error. Try again.");
  }
}
