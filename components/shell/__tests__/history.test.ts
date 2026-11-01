/**
 * The sidebar's History (lib/shell/history.ts): one row per product, and a shared guest never gets the shared account's list.
 *
 *   npx tsx --test components/shell/__tests__/history.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIdOfPath, HISTORY_IDS, historyFor, historyRows, parseHistoryIds, rememberId } from "@/lib/shell/history";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const build = (id: string, over: { name?: string | null; note?: string | null; slug?: string | null } = {}) => ({ id, name: null, note: null, slug: null, ...over });

function fakeDeps() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      listUserBuilds: async (userId: string) => {
        calls.push(`all:${userId}`);
        return [build(A, { name: "Whole account" })];
      },
      listBuildsByIds: async (userId: string, ids: string[]) => {
        calls.push(`ids:${userId}:${ids.join()}`);
        return [build(B, { name: "Mine" })];
      },
    },
  };
}

describe("History rows", () => {
  it("keeps a product's newest build only, and a build with no product keeps its row", () => {
    const rows = historyRows([
      build(A, { name: "Crumb Counter", slug: "p1" }),
      build(B, { name: "Crumb Counter, older", slug: "p1" }),
      build("c", { note: "A bakery order sheet" }),
      build("d"),
    ]);
    assert.deepEqual(rows, [
      { id: A, title: "Crumb Counter" },
      { id: "c", title: "A bakery order sheet" },
      { id: "d", title: "Untitled muse" },
    ]);
  });

  it("stops at the limit", () => {
    assert.equal(historyRows(Array.from({ length: 30 }, (_, i) => build(`b${i}`)), 20).length, 20);
  });
});

describe("who sees what", () => {
  it("gives nobody signed in nothing, and reads nothing", async () => {
    const { calls, deps } = fakeDeps();
    assert.deepEqual(await historyFor(null, [A], deps), []);
    assert.deepEqual(calls, []);
  });

  it("never lists the shared account for a guest, even with no ids", async () => {
    const { calls, deps } = fakeDeps();
    const guest = { id: "shared", isAdmin: false, openAccess: true };
    assert.deepEqual(await historyFor(guest, [], deps), []);
    assert.deepEqual(calls, []);
    assert.deepEqual(await historyFor(guest, [B], deps), [{ id: B, title: "Mine" }]);
    assert.deepEqual(calls, [`ids:shared:${B}`]);
  });

  it("lists a signed-in person's own builds and ignores the ids", async () => {
    const { calls, deps } = fakeDeps();
    assert.deepEqual(await historyFor({ id: "u1", isAdmin: false }, [B], deps), [{ id: A, title: "Whole account" }]);
    assert.deepEqual(calls, ["all:u1"]);
  });

  it("lists an admin's own builds while sign-in is off", async () => {
    const { calls, deps } = fakeDeps();
    await historyFor({ id: "admin", isAdmin: true, openAccess: true }, [], deps);
    assert.deepEqual(calls, ["all:admin"]);
  });
});

describe("the ids a browser keeps", () => {
  it("takes only well-formed, unique ids, up to the cap", () => {
    assert.deepEqual(parseHistoryIds(`${A},nope,${A.toUpperCase()},,'; drop table builds`), [A]);
    assert.deepEqual(parseHistoryIds(null), []);
    const many = Array.from({ length: 80 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    assert.equal(parseHistoryIds(many).length, HISTORY_IDS);
  });

  it("finds the build on its room's paths only", () => {
    assert.equal(buildIdOfPath(`/b/${A}`), A);
    assert.equal(buildIdOfPath(`/b/${A}/more`), A);
    assert.equal(buildIdOfPath("/b/not-a-build"), null);
    assert.equal(buildIdOfPath("/builds"), null);
  });

  it("moves the newest to the front without repeating it", () => {
    assert.deepEqual(rememberId([A, B], B), [B, A]);
  });
});
