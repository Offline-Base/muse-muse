import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogTool } from "@/lib/tools/catalog";
import { classifyFailure, replyFailed, sweepAccounts, untilAborted, type AccountsApi } from "@/lib/tools/composio/client";
import { ensureToolSession, sessionConfigFor, sessionConfigHash } from "@/lib/tools/composio/sessions";
import type { CatalogTool } from "@/lib/tools/composio/sync";
import { fakeComposio, PRODUCT } from "@/lib/tools/__tests__/helpers";

const tools = (...ids: string[]) => ids.map((id) => catalogTool(id) as CatalogTool);

/** The shapes the spike saw: status on the error, and the body in `error` or only in the message. */
function apiError(status: number, code: number, slug: string) {
  return Object.assign(new Error(`${status} ${JSON.stringify({ error: { message: "m", code, slug, status } })}`), { status, error: { error: { message: "m", code, slug, status } } });
}

test("400 codes map as the spike found", () => {
  assert.deepEqual(classifyFailure(apiError(400, 4302, "ToolRouterV2_NoActiveConnection")), { kind: "no_connection" });
  assert.deepEqual(classifyFailure(apiError(400, 4310, "ToolRouterV2_ToolNotInEnabledList")), { kind: "not_enabled" });
  assert.deepEqual(classifyFailure(Object.assign(new Error(`400 ${JSON.stringify({ error: { code: 4302 } })}`), { status: 400 })), { kind: "no_connection" });
});

test("a whole toolkit off (4324, seen live) is the same refusal as one tool off", () => {
  assert.deepEqual(classifyFailure(apiError(400, 4324, "ToolRouterV2_ToolkitNotAllowed")), { kind: "not_enabled" });
});

test("a failed reply is resultType failed, or a completed one saying success: false, as an unreachable host does", () => {
  assert.equal(replyFailed({ resultType: "failed", data: null }), true);
  assert.equal(replyFailed({ resultType: "blocked", data: null }), true);
  assert.equal(replyFailed({ resultType: "completed", data: { code: "SCRAPE_DNS_RESOLUTION_ERROR", error: "DNS resolution failed", success: false } }), true);
  assert.equal(replyFailed({ resultType: "completed", data: { data: {}, success: true } }), false);
  assert.equal(replyFailed({ resultType: "completed", data: null }), false);
});

test("a completed reply that says no is a failure, with or without a reason: Slack answers ok: false", () => {
  assert.equal(replyFailed({ resultType: "completed", data: { ok: false, error: "channel_not_found" } }), true);
  assert.equal(replyFailed({ resultType: "completed", data: { success: false } }), true);
  assert.equal(replyFailed({ resultType: "completed", data: { ok: true, ts: "1" } }), false);
});

function accountsApi(pages: Array<{ items: Array<{ id: string }>; nextCursor?: string | null }>, fail: Record<string, unknown> = {}) {
  const queries: Array<Parameters<AccountsApi["list"]>[0]> = [];
  const deleted: string[] = [];
  const api: AccountsApi = {
    list: async (query) => {
      queries.push(query);
      return pages[queries.length - 1];
    },
    delete: async (id) => {
      if (fail[id]) throw fail[id];
      deleted.push(id);
    },
  };
  return { api, queries, deleted };
}

test("a sweep asks by user with no status filter, follows pages, and leaves `keep`", async () => {
  const { api, queries, deleted } = accountsApi([{ items: [{ id: "a" }, { id: "keep" }], nextCursor: "next" }, { items: [{ id: "b" }], nextCursor: null }]);
  assert.equal(await sweepAccounts(api, "mmo_x", { toolkit: "gmail", keep: "keep" }), 2);
  assert.deepEqual(deleted, ["a", "b"]);
  assert.deepEqual(queries, [{ userIds: ["mmo_x"], toolkitSlugs: ["gmail"], limit: 100 }, { userIds: ["mmo_x"], toolkitSlugs: ["gmail"], limit: 100, cursor: "next" }]);
  const all = accountsApi([{ items: [] }]);
  assert.equal(await sweepAccounts(all.api, "mmo_x"), 0);
  assert.deepEqual(all.queries, [{ userIds: ["mmo_x"], limit: 100 }]);
});

test("a sweep counts an account already gone as gone, and throws on anything else", async () => {
  const gone = accountsApi([{ items: [{ id: "a" }, { id: "b" }] }], { a: Object.assign(new Error("not found"), { status: 404 }) });
  assert.equal(await sweepAccounts(gone.api, "mmo_x"), 1);
  const down = accountsApi([{ items: [{ id: "a" }] }], { a: Object.assign(new Error("down"), { status: 500 }) });
  await assert.rejects(sweepAccounts(down.api, "mmo_x"), /down/);
});

test("a used-up balance is known by its status or its slug", () => {
  assert.deepEqual(classifyFailure(Object.assign(new Error("402"), { status: 402 })), { kind: "wallet_empty" });
  assert.deepEqual(classifyFailure(apiError(403, 1, "Metering_WalletBalanceExhausted")), { kind: "wallet_empty" });
  assert.deepEqual(classifyFailure(new Error('{"error":{"slug":"Metering_WalletBalanceExhausted"}}')), { kind: "wallet_empty" });
});

test("other refusals owe nothing, and a timeout or a 5xx may have run", () => {
  assert.deepEqual(classifyFailure(Object.assign(new Error("nope"), { status: 404 })), { kind: "refused", status: 404 });
  for (const err of [new Error("timed out"), Object.assign(new Error("x"), { status: 500 }), Object.assign(new Error("x"), { status: 429 }), Object.assign(new Error("x"), { status: 408 }), null]) {
    assert.deepEqual(classifyFailure(err), { kind: "unknown" });
  }
});

test("a product session enables only its tools, Instant, and no finder, workbench or proxy", () => {
  const config = sessionConfigFor(tools("web_search", "scholar", "places", "read_page"));
  assert.deepEqual(config, {
    sessionPreset: "direct_tools",
    toolkits: { enable: ["firecrawl", "serpapi"] },
    tools: {
      firecrawl: { enable: ["FIRECRAWL_SCRAPE"] },
      serpapi: { enable: ["SERPAPI_GOOGLE_MAPS_SEARCH", "SERPAPI_SCHOLAR_SEARCH"] },
    },
    instant: { toolkits: { enable: ["firecrawl", "serpapi"] }, returnInstantCharge: true },
    manageConnections: { enable: false },
    sandbox: { enable: false, enableProxyExecution: false },
  });
});

test("an owner session has its own toolkits and no Instant", () => {
  const config = sessionConfigFor(tools("gmail_read", "gmail_send", "slack_send"));
  assert.deepEqual(config.toolkits.enable, ["gmail", "slack"]);
  assert.equal(config.instant, undefined);
  assert.deepEqual(config.tools.gmail.enable, ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_SEND_EMAIL"]);
});

test("sessions: one Composio no longer has is replaced, and other failures aren't hidden", async () => {
  const row = { sessionId: "sess_old", configHash: "stale" };
  const saved: string[] = [];
  const store = { findToolSession: async () => row, saveToolSession: async (r: { sessionId: string }) => void saved.push(r.sessionId) };
  const gone = fakeComposio({
    updateSession: async () => {
      throw Object.assign(new Error("gone"), { status: 404 });
    },
  });
  const config = sessionConfigFor(tools("scholar"));
  assert.equal(await ensureToolSession(gone.api, store, { productId: PRODUCT, composioUserId: "mmp_x", config }), "sess_1");
  assert.deepEqual(saved, ["sess_1"]);
  const down = fakeComposio({
    updateSession: async () => {
      throw Object.assign(new Error("down"), { status: 500 });
    },
  });
  await assert.rejects(ensureToolSession(down.api, store, { productId: PRODUCT, composioUserId: "mmp_x", config }));
  assert.equal(down.calls.create.length, 0);
});

test("sessions: created once, reused, and updated when the tools change", async () => {
  const fake = fakeComposio();
  const rows = new Map<string, { sessionId: string; configHash: string }>();
  const store = {
    findToolSession: async (p: string, u: string) => rows.get(`${p}:${u}`) ?? null,
    saveToolSession: async (r: { productId: string; composioUserId: string; sessionId: string; configHash: string }) => {
      rows.set(`${r.productId}:${r.composioUserId}`, { sessionId: r.sessionId, configHash: r.configHash });
    },
  };
  const first = sessionConfigFor(tools("scholar"));
  const a = await ensureToolSession(fake.api, store, { productId: PRODUCT, composioUserId: "mmp_x", config: first });
  const b = await ensureToolSession(fake.api, store, { productId: PRODUCT, composioUserId: "mmp_x", config: first });
  assert.equal(a, b);
  assert.equal(fake.calls.create.length, 1);
  assert.equal(fake.calls.update.length, 0);

  const second = sessionConfigFor(tools("scholar", "places"));
  assert.notEqual(sessionConfigHash(first), sessionConfigHash(second));
  const c = await ensureToolSession(fake.api, store, { productId: PRODUCT, composioUserId: "mmp_x", config: second });
  assert.equal(c, a);
  assert.equal(fake.calls.create.length, 1);
  assert.equal(fake.calls.update.length, 1);
  assert.deepEqual(fake.calls.update[0].config, second);
  assert.equal(rows.get(`${PRODUCT}:mmp_x`)?.configHash, sessionConfigHash(second));
});

test("untilAborted gives the work's answer, or stops waiting when the signal fires", async () => {
  assert.equal(await untilAborted(Promise.resolve("done"), new AbortController().signal), "done");
  await assert.rejects(untilAborted(Promise.reject(new Error("broke")), new AbortController().signal), /broke/);
  const late = new AbortController();
  const waiting = untilAborted(new Promise(() => {}), late.signal);
  late.abort(new Error("too long"));
  await assert.rejects(waiting, /too long/);
  const already = new AbortController();
  already.abort(new Error("already"));
  await assert.rejects(untilAborted(new Promise(() => {}), already.signal), /already/);
});
