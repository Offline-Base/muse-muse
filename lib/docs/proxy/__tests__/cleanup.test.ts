import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDocsObjects,
  DOCS_CLEANUP_BUDGET_MS,
  deleteUpstreamObject,
  retrieveUpstreamResponse,
  type DocsCleanupDeps,
} from "@/lib/docs/proxy/cleanup";
import type { DocsObjectKind } from "@/lib/docs/proxy/endpoints";
import type { DocsHoldState } from "@/lib/docs/proxy/types";
import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;

interface Row {
  id: string;
  kind: DocsObjectKind;
  ageHours: number;
  hold?: DocsHoldState | null;
}

function fakeCleanup(
  rows: Row[],
  upstream: (kind: DocsObjectKind, id: string) => "gone" | "failed",
  responses: (id: string) => { status: number; json: unknown } | null = () => ({ status: 404, json: null }),
) {
  const table = rows.map((r) => ({ ...r }));
  const deleted: string[] = [];
  const settled: Array<{ reservation: string; item: ModelUsage | null }> = [];
  const counters = new Map<string, number>();
  const deps: DocsCleanupDeps = {
    stale: async (kind, before, limit) =>
      table
        .filter((r) => r.kind === kind && NOW.getTime() - r.ageHours * HOUR < before.getTime())
        .sort((a, b) => b.ageHours - a.ageHours)
        .slice(0, limit)
        .map((r) => r.id),
    deleteUpstream: async (kind, id) => {
      deleted.push(`${kind}:${id}`);
      return upstream(kind, id);
    },
    forget: async (ids) => {
      let n = 0;
      for (const id of ids) {
        const i = table.findIndex((r) => r.id === id);
        if (i >= 0) {
          table.splice(i, 1);
          n++;
        }
      }
      return n;
    },
    pendingHolds: async (before, limit) =>
      table
        .filter((r) => r.hold && NOW.getTime() - r.ageHours * HOUR < before.getTime())
        .sort((a, b) => b.ageHours - a.ageHours)
        .slice(0, limit)
        .map((r) => ({ id: r.id, hold: r.hold as DocsHoldState })),
    retrieveResponse: async (id) => responses(id),
    claimHold: async (id) => {
      const row = table.find((r) => r.id === id);
      const hold = row?.hold ?? null;
      if (row) row.hold = null;
      return hold;
    },
    settleSpend: async (reservation, item) => {
      settled.push({ reservation, item });
    },
    recordUsage: async () => {},
    adjustCounter: async (key, windowStart, delta) => {
      const at = `${key}|${windowStart.toISOString()}`;
      counters.set(at, Math.max(0, (counters.get(at) ?? 0) + delta));
    },
  };
  return { deps, table, deleted, settled, counters };
}

test("files go after an hour and stored responses after a day, at Meta and in the table", async () => {
  const c = fakeCleanup(
    [
      { id: "file-new", kind: "file", ageHours: 0.5 },
      { id: "file-old", kind: "file", ageHours: 2 },
      { id: "resp_new", kind: "response", ageHours: 5 },
      { id: "resp_old", kind: "response", ageHours: 25 },
    ],
    () => "gone",
  );
  const result = await cleanupDocsObjects(c.deps, NOW);
  assert.deepEqual(result, {
    docsBackground: { ok: true, count: 0 },
    docsFiles: { ok: true, count: 1 },
    docsResponses: { ok: true, count: 1 },
  });
  assert.deepEqual(c.deleted.sort(), ["file:file-old", "response:resp_old"]);
  assert.deepEqual(c.table.map((r) => r.id).sort(), ["file-new", "resp_new"]);
});

test("best effort: a failed delete stays for the next run, and is dropped after a week", async () => {
  const c = fakeCleanup(
    [
      { id: "file-stuck", kind: "file", ageHours: 3 },
      { id: "file-ancient", kind: "file", ageHours: 24 * 8 },
      { id: "file-ok", kind: "file", ageHours: 3 },
    ],
    (_kind, id) => (id === "file-ok" ? "gone" : "failed"),
  );
  const result = await cleanupDocsObjects(c.deps, NOW);
  assert.deepEqual(result.docsFiles, { ok: true, count: 1 });
  assert.deepEqual(c.table.map((r) => r.id), ["file-stuck"]);
});

test("one kind failing doesn't stop the other", async () => {
  const c = fakeCleanup([{ id: "resp_old", kind: "response", ageHours: 30 }], () => "gone");
  const deps: DocsCleanupDeps = {
    ...c.deps,
    stale: async (kind, before, limit) => {
      if (kind === "file") throw new Error("database is down");
      return c.deps.stale(kind, before, limit);
    },
  };
  const result = await cleanupDocsObjects(deps, NOW);
  assert.deepEqual(result.docsFiles, { ok: false, error: "database is down" });
  assert.deepEqual(result.docsResponses, { ok: true, count: 1 });
});

test("deleteUpstreamObject: DELETE with the key; 2xx and 404 are gone, anything else failed", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchWith = (status: number) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status });
    }) as typeof fetch;
  assert.equal(await deleteUpstreamObject(fetchWith(200), "https://api.meta.test/v1", "k", "file", "file-1"), "gone");
  assert.equal(calls[0].url, "https://api.meta.test/v1/files/file-1");
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer k");
  assert.equal(await deleteUpstreamObject(fetchWith(404), "https://api.meta.test/v1", "k", "response", "resp_1"), "gone");
  assert.equal(calls[1].url, "https://api.meta.test/v1/responses/resp_1");
  assert.equal(await deleteUpstreamObject(fetchWith(500), "https://api.meta.test/v1", "k", "file", "file-1"), "failed");
  const broken = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await deleteUpstreamObject(broken, "https://api.meta.test/v1", "k", "file", "file-1"), "failed");
});

test("the cleanup works through every stale file in batches, not just the first hundred", async () => {
  const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({ id: `file-${i}`, kind: "file" as const, ageHours: 2 + i / 1000 }));
  const c = fakeCleanup(rows, () => "gone");
  const result = await cleanupDocsObjects(c.deps, NOW);
  assert.deepEqual(result.docsFiles, { ok: true, count: 250 });
  assert.equal(c.table.length, 0);
});

test("the cleanup stops at a batch that deletes nothing, and when its time is up", async () => {
  const stuck = fakeCleanup(
    Array.from({ length: 150 }, (_, i) => ({ id: `file-${i}`, kind: "file" as const, ageHours: 2 })),
    () => "failed",
  );
  const result = await cleanupDocsObjects(stuck.deps, NOW);
  assert.deepEqual(result.docsFiles, { ok: true, count: 0 });
  assert.equal(stuck.deleted.length, 100, "one batch tried, then it waits for the next run");

  let now = 0;
  const slow = fakeCleanup(
    Array.from({ length: 300 }, (_, i) => ({ id: `file-${i}`, kind: "file" as const, ageHours: 2 })),
    () => {
      now += DOCS_CLEANUP_BUDGET_MS / 50;
      return "gone";
    },
  );
  const timed = await cleanupDocsObjects({ ...slow.deps, clock: () => now }, NOW);
  assert.ok(timed.docsFiles.ok && timed.docsFiles.count < 300, "no new deletes start after the budget");
  assert.ok(slow.deleted.length <= 50 + 4, `${slow.deleted.length} deletes`);
});

const hold = (reservation: string, micros: number): DocsHoldState => ({
  reservation,
  model: "muse-spark-1.3-contributor",
  micros,
  usdKey: "docs-usd:203.0.113.9",
  day: "2026-10-31T00:00:00.000Z",
});

test("the sweep settles finished background responses from Meta's usage, once, and leaves running ones", async () => {
  const usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300 };
  const c = fakeCleanup(
    [
      { id: "resp_done", kind: "response", ageHours: 0.5, hold: hold("res-done", 120_000) },
      { id: "resp_running", kind: "response", ageHours: 0.5, hold: hold("res-running", 120_000) },
      { id: "resp_gone", kind: "response", ageHours: 0.5, hold: hold("res-gone", 120_000) },
      { id: "resp_bare", kind: "response", ageHours: 0.5, hold: hold("res-bare", 120_000) },
      { id: "resp_new", kind: "response", ageHours: 0.001, hold: hold("res-new", 120_000) },
      { id: "resp_plain", kind: "response", ageHours: 0.5 },
    ],
    () => "gone",
    (id) =>
      ({
        resp_done: { status: 200, json: { id, status: "completed", output: [], usage } },
        resp_running: { status: 200, json: { id, status: "in_progress", usage: null } },
        resp_bare: { status: 200, json: { id, status: "failed", usage: null } },
      })[id] ?? { status: 404, json: { error: { message: "No such response" } } },
  );
  const result = await cleanupDocsObjects(c.deps, NOW);
  assert.deepEqual(result.docsBackground, { ok: true, count: 1 });
  const cost = usageCost({ model: "muse-spark-1.3-contributor", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300 });
  assert.deepEqual(c.settled.map((s) => [s.reservation, s.item?.costUsd]), [["res-done", cost]]);
  assert.equal(c.counters.get("docs-usd:203.0.113.9|2026-10-31T00:00:00.000Z"), 0, "the IP's counter gave back the worst case");
  const holds = Object.fromEntries(c.table.map((r) => [r.id, r.hold ? r.hold.reservation : null]));
  assert.equal(holds.resp_done, null, "settled");
  assert.equal(holds.resp_running, "res-running", "still running: looked up again next run");
  assert.equal(holds.resp_gone, null, "gone at Meta: the worst case stays as the charge");
  assert.equal(holds.resp_bare, null, "finished without usage: the worst case stays, and it isn't looked up again");
  assert.equal(holds.resp_new, "res-new", "too new: the reader is still polling it");

  // A second sweep finds nothing more to settle.
  const again = await cleanupDocsObjects(c.deps, NOW);
  assert.deepEqual(again.docsBackground, { ok: true, count: 0 });
  assert.equal(c.settled.length, 1);
});

test("retrieveUpstreamResponse: GET with the key, status and JSON back, null when Meta can't be reached", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const ok = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({ id: "resp_1", status: "completed" });
  }) as typeof fetch;
  assert.deepEqual(await retrieveUpstreamResponse(ok, "https://api.meta.test/v1", "k", "resp_1"), {
    status: 200,
    json: { id: "resp_1", status: "completed" },
  });
  assert.equal(calls[0].url, "https://api.meta.test/v1/responses/resp_1");
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer k");
  const broken = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await retrieveUpstreamResponse(broken, "https://api.meta.test/v1", "k", "resp_1"), null);
});
