/** The plan card never ticks ahead of the run. npx tsx --test lib/steps-feed/__tests__/checklist.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChecklist, tuneChecklist } from "@/lib/steps-feed/checklist";
import type { BuildEvent } from "@/lib/types";

const st = (...s: string[]) => s.map((status, id) => ({ id, at: "2026-11-02T00:00:00Z", type: "status", status })) as unknown as BuildEvent[];
const states = (l: { items: Array<{ state: string }> }) => l.items.map((i) => i.state).join(" ");
const run = (o: Record<string, unknown>) => ({ stage: "writing", dataset: { status: "generating" }, job: null, hold: null, ...o }) as never;

describe("a build's plan card", () => {
  it("ticks only what's over", () => {
    assert.equal(states(buildChecklist("briefing", st("queued", "briefing"), "t")), "running todo todo todo todo");
    assert.equal(states(buildChecklist("building", st("briefing", "building"), "t")), "done running todo todo todo");
  });
  it("keeps the furthest step through fix rounds, and doesn't tick it", () => {
    assert.equal(states(buildChecklist("fixing", st("building", "verifying", "fixing"), "t")), "done done running todo todo");
    assert.equal(states(buildChecklist("building", st("building", "verifying", "fixing", "building"), "t")), "done done running todo todo");
  });
  it("marks where a failed or refused build stopped, and never ticks that step", () => {
    assert.equal(states(buildChecklist("failed", st("building", "verifying", "failed"), "t")), "done done bad todo todo");
    assert.equal(states(buildChecklist("refused", st("briefing", "refused"), "t")), "bad todo todo todo todo");
  });
  it("never ticks the checks of a partial build, which shipped with some failing", () => {
    assert.equal(states(buildChecklist("partial", st("building", "verifying", "deploying", "partial"), "t")), "done done bad done done");
    assert.equal(states(buildChecklist("partial", st("building", "verifying", "partial"), "t", true)), "done done bad done");
  });
  it("ticks everything only once live, and drops going online when publishing was off", () => {
    assert.equal(states(buildChecklist("live", st("building", "deploying", "live"), "t")), "done done done done done");
    const off = buildChecklist("live", st("building", "live"), "t", true);
    assert.equal(off.items.length, 4);
    assert.ok(!off.items.some((i) => i.id === "ship"));
  });
});

describe("a model's plan card", () => {
  it("follows the run", () => {
    assert.equal(states(tuneChecklist(run({}))), "running todo todo todo");
    assert.equal(states(tuneChecklist(run({ stage: "waiting", dataset: { status: "ready" } }))), "done done running todo");
    assert.equal(states(tuneChecklist(run({ stage: "scoring", dataset: { status: "ready" }, job: { status: "succeeded" } }))), "done done done running");
    assert.equal(states(tuneChecklist(run({ stage: "ready", dataset: { status: "ready" }, job: { status: "succeeded" } }))), "done done done done");
  });
  it("never claims training that stopped", () => {
    assert.equal(states(tuneChecklist(run({ stage: "failed", dataset: { status: "ready" }, job: { status: "failed" } }))), "done done bad todo");
  });
  it("ends a dataset at the dataset, with no training step", () => {
    const d = tuneChecklist(run({ datasetOnly: true, stage: "waiting", dataset: { status: "ready" } }));
    assert.equal(d.title, "Your dataset");
    assert.equal(states(d), "done done");
    assert.ok(!d.items.some((i) => i.id === "train"));
  });
});
