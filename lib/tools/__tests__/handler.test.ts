import assert from "node:assert/strict";
import { test } from "node:test";
import { agentModels, BUILD_TOKEN, errorOf, fakeComposio, fakeTools, NOW, OTHER_PRODUCT, PRODUCT, TOKEN, toolsRequest } from "@/lib/tools/__tests__/helpers";
import type { ToolReply } from "@/lib/tools/composio/client";
import { handleOwnerExchange, handleTools, type ToolsDeps } from "@/lib/tools/handler";
import { composioUserId, mintOwnerCode, mintOwnerSession, productComposioUserId } from "@/lib/tools/principal";
import { COMPOSIO_CALL_USD } from "@/lib/tools/pricing";
import { mintConnectState } from "@/lib/tools/sign";

const SUBJECT = "owner-subject";
const ownerHeaders = () => ({ "x-musemuse-owner": mintOwnerSession({ productId: PRODUCT, subject: SUBJECT }, NOW).session });
const OWNER_ID = composioUserId("o", PRODUCT, SUBJECT);
const SCHOLAR = { name: "SERPAPI_SCHOLAR_SEARCH", arguments: { query: "webxr" } };
const SEND = { recipient_email: "a@example.com", subject: "Hi", body: "Words" };
const GMAIL = [{ toolkit: "gmail", connectedAccountId: "ca_1", composioUserId: OWNER_ID }];

const exec = (deps: ToolsDeps, body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) =>
  handleTools(toolsRequest("/execute", body, headers, token), ["execute"], deps);

type Ok = { ok: true; output: unknown; sources: Array<{ url: string }>; costUsd: number; simulated: boolean; truncated?: boolean };
type Pause = { ok: false; code: string; approval?: { id: string; title: string; lines: string[] }; toolkit?: string; label?: string; canConnect?: boolean; stale?: boolean };

/** Whatever happens to a call, its slot goes back. */
function assertBalanced(g: ReturnType<typeof fakeTools>) {
  assert.equal(g.inFlight(), 0);
}

test("flags off: every route answers as disabled, and nothing is looked up", async () => {
  const g = fakeTools({ agentsEnabled: false });
  const lookups: string[] = [];
  g.deps.findToken = async () => {
    lookups.push("token");
    return null;
  };
  for (const [method, path] of [["GET", []], ["POST", ["execute"]], ["GET", ["connections"]], ["POST", ["connect"]], ["POST", ["disconnect"]]] as const) {
    const req = new Request("https://platform.test/x", { method, headers: { authorization: `Bearer ${TOKEN}` }, ...(method === "POST" ? { body: "{}" } : {}) });
    const err = await errorOf(await handleTools(req, path, g.deps));
    assert.equal(err.status, 503, path.join("/"));
    assert.equal(err.code, "tools_paused");
  }
  assert.deepEqual(lookups, []);
  assert.equal((await handleTools(toolsRequest("/callback?state=x", undefined, {}, null), ["callback"], g.deps)).status, 503);
  const owner = await errorOf(await handleOwnerExchange(toolsRequest("/x", { code: "x" }), g.deps));
  assert.equal(owner.code, "tools_paused");
});

test("personal flag off: personal tools are refused and their routes answer as disabled, public tools still work", async () => {
  const g = fakeTools({ personalEnabled: false, models: agentModels("scholar", "gmail_read"), connections: GMAIL });
  const refused = await errorOf(await exec(g.deps, { name: "GMAIL_FETCH_EMAILS", arguments: {} }, ownerHeaders()));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "tool_not_allowed");
  assert.equal(g.calls.execute.length, 0);
  assert.equal((await errorOf(await handleTools(toolsRequest("/connect", { toolkit: "gmail" }, ownerHeaders()), ["connect"], g.deps))).code, "tool_not_allowed");
  assert.equal((await errorOf(await handleTools(toolsRequest("/disconnect", { toolkit: "gmail" }, ownerHeaders()), ["disconnect"], g.deps))).code, "tool_not_allowed");
  assert.equal((await handleOwnerExchange(toolsRequest("/x", { code: "x" }), g.deps)).status, 503);
  assert.equal((await handleTools(toolsRequest("/callback?state=x", undefined, {}, null), ["callback"], g.deps)).status, 503);
  const list = (await (await handleTools(toolsRequest("?ids=scholar,gmail_read", undefined, ownerHeaders()), [], g.deps)).json()) as { tools: Array<{ id: string }> };
  assert.deepEqual(list.tools.map((t) => t.id), ["scholar"]);
  assert.equal((await exec(g.deps, SCHOLAR)).status, 200);
});

test("step 1: a bad token is 401, and a product that's off is 403", async () => {
  const g = fakeTools();
  assert.equal((await errorOf(await exec(g.deps, SCHOLAR, {}, null))).status, 401);
  assert.equal((await errorOf(await exec(g.deps, SCHOLAR, {}, "mm_live_unknown"))).code, "invalid_token");
  for (const status of ["disabled", "failed", null] as const) {
    const off = fakeTools({ status });
    const err = await errorOf(await exec(off.deps, SCHOLAR));
    assert.equal(err.status, 403);
    assert.equal(err.code, "product_disabled");
  }
});

test("step 2: a tool the brief didn't pick, or no agent marker, or off the catalog, is refused", async () => {
  const g = fakeTools({ models: agentModels("places") });
  const err = await errorOf(await exec(g.deps, SCHOLAR));
  assert.equal(err.status, 403);
  assert.equal(err.code, "tool_not_allowed");

  const noMarker = fakeTools({ models: ["muse-wonder-1.0", "tool:scholar"] });
  assert.equal((await errorOf(await exec(noMarker.deps, SCHOLAR))).code, "tool_not_allowed");

  for (const name of ["EXA_SEARCH", "COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "GMAIL_DELETE_DRAFT", "GMAIL_SEND_DRAFT", "TAVILY_SEARCH", "web_search"]) {
    const open = fakeTools({ models: agentModels("scholar", "gmail_send", "gmail_draft") });
    const refused = await errorOf(await exec(open.deps, { name, arguments: {} }, ownerHeaders()));
    assert.equal(refused.code, "tool_not_allowed", name);
    assert.equal(open.calls.execute.length, 0, name);
  }
  assert.equal(g.calls.execute.length, 0);
});

test("step 2: the manifest narrows a live product's list and can't widen it", async () => {
  const narrowed = fakeTools({ models: agentModels("scholar", "places"), manifest: { agent: { tools: [{ id: "places" }] } } });
  assert.equal((await errorOf(await exec(narrowed.deps, SCHOLAR))).code, "tool_not_allowed");
  const widened = fakeTools({ models: agentModels("places"), manifest: { agent: { tools: [{ id: "scholar" }, { id: "places" }] } } });
  assert.equal((await errorOf(await exec(widened.deps, SCHOLAR))).code, "tool_not_allowed");
});

test("step 2: no key means tools are paused, for live calls only", async () => {
  const g = fakeTools({ composio: null });
  assert.equal((await errorOf(await exec(g.deps, SCHOLAR))).code, "tools_paused");
  const build = fakeTools({ composio: null });
  assert.equal((await exec(build.deps, SCHOLAR, {}, BUILD_TOKEN)).status, 200);
});

test("step 3: a visitor or a bad pass can't use personal tools", async () => {
  const headers: Array<Record<string, string>> = [
    {},
    { "x-musemuse-visitor": "v1" },
    { "x-musemuse-owner": "os1.forged.subject.999.sig" },
    { "x-musemuse-owner": mintOwnerSession({ productId: OTHER_PRODUCT, subject: SUBJECT }, NOW).session },
    { "x-musemuse-owner": mintOwnerSession({ productId: PRODUCT, subject: SUBJECT }, new Date(NOW.getTime() - 13 * 3_600_000)).session },
  ];
  for (const h of headers) {
    const g = fakeTools({ models: agentModels("gmail_read"), connections: GMAIL });
    const err = await errorOf(await exec(g.deps, { name: "GMAIL_FETCH_EMAILS", arguments: {} }, h));
    assert.equal(err.status, 403, JSON.stringify(h));
    assert.equal(err.code, "sign_in_required");
    assert.equal(g.calls.execute.length, 0);
  }
});

test("step 3: the owner with no connection gets the card, before any confirmation or cost", async () => {
  const g = fakeTools({ models: agentModels("gmail_send") });
  const res = await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND }, ownerHeaders());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, code: "needs_connection", toolkit: "gmail", label: "Gmail", canConnect: true });
  assert.equal(g.reservations.size, 0);
});

test("step 4: arguments outside the catalog are refused before any cost, with Firecrawl's and Slack's dangerous ones", async () => {
  const g = fakeTools({ models: agentModels("read_page", "slack_send", "gmail_send"), connections: [...GMAIL, { toolkit: "slack", connectedAccountId: "ca_2", composioUserId: OWNER_ID }] });
  const cases = [
    { name: "FIRECRAWL_SCRAPE", arguments: { url: "https://a.example/", actions: [] }, userInput: "https://a.example/" },
    { name: "FIRECRAWL_SCRAPE", arguments: { url: "https://a.example/", jsonOptions: {} }, userInput: "https://a.example/" },
    { name: "SLACK_SEND_MESSAGE", arguments: { channel: "C1", markdown_text: "x", blocks: [] } },
    { name: "SLACK_SEND_MESSAGE", arguments: { channel_id: "C1", markdown_text: "x" } },
    { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@example.com", to: "b@example.com" } },
    { name: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@example.com", extra_recipients: ["b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com"] } },
  ];
  for (const body of cases) {
    const err = await errorOf(await exec(g.deps, body, ownerHeaders()));
    assert.equal(err.status, 400, JSON.stringify(body));
    assert.equal(err.code, "invalid_arguments");
  }
  assert.equal(g.calls.execute.length, 0);
  assert.equal(g.reservations.size, 0);
});

test("step 4: read_page opens only what the person typed, for builds too", async () => {
  for (const token of [TOKEN, BUILD_TOKEN]) {
    const g = fakeTools();
    const url = "https://a.example/story";
    const wrong = await errorOf(await exec(g.deps, { name: "FIRECRAWL_SCRAPE", arguments: { url }, userInput: "read https://other.example/" }, {}, token));
    assert.equal(wrong.code, "invalid_arguments");
    assert.equal((await errorOf(await exec(g.deps, { name: "FIRECRAWL_SCRAPE", arguments: { url } }, {}, token))).code, "invalid_arguments");
    const right = await exec(g.deps, { name: "FIRECRAWL_SCRAPE", arguments: { url }, userInput: `please read ${url}` }, {}, token);
    assert.equal(right.status, 200);
  }
});

test("step 4: a write needs a confirmation with matching arguments, and a used approval is no approval", async () => {
  const g = fakeTools({ models: agentModels("gmail_send"), connections: GMAIL });
  const first = await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND }, ownerHeaders());
  assert.equal(first.status, 200);
  const pause = (await first.json()) as Pause;
  assert.equal(pause.code, "needs_confirmation");
  assert.equal(pause.approval?.title, "Send this email?");
  assert.ok(pause.approval?.lines.some((l) => l.includes("a@example.com")));
  assert.equal(g.calls.execute.length, 0);
  assert.equal(g.reservations.size, 0);

  const changed = (await (await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: { ...SEND, recipient_email: "b@example.com" }, approval: pause.approval?.id }, ownerHeaders())).json()) as Pause;
  assert.equal(changed.code, "needs_confirmation");
  assert.equal(changed.stale, true);
  assert.equal(g.calls.execute.length, 0);

  const sent = await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: { subject: "Hi", recipient_email: "a@example.com", body: "Words" }, approval: pause.approval?.id }, ownerHeaders());
  assert.equal(((await sent.json()) as Ok).ok, true);
  assert.equal(g.calls.execute.length, 1);

  const again = (await (await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND, approval: pause.approval?.id }, ownerHeaders())).json()) as Pause;
  assert.equal(again.code, "needs_confirmation");
  assert.equal(g.calls.execute.length, 1);
  assertBalanced(g);
});

test("step 4: a read tool never asks, even Firecrawl, which Composio tags as a create", async () => {
  const g = fakeTools();
  const res = await exec(g.deps, { name: "FIRECRAWL_SCRAPE", arguments: { url: "https://a.example/" }, userInput: "https://a.example/" });
  assert.equal(((await res.json()) as Ok).ok, true);
});

test("step 5: per-minute limits refuse and don't call out", async () => {
  const g = fakeTools();
  const hit = g.deps.hitRateLimits;
  g.deps.hitRateLimits = async (keys, w) => ({ ...(await hit(keys, w)), [`tools-token:tok`]: 61 });
  const err = await errorOf(await exec(g.deps, SCHOLAR));
  assert.equal(err.status, 429);
  assert.equal(err.code, "rate_limited");
  assert.equal(g.calls.execute.length, 0);
});

test("step 5: limits cover the visitor, the IP, the tool and the toolkit", async () => {
  const g = fakeTools();
  const seen: string[] = [];
  g.deps.hitRateLimits = async (keys) => {
    seen.push(...keys);
    return {};
  };
  await exec(g.deps, SCHOLAR, { "x-musemuse-client-ip": "203.0.113.9", "x-musemuse-visitor": "v1" });
  assert.ok(seen.includes("tools-token:tok"));
  assert.ok(seen.includes(`tools-ip:${PRODUCT}:203.0.113.9`));
  assert.ok(seen.some((k) => k.startsWith(`tools-visitor:${PRODUCT}:`)));
  assert.ok(seen.includes("tools-toolkit:serpapi"));
  assert.ok(seen.includes("tools-tool:scholar"));
});

test("step 5: a build's canned calls don't use the platform's provider limits", async () => {
  const g = fakeTools();
  const seen: string[] = [];
  g.deps.hitRateLimits = async (keys) => {
    seen.push(...keys);
    return {};
  };
  await exec(g.deps, SCHOLAR, {}, BUILD_TOKEN);
  assert.deepEqual(seen, ["tools-token:tok"]);
});

test("step 5: sends stop at 10 a day per product, and survive the cleanup's hourly sweep", async () => {
  const g = fakeTools({ models: agentModels("gmail_send"), connections: GMAIL });
  const send = async () => {
    const pause = (await (await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND }, ownerHeaders())).json()) as Pause;
    return exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND, approval: pause.approval?.id }, ownerHeaders());
  };
  for (let i = 0; i < 10; i += 1) assert.equal((await send()).status, 200, `send ${i}`);
  const err = await errorOf(await send());
  assert.equal(err.status, 429);
  assert.equal(err.code, "rate_limited");
  assert.equal(g.calls.execute.length, 10);
  const day = [...g.counters.keys()].find((k) => k.startsWith(`tools-day:${PRODUCT}:gmail_send@`)) as string;
  // A window that started today would be gone an hour later (deleteRateLimitsBefore), so it starts at the next midnight.
  assert.equal(day.split("@")[1], "2026-11-01T00:00:00.000Z");
});

test("step 5: a full slot table refuses and gives the daily count back", async () => {
  const g = fakeTools({ models: agentModels("gmail_send"), connections: GMAIL, inFlightFull: true });
  const pause = (await (await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND }, ownerHeaders())).json()) as Pause;
  const err = await errorOf(await exec(g.deps, { name: "GMAIL_SEND_EMAIL", arguments: SEND, approval: pause.approval?.id }, ownerHeaders()));
  assert.equal(err.code, "rate_limited");
  assert.deepEqual([...g.counters.entries()].filter(([k]) => k.startsWith("tools-day:")).map(([, v]) => v), [0]);
});

test("step 6: each budget stops a call before it costs anything", async () => {
  const cases: Array<[Parameters<typeof fakeTools>[0], string]> = [
    [{ spent: 3 }, "budget_exceeded"],
    [{ toolsSpent: 10 }, "budget_exceeded"],
    [{ platformSpent: 100 }, "budget_exceeded"],
    [{ toolsCalls: 0.5 }, "budget_exceeded"],
    [{ toolsCap: 0 }, "tools_paused"],
  ];
  for (const [opts, code] of cases) {
    const g = fakeTools(opts);
    const err = await errorOf(await exec(g.deps, SCHOLAR));
    assert.equal(err.code, code, JSON.stringify(opts));
    assert.equal(g.reservations.size, 0);
    assert.equal(g.calls.execute.length, 0);
    assertBalanced(g);
  }
});

test("step 6: run caps count tool calls and dollars, and an invalid run id is refused", async () => {
  const g = fakeTools();
  const run = { "x-musemuse-run-id": "run_12345678" };
  for (let i = 0; i < 12; i += 1) assert.equal((await exec(g.deps, SCHOLAR, run)).status, 200, `call ${i}`);
  const over = await errorOf(await exec(g.deps, SCHOLAR, run));
  assert.equal(over.status, 429);
  assert.equal(over.code, "run_limit");
  assert.equal(g.calls.execute.length, 12);
  assert.equal((await errorOf(await exec(g.deps, SCHOLAR, { "x-musemuse-run-id": "bad" }))).code, "invalid_run_id");
});

test("step 6: a build's run has 8 tool calls", async () => {
  const g = fakeTools();
  const run = { "x-musemuse-run-id": "run_build_1" };
  for (let i = 0; i < 8; i += 1) assert.equal((await exec(g.deps, SCHOLAR, run, BUILD_TOKEN)).status, 200);
  assert.equal((await errorOf(await exec(g.deps, SCHOLAR, run, BUILD_TOKEN))).code, "run_limit");
});

test("steps 7 to 9: a live call reserves the list price, calls with no version, and settles at the charge", async () => {
  const g = fakeTools();
  const res = await exec(g.deps, SCHOLAR, { "x-musemuse-run-id": "run_12345678" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Ok;
  assert.equal(body.ok, true);
  assert.equal(body.simulated, false);
  assert.equal(body.costUsd, Number((0.009167 + COMPOSIO_CALL_USD).toFixed(6)));
  assert.deepEqual(body.sources, [{ url: "https://papers.test/1", title: "A paper", snippet: "Words" }]);

  const [reservation] = [...g.reservations.values()];
  assert.equal(reservation.model, "composio:SERPAPI_SCHOLAR_SEARCH");
  assert.equal(reservation.costUsd, 0.025 + COMPOSIO_CALL_USD);
  assert.deepEqual(reservation.ctx, { source: "tools", endpoint: "tools/execute", productId: PRODUCT, tokenId: "tok" });

  assert.equal(g.settled.length, 1);
  assert.equal(g.settled[0].item?.units, 1);
  assert.equal(g.settled[0].item?.costUsd, 0.009167 + COMPOSIO_CALL_USD);
  assert.equal(g.settled[0].item?.model, "composio:SERPAPI_SCHOLAR_SEARCH");

  assert.equal(g.calls.create.length, 1);
  assert.equal(g.calls.create[0].userId, productComposioUserId(PRODUCT));
  assert.deepEqual(g.calls.execute[0].args, { query: "webxr" });
  // The options carry only the abort signal: no version, ever.
  assert.deepEqual(g.calls.execute[0].extraKeys, []);
  assertBalanced(g);
});

test("step 8: a product's calls share one session, and an owner's personal call has its own", async () => {
  const g = fakeTools({ models: agentModels("scholar", "gmail_read"), connections: GMAIL });
  await exec(g.deps, SCHOLAR);
  await exec(g.deps, SCHOLAR, { "x-musemuse-visitor": "v1" });
  await exec(g.deps, SCHOLAR, ownerHeaders());
  assert.equal(g.calls.create.length, 1);
  await exec(g.deps, { name: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } }, ownerHeaders());
  assert.equal(g.calls.create.length, 2);
  assert.equal(g.calls.create[1].userId, OWNER_ID);
  assert.deepEqual(g.calls.create[1].config.toolkits.enable, ["gmail"]);
  assert.equal(g.calls.create[1].config.instant, undefined);
});

test("step 8: a build gets canned output at $0 with one unit, and zero provider calls of any kind", async () => {
  const g = fakeTools({ models: agentModels("scholar", "gmail_read", "gmail_send", "slack_send"), fixtures: { SERPAPI_SCHOLAR_SEARCH: [{ results: { organic_results: [{ title: "Canned", link: "https://example.com/c" }] } }] } });
  const res = await exec(g.deps, SCHOLAR, {}, BUILD_TOKEN);
  const body = (await res.json()) as Ok;
  assert.equal(body.simulated, true);
  assert.equal(body.costUsd, 0);
  assert.deepEqual(body.sources, [{ url: "https://example.com/c", title: "Canned" }]);
  assert.equal(g.recorded.length, 1);
  assert.equal(g.recorded[0].items[0].units, 1);
  assert.equal(g.recorded[0].items[0].costUsd, 0);
  assert.equal(g.reservations.size, 0);

  // A personal tool, sample account, with the confirmation flow running for real so tests use the cards.
  const read = (await (await exec(g.deps, { name: "GMAIL_FETCH_EMAILS", arguments: {} }, {}, BUILD_TOKEN)).json()) as Ok;
  assert.equal(read.simulated, true);
  const send = { name: "SLACK_SEND_MESSAGE", arguments: { channel: "C1", markdown_text: "hi" } };
  const pause = (await (await exec(g.deps, send, {}, BUILD_TOKEN)).json()) as Pause;
  assert.equal(pause.code, "needs_confirmation");
  assert.equal(((await (await exec(g.deps, { ...send, approval: pause.approval?.id }, {}, BUILD_TOKEN)).json()) as Ok).simulated, true);

  const connect = (await (await handleTools(toolsRequest("/connect", { toolkit: "gmail", returnTo: "/x" }, {}, BUILD_TOKEN), ["connect"], g.deps)).json()) as { simulated: boolean; url: string | null };
  assert.equal(connect.simulated, true);
  assert.equal(connect.url, null);
  const disconnect = (await (await handleTools(toolsRequest("/disconnect", { toolkit: "gmail" }, {}, BUILD_TOKEN), ["disconnect"], g.deps)).json()) as { simulated: boolean };
  assert.equal(disconnect.simulated, true);

  const provider = g.calls;
  assert.equal(provider.create.length + provider.update.length + provider.execute.length + provider.authorize.length + provider.verify.length + provider.delete.length, 0);
});

test("step 8: a build isn't stopped by Meta spend, since a canned call costs nothing", async () => {
  const g = fakeTools({ spent: 99, budget: 10, toolsCap: 0 });
  assert.equal((await exec(g.deps, SCHOLAR, {}, BUILD_TOKEN)).status, 200);
});

function withReply(reply: ToolReply) {
  const fake = fakeComposio({ execute: async () => reply });
  return fakeTools({ composio: fake.api });
}

test("step 9: a failed call is a plain tool_failed, settled at $0 with its unit, and doesn't name the provider", async () => {
  const g = withReply({ data: { message: "bad" }, error: "Invalid request data provided\nmore", resultType: "failed", instantCharge: null });
  const err = await errorOf(await exec(g.deps, SCHOLAR));
  assert.equal(err.status, 502);
  assert.equal(err.code, "tool_failed");
  assert.match(err.message, /Invalid request data provided/);
  assert.equal(g.settled[0].item?.costUsd, 0);
  assert.equal(g.settled[0].item?.units, 1);

  const named = withReply({ data: null, error: "Composio could not do it", resultType: "failed" });
  assert.doesNotMatch((await errorOf(await exec(named.deps, SCHOLAR))).message, /composio/i);
});

test("step 9: a failed call with a charge still pays the charge", async () => {
  const g = withReply({ data: null, error: "x", resultType: "failed", instantCharge: { amount: "0.002" } });
  await exec(g.deps, SCHOLAR);
  assert.equal(g.settled[0].item?.costUsd, 0.002 + COMPOSIO_CALL_USD);
});

test("step 9: a success with no charge keeps the estimate", async () => {
  const g = withReply({ data: { results: { organic_results: [] } }, error: null, resultType: "completed" });
  const body = (await (await exec(g.deps, SCHOLAR)).json()) as Ok;
  assert.equal(g.settled[0].item?.costUsd, 0.025 + COMPOSIO_CALL_USD);
  assert.equal(body.costUsd, Number((0.025 + COMPOSIO_CALL_USD).toFixed(6)));
});

test("step 9: output rules come first and a big reply is trimmed under 32 KB with its sources whole", async () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ title: `T${i}`, link: `https://a.test/${i}`, snippet: "word ".repeat(40), inline_links: { junk: "x".repeat(500) } }));
  const g = withReply({ data: { results: { organic_results: big, junk: "y".repeat(200_000) } }, error: null, resultType: "completed", instantCharge: { amount: "0.01" } });
  const body = (await (await exec(g.deps, SCHOLAR)).json()) as Ok;
  assert.equal(body.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(body.output)) <= 32 * 1024);
  assert.equal(body.sources.length, 20);
  assert.doesNotMatch(JSON.stringify(body.output), /inline_links|yyyy/);
});

function throwing(err: unknown) {
  const fake = fakeComposio({
    execute: async () => {
      throw err;
    },
  });
  return { g: fakeTools({ composio: fake.api, models: agentModels("scholar", "gmail_read"), connections: GMAIL }), fake };
}

const apiError = (status: number, code: number, slug: string) => Object.assign(new Error(`${status} refused`), { status, error: { error: { code, slug, status } } });

test("a used-up balance (402) is tools_paused, and nothing is owed", async () => {
  const { g } = throwing(apiError(402, 0, "Metering_WalletBalanceExhausted"));
  const err = await errorOf(await exec(g.deps, SCHOLAR));
  assert.equal(err.status, 503);
  assert.equal(err.code, "tools_paused");
  assert.doesNotMatch(err.message, /composio|wallet|metering/i);
  assert.deepEqual(g.settled[0].item, null);
  assertBalanced(g);
});

test("400 code 4302 is needs_connection, marks the row stale and owes nothing", async () => {
  const { g } = throwing(apiError(400, 4302, "ToolRouterV2_NoActiveConnection"));
  const res = await exec(g.deps, { name: "GMAIL_FETCH_EMAILS", arguments: {} }, ownerHeaders());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, code: "needs_connection", toolkit: "gmail", label: "Gmail", canConnect: true });
  assert.deepEqual(g.settled[0].item, null);
  assert.deepEqual(g.revoked, [{ productId: PRODUCT, composioUserId: OWNER_ID, toolkit: "gmail" }]);
});

test("400 code 4310 is tool_not_allowed, and owes nothing", async () => {
  const { g } = throwing(apiError(400, 4310, "ToolRouterV2_ToolNotInEnabledList"));
  const err = await errorOf(await exec(g.deps, SCHOLAR));
  assert.equal(err.status, 403);
  assert.equal(err.code, "tool_not_allowed");
  assert.deepEqual(g.settled[0].item, null);
});

test("a timeout keeps the estimate, because the tool may have done billable work, and isn't retried", async () => {
  let attempts = 0;
  const fake = fakeComposio({
    execute: async () => {
      attempts += 1;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  const g = fakeTools({ composio: fake.api });
  const err = await errorOf(await exec(g.deps, SCHOLAR, { "x-musemuse-run-id": "run_12345678" }));
  assert.equal(err.code, "tool_failed");
  assert.equal(attempts, 1);
  assert.equal(g.settled[0].item?.costUsd, 0.025 + COMPOSIO_CALL_USD);
});

test("a session that can't be made owes nothing, and gives its holds back", async () => {
  const fake = fakeComposio({
    createSession: async () => {
      throw new Error("down");
    },
  });
  const g = fakeTools({ composio: fake.api });
  const err = await errorOf(await exec(g.deps, SCHOLAR, { "x-musemuse-run-id": "run_12345678" }));
  assert.equal(err.code, "tool_failed");
  assert.deepEqual(g.settled[0].item, null);
  assert.deepEqual([...g.counters.entries()].filter(([k]) => k.startsWith("run-calls") || k.startsWith("tools-calls")).map(([, v]) => v), [0, 0]);
  assertBalanced(g);
});

test("the list says who's asking and shapes each tool, without the key or a version anywhere", async () => {
  const g = fakeTools({ models: agentModels("web_search", "scholar", "gmail_read", "gmail_send"), connections: GMAIL });
  const owner = (await (await handleTools(toolsRequest("", undefined, ownerHeaders()), [], g.deps)).json()) as {
    simulated: boolean;
    principal: string;
    toolSearch: boolean;
    tools: Array<{ id: string; builtin?: boolean; functions?: Array<{ name: string }>; connection?: { connected: boolean; canConnect: boolean }; confirm?: boolean; tier: string }>;
  };
  assert.equal(owner.principal, "owner");
  assert.equal(owner.simulated, false);
  assert.equal(owner.toolSearch, false);
  const byId = Object.fromEntries(owner.tools.map((t) => [t.id, t]));
  assert.equal(byId.web_search.builtin, true);
  assert.equal(byId.web_search.functions, undefined);
  assert.equal(byId.scholar.functions?.[0].name, "SERPAPI_SCHOLAR_SEARCH");
  assert.deepEqual(byId.gmail_read.connection, { toolkit: "gmail", label: "Gmail", connected: true, canConnect: true });
  assert.equal(byId.gmail_send.confirm, true);
  assert.equal(byId.gmail_read.confirm, undefined);
  assert.doesNotMatch(JSON.stringify(owner), /"version"|estimateUsd|"sample"/);

  const visitor = (await (await handleTools(toolsRequest("", undefined, { "x-musemuse-visitor": "v" }), [], g.deps)).json()) as typeof owner;
  assert.equal(visitor.principal, "visitor");
  const v = Object.fromEntries(visitor.tools.map((t) => [t.id, t]));
  assert.equal(v.gmail_read.functions, undefined);
  assert.deepEqual(v.gmail_read.connection, { toolkit: "gmail", label: "Gmail", connected: false, canConnect: false });
  assert.ok(v.scholar.functions);

  const build = (await (await handleTools(toolsRequest("", undefined, {}, BUILD_TOKEN), [], g.deps)).json()) as typeof owner;
  assert.equal(build.simulated, true);
  assert.equal(build.principal, "build");
  assert.ok(Object.fromEntries(build.tools.map((t) => [t.id, t])).gmail_send.functions);
});

test("the list filters by ids and refuses an unknown format", async () => {
  const g = fakeTools({ models: agentModels("scholar", "places") });
  const list = (await (await handleTools(toolsRequest("?ids=places,gmail_read,nonsense"), [], g.deps)).json()) as { tools: Array<{ id: string }> };
  assert.deepEqual(list.tools.map((t) => t.id), ["places"]);
  assert.equal((await errorOf(await handleTools(toolsRequest("?format=xml"), [], g.deps))).code, "invalid_arguments");
});

test("above 8 functions, namespaced output defers them behind tool_search; at 8 or fewer it doesn't", async () => {
  const many = fakeTools({ models: agentModels("scholar", "places", "events", "read_page", "gmail_read", "gmail_draft", "gmail_send", "calendar_read", "calendar_add"), connections: GMAIL });
  type Listing = { toolSearch: boolean; namespaces?: Array<{ type: string; name: string; description: string; tools: Array<{ name: string; defer_loading?: boolean }> }>; tools: Array<{ id: string; namespace?: string; functions?: Array<{ defer_loading?: boolean }> }> };
  const namespaced = (await (await handleTools(toolsRequest("?format=namespaced", undefined, ownerHeaders()), [], many.deps)).json()) as Listing;
  assert.equal(namespaced.toolSearch, true);
  assert.deepEqual(namespaced.namespaces?.map((n) => n.name).sort(), ["firecrawl", "gmail", "googlecalendar", "serpapi"]);
  for (const ns of namespaced.namespaces ?? []) {
    assert.equal(ns.type, "namespace");
    assert.ok(ns.description);
    for (const fn of ns.tools) assert.equal(fn.defer_loading, true);
  }
  const gmail = namespaced.tools.find((t) => t.id === "gmail_read");
  assert.equal(gmail?.namespace, "gmail");
  assert.equal(gmail?.functions?.[0].defer_loading, true);

  const flat = (await (await handleTools(toolsRequest("?format=functions", undefined, ownerHeaders()), [], many.deps)).json()) as Listing;
  assert.equal(flat.toolSearch, false);
  assert.equal(flat.namespaces, undefined);

  const few = fakeTools({ models: agentModels("scholar", "places") });
  const small = (await (await handleTools(toolsRequest("?format=namespaced"), [], few.deps)).json()) as Listing;
  assert.equal(small.toolSearch, false);
  assert.equal(small.tools[0].namespace, undefined);
});

test("connections: owner, visitor and build each see their own", async () => {
  const g = fakeTools({ models: agentModels("gmail_read", "slack_read"), connections: GMAIL });
  const get = async (h: Record<string, string>, t = TOKEN) => (await (await handleTools(toolsRequest("/connections", undefined, h, t), ["connections"], g.deps)).json()) as { principal: string; connections: Array<{ toolkit: string; connected: boolean; canConnect: boolean; simulated?: boolean }> };
  const owner = await get(ownerHeaders());
  assert.deepEqual(owner.connections.map((c) => [c.toolkit, c.connected, c.canConnect]), [["gmail", true, true], ["slack", false, true]]);
  const visitor = await get({});
  assert.deepEqual(visitor.connections.map((c) => [c.toolkit, c.connected, c.canConnect]), [["gmail", false, false], ["slack", false, false]]);
  const build = await get({}, BUILD_TOKEN);
  assert.ok(build.connections.every((c) => c.connected && c.simulated));
});

test("connect: only the owner, only this product's toolkits, only a path on the product", async () => {
  const g = fakeTools({ models: agentModels("gmail_read") });
  const post = (body: unknown, h: Record<string, string> = ownerHeaders()) => handleTools(toolsRequest("/connect", body, h), ["connect"], g.deps);
  assert.equal((await errorOf(await post({ toolkit: "gmail" }, {}))).code, "sign_in_required");
  assert.equal((await errorOf(await post({ toolkit: "gmail" }, { "x-musemuse-visitor": "v" }))).code, "sign_in_required");
  assert.equal((await errorOf(await post({ toolkit: "slack" }))).code, "tool_not_allowed");
  assert.equal((await errorOf(await post({ toolkit: "serpapi" }))).code, "tool_not_allowed");
  assert.equal((await errorOf(await post({ toolkit: "gmail", returnTo: "https://evil.example" }))).code, "invalid_arguments");
  assert.equal((await errorOf(await post({ toolkit: "gmail", returnTo: "//evil.example" }))).code, "invalid_arguments");
  assert.equal(g.calls.authorize.length, 0);

  const res = (await (await post({ toolkit: "gmail", returnTo: "/settings" })).json()) as { ok: boolean; url: string; simulated: boolean };
  assert.deepEqual(res, { ok: true, url: "https://connect.composio.dev/link/abc", simulated: false });
  const { callbackUrl, toolkit } = g.calls.authorize[0];
  assert.equal(toolkit, "gmail");
  assert.ok(callbackUrl.startsWith("https://platform.test/api/gateway/tools/callback?state=cs1."));
  assert.equal(g.calls.create[0].userId, OWNER_ID);
});

async function connectedVia(g: ReturnType<typeof fakeTools>, query: string) {
  return handleTools(new Request(`https://platform.test/api/gateway/tools/callback?${query}`), ["callback"], g.deps);
}

const STATE = () => mintConnectState({ productId: PRODUCT, composioUserId: OWNER_ID, toolkit: "gmail", returnTo: "/settings" }, NOW);

test("callback: a verified account is saved, and the browser goes back to the product", async () => {
  const g = fakeTools({ models: agentModels("gmail_read") });
  const res = await connectedVia(g, `state=${STATE()}&status=success&connected_account_id=ca_new`);
  assert.equal(res.status, 303);
  const target = new URL(res.headers.get("location") as string);
  assert.equal(target.origin, "https://product.example");
  assert.equal(target.pathname, "/api/musemuse/connected");
  assert.equal(target.searchParams.get("toolkit"), "gmail");
  assert.equal(target.searchParams.get("returnTo"), "/settings");
  assert.equal(target.searchParams.get("error"), null);
  assert.deepEqual(g.calls.verify, [{ connectedAccountId: "ca_new", userId: OWNER_ID, toolkit: "gmail" }]);
  assert.deepEqual(g.saved, [{ productId: PRODUCT, principal: "owner", composioUserId: OWNER_ID, toolkit: "gmail", connectedAccountId: "ca_new" }]);
});

test("callback: replacing an account removes the old one", async () => {
  const g = fakeTools({ models: agentModels("gmail_read"), connections: [{ toolkit: "gmail", connectedAccountId: "ca_old", composioUserId: OWNER_ID }] });
  await connectedVia(g, `state=${STATE()}&connected_account_id=ca_new`);
  assert.deepEqual(g.calls.delete, ["ca_old"]);
});

test("callback: `status` is only a hint, so an account Composio won't vouch for isn't saved", async () => {
  const fake = fakeComposio({ verifyConnection: async () => false });
  const g = fakeTools({ composio: fake.api });
  const res = await connectedVia(g, `state=${STATE()}&status=success&connected_account_id=ca_someone_elses`);
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("location") as string).searchParams.get("error"), "connect_failed");
  assert.deepEqual(g.saved, []);
});

test("callback: a bad, expired or reused state is refused and saves nothing", async () => {
  const g = fakeTools();
  assert.equal((await connectedVia(g, "state=nonsense&connected_account_id=ca_1")).status, 400);
  assert.equal((await connectedVia(g, "connected_account_id=ca_1")).status, 400);
  const old = mintConnectState({ productId: PRODUCT, composioUserId: OWNER_ID, toolkit: "gmail", returnTo: "/" }, new Date(NOW.getTime() - 16 * 60_000));
  assert.equal((await connectedVia(g, `state=${old}&connected_account_id=ca_1`)).status, 400);
  const state = STATE();
  assert.equal((await connectedVia(g, `state=${state}&connected_account_id=ca_1`)).status, 303);
  assert.equal((await connectedVia(g, `state=${state}&connected_account_id=ca_2`)).status, 400);
  assert.equal(g.saved.length, 1);
});

test("callback: a product that's off keeps nothing, and one with no site gets a plain page", async () => {
  const off = fakeTools({ status: "disabled" });
  assert.equal((await connectedVia(off, `state=${STATE()}&connected_account_id=ca_1`)).status, 403);
  assert.deepEqual(off.saved, []);
  const local = fakeTools({ liveUrl: null });
  const res = await connectedVia(local, `state=${STATE()}&connected_account_id=ca_1`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Connected/);
});

test("disconnect: deletes at the provider and marks the row, and a failure keeps the row", async () => {
  const g = fakeTools({ models: agentModels("gmail_read"), connections: GMAIL });
  const res = await handleTools(toolsRequest("/disconnect", { toolkit: "gmail" }, ownerHeaders()), ["disconnect"], g.deps);
  assert.deepEqual(await res.json(), { ok: true, simulated: false });
  assert.deepEqual(g.calls.delete, ["ca_1"]);
  assert.deepEqual(g.revoked, [{ productId: PRODUCT, composioUserId: OWNER_ID, toolkit: "gmail" }]);

  const gone = fakeComposio({
    deleteConnection: async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  });
  const already = fakeTools({ composio: gone.api, models: agentModels("gmail_read"), connections: GMAIL });
  assert.equal((await handleTools(toolsRequest("/disconnect", { toolkit: "gmail" }, ownerHeaders()), ["disconnect"], already.deps)).status, 200);
  assert.equal(already.revoked.length, 1);

  const down = fakeComposio({
    deleteConnection: async () => {
      throw new Error("down");
    },
  });
  const failed = fakeTools({ composio: down.api, models: agentModels("gmail_read"), connections: GMAIL });
  assert.equal((await errorOf(await handleTools(toolsRequest("/disconnect", { toolkit: "gmail" }, ownerHeaders()), ["disconnect"], failed.deps))).code, "tool_failed");
  assert.equal(failed.revoked.length, 0);
  assert.equal((await errorOf(await handleTools(toolsRequest("/disconnect", { toolkit: "gmail" }, { "x-musemuse-visitor": "v" }), ["disconnect"], failed.deps))).code, "sign_in_required");
});

test("owner exchange: a code works once, on its own product, and gives a working 12-hour session", async () => {
  const g = fakeTools({ models: agentModels("gmail_read"), connections: GMAIL });
  const code = mintOwnerCode({ productId: PRODUCT, subject: SUBJECT }, NOW);
  const res = await handleOwnerExchange(toolsRequest("/x", { code }), g.deps);
  assert.equal(res.status, 200);
  const { session, expiresAt } = (await res.json()) as { session: string; expiresAt: string };
  assert.equal(new Date(expiresAt).getTime(), NOW.getTime() + 12 * 3_600_000);
  const list = await handleTools(toolsRequest("", undefined, { "x-musemuse-owner": session }), [], g.deps);
  assert.equal(((await list.json()) as { principal: string }).principal, "owner");

  assert.equal((await errorOf(await handleOwnerExchange(toolsRequest("/x", { code }), g.deps))).code, "sign_in_required");
  const other = mintOwnerCode({ productId: OTHER_PRODUCT, subject: SUBJECT }, NOW);
  assert.equal((await errorOf(await handleOwnerExchange(toolsRequest("/x", { code: other }), g.deps))).code, "sign_in_required");
  assert.equal((await errorOf(await handleOwnerExchange(toolsRequest("/x", { code: "oc1.a.b.c.d.e" }), g.deps))).code, "sign_in_required");
  const old = mintOwnerCode({ productId: PRODUCT, subject: SUBJECT }, new Date(NOW.getTime() - 6 * 60_000));
  assert.equal((await errorOf(await handleOwnerExchange(toolsRequest("/x", { code: old }), g.deps))).code, "sign_in_required");
  assert.equal((await errorOf(await handleOwnerExchange(toolsRequest("/x", { code: mintOwnerCode({ productId: PRODUCT, subject: SUBJECT }, NOW) }, {}, BUILD_TOKEN), g.deps))).code, "sign_in_required");
  assert.equal((await handleOwnerExchange(toolsRequest("/x", { code }, {}, null), g.deps)).status, 401);
});

test("bad requests get plain answers", async () => {
  const g = fakeTools();
  const raw = (body: string) => new Request("https://platform.test/x", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
  assert.equal((await errorOf(await handleTools(raw("not json"), ["execute"], g.deps))).code, "invalid_body");
  assert.equal((await errorOf(await handleTools(raw("[]"), ["execute"], g.deps))).code, "invalid_body");
  assert.equal((await errorOf(await exec(g.deps, { arguments: {} }))).code, "invalid_arguments");
  assert.equal((await errorOf(await exec(g.deps, { name: "SERPAPI_SCHOLAR_SEARCH", arguments: [] }))).code, "invalid_arguments");
  assert.equal((await errorOf(await exec(g.deps, { ...SCHOLAR, approval: 5 }))).code, "invalid_arguments");
  assert.equal((await errorOf(await exec(g.deps, { ...SCHOLAR, userInput: "x".repeat(70_000) }))).code, "invalid_arguments");
  assert.equal((await errorOf(await handleTools(raw("x".repeat(140_000)), ["execute"], g.deps))).code, "invalid_arguments");
  assert.equal((await errorOf(await handleTools(toolsRequest("/nope"), ["nope"], g.deps))).code, "unknown_endpoint");
  assert.equal((await errorOf(await handleTools(toolsRequest("/execute"), ["execute"], g.deps))).code, "unknown_endpoint");
});

test("an unexpected failure is a plain 500, with its slot back", async () => {
  const g = fakeTools();
  g.deps.reserveSpend = async () => {
    throw new Error("database down");
  };
  const err = await errorOf(await exec(g.deps, SCHOLAR));
  assert.equal(err.status, 500);
  assert.doesNotMatch(err.message, /database/);
  assertBalanced(g);
});
