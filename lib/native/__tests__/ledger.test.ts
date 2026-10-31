/**
 * The spend ledger on a real Postgres (PGlite): caps of $150 total, Device Farm $40 and Windows $15, holds that take both
 * rows or neither, commits that give back holds, the Mac's projection and the alert at $120. native_budget always
 * matches what native_spend says happened.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/ledger.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { sql } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const SAVED = { ...process.env };

describe("the spend ledger", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let testDb: TestDb;
  let client: import("@electric-sql/pglite").PGlite;
  let close: () => Promise<void>;
  let ledger: typeof import("@/lib/native/ledger");

  before(async () => {
    const { makeTestDb } = await import("./helpers");
    ({ db: testDb, client, close } = await makeTestDb());
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    ledger = await import(at("../ledger.ts"));
  });
  after(async () => {
    await close();
    process.env = { ...SAVED };
  });
  beforeEach(async () => {
    await testDb.delete(realSchema.nativeSpend);
    await testDb.delete(realSchema.nativeBudget);
    for (const key of ["NATIVE_SPEND_CAP_USD", "NATIVE_SPEND_ALERT_USD", "NATIVE_DEVICE_FARM_CAP_USD", "NATIVE_WINDOWS_CAP_USD", "NATIVE_MAC_ALLOCATED_AT", "NATIVE_MAC_RELEASE_AT", "NATIVE_MAC_HOURLY_USD", "NATIVE_WINDOWS_HOURLY_USD"]) {
      delete process.env[key];
    }
  });

  /** native_budget has to be what the rows in native_spend add up to. */
  async function assertBooksAgree() {
    const spend = await testDb.select().from(realSchema.nativeSpend);
    const budget = await testDb.select().from(realSchema.nativeBudget);
    const cents = (usd: number) => ledger.toCents(usd);
    for (const lane of ["windows", "device_farm", "mac"] as const) {
      const rows = spend.filter((s) => s.lane === lane);
      const row = budget.find((b) => b.lane === lane);
      const reserved = rows.reduce((sum, s) => sum + (s.kind === "reserve" ? cents(s.usd) : s.kind === "release" ? -cents(s.usd) : 0), 0);
      const committed = rows.reduce((sum, s) => sum + (s.kind === "commit" ? Math.round(s.usd * 100) : 0), 0);
      assert.equal(row?.reservedCents ?? 0, Math.max(0, reserved), `${lane} reserved`);
      assert.equal(row?.committedCents ?? 0, committed, `${lane} committed`);
    }
    const others = budget.filter((b) => b.lane !== "total");
    const total = budget.find((b) => b.lane === "total");
    assert.equal(total?.reservedCents ?? 0, others.reduce((n, b) => n + b.reservedCents, 0), "total reserved");
    assert.equal(total?.committedCents ?? 0, others.reduce((n, b) => n + b.committedCents, 0), "total committed");
  }

  it("uses the agreed caps by default: $150 total, $40 Device Farm, $15 Windows, an alert at $120", async () => {
    assert.deepEqual(ledger.spendCaps(), { mac: null, windows: 15, device_farm: 40, total: 150 });
    assert.equal((await ledger.spendView()).alertUsd, 120);
  });

  it("holds on the budget and the total, then commits what it cost and gives back the hold", async () => {
    assert.deepEqual(await ledger.reserve("device_farm", 0.85, { ref: "run-1" }), { ok: true, usd: 0.85 });
    let view = await ledger.spendView();
    assert.equal(view.lanes.device_farm.reservedUsd, 0.85);
    assert.equal(view.lanes.total.reservedUsd, 0.85);
    await ledger.commit("device_farm", { usd: 0.34, holdUsd: 0.85, ref: "run-1" });
    view = await ledger.spendView();
    assert.equal(view.lanes.device_farm.reservedUsd, 0);
    assert.equal(view.lanes.device_farm.committedUsd, 0.34);
    assert.equal(view.lanes.total.committedUsd, 0.34);
    await assertBooksAgree();
  });

  it("refuses a hold past the budget's cap, and leaves no trace of it", async () => {
    assert.equal((await ledger.reserve("windows", 14.5)).ok, true);
    const refused = await ledger.reserve("windows", 1);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, "lane_cap");
    assert.equal((await ledger.spendView()).lanes.total.reservedUsd, 14.5);
    assert.equal((await testDb.select().from(realSchema.nativeSpend)).length, 1);
    assert.equal(await ledger.canSpend("windows", 1), false);
    assert.equal(await ledger.canSpend("windows", 0.5), true);
    assert.equal((await ledger.reserve("windows", 0.5)).ok, true, "up to the cap exactly is fine");
    await assertBooksAgree();
  });

  it("refuses a hold that fits its budget but not the total", async () => {
    process.env.NATIVE_SPEND_CAP_USD = "20";
    assert.equal((await ledger.reserve("device_farm", 18)).ok, true);
    const refused = await ledger.reserve("windows", 5);
    assert.equal(refused.ok === false && refused.reason, "total_cap");
    assert.equal(await ledger.canSpend("windows", 5), false);
    assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 0);
    await assertBooksAgree();
  });

  it("refuses a hold of nothing", async () => {
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const refused = await ledger.reserve("windows", usd);
      assert.equal(refused.ok === false && refused.reason, "bad_amount");
    }
  });

  it("gives a released hold back, so it can be held again", async () => {
    assert.equal((await ledger.reserve("windows", 15)).ok, true);
    assert.equal((await ledger.reserve("windows", 1)).ok, false);
    await ledger.release("windows", 15, { ref: "x" });
    assert.equal((await ledger.reserve("windows", 15)).ok, true);
    await assertBooksAgree();
  });

  it("a commit past the cap still records the money, and then refuses what comes next", async () => {
    assert.equal((await ledger.reserve("windows", 1)).ok, true);
    await ledger.commit("windows", { usd: 16, holdUsd: 1 });
    const view = await ledger.spendView();
    assert.equal(view.lanes.windows.committedUsd, 16);
    assert.equal((await ledger.reserve("windows", 0.01)).ok, false);
    await assertBooksAgree();
  });

  it("projects the Mac from allocation to release, at 24 hours at least, and commits it once", async () => {
    assert.equal(ledger.macProjectedUsd(), 0, "nothing until it's allocated");
    await ledger.syncMacHost();
    assert.equal((await ledger.spendView()).lanes.mac.committedUsd, 0);

    process.env.NATIVE_MAC_ALLOCATED_AT = "2026-11-01T02:00:00Z";
    process.env.NATIVE_MAC_RELEASE_AT = "2026-11-05T02:00:00Z";
    assert.ok(Math.abs(ledger.macProjectedUsd() - 96 * 0.65) < 1e-9);
    await ledger.syncMacHost();
    await ledger.syncMacHost();
    let view = await ledger.spendView();
    assert.equal(view.lanes.mac.committedUsd, 62.4);
    assert.equal(view.lanes.total.committedUsd, 62.4);
    assert.equal((await testDb.select().from(realSchema.nativeSpend)).length, 1, "a repeat writes nothing");

    process.env.NATIVE_MAC_RELEASE_AT = "2026-11-01T03:00:00Z";
    assert.ok(Math.abs(ledger.macProjectedUsd() - 24 * 0.65) < 1e-9, "the host's 24-hour minimum");
    await ledger.syncMacHost();
    view = await ledger.spendView();
    assert.equal(view.lanes.mac.committedUsd, 15.6);
    assert.equal(view.lanes.total.committedUsd, 15.6);
    await assertBooksAgree();
  });

  it("uses Nov 4, 9 PM ET as the Mac's release when none is set", async () => {
    process.env.NATIVE_MAC_ALLOCATED_AT = "2026-11-01T02:00:00Z";
    assert.ok(Math.abs(ledger.macProjectedUsd() - 96 * 0.65) < 1e-9);
  });

  it("the Mac's fixed cost counts against what the total can still hold", async () => {
    process.env.NATIVE_MAC_ALLOCATED_AT = "2026-11-01T02:00:00Z";
    process.env.NATIVE_MAC_RELEASE_AT = "2026-11-05T02:00:00Z";
    process.env.NATIVE_SPEND_CAP_USD = "70";
    await ledger.syncMacHost();
    assert.equal((await ledger.reserve("device_farm", 8)).ok, false);
    assert.equal((await ledger.reserve("device_farm", 7)).ok, true);
  });

  it("alerts at the line, counting holds", async () => {
    process.env.NATIVE_SPEND_ALERT_USD = "10";
    assert.equal((await ledger.spendView()).alerting, false);
    assert.equal((await ledger.reserve("device_farm", 9.99)).ok, true);
    assert.equal((await ledger.spendView()).alerting, false);
    assert.equal((await ledger.reserve("device_farm", 0.01)).ok, true);
    assert.equal((await ledger.spendView()).alerting, true);
  });

  describe("two ledger calls at once", () => {
    /** The statements a call sends, in order. PGlite has one connection, so the order is all a test here can hold. */
    async function statementsOf(call: () => Promise<unknown>): Promise<string[]> {
      const sent: string[] = [];
      const real = client.query.bind(client);
      const spy = mock.method(client, "query", (text: string, ...rest: unknown[]) => {
        sent.push(text.replace(/\s+/g, " "));
        return (real as (...args: unknown[]) => unknown)(text, ...rest);
      });
      try {
        await call();
      } finally {
        spy.mock.restore();
      }
      return sent;
    }
    const LOCK = /^select lane from native_budget where lane in \(\$1, 'total'\) order by lane for update/;
    const touchesBudget = (s: string) => /^(with .*)?update "?native_budget"?/.test(s) || /update native_budget/.test(s);

    for (const [name, call] of [
      ["commit", () => ledger.commit("windows", { usd: 1, holdUsd: 1 })],
      ["release", () => ledger.release("windows", 1)],
      ["commitIf", () => ledger.commitIf("windows", { usd: 1, holdUsd: 1 }, sql`select 1 as won`)],
      ["reserve", () => ledger.reserve("windows", 1)],
    ] as const) {
      it(`${name} locks both budgets in reserve's order before it changes one, so no two can deadlock`, async () => {
        const sent = await statementsOf(call);
        const lock = sent.findIndex((s) => LOCK.test(s));
        const change = sent.findIndex(touchesBudget);
        assert.ok(lock >= 0, `no lock in: ${sent.join(" | ")}`);
        assert.ok(change > lock, `the change came first: ${sent.join(" | ")}`);
      });
    }
  });

  describe("a commit tied to another change", () => {
    it("lands with what it's tied to", async () => {
      await ledger.reserve("windows", 2);
      const won = await ledger.commitIf("windows", { usd: 0.5, holdUsd: 2, ref: "r", note: "n" }, sql`select 1 as won`);
      assert.equal(won, true);
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.committedUsd, 0.5);
      assert.equal(view.lanes.windows.reservedUsd, 0);
      assert.equal(view.lanes.total.committedUsd, 0.5);
      assert.equal(view.lanes.total.reservedUsd, 0);
      const spend = await testDb.select().from(realSchema.nativeSpend);
      assert.deepEqual(spend.map((s) => s.kind).sort(), ["commit", "release", "reserve"]);
      assert.ok(spend.filter((s) => s.kind !== "reserve").every((s) => s.ref === "r" && s.note === "n" && s.lane === "windows"));
      await assertBooksAgree();
    });

    it("leaves no trace when that change finds nothing to do", async () => {
      await ledger.reserve("windows", 2);
      const won = await ledger.commitIf("windows", { usd: 0.5, holdUsd: 2 }, sql`select 1 as won where false`);
      assert.equal(won, false);
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.committedUsd, 0);
      assert.equal(view.lanes.windows.reservedUsd, 2);
      assert.deepEqual((await testDb.select().from(realSchema.nativeSpend)).map((s) => s.kind), ["reserve"]);
      await assertBooksAgree();
    });

    it("writes no release row when there was no hold", async () => {
      assert.equal(await ledger.commitIf("windows", { usd: 0.5 }, sql`select 1 as won`), true);
      assert.deepEqual((await testDb.select().from(realSchema.nativeSpend)).map((s) => s.kind), ["commit"]);
      await assertBooksAgree();
    });
  });

  it("rounds a hold up to the cent, so the budget is never short", () => {
    assert.equal(ledger.toCents(0.166), 17);
    assert.equal(ledger.toCents(0.17), 17);
    assert.equal(ledger.toCents(1.1), 110, "no floating point surprise");
  });
});
