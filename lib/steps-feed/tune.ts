import type { FeedRow, FeedStep, StepTone } from "@/lib/steps-feed/facts";
import type { TuneRunView } from "@/lib/train/tune/types";

/**
 * A model run told the way BUILD_ROOM_STEPS tells a build (docs/TRAINING.md "One box for everything"): one plain line
 * for each stage it really reached, from the run's own state, with no model call. Pure, so the room and the tests share it.
 */
const WAITS: Partial<Record<NonNullable<TuneRunView["hold"]>["reason"], string>> = {
  not_started: "Waiting for someone to start the training",
  daily_cap: "Waiting for tomorrow's budget",
  paused: "Waiting for the spending limit to reset",
  sweep_not_running: "Waiting for the safety check on big computers",
  lambda_unavailable: "Waiting to reach the big computers",
};

export function tuneFeed(v: Pick<TuneRunView, "stage" | "dataset" | "job" | "written" | "hold" | "verdict">): { rows: FeedRow[] } {
  const steps: FeedStep[] = [];
  const add = (id: string, plain: string, tone: StepTone = "plain", final = false) => steps.push({ id: `tune-${id}`, text: plain, plain, noun: plain, tone, final });
  const d = v.dataset;
  const job = v.job;

  add("read", "Reading what you asked for");
  if (d.status === "generating") add("write", v.stage === "failed" ? "The practice examples stopped partway" : `Writing practice examples, ${v.written ?? 0} of ${d.requested}`, v.stage === "failed" ? "bad" : "plain");
  else if (d.status === "failed") add("write", "The practice examples couldn't be written", "bad");
  else add("write", `Wrote ${d.trainCount + d.evalCount} practice examples`);

  if (d.status === "ready") {
    if (v.stage === "checking") add("check", "Checking there are enough examples");
    else if (v.stage === "failed" && !job) add("check", "There weren't enough good examples to learn from", "bad");
    else add("check", `Kept ${d.evalCount} examples aside for a test`);
  }
  if (v.stage === "waiting") add("wait", (v.hold && WAITS[v.hold.reason]) ?? "Waiting for a big computer to be free");
  if (job) {
    if (job.status === "succeeded") add("train", "The model finished learning");
    else if (job.status === "failed") add("train", "The learning stopped before it finished", "bad");
    else if (job.status === "stopped") add("train", "The learning was stopped", "bad");
    else add("train", "Teaching the model on a big computer");
    if (job.status === "succeeded") add("score", v.stage === "scoring" ? "Giving both models the same test" : "Both models took the same test");
  }
  if (v.stage === "ready") {
    if (v.verdict?.passed) add("end", "The tuned model did better than the one it started from", "good", true);
    else if (v.verdict?.scored) add("end", "The tuned model didn't do better than the one it started from", "plain", true);
    else add("end", "It wasn't scored, so it hasn't passed", "plain", true);
  } else if (v.stage === "failed") add("end", "The model run stopped and didn't finish", "bad", true);
  else if (v.stage === "stopped") add("end", "This run was stopped", "bad", true);

  const open = v.stage !== "ready" && v.stage !== "failed" && v.stage !== "stopped";
  return { rows: steps.map((step, i) => ({ type: "step" as const, step, running: open && i === steps.length - 1 })) };
}
