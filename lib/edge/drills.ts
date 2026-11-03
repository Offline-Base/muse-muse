/**
 * The four simulated outage drills, and the four photo drills for a product that looks with Meta SAM 3.1
 * (template/scripts/edge-drill.mjs, docs/EDGE_DEMO.md), as people read them: their names, what each one simulated, and
 * how their results come out of a verify summary. Pure and env-free, so the build
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
  { id: 1, name: "cloud refused", simulated: "The cloud refused every connection, so after trying it the product had to answer from a simulated board, with its label." },
  { id: 2, name: "cloud hung", simulated: "The cloud never answered, so after trying it the product had to answer from a simulated board, with its label, within 15 s." },
  { id: 3, name: "both down", simulated: "The cloud and the simulated board were both down, so the product had to reply with its plain both-down message and no server error." },
  { id: 4, name: "tampered reply rejected", simulated: "A simulated board sent a reply with the wrong types, and none of it was allowed into the product's reply." },
];

/**
 * The four photo drills (template/scripts/edge-drill.mjs, 12 to 15), run for a product whose edge-drill.json names a
 * route that looks with Meta SAM 3.1 through segmentOrEdge. A build without that route runs none of them.
 */
export const EDGE_SAM_DRILLS: ReadonlyArray<{ id: number; name: string; simulated: string }> = [
  { id: 12, name: "SAM, cloud refused", simulated: "The cloud refused every connection, so after trying it the product had to look at a simulated photo on a simulated board, with its label." },
  { id: 13, name: "SAM, cloud hung", simulated: "The cloud never answered, so after trying it the product had to look at a simulated photo on a simulated board, with its label, within 15 s." },
  { id: 14, name: "SAM, both down", simulated: "The cloud and the simulated board were both down, so the product had to say plainly that it can't see right now, with no label and no server error." },
  { id: 15, name: "SAM, tampered board reply rejected", simulated: "A simulated board sent a look with the wrong types, and none of it was allowed into the product's reply." },
];

/**
 * The two board status drills (template/scripts/edge-drill.mjs, 17 and 18), run for every edge product: the product's
 * board status route (app/api/board-status) says connected only while the simulated board answers, says "Not connected
 * to a board" when it doesn't, and the page shows the line.
 */
export const EDGE_BOARD_DRILLS: ReadonlyArray<{ id: number; name: string; simulated: string }> = [
  { id: 17, name: "board status, board up", simulated: "A simulated board answered its health check, so the product's board status line had to say it was connected, and the page had to show that line." },
  { id: 18, name: "board status, board down", simulated: "The simulated board dropped every connection, so the product's board status line had to say \"Not connected to a board\"." },
];

/** The sample photo drill (19), for a product that looks at photos: its "Try the sample" photo must be served from public/samples/. */
export const EDGE_SAMPLE_DRILL: { id: number; name: string; simulated: string } = {
  id: 19,
  name: "SAM, sample photo served",
  simulated: "Not simulated: the product had to serve the sample photo its \"Try the sample\" button loads, from public/samples/.",
};

/** Every drill this version knows, by id. */
export const ALL_EDGE_DRILLS: ReadonlyArray<{ id: number; name: string; simulated: string }> = [...EDGE_DRILLS, ...EDGE_SAM_DRILLS, ...EDGE_BOARD_DRILLS, EDGE_SAMPLE_DRILL];

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
      simulated: ALL_EDGE_DRILLS.find((d) => d.id === id)?.simulated ?? "",
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
