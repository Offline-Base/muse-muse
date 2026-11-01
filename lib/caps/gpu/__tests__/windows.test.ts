/**
 * Demo windows (docs/CAPABILITIES.md, section 17): opening within the cap, the reservation, closing, settling, the sweep, on
 * fakes. launchJob is a fake: no GPU starts.
 *
 *   npx tsx --test lib/caps/gpu/__tests__/windows.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GlimmerWindow } from "@/lib/caps/gpu/types";
import { closeWindow, openWindow, sweepWindows, windowView, WINDOW_MODEL, type WindowDeps, type WindowJob } from "@/lib/caps/gpu/windows";
import type { LaunchInput } from "@/lib/train/launch";
import type { TrainJobRow } from "@/lib/train/logic";

const NOW = new Date("2026-11-03T15:00:00Z");
const ADAPTER = "aaaaaaaa-0000-4000-8000-000000000001";
const SERVE = "cccccccc-0000-4000-8000-000000000001";

let rows: GlimmerWindow[];
let reservations: Map<string, { model: string | null; usd: number; settled?: { costUsd: number } | null }>;
let launches: LaunchInput[];
let job: WindowJob | null;
let stops: string[];
let launch: WindowDeps["launch"];

function deps(over: Partial<WindowDeps> = {}): WindowDeps {
  return {
    dailyUsd: () => 15,
    dailySpendCapUsd: () => 100,
    jobCeilings: () => ({ maxMinutes: 300, maxUsd: 5 }),
    platformSpendToday: async () => 0,
    reservedToday: async () => rows.filter((r) => r.status !== "failed").reduce((n, r) => n + (r.costUsd ?? r.capUsd), 0),
    adapter: async (id) => (id === ADAPTER ? { job: { params: { baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } }, metrics: null } : null),
    async insert(input) {
      if (rows.some((r) => r.status === "open")) return null;
      const row: GlimmerWindow = { id: `w${rows.length + 1}`, status: "open", costUsd: null, serveJobId: null, createdAt: NOW, ...input };
      rows.push(row);
      return row;
    },
    get: async (id) => rows.find((r) => r.id === id) ?? null,
    unsettled: async () => rows.filter((r) => r.status === "open" || r.status === "closing"),
    async attach(id, serveJobId) {
      rows.find((r) => r.id === id)!.serveJobId = serveJobId;
    },
    async move(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r || (r.status !== "open" && r.status !== "closing")) return null;
      Object.assign(r, patch);
      return r;
    },
    async reserveSpend(ctx, model, usd) {
      assert.equal(ctx.source, "glimmer");
      const id = `r${reservations.size + 1}`;
      reservations.set(id, { model, usd });
      return id;
    },
    async settleSpend(id, item) {
      reservations.get(id)!.settled = item ? { costUsd: item.costUsd } : null;
    },
    launch: (input, caller) => launch(input, caller),
    job: async () => job,
    async stop(id) {
      stops.push(id);
    },
    ...over,
  };
}

const open = (input: Record<string, unknown> = {}, d = deps()) => openWindow({ adapterJobId: ADAPTER, ...input }, { userId: "admin" }, d, NOW);
const running: WindowJob = { status: "running", costUsd: 0.4, instanceId: "i-1", terminatedAt: null, stopRequested: false };
const finished: WindowJob = { status: "succeeded", costUsd: 1.1, instanceId: "i-1", terminatedAt: NOW, stopRequested: true };

beforeEach(() => {
  rows = [];
  reservations = new Map();
  launches = [];
  job = running;
  stops = [];
  launch = async (input) => {
    launches.push(input);
    return { ok: true, job: { id: SERVE } as TrainJobRow };
  };
});

describe("opening a window", () => {
  it("starts one serve job, sends its own limits, and reserves exactly what it may spend", async () => {
    const got = await open({ minutes: 30 });
    assert.ok(got.ok);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.recipe, "glimmer-serve");
    assert.equal(launches[0]!.params.adapterJobId, ADAPTER);
    assert.equal(launches[0]!.params.minutes, 30);
    assert.equal(launches[0]!.maxUsd, got.window.capUsd);
    assert.equal(reservations.get("r1")!.usd, got.window.capUsd);
    assert.equal(reservations.get("r1")!.model, WINDOW_MODEL);
    assert.equal(got.window.serveJobId, SERVE);
    assert.equal(got.window.status, "open");
    assert.equal(got.window.sparkOpen, true);
    assert.equal(got.window.endsAt.getTime() - got.window.startsAt.getTime(), (30 + 15) * 60_000, "serving minutes plus the boot");
  });

  it("is paused at a daily cap of 0, before anything starts", async () => {
    const got = await open({}, deps({ dailyUsd: () => 0 }));
    assert.ok(!got.ok);
    assert.equal(got.status, 503);
    assert.equal(got.code, "caps_paused");
    assert.equal(launches.length, 0);
  });

  it("refuses a window the daily cap can't cover, counting today's windows", async () => {
    assert.ok((await open()).ok);
    const cap = rows[0]!.capUsd;
    await closeWindow("w1", deps({ job: async () => finished }));
    const got = await open({}, deps({ dailyUsd: () => rows[0]!.costUsd! + cap - 0.01 }));
    assert.ok(!got.ok);
    assert.equal(got.code, "budget_exceeded");
    assert.equal(got.status, 429);
    assert.equal(launches.length, 1, "no second GPU");
  });

  it("refuses when the platform's daily spend cap can't cover it", async () => {
    const got = await open({}, deps({ platformSpendToday: async () => 99.9 }));
    assert.ok(!got.ok);
    assert.equal(got.code, "budget_exceeded");
  });

  it("allows one window at a time, and gives the second's reservation back", async () => {
    assert.ok((await open()).ok);
    const got = await open();
    assert.ok(!got.ok);
    assert.equal(got.code, "window_open");
    assert.equal(reservations.get("r2")!.settled, null);
    assert.equal(launches.length, 1);
  });

  it("refuses a bad adapter and bad minutes before any money moves", async () => {
    for (const input of [{ adapterJobId: "nope" }, { adapterJobId: "dddddddd-0000-4000-8000-000000000009" }, { minutes: "soon" }, { adapterJobId: undefined }]) {
      const got = await open(input);
      assert.ok(!got.ok, JSON.stringify(input));
      assert.equal(got.status, 400);
    }
    assert.equal(reservations.size, 0);
  });

  it("gives everything back when the lab refuses the GPU, and says why in plain words", async () => {
    launch = async () => ({ ok: false, status: 409, code: "too_many_active", body: { max: 1 } });
    const got = await open();
    assert.ok(!got.ok);
    assert.equal(got.status, 409);
    assert.equal(got.code, "too_many_active");
    assert.match(got.message, /only slot/);
    assert.equal(rows[0]!.status, "failed");
    assert.equal(reservations.get("r1")!.settled, null);
    assert.ok((await open({}, deps({ launch: async () => ({ ok: true, job: { id: SERVE } as TrainJobRow }) }))).ok, "a failed window doesn't block the next");
  });

  it("gives everything back when launching throws", async () => {
    launch = async () => {
      throw new Error("workflow down");
    };
    await assert.rejects(() => open());
    assert.equal(rows[0]!.status, "failed");
    assert.equal(reservations.get("r1")!.settled, null);
  });

  it("shares a Try it live GPU that's already up for that adapter", async () => {
    launch = async () => ({ ok: false, status: 409, code: "demo_running", body: { serveJobId: "eeeeeeee-0000-4000-8000-000000000001" } });
    const got = await open();
    assert.ok(got.ok);
    assert.equal(got.window.serveJobId, "eeeeeeee-0000-4000-8000-000000000001");
  });

  it("marks a plain Glimmer adapter as no Derivative", async () => {
    const got = await open({}, deps({ adapter: async () => ({ job: { params: {} }, metrics: null }) }));
    assert.ok(got.ok);
    assert.equal(got.window.sparkOpen, false);
  });
});

describe("closing a window", () => {
  it("asks the GPU to stop, then settles at the real cost once it's down", async () => {
    await open();
    const closing = await closeWindow("w1", deps());
    assert.equal(closing?.status, "closing");
    assert.deepEqual(stops, [SERVE]);
    assert.equal(reservations.get("r1")!.settled, undefined, "the GPU still bills");
    job = finished;
    assert.equal(await sweepWindows(NOW, deps()), 1);
    assert.equal(rows[0]!.status, "closed");
    assert.equal(rows[0]!.costUsd, 1.1);
    assert.deepEqual(reservations.get("r1")!.settled, { costUsd: 1.1 });
  });

  it("settles at once when the GPU is already down, and only once", async () => {
    await open();
    job = finished;
    assert.equal((await closeWindow("w1", deps()))?.status, "closed");
    assert.equal(stops.length, 0);
    reservations.get("r1")!.settled = { costUsd: -1 };
    assert.equal((await closeWindow("w1", deps()))?.status, "closed");
    assert.deepEqual(reservations.get("r1")!.settled, { costUsd: -1 }, "a second close changes nothing");
  });

  it("settles a job that never got a GPU at what it cost", async () => {
    await open();
    job = { status: "failed", costUsd: 0, instanceId: null, terminatedAt: null, stopRequested: false };
    assert.equal((await closeWindow("w1", deps()))?.status, "closed");
    assert.deepEqual(reservations.get("r1")!.settled, { costUsd: 0 });
  });

  it("answers null for a window that doesn't exist", async () => {
    assert.equal(await closeWindow("nope", deps()), null);
  });
});

describe("the sweep", () => {
  it("leaves a running window alone until its end, then stops its GPU", async () => {
    await open();
    assert.equal(await sweepWindows(NOW, deps()), 0);
    assert.equal(stops.length, 0);
    const later = new Date(rows[0]!.endsAt.getTime() + 1);
    assert.equal(await sweepWindows(later, deps()), 1);
    assert.deepEqual(stops, [SERVE]);
    assert.equal(rows[0]!.status, "closing");
  });

  it("settles a window whose job failed under it", async () => {
    await open();
    job = { status: "failed", costUsd: 0.2, instanceId: "i-1", terminatedAt: NOW, stopRequested: false };
    await sweepWindows(NOW, deps());
    assert.equal(rows[0]!.status, "closed");
    assert.equal(rows[0]!.costUsd, 0.2);
  });

  it("doesn't touch a window still attaching its job, but settles a stale one", async () => {
    await open();
    rows[0]!.serveJobId = null;
    job = null;
    assert.equal(await sweepWindows(new Date(NOW.getTime() + 60_000), deps()), 0);
    assert.equal(await sweepWindows(new Date(NOW.getTime() + 6 * 60_000), deps()), 1);
    assert.deepEqual(reservations.get("r1")!.settled, { costUsd: 0 });
  });
});

describe("what an admin sees", () => {
  it("is never an address, a key or a token", async () => {
    const got = await open();
    assert.ok(got.ok);
    assert.deepEqual(Object.keys(windowView(got.window)).sort(), ["adapterJobId", "capUsd", "costUsd", "endsAt", "id", "serveJobId", "startsAt", "status"].sort());
  });
});
