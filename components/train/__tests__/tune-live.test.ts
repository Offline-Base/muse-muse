/**
 * A run's live demo as its room reads it (app/fine-tuning/runs/live.ts), with lib/train/store faked: the Try it live box
 * while a serve job is open, Start a live demo when the adapter can be served, and nothing for a job that isn't a
 * trained Muse Glimmer LoRA, an adapter that can't be served, or a read that fails. Made-up rows only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/tune-live.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import { JOB_ID, SERVE_ID, jobRow } from "@/components/train/__tests__/tune-room-fixture";
import type { TrainJobRow } from "@/lib/train/logic";
import type { LiveDemoView } from "@/lib/train/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (p: string) => new URL(p, import.meta.url).href;
const NOW = new Date("2026-11-01T14:00:00.000Z");

let demo: LiveDemoView | null = null;
let source: { job: TrainJobRow; metrics: Record<string, unknown> | null } | null = null;
let fail = false;
const calls: string[] = [];

const trained = () =>
  jobRow({
    status: "succeeded",
    terminatedAt: new Date("2026-11-01T13:05:00.000Z"),
    evalSummary: { items: 20, tunedWins: 18, baseWins: 1, ties: 1, avgBaseScore: 3.1, avgTunedScore: 8.4, judgeCostUsd: 0.25 },
  } as Partial<TrainJobRow>);
const servable = { cache_used: "yes", adapter_dir: `/lambda/nfs/cache/models/${JOB_ID}` };

describe("a run's live demo", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let live: typeof import("@/app/fine-tuning/runs/live");
  let format: typeof import("@/components/train/format");
  let env: typeof import("@/lib/env").env;
  let userdata: typeof import("@/lib/train/userdata");

  before(async () => {
    mock.module(at("../../../lib/train/store.ts"), {
      namedExports: {
        getLiveDemo: async (id: string) => {
          calls.push(`demo ${id}`);
          if (fail) throw new Error("made-up outage");
          return demo;
        },
        getAdapterSource: async (id: string) => {
          calls.push(`source ${id}`);
          return source;
        },
        lastSweepOkAt: async () => null,
        // app/api/train/shared.ts imports it; nothing here calls it.
        verifyJobToken: async () => false,
      },
    });
    live = await import("@/app/fine-tuning/runs/live");
    format = await import("@/components/train/format");
    env = (await import("@/lib/env")).env;
    userdata = await import("@/lib/train/userdata");
  });

  beforeEach(() => {
    demo = null;
    source = { job: trained(), metrics: servable };
    fail = false;
    calls.length = 0;
  });

  it("reads nothing for a run with no job, or a job that hasn't trained", async () => {
    assert.equal(await live.runLiveDemo(null, NOW), null);
    for (const status of ["running", "failed", "stopped"] as const) assert.equal(await live.runLiveDemo({ ...trained(), status }, NOW), null, status);
    assert.equal(await live.runLiveDemo({ ...trained(), recipe: "glimmer-serve" }, NOW), null);
    assert.deepEqual(calls, []);
  });

  it("gives the open demo's Try it live box", async () => {
    demo = { serveJobId: SERVE_ID, state: "live", minutes: 30, endsAt: "2026-11-01T14:30:00.000Z" };
    assert.deepEqual(await live.runLiveDemo(trained(), NOW), { kind: "demo", demo });
    assert.deepEqual(calls, [`demo ${JOB_ID}`]);
  });

  it("offers Start a live demo with the job page's limits when the adapter can be served", async () => {
    const got = await live.runLiveDemo(trained(), NOW);
    assert.equal(got?.kind, "start");
    if (got?.kind !== "start") return;
    assert.equal(got.adapterTitle, "a made-up bakery's counter helper");
    assert.deepEqual(got.ceilings, { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd });
    assert.equal(got.maxActive, env.trainMaxActive);
    assert.equal(got.dailyUsd, env.trainDailyUsd);
    assert.equal(got.publicPage, true, "a judged job has a public results page");
    // Outside a public https deployment the jobs route would refuse, and the card says why up front.
    if (!userdata.callbackOrigin(env.platformUrl)) assert.equal(got.blocked, format.NOT_PUBLIC_TEXT);
    else assert.equal(typeof got.blocked === "string" || got.blocked === null, true);
  });

  it("offers nothing when the adapter can't be served or a read fails", async () => {
    source = { job: trained(), metrics: { cache_used: "no" } };
    assert.equal(await live.runLiveDemo(trained(), NOW), null);
    source = null;
    assert.equal(await live.runLiveDemo(trained(), NOW), null);
    fail = true;
    const quiet = mock.method(console, "error", () => {});
    try {
      assert.equal(await live.runLiveDemo(trained(), NOW), null);
      assert.equal(quiet.mock.callCount(), 1);
    } finally {
      quiet.mock.restore();
    }
  });
});
