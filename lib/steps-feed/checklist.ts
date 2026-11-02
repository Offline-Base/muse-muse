import type { BuildEvent, BuildStatus } from "@/lib/types";
import type { TuneRunView } from "@/lib/train/tune/types";

/**
 * The plan card at the top of a room (BUILD_ROOM_STEPS): a few big steps that tick off as the run really reaches them,
 * from its own status and never from a model. A step shows done only once a later one has begun or the run finished it. Pure.
 */
export type ChecklistState = "done" | "running" | "todo" | "bad";
export interface ChecklistItem {
  id: string;
  label: string;
  state: ChecklistState;
}
export interface Checklist {
  title: string;
  items: ChecklistItem[];
}

const BUILD_STEPS: Array<{ id: string; label: string; statuses: BuildStatus[] }> = [
  { id: "read", label: "Read what you asked for and write the plan", statuses: ["queued", "briefing"] },
  { id: "build", label: "Build the product", statuses: ["provisioning", "building", "previewing"] },
  { id: "check", label: "Try everything out and fix what breaks", statuses: ["verifying", "fixing"] },
  { id: "demo", label: "Record a short demo", statuses: ["recording"] },
  { id: "ship", label: "Put it online", statuses: ["deploying"] },
];

function fromIndex<T extends { id: string; label: string }>(steps: T[], at: number, ended: "done" | "bad" | null): ChecklistItem[] {
  return steps.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: ended === "done" ? "done" : i < at ? "done" : i > at ? "todo" : ended === "bad" ? "bad" : "running",
  }));
}

export function buildChecklist(status: string, events: readonly BuildEvent[], title: string, unpublished = false): Checklist {
  const seen = events.flatMap((e) => (e.type === "status" ? [e.status] : []));
  // Fix rounds go back and forth, so the furthest step reached counts. The newest status is what's running.
  const furthest = [...seen, status as BuildStatus].reduce((most, s) => Math.max(most, BUILD_STEPS.findIndex((b) => b.statuses.includes(s))), 0);
  const steps = unpublished ? BUILD_STEPS.filter((s) => s.id !== "ship") : BUILD_STEPS;
  const at = Math.min(furthest, steps.length - 1);
  if (status === "live") return { title, items: fromIndex(steps, at, "done") };
  // A partial build did ship part of it, and a failed or refused one stopped at the step it had reached.
  if (status === "partial") return { title, items: fromIndex(steps, steps.length - 1, "done") };
  return { title, items: fromIndex(steps, at, status === "failed" || status === "refused" ? "bad" : null) };
}

export function tuneChecklist(v: Pick<TuneRunView, "stage" | "dataset" | "job" | "hold" | "datasetOnly">, title = "Your model"): Checklist {
  const write = { id: "write", label: "Write the practice examples" };
  if (v.datasetOnly && !v.job) {
    const steps = [write, { id: "check", label: "Set some aside for a test" }];
    if (v.stage === "writing") return { title: "Your dataset", items: fromIndex(steps, 0, null) };
    if (v.stage === "failed" || v.stage === "stopped") return { title: "Your dataset", items: fromIndex(steps, 0, "bad") };
    return { title: "Your dataset", items: fromIndex(steps, 1, "done") };
  }
  const steps = [write, { id: "check", label: "Check there are enough to learn from" }, { id: "train", label: "Teach the model on a big computer" }, { id: "score", label: "Give both models the same test" }];
  const reached = v.job?.status === "succeeded" ? 3 : v.job ? 2 : v.dataset.status === "ready" ? (v.stage === "checking" ? 1 : 2) : 0;
  if (v.stage === "ready") return { title, items: fromIndex(steps, 3, "done") };
  return { title, items: fromIndex(steps, reached, v.stage === "failed" || v.stage === "stopped" ? "bad" : null) };
}
