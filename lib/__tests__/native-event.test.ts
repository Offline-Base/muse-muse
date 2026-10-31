/**
 * Condensing a build's `native` events (lib/types.ts): the latest event for a step wins, media and artifacts stay until
 * replaced, events from a newer branch can't break it, and a run is active while any step can still change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { condenseNativeEvents, type NativeEventBody } from "@/lib/types";

const step = (item: string, state: NativeEventBody["state"], extra: Partial<NativeEventBody> = {}): NativeEventBody => ({
  type: "native",
  runId: "run-1",
  origin: "ship",
  item,
  target: "phone",
  state,
  title: `${item} ${state}`,
  ...extra,
});

describe("condenseNativeEvents", () => {
  it("is empty for a build with no native events, whatever else its log has", () => {
    assert.deepEqual(condenseNativeEvents([]), []);
    assert.deepEqual(condenseNativeEvents([{ type: "log" }, { type: "cost" }, { type: "status" }]), []);
  });

  it("keeps a step's latest state, in the order the steps first appeared", () => {
    const [run] = condenseNativeEvents([step("package:android", "planned"), step("check:ios_sim", "planned"), step("package:android", "running"), step("package:android", "done")]);
    assert.deepEqual(run!.items.map((i) => [i.item, i.state]), [
      ["package:android", "done"],
      ["check:ios_sim", "planned"],
    ]);
    assert.equal(run!.items[0]!.title, "package:android done");
  });

  it("keeps runs apart, and each run's origin", () => {
    const runs = condenseNativeEvents([step("a", "done"), step("a", "queued", { runId: "run-2", origin: "agent" })]);
    assert.deepEqual(runs.map((r) => [r.runId, r.origin, r.items[0]!.state]), [
      ["run-1", "ship", "done"],
      ["run-2", "agent", "queued"],
    ]);
  });

  it("keeps media, the artifact and the cost from before until a later event replaces them", () => {
    const media = [{ kind: "video" as const, url: "https://blob.example/clip.mp4", caption: "On an Android emulator" }];
    const artifact = { kind: "android_apk", url: "https://blob.example/a.apk", bytes: 41_000_000 };
    const [run] = condenseNativeEvents([step("a", "running", { media, artifact, costUsd: 0.5 }), step("a", "done")]);
    const item = run!.items[0]!;
    assert.deepEqual(item.media, media);
    assert.deepEqual(item.artifact, artifact);
    assert.equal(item.costUsd, 0.5);
    const [later] = condenseNativeEvents([step("a", "running", { costUsd: 0.5 }), step("a", "done", { costUsd: 0.68 })]);
    assert.equal(later!.items[0]!.costUsd, 0.68);
  });

  it("drops the queue place once the step has moved on", () => {
    const [run] = condenseNativeEvents([step("a", "queued", { queue: { ahead: 2, etaSeconds: 240 } }), step("a", "running")]);
    assert.equal(run!.items[0]!.queue, undefined);
  });

  it("is active until every step is done, failed or skipped, and adds up the cost", () => {
    assert.equal(condenseNativeEvents([step("a", "done"), step("b", "running")])[0]!.active, true);
    assert.equal(condenseNativeEvents([step("a", "done"), step("b", "queued")])[0]!.active, true);
    assert.equal(condenseNativeEvents([step("a", "done"), step("b", "planned")])[0]!.active, true);
    const [run] = condenseNativeEvents([step("a", "done", { costUsd: 0.25 }), step("b", "failed", { costUsd: 0.5 }), step("c", "skipped")]);
    assert.equal(run!.active, false);
    assert.equal(run!.costUsd, 0.75);
  });

  it("doesn't hold a run open for a state from a newer branch", () => {
    const newer = { ...step("a", "done"), state: "paused" } as unknown as NativeEventBody;
    assert.equal(condenseNativeEvents([newer])[0]!.active, false);
  });

  it("skips an event that doesn't name a run and a step", () => {
    const odd = [{ type: "native" }, { type: "native", runId: 7, item: "a" }, { type: "native", runId: "r" }];
    assert.deepEqual(condenseNativeEvents(odd), []);
  });
});
