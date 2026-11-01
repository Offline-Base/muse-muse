// Platform file (Muse Muse platform services). Don't edit.
//
// Replay mode for Muse Code runs: plays back lib/muse-code/sample-run.json (a recorded run with made-up data) as if it
// were happening now, so a build's tests can exercise the whole run screen and spend nothing. A replay run's id starts
// with "replay_" and holds the time it started, so any server instance can answer it without storing anything. Only a
// build's own server plays replays (MUSE_CODE_REPLAY_OK=1, which the platform sets in the build only), never the live
// product, so a person never sees a recording as if it were their task.
import recording from "./sample-run.json";

export interface RunStep {
  n: number;
  kind: string;
  text: string;
  itemId?: string;
  tool?: string;
  ok?: boolean;
  files?: number;
  added?: number;
  removed?: number;
}

export interface RecordedRun {
  task: string;
  model: string;
  durationMs: number;
  steps: Array<Omit<RunStep, "n"> & { at: number }>;
  result: { status: string; worked: boolean; finalText: string; files: Array<{ path: string; bytes: number }>; dropped: Array<{ path: string; why: string }>; costUsd: number };
}

export const SAMPLE_RUN = recording as RecordedRun;
const PREFIX = "replay_";

export function isReplayId(id: string): boolean {
  return /^replay_\d{10,16}$/.test(id);
}

export function replayAllowed(): boolean {
  return process.env.MUSE_CODE_REPLAY_OK === "1";
}

/** A new replay run's id, started `now`. */
export function replayStart(now: number = Date.now(), run: RecordedRun = SAMPLE_RUN) {
  return { id: `${PREFIX}${now}`, status: "running", model: run.model, budgetUsd: 0, endsAt: new Date(now + run.durationMs).toISOString(), replay: true };
}

function startedAt(id: string): number {
  return Number(id.slice(PREFIX.length));
}

/** The steps a replay has reached by `now`, after step `after`, and its status. */
export function replayEvents(id: string, after: number, now: number = Date.now(), run: RecordedRun = SAMPLE_RUN) {
  const elapsed = now - startedAt(id);
  const reached = run.steps.map((s, n) => ({ ...s, n })).filter((s) => s.at <= elapsed);
  const done = elapsed >= run.durationMs;
  const events: RunStep[] = reached.filter((s) => s.n > after).map(({ at: _at, ...s }) => s);
  const share = Math.min(1, Math.max(0, elapsed / run.durationMs));
  return {
    id,
    status: done ? run.result.status : "running",
    model: run.model,
    endsAt: new Date(startedAt(id) + run.durationMs).toISOString(),
    events,
    next: reached.length - 1,
    costUsd: Math.round(run.result.costUsd * share * 1e6) / 1e6,
    finalText: done ? run.result.finalText : null,
    worked: done ? run.result.worked : null,
    reason: done ? "Replayed a recorded sample run." : null,
    replay: true,
  };
}

/** A replay's result, once its time has run. */
export function replayResult(id: string, now: number = Date.now(), run: RecordedRun = SAMPLE_RUN) {
  const done = now - startedAt(id) >= run.durationMs;
  if (!done) return { id, status: "running", done: false, model: run.model, finalText: null, worked: null, costUsd: 0, replay: true };
  return { id, status: run.result.status, done: true, model: run.model, finalText: run.result.finalText, worked: run.result.worked, files: run.result.files, dropped: run.result.dropped, zipUrl: null, zipExpiresAt: null, costUsd: run.result.costUsd, reason: "Replayed a recorded sample run.", replay: true };
}
