/**
 * A "both" request's app and model (docs/TRAINING.md "One box for everything"): the build and the run are kept as a pair
 * in rate_limits, no migration, under the window that never starts. Ids only. A run pairs with one build. Who may see a
 * pair is decided on reading (pairedRunFor), since a build room is public and a run isn't.
 */
import { and, eq, like } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { offersOwnModel } from "@/lib/train/tune/from-build";
import { productDay } from "@/lib/train/tune/start";
import { readRunProduct, saveRunAutoPublish, saveRunProduct, TUNE_KEEP_WINDOW } from "@/lib/train/tune/run-store";
import type { Brief } from "@/lib/brief/schema";
import type { RunCaller } from "@/lib/train/tune/caller";

const limits = schema.rateLimits;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isPairId = (id: unknown): id is string => typeof id === "string" && UUID_RE.test(id);

const pairKey = (buildId: string, runId: string) => `make-pair:${buildId.toLowerCase()}:${runId.toLowerCase()}`;
const runKey = (runId: string) => `make-pair-run:${runId.toLowerCase()}`;

/** The build a run is paired with, or null. */
export async function pairOfRun(runId: string): Promise<string | null> {
  const [row] = await db()
    .select({ key: limits.key })
    .from(limits)
    .where(and(like(limits.key, `make-pair:%:${runId.toLowerCase()}`), eq(limits.windowStart, TUNE_KEEP_WINDOW)))
    .limit(1);
  return row ? (row.key.split(":")[1] ?? null) : null;
}

/** Keeps the pair. False when the run is already paired with another build. */
export async function savePair(buildId: string, runId: string): Promise<boolean> {
  const taken = await reserveCounter(runKey(runId), TUNE_KEEP_WINDOW, 1, 1);
  if (taken === null) return (await pairOfRun(runId)) === buildId.toLowerCase();
  await db().insert(limits).values({ key: pairKey(buildId, runId), windowStart: TUNE_KEEP_WINDOW, count: 1 }).onConflictDoNothing();
  return true;
}

/** The runs kept with a build. Few: each one took a real Start. */
export async function runsOfBuild(buildId: string): Promise<string[]> {
  const prefix = `make-pair:${buildId.toLowerCase()}:`;
  const rows = await db()
    .select({ key: limits.key })
    .from(limits)
    .where(and(like(limits.key, `${prefix}%`), eq(limits.windowStart, TUNE_KEEP_WINDOW)))
    .limit(20);
  return rows.map((r) => r.key.slice(prefix.length)).filter((id) => UUID_RE.test(id));
}

export interface PairBuild {
  userId: string | null;
  productId: string | null;
  status: string;
  brief: Pick<Brief, "capabilities"> | null;
}

export async function buildForPair(buildId: string): Promise<PairBuild | null> {
  const b = schema.builds;
  const [row] = await db().select({ userId: b.userId, productId: b.productId, status: b.status, brief: b.brief }).from(b).where(eq(b.id, buildId.toLowerCase())).limit(1);
  return (row as PairBuild | undefined) ?? null;
}

export type LinkState = "linked" | "not_yet" | "no_glimmer" | "product_daily" | "off";

export interface LinkDeps {
  fromBuilds: boolean;
  readProduct: typeof readRunProduct;
  saveProduct: typeof saveRunProduct;
  reserve: typeof reserveCounter;
  giveBack: typeof adjustCounter;
}

export const linkDeps = (fromBuilds: boolean): LinkDeps => ({ fromBuilds, readProduct: readRunProduct, saveProduct: saveRunProduct, reserve: reserveCounter, giveBack: adjustCounter });

/**
 * Links a run to its build's product once there is one, so ownModelFor can find it: an admin's only, with TUNE_FROM_BUILDS
 * on, for a brief that picked Muse Glimmer, within the product's one run a day, as a run planned from a build is.
 */
export async function linkRun(i: { caller: Pick<RunCaller, "isAdmin" | "visitor">; runId: string; buildId: string; build: PairBuild; now: Date }, deps: LinkDeps): Promise<LinkState> {
  if (!i.caller.isAdmin || i.caller.visitor || !deps.fromBuilds) return "off";
  if (await deps.readProduct(i.runId)) return "linked";
  if (!i.build.productId || (i.build.status !== "live" && i.build.status !== "partial")) return "not_yet";
  if (!offersOwnModel(i.build.brief, i.build.status)) return "no_glimmer";
  const day = productDay(i.build.productId, i.now);
  if ((await deps.reserve(day.key, day.until, 1, 1)) === null) return "product_daily";
  try {
    await deps.saveProduct(i.runId, i.build.productId, i.buildId);
  } catch (err) {
    await deps.giveBack(day.key, day.until, -1).catch((e) => console.error("[make/pair] release day", e));
    throw err;
  }
  return "linked";
}

export { saveRunAutoPublish };
