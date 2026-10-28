/**
 * Helpers shared by the /api/train routes (docs/TRAINING.md "Routes"). Not a route: Next only serves route.ts files.
 */
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import type { LambdaInstanceType } from "@/lib/train/lambda";
import { RECIPES } from "@/lib/train/recipes";
import { verifyJobToken } from "@/lib/train/store";
import type { GpuOption, Recipe, RecipeView } from "@/lib/train/types";

/** True when LAMBDA_API_KEY is set. The value itself is never read here. */
export function lambdaConfigured(): boolean {
  return Boolean(process.env.LAMBDA_API_KEY);
}

/** Why the 5-minute sweep can't guard jobs started here, as sweepOffReason answers it. */
export type SweepOffReason = "cron_secret_unset" | "not_production";

/**
 * Why the 5-minute sweep (/api/cron/train-sweep) isn't guarding this deployment, or null when it is. It is the backstop
 * that terminates a GPU whose workflow died, so no job starts without it:
 * - "cron_secret_unset": without CRON_SECRET the sweep route answers 503 to every cron call.
 * - "not_production": Vercel runs crons only on the production deployment. TRAIN_ALLOW_OUTSIDE_PRODUCTION=1 lifts this
 *   for a deliberate test on a preview or a tunnel, where the admin calls the sweep with the CRON_SECRET themselves.
 */
export function sweepOffReason(): SweepOffReason | null {
  if (!env.cronSecret) return "cron_secret_unset";
  if (process.env.VERCEL_ENV !== "production" && process.env.TRAIN_ALLOW_OUTSIDE_PRODUCTION !== "1") {
    return "not_production";
  }
  return null;
}

/** The sweep counts as running while its last good run is at most this old: three missed 5-minute runs. */
export const SWEEP_FRESH_MS = 15 * 60_000;

/**
 * True when the 5-minute sweep last ran with Lambda's listing answering (lib/train/store.ts recordSweepOk, given here
 * as `lastOkAt`) within SWEEP_FRESH_MS of `now`. sweepOffReason says the sweep can run here; this says it does. It
 * catches a cron Vercel isn't calling (crons turned off, or a plan that runs them once a day) and a sweep that keeps
 * failing. A new deployment starts jobs once the first sweep ran, within 5 minutes, or after the admin calls
 * /api/cron/train-sweep once by hand with the CRON_SECRET.
 */
export function sweepRunning(lastOkAt: Date | null, now: Date): boolean {
  return lastOkAt !== null && now.getTime() - lastOkAt.getTime() <= SWEEP_FRESH_MS;
}

/**
 * The public host of the Blob store BLOB_READ_WRITE_TOKEN belongs to ("<store id>.public.blob.vercel-storage.com",
 * lowercase), from the token's "vercel_blob_rw_<store id>_<secret>" shape, as @vercel/blob reads it. Null without a
 * token or with one of another shape. The secret part is never returned.
 */
export function blobPublicHost(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN ?? "";
  const storeId = token.startsWith("vercel_blob_rw_") ? (token.split("_")[3] ?? "") : "";
  return /^[A-Za-z0-9-]+$/.test(storeId) ? `${storeId.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/** Longer than any URL an upload grant can produce (the upload route's pathname is under 200 characters). */
const BLOB_URL_MAX = 512;

/**
 * `url` as stored, when it is a file this job uploaded: https on this deployment's Blob store, under models/<jobId>/,
 * with no credentials, port, query or fragment. Null for anything else (another host, another job's folder, no
 * BLOB_READ_WRITE_TOKEN), so an artifact link on the job page can only open the job's own upload.
 */
export function jobBlobUrl(url: string, jobId: string): string | null {
  const host = blobPublicHost();
  if (!host || url.length > BLOB_URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const folder = `/models/${jobId.toLowerCase()}/`;
  const ok =
    u.protocol === "https:" &&
    u.hostname === host &&
    !u.username &&
    !u.password &&
    !u.port &&
    !u.search &&
    !u.hash &&
    u.pathname.startsWith(folder) &&
    u.pathname.length > folder.length;
  return ok ? u.href : null;
}

/** A recipe without its script, for the admin page. */
export function recipeView(recipe: Recipe): RecipeView {
  const { script: _script, ...view } = recipe;
  return view;
}

/**
 * The GPU types the given recipes can use, in recipe order, with Lambda's price and the regions that have capacity
 * right now. A type Lambda doesn't list shows the recipe's label, no price and no regions.
 */
export function gpuOptions(types: LambdaInstanceType[], recipes: Recipe[] = RECIPES): GpuOption[] {
  const byName = new Map(types.map((t) => [t.name, t]));
  const options = new Map<string, GpuOption>();
  for (const recipe of recipes) {
    for (const choice of recipe.gpus) {
      const known = options.get(choice.instanceType);
      if (known) {
        if (!known.recipes.includes(recipe.id)) known.recipes.push(recipe.id);
        continue;
      }
      const type = byName.get(choice.instanceType);
      options.set(choice.instanceType, {
        instanceType: choice.instanceType,
        description: type?.description || choice.label,
        priceCentsPerHour: type?.priceCentsPerHour ?? 0,
        regions: type?.regionsWithCapacity ?? [],
        recipes: [recipe.id],
      });
    }
  }
  return [...options.values()];
}

/**
 * Checks "Authorization: Bearer <job token>" for this job (verifyJobToken: the stored hash, and no later than 15
 * minutes after the job ended). Throws HttpError 401 otherwise. The instance's runner is the only caller; it has no
 * session, and nothing in front of these routes asks for one.
 */
export async function requireJobToken(req: Request, jobId: string): Promise<void> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !(await verifyJobToken(jobId, token))) throw new HttpError(401, "unauthorized");
}

/** The platform's ceilings on one job's limits (TRAIN_JOB_MAX_MINUTES, TRAIN_JOB_MAX_USD). */
export function limitCeilings(): { maxMinutes: number; maxUsd: number } {
  return { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd };
}
