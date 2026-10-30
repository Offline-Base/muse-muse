/**
 * The workflow control room (content/meta-docs/pages/muse-code/workflows.md "Monitor and control a run") as a keyboard
 * model. /workflows opens a run list: Up and Down (or J and K) select a run, Enter or Right opens its phases and child
 * agents, C cancels the selected workflow, R opens a completed one's result, Space or Esc closes. Inside a run, P
 * pauses or resumes it, X skips a selected running child and R restarts one (R is not a retry for completed or failed
 * children), Esc or Left goes back a level, and Space closes from any level. What a key does depends on the selected
 * row and its state, as the page says, so a key that doesn't apply says why instead of doing nothing. Pure, so the
 * simulator and its tests agree.
 */

export type RunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
export type ChildStatus = "running" | "queued" | "completed" | "failed" | "skipped" | "cancelled";

export interface RoomChild {
  name: string;
  phase: string;
  status: ChildStatus;
  restarts: number;
}

export interface RoomRun {
  name: string;
  status: RunStatus;
  elapsed: string;
  tokens: number;
  children: RoomChild[];
  /** What a completed run returned. */
  result?: string;
}

export type RoomLevel = "list" | "run" | "result";

export interface RoomState {
  open: boolean;
  level: RoomLevel;
  /** The selected run in the list. */
  run: number;
  /** The selected child inside a run. */
  child: number;
  runs: RoomRun[];
  /** What the last key did, in the page's terms. */
  message: string;
}

const child = (name: string, phase: string, status: ChildStatus): RoomChild => ({ name, phase, status, restarts: 0 });

/** Three runs in the states the page's controls care about: one running, one completed, one failed. */
export const SAMPLE_RUNS: readonly RoomRun[] = [
  {
    name: "review-change",
    status: "running",
    elapsed: "2m 14s",
    tokens: 48_200,
    children: [
      child("API compatibility", "Inspect", "completed"),
      child("Security risks", "Inspect", "running"),
      child("Missing tests", "Inspect", "running"),
      child("Verifier", "Verify", "queued"),
      child("Report", "Synthesize", "queued"),
    ],
  },
  {
    name: "dependency-upgrade",
    status: "completed",
    elapsed: "6m 02s",
    tokens: 131_900,
    children: [
      child("Production call sites", "Inspect", "completed"),
      child("Tests and build", "Inspect", "completed"),
      child("Verifier", "Verify", "completed"),
      child("Plan", "Synthesize", "completed"),
    ],
    result: "An ordered implementation plan in 7 steps, with file references, and 2 high-risk call sites the verifier confirmed.",
  },
  {
    name: "package-updates",
    status: "failed",
    elapsed: "3m 40s",
    tokens: 62_300,
    children: [child("packages/api", "Update", "completed"), child("packages/web", "Update", "failed"), child("packages/cli", "Update", "completed")],
  },
];

export const CLOSED_MESSAGE = "Type /workflows to open the control room.";

export function initialRoom(): RoomState {
  return { open: false, level: "list", run: 0, child: 0, runs: SAMPLE_RUNS.map((r) => ({ ...r, children: r.children.map((c) => ({ ...c })) })), message: CLOSED_MESSAGE };
}

export function openRoom(state: RoomState): RoomState {
  return { ...state, open: true, level: "list", message: "The run list: each workflow's status, elapsed time, token usage and child progress." };
}

/** "3 of 5 done": children that finished one way or another, out of all of them. */
export function progress(run: RoomRun): string {
  const done = run.children.filter((c) => c.status !== "running" && c.status !== "queued").length;
  return `${done} of ${run.children.length} done`;
}

export type RoomKey = "up" | "down" | "enter" | "right" | "left" | "esc" | "space" | "c" | "r" | "p" | "x";

/** A KeyboardEvent key as a control-room key, or null for keys the control room doesn't use. */
export function roomKey(key: string): RoomKey | null {
  switch (key) {
    case "ArrowUp":
    case "k":
    case "K":
      return "up";
    case "ArrowDown":
    case "j":
    case "J":
      return "down";
    case "Enter":
      return "enter";
    case "ArrowRight":
      return "right";
    case "ArrowLeft":
      return "left";
    case "Escape":
      return "esc";
    case " ":
    case "Spacebar":
      return "space";
    default: {
      const k = key.toLowerCase();
      return k === "c" || k === "r" || k === "p" || k === "x" ? k : null;
    }
  }
}

const CLOSE_NOTE = "Closed the control room. The workflow continues in the background, and Muse Code delivers its completion to the conversation, so you don't need to poll it.";

function withRun(state: RoomState, patch: Partial<RoomRun>): RoomRun[] {
  return state.runs.map((r, i) => (i === state.run ? { ...r, ...patch } : r));
}

function withChild(state: RoomState, patch: Partial<RoomChild>): RoomRun[] {
  return state.runs.map((r, i) => (i === state.run ? { ...r, children: r.children.map((c, j) => (j === state.child ? { ...c, ...patch } : c)) } : r));
}

/** What one key press does, from the state it's pressed in. */
export function pressKey(state: RoomState, key: RoomKey): RoomState {
  if (!state.open) return { ...state, message: CLOSED_MESSAGE };
  const run = state.runs[state.run];
  if (key === "space") return { ...state, open: false, level: "list", message: CLOSE_NOTE };

  if (state.level === "list") {
    switch (key) {
      case "up":
      case "down": {
        const next = Math.max(0, Math.min(state.runs.length - 1, state.run + (key === "up" ? -1 : 1)));
        const r = state.runs[next];
        return { ...state, run: next, child: 0, message: `Selected ${r.name}: ${r.status}, ${progress(r)}.` };
      }
      case "enter":
      case "right":
        return { ...state, level: "run", child: 0, message: `Opened ${run.name}: its phases and child agents. Esc or Left goes back to the list.` };
      case "esc":
        return { ...state, open: false, message: CLOSE_NOTE };
      case "c":
        if (run.status !== "running" && run.status !== "paused") return { ...state, message: `Nothing to cancel: ${run.name} is already ${run.status}.` };
        return {
          ...state,
          runs: state.runs.map((r, i) =>
            i === state.run ? { ...r, status: "cancelled", children: r.children.map((c) => (c.status === "running" || c.status === "queued" ? { ...c, status: "cancelled" } : c)) } : r,
          ),
          message: `Cancelled ${run.name}. Its running and queued children stop.`,
        };
      case "r":
        if (run.status !== "completed") return { ...state, message: `R opens the result of a completed workflow, and ${run.name} is ${run.status}.` };
        return { ...state, level: "result", message: `${run.name}'s result. Esc or Left goes back to the list.` };
      case "p":
      case "x":
        return { ...state, message: `${key.toUpperCase()} works inside a workflow: press Enter to open ${run.name} first.` };
      default:
        return state;
    }
  }

  if (state.level === "result") {
    if (key === "esc" || key === "left") return { ...state, level: "list", message: "Back to the run list." };
    return { ...state, message: "Esc or Left goes back to the run list; Space closes the control room." };
  }

  // Inside a run.
  const kid = run.children[state.child];
  switch (key) {
    case "up":
    case "down": {
      const next = Math.max(0, Math.min(run.children.length - 1, state.child + (key === "up" ? -1 : 1)));
      const c = run.children[next];
      return { ...state, child: next, message: `Selected ${c.name} (${c.phase}): ${c.status}.` };
    }
    case "esc":
    case "left":
      return { ...state, level: "list", message: "Back to the run list." };
    case "enter":
    case "right":
      return { ...state, message: `Already showing ${run.name}'s phases and child agents.` };
    case "p":
      if (run.status === "running") return { ...state, runs: withRun(state, { status: "paused" }), message: `Paused ${run.name}. P again resumes it.` };
      if (run.status === "paused") return { ...state, runs: withRun(state, { status: "running" }), message: `Resumed ${run.name}.` };
      return { ...state, message: `P pauses or resumes a run in progress, and ${run.name} is ${run.status}.` };
    case "x":
      if (kid?.status !== "running") return { ...state, message: `X skips a running child, and ${kid?.name ?? "this row"} is ${kid?.status ?? "empty"}.` };
      return { ...state, runs: withChild(state, { status: "skipped" }), message: `Skipped ${kid.name}. The workflow goes on without its result.` };
    case "r":
      if (kid?.status !== "running") {
        return { ...state, message: `R isn't a general retry: it restarts a running child only, and ${kid?.name ?? "this row"} is ${kid?.status ?? "empty"}.` };
      }
      return { ...state, runs: withChild(state, { restarts: kid.restarts + 1 }), message: `Restarted ${kid.name}: it starts its task over.` };
    case "c":
      return { ...state, message: "C cancels from the run list: Esc goes back to it." };
    default:
      return state;
  }
}

/** The page's two ways back from a failed run, filled in with the reader's ids. */
export function recoverySteps(input: { runId: string; sessionId: string; scriptPath: string }): { sameProcess: string; afterRestart: string } {
  const runId = input.runId.trim() || "<run-id>";
  const sessionId = input.sessionId.trim() || "<session-id>";
  const scriptPath = input.scriptPath.trim() || "<scriptPath from the Workflow result>";
  return {
    // Short lines, like the page's own prompts, so the request reads without scrolling.
    sameProcess: [`I edited ${scriptPath}.`, `Resume workflow run ${runId}: call the Workflow tool`, `with that script path and resumeFromRunId ${runId}.`].join("\n"),
    afterRestart: `muse workflows recover ${runId} --session ${sessionId} --apply`,
  };
}
