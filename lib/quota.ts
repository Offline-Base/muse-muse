import { existsSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import type { SessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { fileStorageAvailable } from "@/lib/local-files";
import { ADULT_COOKIE, trustBuildRefusal, type TrustBuildRefusal } from "@/lib/trust/account";
import { platformSpendToday } from "@/lib/usage";

/** Builds count against a user's quota for 24 hours after they start. */
export const QUOTA_WINDOW_MS = 24 * 3_600_000;

/**
 * builds.workflow_run_id of a build imported from a local run (lib/promote/store.ts). It ran on a laptop, not here, so
 * it never counts against the quota of the guest account it belongs to on the live site. attachRun is the only other
 * writer of the column, and the build API never sends it.
 */
export const IMPORTED_RUN = "imported";

export function quotaWindowStart(now: Date): Date {
  return new Date(now.getTime() - QUOTA_WINDOW_MS);
}

/**
 * Builds per rolling 24 hours for anyone who isn't an admin: MAX_BUILDS_PER_USER_PER_DAY, read on every check so a
 * change reaches everyone at once. users.daily_build_quota is not read. signIn copies the env value into it only when
 * the row is created and nothing ever changes it, so it can't tell an admin's override from a stale copy, and trusting
 * it kept a raised limit from reaching anyone who had already signed in.
 */
export function dailyBuildQuota(): number {
  return env.maxBuildsPerUserPerDay;
}

/** Admins are exempt. Everyone else may start `quota` builds per rolling 24 hours. */
export function quotaDecision(input: { isAdmin: boolean; quota: number; used: number }): {
  allowed: boolean;
  remaining: number | null;
} {
  if (input.isAdmin) return { allowed: true, remaining: null };
  const remaining = Math.max(0, input.quota - input.used);
  return { allowed: remaining > 0, remaining };
}

export function spendPausedDecision(spentUsd: number, capUsd: number): boolean {
  return spentUsd >= capUsd;
}

/** Builds of any kind (new builds and refinements) the user started on this site since `since`. Imported ones don't count. */
export async function buildsStartedSince(userId: string, since: Date): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.builds)
    .where(
      and(
        eq(schema.builds.userId, userId),
        gte(schema.builds.startedAt, since),
        or(isNull(schema.builds.workflowRunId), ne(schema.builds.workflowRunId, IMPORTED_RUN)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** True when today's platform-wide Meta spend has reached DAILY_SPEND_CAP_USD. */
export async function spendPaused(): Promise<boolean> {
  return spendPausedDecision(await platformSpendToday(), env.dailySpendCapUsd);
}

/** Environment variables, process.env by default. */
type EnvSource = Record<string, string | undefined>;

/** Why this machine can't run a build at all, before anything is paid for. */
export type BuildSetupRefusal = { ok: false; status: 503; error: "no_model_key" | "no_sandbox" };

/**
 * True when @vercel/sandbox can find credentials the way the build code calls it. lib/sandbox/builder.ts (and the
 * restore, edge and caps sessions) call Sandbox.create, getOrCreate and get with no token, so the SDK falls back to
 * Vercel OIDC (@vercel/sandbox utils/get-credentials.js, then @vercel/oidc getVercelOidcToken), which reads, in order:
 *   - the request's x-vercel-oidc-token header, which Vercel adds to function calls on a project with OIDC on, as
 *     production's builds already rely on. So on Vercel (VERCEL=1) this check passes, and production is never refused
 *   - the file named by VERCEL_OIDC_TOKEN_FILE
 *   - VERCEL_OIDC_TOKEN (from `npx vercel env pull`)
 *   - with no token or an expired one, a refresh through the Vercel CLI login for the project in the nearest folder
 *     above the working directory that has a .vercel folder, from .vercel/project.json (`npx vercel link`)
 * VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID is not on that list: only the native packager passes them
 * (lib/native/packager.ts sandboxCredentials), so a build with only those would still fail at Provision. The SDK's
 * interactive device sign-in (a terminal prompt in the server's log) isn't counted either.
 */
export function sandboxCredentialsAvailable(source: EnvSource = process.env, cwd: string = process.cwd()): boolean {
  if (source.VERCEL) return true;
  const context = (globalThis as Record<symbol, { get?: () => { headers?: Record<string, string | undefined> } } | undefined>)[
    Symbol.for("@vercel/request-context")
  ];
  if (context?.get?.()?.headers?.["x-vercel-oidc-token"]) return true;
  if (source.VERCEL_OIDC_TOKEN_FILE?.trim() || source.VERCEL_OIDC_TOKEN?.trim()) return true;
  return linkedProject(cwd);
}

/** The same search @vercel/oidc's refresh makes: the nearest folder up from `cwd` with .vercel, then its project.json. */
function linkedProject(cwd: string): boolean {
  let dir = path.resolve(cwd);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, ".vercel"))) return existsSync(path.join(dir, ".vercel", "project.json"));
    dir = path.dirname(dir);
  }
  return false;
}

/**
 * no_model_key when MODEL_API_KEY is empty (the brief, the first step, would fail), no_sandbox when Vercel Sandbox has
 * no credentials (Provision would fail after the brief was paid for). Null when both are there, as on production.
 */
export function buildSetupRefusal(source: EnvSource = process.env, cwd: string = process.cwd()): BuildSetupRefusal | null {
  if (!source.MODEL_API_KEY?.trim()) return { ok: false, status: 503, error: "no_model_key" };
  if (!sandboxCredentialsAvailable(source, cwd)) return { ok: false, status: 503, error: "no_sandbox" };
  return null;
}

export type BuildAllowance =
  | { ok: true }
  | { ok: false; status: 429 | 503; error: "daily_limit" | "shared_limit" | "paused" | "no_storage" }
  | BuildSetupRefusal
  // Wave 3, unit 1: a ban, an unconfirmed 18+ or the builder's daily dollars, with a plain sentence (lib/trust/account.ts).
  | TrustBuildRefusal;

/**
 * The spend cap applies to everyone. The daily quota applies to everyone but admins. The shared guest (OPEN_ACCESS=guest)
 * gets "shared_limit" instead of "daily_limit", since the builds that used it up were usually someone else's.
 */
export async function checkBuildAllowed(user: SessionUser): Promise<BuildAllowance> {
  // Every build stores screenshots and a demo, so without file storage it would run for minutes and then fail.
  // BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID counts (lib/local-files.ts fileStorageAvailable).
  if (!fileStorageAvailable()) return { ok: false, status: 503, error: "no_storage" };
  // A build with no Meta key or no Sandbox credentials would fail at the brief or at Provision, the second after the
  // brief was already paid for. Both are set on production, so this never refuses there.
  const setup = buildSetupRefusal();
  if (setup) return setup;
  if (await spendPaused()) return { ok: false, status: 503, error: "paused" };
  // ---------- Wave 3, unit 1: trust (docs/CAPABILITIES.md, section 7). Reads nothing with its flags off ----------
  const refused = await trustBuildRefusal(user, async () => (await cookies()).get(ADULT_COOKIE)?.value ?? null);
  if (refused) return refused;
  if (user.isAdmin) return { ok: true };
  const used = await buildsStartedSince(user.id, quotaWindowStart(new Date()));
  // Admin sessions returned above. users.is_admin can be true for an admin's shared-code session, which isn't admin.
  const decision = quotaDecision({ isAdmin: false, quota: dailyBuildQuota(), used });
  if (decision.allowed) return { ok: true };
  return { ok: false, status: 429, error: user.openAccess ? "shared_limit" : "daily_limit" };
}
