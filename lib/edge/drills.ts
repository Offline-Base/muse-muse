/**
 * The four simulated outage drills (template/scripts/edge-drill.mjs, docs/EDGE_DEMO.md) as people read them: their
 * names, what each one simulated, and how their results come out of a verify summary. Pure and env-free, so the build
 * room, the product page and lib/pipeline/edge-build.ts share one list.
 */

/** The drill's step names start with this, so the fix prompt and the product page show them as one group. */
export const EDGE_DRILL_STEP = "Simulated outage drill";

/** The group's heading wherever the drills' results show. */
export const DRILL_GROUP_TITLE = "Outage drills (simulated)";

/** The product page's line when newer checks ran without the drill (a verify that failed doesn't get one). */
export const DRILLS_EARLIER_NOTE = "These ran on an earlier try, not on the newest checks.";

/** The four drills, by id, with one plain line of what each simulated. */
export const EDGE_DRILLS: ReadonlyArray<{ id: number; name: string; simulated: string }> = [
  { id: 1, name: "cloud refused", simulated: "The cloud refused every connection, so the answer had to come from a simulated board, with its label." },
  { id: 2, name: "cloud hung", simulated: "The cloud never answered, so the product had to wait out its 10 s limit and then answer from a simulated board." },
  { id: 3, name: "both down", simulated: "The cloud and the simulated board were both down, so the page had to show its plain both-down message." },
  { id: 4, name: "tampered reply rejected", simulated: "A simulated board sent a reply with the wrong types, and none of it was allowed to reach the page." },
];

/** One drill's result as the build room and the product page show it. */
export interface DrillRow {
  id: number;
  name: string;
  ok: boolean;
  ms?: number;
  /** Why it failed, from the drill or the step that ran it. */
  detail?: string;
  /** What it simulated. Empty for a drill this version doesn't know. */
  simulated: string;
}

const STEP_NAME = new RegExp(`^${EDGE_DRILL_STEP} (\\d+): (.+)$`);

type Step = { name: string; ok: boolean; ms?: number; detail?: string };

/**
 * A verify summary's steps split into verify's own and the drills', in the order they ran. `drills` is empty for a
 * build that didn't run the drill, and then `checks` is the same list.
 */
export function splitDrillSteps<S extends Step>(steps: readonly S[]): { checks: S[]; drills: DrillRow[] } {
  const checks: S[] = [];
  const drills: DrillRow[] = [];
  for (const s of steps) {
    const m = STEP_NAME.exec(s.name);
    if (!m) {
      checks.push(s);
      continue;
    }
    const id = Number(m[1]);
    drills.push({
      id,
      name: m[2]!,
      ok: s.ok,
      ...(typeof s.ms === "number" ? { ms: s.ms } : {}),
      ...(s.detail ? { detail: s.detail } : {}),
      simulated: EDGE_DRILLS.find((d) => d.id === id)?.simulated ?? "",
    });
  }
  return { checks: drills.length ? checks : [...steps], drills };
}

/**
 * The drills to show on a product page, from its build's verify summaries, oldest first: the newest round that ran the
 * drill. `later` is true when newer checks ran without it (the drill runs only after a verify that passed), so the page
 * says these are from an earlier try. Null for a build that never ran the drill.
 */
export function latestDrills(summaries: ReadonlyArray<{ steps: readonly Step[] }>): { drills: DrillRow[]; later: boolean } | null {
  for (let i = summaries.length - 1; i >= 0; i--) {
    const { drills } = splitDrillSteps(summaries[i]!.steps);
    if (drills.length) return { drills, later: i < summaries.length - 1 };
  }
  return null;
}
