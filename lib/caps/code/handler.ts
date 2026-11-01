import { BROWSE_LIMITS, BROWSE_WORST_USD, EXEC_LIMITS, EXEC_WORST_USD, sandboxCostUsd } from "@/lib/caps/code/limits";
import { readBrowseArgs, runBrowse, type BrowseArgs } from "@/lib/caps/code/browse";
import { readExecArgs, runExec, type ExecArgs, type ExecOutcome } from "@/lib/caps/code/exec";
import { samplePageFor } from "@/lib/caps/code/pages";
import { browsePolicy, execPolicy } from "@/lib/caps/code/policy";
import type { LaunchSession } from "@/lib/caps/code/session";
import type { ExecRunRow } from "@/lib/caps/code/store";
import { capError, dayWindow, readJsonBody, runCapGate, type CapContext, type CapGateDeps, type CapLimit, type CapRoute, type CapStage, type CapWorkResult } from "@/lib/caps/gate";
import { subjectKey, type CapCaller } from "@/lib/caps/principal";
import { resolvesToPublic } from "@/lib/tools/args";
import type { ToolFixtures } from "@/lib/tools/ids";
import type { ModelUsage } from "@/lib/types";

/**
 * {GATEWAY_URL}/exec and {GATEWAY_URL}/browse (docs/CAPABILITIES.md, section 15), behind the cap gate (lib/caps/gate.ts).
 *
 * Who may (decision 10): the product's owner, and a build's own tests. Visitors and signed-in end users only for /exec
 * and only with CODE_EXEC_VISITORS, which stays off until the owner has read Meta's terms. Both routes need a product
 * made by a signed-in builder (CAP_NEEDS_BUILDER.code, the gate's check 4).
 *
 * Exec is real in a build too, at most 5 runs a build. Browse is a recorded page for a build (lib/caps/code/pages), since
 * a build reaches no other site.
 */

export interface CodeDeps extends CapGateDeps {
  /** CODE_EXEC and CODE_BROWSE, on top of the code cap being served. */
  execOn(): boolean;
  browseOn(): boolean;
  /** CODE_EXEC_VISITORS. */
  visitorsOn(): boolean;
  /** CODE_EXEC_DAILY_USD and CODE_BROWSE_DAILY_USD. 0 pauses. */
  execDailyUsd(): number;
  browseDailyUsd(): number;
  /** What each route spent across the platform today, reservations included. */
  spendToday(source: "exec" | "browse"): Promise<number>;
  /** CODE_EXEC_SNAPSHOT_ID, or null for Vercel's own image. */
  execSnapshotId(): string | null;
  /** The builder snapshot, which has Chromium. Null: browse isn't set up here. */
  browseSnapshotId(): string | null;
  launch: LaunchSession;
  recordRun(row: ExecRunRow): Promise<void>;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  /** Every address a host resolves to. Throws when it doesn't resolve. */
  lookupHost(host: string): Promise<string[]>;
  /** A build's own tool fixtures (builds.tool_fixtures), for `cap:code:browse`. */
  buildFixtures?(productId: string): Promise<ToolFixtures | null>;
  /** Milliseconds, for timing a sandbox. Date.now by default. */
  clock?(): number;
}

const OWNER_SPACE = "product-owner";
const isBuild = (stage: Pick<CapStage, "token">) => stage.token.scope === "build";

/** Who the run is for: build, owner, user or visitor, and their subject key (never a raw id). */
function whoRuns(stage: CapStage): { principal: ExecRunRow["principal"]; subject: string | null } {
  const { caller, token } = stage;
  if (isBuild(stage)) return { principal: "build", subject: null };
  if (caller.owner) return { principal: "owner", subject: subjectKey("owner", token.productId, OWNER_SPACE) };
  if (caller.user) return { principal: "user", subject: subjectKey("user", token.productId, caller.user) };
  return { principal: "visitor", subject: caller.visitor ? subjectKey("visitor", token.productId, caller.visitor) : null };
}

const ownerOnly = () => capError("sign_in_required", "Only the product's owner can use this. Open the product as its owner from Muse Muse.");

function mayRun(caller: CapCaller, build: boolean, visitors: boolean): boolean {
  return build || Boolean(caller.owner) || (visitors && Boolean(caller.user || caller.visitor));
}

function limitsFor(stage: CapStage, prefix: "exec" | "browse"): CapLimit[] {
  const per = prefix === "exec" ? EXEC_LIMITS : BROWSE_LIMITS;
  const limits: CapLimit[] = [{ key: `${prefix}:token:${stage.token.id}`, limit: per.perTokenPerMinute, window: "minute", who: "this product" }];
  if (isBuild(stage)) return limits;
  limits.push({ key: `${prefix}:product:${stage.token.productId}`, limit: per.perProductPerDay, window: "day", who: "this product" });
  const { subject } = whoRuns(stage);
  if (subject) limits.push({ key: `${prefix}:person:${stage.token.productId}:${subject}`, limit: per.perPersonPerDay, window: "day", who: "you" });
  return limits;
}

/** A build's own count, kept two days so the hourly prune of old windows keeps it for the whole build. */
async function buildQuota(ctx: CapContext<unknown>, deps: CodeDeps, prefix: "exec" | "browse", limit: number): Promise<Response | null> {
  if (!isBuild(ctx)) return null;
  const window = new Date(dayWindow(ctx.now).getTime() + 86_400_000);
  const left = await deps.reserveCounter(`${prefix}-build:${ctx.token.buildId}`, window, 1, limit);
  return left === null ? capError("rate_limited", `A build's tests can make ${limit} of these.`) : null;
}

const sandboxUsage = (model: string, costUsd: number): ModelUsage => ({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd });

const noStore = { "cache-control": "no-store" };

/** POST {GATEWAY_URL}/exec {language, code, stdin?, files?}. With CODE_EXEC or the code cap off: 404, nothing touched. */
export function handleExec(req: Request, deps: CodeDeps): Promise<Response> {
  return runCapGate(req, deps, execRoute(deps));
}

export function execRoute(deps: CodeDeps): CapRoute<ExecArgs> {
  return {
    cap: "code",
    what: "/exec",
    enabled: deps.execOn,
    allow: ({ caller, token }) => (mayRun(caller, token.scope === "build", deps.visitorsOn()) ? null : ownerOnly()),
    async args({ req }) {
      if (req.method !== "POST") return capError("invalid_arguments", "Use POST.");
      const body = await readJsonBody(req, EXEC_LIMITS.bodyMaxBytes);
      return body instanceof Response ? body : readExecArgs(body);
    },
    limits: (stage) => limitsFor(stage, "exec"),
    inFlight: (stage) => ({ key: `exec:product:${stage.token.productId}`, limit: EXEC_LIMITS.atOncePerProduct }),
    quota: (ctx) => buildQuota(ctx, deps, "exec", EXEC_LIMITS.perBuild),
    spend: {
      source: "exec",
      endpoint: "exec",
      model: "sandbox:exec",
      worstCaseUsd: () => EXEC_WORST_USD,
      get capDailyUsd() {
        return deps.execDailyUsd();
      },
      capSpendToday: () => deps.spendToday("exec"),
    },
    async work(ctx): Promise<CapWorkResult> {
      const clock = deps.clock ?? Date.now;
      const who = whoRuns(ctx);
      const row = (status: ExecRunRow["status"], ms: number, costUsd: number): ExecRunRow => ({
        productId: ctx.token.productId,
        namespace: ctx.namespace,
        kind: "exec",
        principal: who.principal,
        subjectKey: who.subject,
        language: ctx.args.language,
        status,
        ms,
        costUsd,
      });
      // The second limit on runs at once: all products together.
      const slot = deps.acquireInFlight ? await deps.acquireInFlight("exec:all", EXEC_LIMITS.atOnceInAll, ctx.now) : null;
      if (deps.acquireInFlight && !slot) return { response: capError("rate_limited", "Muse Muse is running as many programs as it can right now. Try again in a minute.", { "retry-after": "30" }) };
      const started = clock();
      let outcome: ExecOutcome | null = null;
      try {
        const session = await deps.launch({ purpose: "exec", snapshotId: deps.execSnapshotId(), networkPolicy: execPolicy(), vcpus: EXEC_LIMITS.vcpus, timeoutMs: (EXEC_LIMITS.runSeconds + 45) * 1000, productId: ctx.token.productId });
        try {
          outcome = await runExec(session, ctx.args);
        } finally {
          await session.stop();
        }
      } catch (err) {
        console.error("[caps] code /exec sandbox failed:", err instanceof Error ? err.message : "unknown");
      } finally {
        if (slot && deps.releaseInFlight) await deps.releaseInFlight("exec:all", slot).catch(() => undefined);
      }
      const wall = clock() - started;
      const cost = sandboxCostUsd(wall, EXEC_LIMITS.vcpus);
      await deps.recordRun(row(outcome?.status ?? "failed", outcome?.ms ?? 0, cost)).catch((err) => console.error("[caps] code exec_runs:", err instanceof Error ? err.message : "unknown"));
      if (!outcome) return { response: capError("cap_failed", "The program couldn't be started. Try again."), usage: sandboxUsage("sandbox:exec", cost) };
      return {
        response: Response.json(
          { status: outcome.status, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated, ms: outcome.ms },
          { headers: noStore },
        ),
        usage: sandboxUsage("sandbox:exec", cost),
      };
    },
  };
}

/** POST {GATEWAY_URL}/browse {url, input, actions?}. With CODE_BROWSE or the code cap off: 404, nothing touched. */
export function handleBrowse(req: Request, deps: CodeDeps): Promise<Response> {
  return runCapGate(req, deps, browseRoute(deps));
}

export function browseRoute(deps: CodeDeps): CapRoute<BrowseArgs> {
  return {
    cap: "code",
    what: "/browse",
    enabled: deps.browseOn,
    // Never visitors, whatever CODE_EXEC_VISITORS says.
    allow: ({ caller, token }) => (mayRun(caller, token.scope === "build", false) ? null : ownerOnly()),
    async args({ req }) {
      if (req.method !== "POST") return capError("invalid_arguments", "Use POST.");
      const body = await readJsonBody(req, BROWSE_LIMITS.bodyMaxBytes);
      return body instanceof Response ? body : readBrowseArgs(body);
    },
    limits: (stage) => limitsFor(stage, "browse"),
    // A build's page is recorded, so it holds nothing.
    inFlight: (stage) => (isBuild(stage) ? null : { key: "browse:all", limit: BROWSE_LIMITS.atOnceInAll }),
    quota: (ctx) => buildQuota(ctx, deps, "browse", BROWSE_LIMITS.perBuild),
    spend: {
      source: "browse",
      endpoint: "browse",
      model: "sandbox:browse",
      worstCaseUsd: (ctx) => (isBuild(ctx) ? 0 : BROWSE_WORST_USD),
      get capDailyUsd() {
        return deps.browseDailyUsd();
      },
      capSpendToday: () => deps.spendToday("browse"),
    },
    async work(ctx): Promise<CapWorkResult> {
      const who = whoRuns(ctx);
      const row = (status: ExecRunRow["status"], ms: number, costUsd: number): ExecRunRow => ({
        productId: ctx.token.productId,
        namespace: ctx.namespace,
        kind: "browse",
        principal: who.principal,
        subjectKey: who.subject,
        language: null,
        status,
        ms,
        costUsd,
      });
      const record = (r: ExecRunRow) => deps.recordRun(r).catch((err) => console.error("[caps] code exec_runs:", err instanceof Error ? err.message : "unknown"));

      if (isBuild(ctx)) {
        const { marker: _marker, ...page } = samplePageFor(ctx.args, await deps.buildFixtures?.(ctx.token.productId).catch(() => null));
        await record(row("simulated", 0, 0));
        return { response: Response.json({ ...page, simulated: true }, { headers: noStore }), usage: null };
      }

      const snapshotId = deps.browseSnapshotId();
      if (!snapshotId) return { response: capError("cap_failed", "Opening pages isn't set up on this Muse Muse site yet."), usage: null };
      let isPublic = false;
      try {
        isPublic = await resolvesToPublic(ctx.args.url, deps.lookupHost);
      } catch {
        return { response: capError("invalid_arguments", "That site couldn't be found."), usage: null };
      }
      if (!isPublic) return { response: capError("invalid_arguments", "That address isn't a public website."), usage: null };

      const clock = deps.clock ?? Date.now;
      const started = clock();
      let outcome: Awaited<ReturnType<typeof runBrowse>> | null = null;
      try {
        const session = await deps.launch({ purpose: "browse", snapshotId, networkPolicy: browsePolicy(ctx.args.host), vcpus: BROWSE_LIMITS.vcpus, timeoutMs: (BROWSE_LIMITS.seconds + 45) * 1000, productId: ctx.token.productId });
        try {
          outcome = await runBrowse(session, ctx.args);
        } finally {
          await session.stop();
        }
      } catch (err) {
        console.error("[caps] code /browse sandbox failed:", err instanceof Error ? err.message : "unknown");
      }
      const wall = clock() - started;
      const cost = sandboxCostUsd(wall, BROWSE_LIMITS.vcpus);
      await record(row(outcome?.ok ? "ok" : "failed", wall, cost));
      const usage = sandboxUsage("sandbox:browse", cost);
      if (!outcome) return { response: capError("cap_failed", "The page couldn't be opened. Try again."), usage };
      if (!outcome.ok || !outcome.page) return { response: capError("cap_failed", outcome.problem ?? "That page couldn't be opened."), usage };
      return { response: Response.json(outcome.page, { headers: noStore }), usage };
    },
  };
}
