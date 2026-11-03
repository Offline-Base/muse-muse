import { z } from "zod";

/**
 * Milestone builds (docs/CAPABILITIES.md, section 8): a big brief splits into 2 or 3 milestones, each built in its own
 * Muse Code round of the same session, with a strict verify between them. Only zod here, so lib/brief/schema.ts can
 * import it without a cycle.
 */

export const MILESTONES_MIN = 2;
export const MILESTONES_MAX = 3;

export const MilestoneSchema = z.object({
  title: z.string().min(1).max(60),
  doneMeans: z.string().min(1).max(300),
});

export const MilestonesSchema = z.array(MilestoneSchema).min(MILESTONES_MIN).max(MILESTONES_MAX);

export type Milestone = z.infer<typeof MilestoneSchema>;

/** Where a milestone is, as the build room and builds.round_plan show it. */
export type MilestoneState = "planned" | "building" | "passed" | "failed" | "skipped";

/** builds.round_plan (migration 0019): the first round's cap and the milestones with their states. */
export interface RoundPlanRecord {
  capMinutes: number;
  milestones: Array<{ title: string; state: MilestoneState }>;
  /**
   * The whole build's time limit, start to live, in minutes: the plan's wall, or the plain build's (buildWallMs). A chain's
   * is one session's. The build room shows it. Missing on builds from before Nov 3, which the room then shows no limit for.
   */
  wallMinutes?: number;
  /** CHAINED_BUILDS: how long the sweep gives this build, and the session it's on. */
  chain?: { maxHours: number; session: number };
}

/** The milestones a brief really has: 2 or 3 with a title and what done means, or none. */
export function briefMilestones(brief: { milestones?: Milestone[] | null }): Milestone[] {
  const list = Array.isArray(brief.milestones) ? brief.milestones : [];
  const usable = list.filter((m) => m && typeof m.title === "string" && m.title.trim() && typeof m.doneMeans === "string" && m.doneMeans.trim());
  return usable.length >= MILESTONES_MIN ? usable.slice(0, MILESTONES_MAX) : [];
}
