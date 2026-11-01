/** npx tsx --test lib/train/host/__tests__/limits.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excessEndpoints, freeSlot, heldToday, mayDeploy, MIN_RUN_MINUTES, planRun, spentToday, stopReasonFor, type HostLimits } from "@/lib/train/host/limits";

const NOW = new Date("2026-11-03T12:00:00Z");
const LIMITS: HostLimits = { dailyUsd: 25, maxLive: 2, idleMinutes: 15, maxMinutes: 240 };
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const money = { heldToday: 0, platformSpend: 0, platformCap: 100 };

describe("planRun", () => {
  it("gives the full time when the budget covers it, and reserves it first", () => {
    assert.deepEqual(planRun({ hourlyUsd: 4.85, gpu: "H100" }, LIMITS, money), { ok: true, minutes: 240, reserveUsd: 19.4 });
  });
  it("cuts the time so an expensive provider can't outspend the budget", () => {
    const plan = planRun({ hourlyUsd: 8, gpu: "H100" }, LIMITS, money);
    assert.ok(plan.ok);
    assert.equal(plan.minutes, 187);
    assert.ok(plan.reserveUsd <= 25);
  });
  it("refuses when what is left can't cover a minimum run", () => {
    const plan = planRun({ hourlyUsd: 8, gpu: "H100" }, LIMITS, { ...money, heldToday: 22 });
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && /left today/.test(plan.message));
    assert.ok(MIN_RUN_MINUTES === 30);
  });
  it("holds to the platform's cap as well", () => {
    assert.equal(planRun({ hourlyUsd: 8, gpu: "H100" }, LIMITS, { ...money, platformSpend: 99.5 }).ok, false);
  });
  it("reserves a job's own dollar limit, whatever its rate", () => {
    assert.deepEqual(planRun({ hourlyUsd: 3.29, gpu: "H100", capUsd: 5, maxMinutes: 45 }, LIMITS, money), { ok: true, minutes: 45, reserveUsd: 5 });
    assert.equal(planRun({ hourlyUsd: 3.29, gpu: "H100", capUsd: 5, maxMinutes: 45 }, LIMITS, { ...money, heldToday: 21 }).ok, false);
  });
  it("refuses with a zero budget", () => {
    assert.equal(planRun({ hourlyUsd: 1, gpu: "L4" }, { ...LIMITS, dailyUsd: 0 }, money).ok, false);
  });
});

describe("money today", () => {
  const row = (over: object) => ({ status: "live" as const, hourlyUsd: 6, reservedUsd: 12, costUsd: null, createdAt: minutesAgo(60), stoppedAt: null, ...over });
  it("holds an open endpoint's reservation and counts only its clock as spent", () => {
    assert.equal(heldToday([row({})], NOW), 12);
    assert.equal(spentToday([row({})], NOW), 6);
  });
  it("counts an overrun past the reservation", () => {
    assert.equal(heldToday([row({ createdAt: minutesAgo(180) })], NOW), 18);
  });
  it("counts a run still open from yesterday, and not one closed yesterday", () => {
    const yesterday = new Date("2026-11-02T23:00:00Z");
    assert.ok(heldToday([row({ createdAt: yesterday })], NOW) > 0);
    assert.equal(heldToday([row({ status: "stopped", costUsd: 3, createdAt: yesterday })], NOW), 0);
  });
});

describe("stopReasonFor", () => {
  const ctx = { limits: LIMITS, spent: 1, on: true, now: NOW };
  const live = { status: "live" as const, stopsAt: new Date(NOW.getTime() + 3_600_000), readyAt: minutesAgo(5), lastUsedAt: null, createdAt: minutesAgo(30) };
  it("leaves a healthy endpoint alone", () => assert.equal(stopReasonFor(live, ctx), null));
  it("stops at the idle limit", () => assert.equal(stopReasonFor({ ...live, readyAt: minutesAgo(15) }, ctx), "idle"));
  it("counts use as activity", () => assert.equal(stopReasonFor({ ...live, readyAt: minutesAgo(60), lastUsedAt: minutesAgo(2) }, ctx), null));
  it("stops at its stop time, however used", () => assert.equal(stopReasonFor({ ...live, stopsAt: NOW, lastUsedAt: NOW }, ctx), "max_time"));
  it("stops at the longest time even if its stop time was later", () => assert.equal(stopReasonFor({ ...live, createdAt: minutesAgo(240), lastUsedAt: NOW }, ctx), "max_time"));
  it("stops at the daily cap, and at a zero cap", () => {
    assert.equal(stopReasonFor(live, { ...ctx, spent: 25 }), "daily_cap");
    assert.equal(stopReasonFor(live, { ...ctx, limits: { ...LIMITS, dailyUsd: 0 } }), "daily_cap");
  });
  it("stops everything with the flag off", () => assert.equal(stopReasonFor(live, { ...ctx, on: false }), "flag_off"));
  it("stops a start that takes too long, but not one under way", () => {
    assert.equal(stopReasonFor({ ...live, status: "starting", readyAt: null, createdAt: minutesAgo(45) }, ctx), "start_timeout");
    assert.equal(stopReasonFor({ ...live, status: "starting", readyAt: null, createdAt: minutesAgo(44) }, ctx), null);
  });
  it("doesn't idle-stop a start", () => assert.equal(stopReasonFor({ ...live, status: "starting", readyAt: null, createdAt: minutesAgo(30) }, ctx), null));
});

describe("slots, excess, who", () => {
  it("finds a free slot or none", () => {
    assert.equal(freeSlot([{ slot: 1 }], 2), 2);
    assert.equal(freeSlot([{ slot: 1 }, { slot: 2 }], 2), null);
    assert.equal(freeSlot([], 0), null);
  });
  it("stops the newest past the limit", () => {
    const rows = [{ createdAt: minutesAgo(30) }, { createdAt: minutesAgo(10) }, { createdAt: minutesAgo(20) }];
    assert.deepEqual(excessEndpoints(rows, 2), [rows[1]]);
  });
  it("admits admins only until opened, and never the shared guest", () => {
    assert.equal(mayDeploy(null, true), false);
    assert.equal(mayDeploy({ isAdmin: true }, false), true);
    assert.equal(mayDeploy({ isAdmin: false }, false), false);
    assert.equal(mayDeploy({ isAdmin: false }, true), true);
    assert.equal(mayDeploy({ isAdmin: false, openAccess: true }, true), false);
  });
});
