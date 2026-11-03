import { jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { BlobPrefix } from "@/lib/storage";
import type { SamData, SamDistractor, SamPhoto, SamStatus } from "@/lib/train/sam/types";

/**
 * SHIM (U6, tg-sam-uploads), the same rule as U2: U1 (tg-sam-core) owns lib/env.ts, lib/db/schema.ts and the run table,
 * and none of them were on main when this unit was written. Everything here stands in for them with the names section 3
 * and section 4 (U1) of the plan give, so U6 builds and tests on its own. On merge the integrator points the three
 * readers at `env.samTune`, `env.samTuneDailyUsd` and `env.samTuneMaxUsd`, and `samTuneRunsShim` at
 * `schema.samTuneRuns` and `SAMTUNE_PREFIX` at the plain "samtune" (once U1 adds it to StoredPrefix in lib/local-files.ts),
 * then deletes this file. Only the columns U6 reads or writes are listed.
 */

/** True when a switch is "1", "true", "yes" or "on" (any case), as lib/env.ts flag() reads it. Anything else is off. */
function flagOn(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function usd(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** SAM_TUNE: off by default. Off, every SAM tune route answers 404. */
export function samTuneOn(): boolean {
  return flagOn("SAM_TUNE");
}

/** SAM_TUNE_DAILY_USD: all SAM tune spend in one UTC day (labels and look-alikes). Default $5. */
export function samTuneDailyUsd(): number {
  return usd("SAM_TUNE_DAILY_USD", 5);
}

/** SAM_TUNE_MAX_USD: one run's spend. Default $1. */
export function samTuneMaxUsd(): number {
  return usd("SAM_TUNE_MAX_USD", 1);
}

/** The columns of U1's `sam_tune_runs` that U6 uses, with the snake_case names lib/db/schema.ts gives camelCase fields. */
export const samTuneRunsShim = pgTable("sam_tune_runs", {
  id: uuid("id").primaryKey(),
  word: text("word").notNull(),
  generic: text("generic").notNull(),
  data: text("data").$type<SamData>().notNull(),
  status: text("status").$type<SamStatus>().notNull(),
  photos: jsonb("photos").$type<SamPhoto[]>(),
  distractors: jsonb("distractors").$type<SamDistractor[]>(),
  costUsd: real("cost_usd").notNull(),
  maxUsd: real("max_usd").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** The Blob folder a run's photos and look-alikes go under: samtune/<runId>/... U1 adds "samtune" to StoredPrefix. */
export const SAMTUNE_PREFIX = "samtune" as unknown as BlobPrefix;
