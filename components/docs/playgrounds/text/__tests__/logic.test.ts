/**
 * The text group's pure logic, checked against real replies from the live API (saved in fixtures/, scrubbed of the
 * visitor id and the encrypted reasoning): reading Responses output items, citation markers, the rule verdicts, the
 * tool library and its search, the tool search loop, effort runs, schema limits, the caching bodies and the token
 * counting cases. Nothing here reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/text/__tests__/logic.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sseReader, type SseEvent } from "@/lib/docs/client/api";
import { answerItems, commentaryItems, itemsOf, itemsReader } from "@/components/docs/playgrounds/text/items";
import { groundingSteps, hostOf, numberSources, searchCounts, segmentCitations, sourceKey } from "@/components/docs/playgrounds/text/grounding";
import { acceptedSummary, checkVerdict, mayBill, replyBlock, verdictOf, withModel } from "@/components/docs/playgrounds/text/rules";
import { CLIENT_SEARCH_TOOL, TOOL_LIBRARY, findFunction, hostedTools, libraryShape, loadedTools, runLibraryCall, searchLibrary } from "@/components/docs/playgrounds/text/tool-library";
import {
  clientSearches,
  firstTsBody,
  functionCalls,
  goalOf,
  loadedGroups,
  modelStepFrom,
  nextTsAction,
  nextTsBody,
  savings,
  searchStepFor,
  searchedFor,
  toolsStepFor,
  tsFinalAnswer,
  type TsBase,
  type TsStep,
} from "@/components/docs/playgrounds/text/tool-search";
import { choicesFor, effortBody, effortResult, encryptedItems, presetSetup, previousFollowUp, replayFirstTurn, replayFollowUp, runLimited } from "@/components/docs/playgrounds/text/efforts";
import { SCHEMA_LIMITS, limitChecks, schemaStats } from "@/components/docs/playgrounds/text/schema-size";
import { bookPart, cacheBody, cacheReading, cacheRunFrom, cachedShare, editedMiddle, EDIT_NOTE, freshTag, pairCost, prefixFor, type CacheSetup } from "@/components/docs/playgrounds/text/caching";
import { CONTEXT_WINDOW, countBody, countKey, countOf, displayCountBody, sendBodyFor, shareLabel, windowShare } from "@/components/docs/playgrounds/text/token-cases";
import { encodeCitations } from "@/components/docs/playgrounds/text/grounding";
import { CITE_CLOSE, CITE_OPEN, markerChar, parseMarkdown, parseInlines, texToText } from "@/components/docs/playgrounds/text/markdown-lite";
import { failureOutcome, recordOf } from "@/components/docs/playgrounds/text/record";

const FIX = new URL("./fixtures/", import.meta.url);
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(name, FIX), "utf8"));
const MODEL = "muse-spark-1.3-contributor";

function streamEvents(name: string): SseEvent[] {
  const events: SseEvent[] = [];
  const reader = sseReader((e) => events.push(e));
  reader.push(readFileSync(new URL(name, FIX), "utf8"));
  reader.end();
  return events;
}

describe("items", () => {
  it("keeps commentary preambles apart from the answer and tool items in order", () => {
    const items = itemsOf(fixture("tool-search-hosted.json"));
    assert.deepEqual(
      items.map((x) => x.type),
      ["reasoning", "message", "tool_search_call", "tool_search_output", "reasoning", "message", "function_call"],
    );
    assert.equal(commentaryItems(items).length, 2);
    assert.equal(answerItems(items).length, 0, "the hosted turn ends on a call, with no answer yet");
  });

  it("reads a real search-grounding stream into the same items the final response has", () => {
    const reader = itemsReader();
    const events = streamEvents("search-grounding-stream.sse");
    let sawLiveText = false;
    for (const e of events) {
      reader.push(e);
      const snap = reader.snapshot();
      if (!snap.done && snap.items.some((x) => x.type === "message" && x.text)) sawLiveText = true;
    }
    const snap = reader.snapshot();
    assert.equal(snap.done, true);
    assert.ok(sawLiveText, "text shows before the stream ends");
    assert.equal(answerItems(snap.items).length, 1);
    const answer = answerItems(snap.items)[0];
    assert.match(answer.text, /^\*\*Kimi Antonelli\*\* won the most recent Formula 1 race\./);
    assert.equal(answer.annotations.length, 4);
    assert.equal((snap.usage as { input_tokens: number }).input_tokens, 5167);
  });
});

describe("grounding", () => {
  const events = streamEvents("search-grounding-stream.sse");
  const reader = itemsReader();
  for (const e of events) reader.push(e);
  const items = reader.snapshot().items;

  it("lists the model's steps: preambles, the search with its query and results, the page it opened", () => {
    const steps = groundingSteps(items);
    assert.deepEqual(
      steps.map((s) => s.kind),
      ["note", "search", "note", "open"],
    );
    const search = steps[1];
    assert.equal(search.kind, "search");
    if (search.kind === "search") {
      assert.deepEqual(search.queries, ["most recent Formula 1 race winner 2026"]);
      assert.equal(search.results?.length, 3, "the fixture keeps three of the twelve results");
    }
    assert.deepEqual(searchCounts(steps), { calls: 2, queries: 1, opened: 1 });
  });

  it("numbers one source per page and puts each marker right after the span it cites", () => {
    const answer = answerItems(items)[0];
    const sources = numberSources([answer]);
    assert.equal(sources.length, 1, "four spans, one page");
    assert.equal(sources[0].spans, 4);
    assert.equal(sources[0].host, "formula1.com");
    const segments = segmentCitations(answer.text, answer.annotations, sources);
    assert.equal(segments.map((s) => s.text).join(""), answer.text, "the text is unchanged");
    const marked = segments.filter((s) => s.markers.length);
    assert.equal(marked.length, 4);
    assert.ok(marked[0].text.endsWith("helped him win"), marked[0].text);
    assert.ok(marked.every((s) => s.cited));
  });

  it("maps code-point offsets onto UTF-16, so an emoji doesn't shift the markers after it", () => {
    const text = "🏁 Leclerc won. Verstappen was second.";
    const start = [..."🏁 Leclerc won. "].length;
    const anns = [{ url: "https://example.com/a", title: "A", start: 2, end: 14 }, { url: "https://example.com/b", title: "B", start, end: [...text].length }];
    const sources = numberSources([{ annotations: anns }]);
    const segs = segmentCitations(text, anns, sources);
    assert.equal(segs.map((s) => s.text).join(""), text);
    assert.deepEqual(
      segs.filter((s) => s.markers.length).map((s) => [s.text, s.markers]),
      [
        ["Leclerc won.", [1]],
        ["Verstappen was second.", [2]],
      ],
    );
  });

  it("clamps offsets past the end and treats a host's case and a trailing slash as the same page", () => {
    assert.equal(sourceKey("https://WWW.Example.com/x/"), sourceKey("https://www.example.com/x"));
    assert.equal(hostOf("https://www.formula1.com/en"), "formula1.com");
    const segs = segmentCitations("Short.", [{ url: "https://a.example", title: "A", start: 0, end: 99 }], numberSources([{ annotations: [{ url: "https://a.example", title: "A", start: 0, end: 99 }] }]));
    assert.deepEqual(segs, [{ text: "Short.", cited: true, markers: [1] }]);
    assert.deepEqual(segmentCitations("No sources.", [], []), [{ text: "No sources.", cited: false, markers: [] }]);
  });
});

describe("rules", () => {
  it("counts only 2xx as accepted and 400 as rejected; anything else can't decide", () => {
    assert.equal(verdictOf("rejected", 400), "matches");
    assert.equal(verdictOf("rejected", 200), "differs");
    assert.equal(verdictOf("accepted", 200), "matches");
    assert.equal(verdictOf("accepted", 400), "differs");
    assert.equal(verdictOf("rejected", 429), "unknown");
    assert.equal(verdictOf("accepted", 0), "unknown");
  });

  it("says what an accepted reply did", () => {
    assert.match(acceptedSummary("responses", fixture("tool-search-hosted.json")), /^The model called crm\.list_open_orders\(\{"customer_id":"CUST-12345"\}\)\.$/);
    assert.equal(acceptedSummary("responses/input_tokens", { object: "response.input_tokens", input_tokens: 1107 }), "Counted 1,107 input tokens.");
    assert.match(acceptedSummary("chat/completions", fixture("reasoning-chat.json")), /^The model answered: /);
  });

  it("swaps the model only in bodies that name one, never to muse-spark-1.3", () => {
    assert.equal(withModel({ model: MODEL, input: "x" }, "muse-spark-1.2").model, "muse-spark-1.2");
    assert.equal(withModel({ model: MODEL }, "muse-spark-1.3").model, MODEL);
    assert.deepEqual(withModel({ input: "x" }, "muse-spark-1.2"), { input: "x" });
    assert.equal(mayBill({ expect: "rejected", path: "responses" }), false);
    assert.equal(mayBill({ expect: "accepted", path: "responses/input_tokens" }), false);
    assert.equal(mayBill({ expect: "accepted", path: "responses" }), true);
  });

  it("holds a check about the reply's shape to the block it names, not just to a 200", () => {
    const check = { expect: "accepted" as const, replyHas: "server_tool_use" };
    const withBlock = { type: "message", content: [{ type: "server_tool_use", name: "tool_search", input: { paths: [""] } }, { type: "tool_use", name: "list_open_orders", input: { customer_id: "CUST-12345" } }] };
    const without = { type: "message", content: [{ type: "tool_use", name: "list_open_orders", input: {} }] };
    assert.equal(checkVerdict(check, 200, withBlock), "matches");
    assert.equal(checkVerdict(check, 200, without), "differs", "a 200 without the block differs from the page");
    assert.equal(checkVerdict(check, 429, without), "unknown");
    assert.equal(checkVerdict({ expect: "rejected" }, 400, null), "matches");
    assert.equal(replyBlock({ output: [{ type: "tool_search_call" }] }, "tool_search_call")?.type, "tool_search_call");
    assert.match(acceptedSummary("messages", withBlock, "server_tool_use"), /^The reply has server_tool_use tool_search \{"paths":\[""\]\}\./);
    assert.match(acceptedSummary("messages", without, "server_tool_use"), /^The reply has no server_tool_use block\./);
  });
});

describe("tool library", () => {
  it("has unique function names, focused namespaces, and one function loaded up front", () => {
    const names = TOOL_LIBRARY.flatMap((n) => n.functions.map((f) => f.name));
    assert.equal(new Set(names).size, names.length);
    assert.ok(TOOL_LIBRARY.every((n) => n.functions.length < 10), "the page: aim for fewer than 10 functions");
    assert.deepEqual(libraryShape(TOOL_LIBRARY, true), { namespaces: 7, functions: 37, deferred: 36 });
    assert.ok(names.every((n) => /^[a-zA-Z0-9_.-]+$/.test(n) && !n.includes(".")));
  });

  it("defers inside namespaces, never the namespace itself, and ends with one tool_search", () => {
    const tools = hostedTools(TOOL_LIBRARY, true);
    assert.deepEqual(tools[tools.length - 1], { type: "tool_search" });
    const crm = tools[0] as { type: string; defer_loading?: boolean; tools: Array<{ name: string; defer_loading?: boolean }> };
    assert.equal(crm.type, "namespace");
    assert.equal(crm.defer_loading, undefined);
    assert.equal(crm.tools.find((t) => t.name === "get_customer_profile")?.defer_loading, undefined);
    assert.equal(crm.tools.find((t) => t.name === "list_open_orders")?.defer_loading, true);
    const allDeferred = hostedTools(TOOL_LIBRARY, false)[0] as typeof crm;
    assert.ok(allDeferred.tools.every((t) => t.defer_loading === true));
    assert.ok(JSON.stringify(loadedTools(TOOL_LIBRARY)).indexOf("defer_loading") < 0);
    assert.equal(CLIENT_SEARCH_TOOL.execution, "client");
  });

  it("finds the function a model's call names, however it spells it", () => {
    assert.equal(findFunction("crm.list_open_orders")?.fn.name, "list_open_orders");
    assert.equal(findFunction("list_open_orders", "crm")?.namespace, "crm");
    assert.equal(findFunction("tool_get_shipping_eta")?.fn.name, "get_shipping_eta");
    assert.equal(findFunction("nope"), null);
  });

  it("answers the same arguments with the same mock data, and actions as done but flagged simulated", () => {
    const a = runLibraryCall("shipping.get_shipping_eta", null, '{"order_id":"order_42"}');
    const b = runLibraryCall("get_shipping_eta", null, '{"order_id":"order_42"}');
    assert.equal(a.output, b.output);
    assert.equal(a.matched, "shipping.get_shipping_eta");
    const refund = runLibraryCall("billing.issue_refund", null, '{"invoice_id":"INV-2207","amount":25,"reason":"damaged"}').value as Record<string, unknown>;
    assert.equal(refund.status, "refunded");
    assert.equal(refund.simulated, true);
    assert.match(String(refund.note), /^Demo only: no money moved\.$/);
    for (const [name, args] of [
      ["devops.rollback_deployment", '{"service":"checkout","deployment_id":"dep_1","reason":"bad deploy"}'],
      ["devops.page_on_call", '{"team":"payments","message":"rollback","severity":"high"}'],
      ["crm.update_customer_email", '{"customer_id":"CUST-1","email":"a@example.com"}'],
      ["calendar.create_event", '{"title":"Sync","start":"2026-11-02T10:00:00Z","duration_minutes":30,"attendees":[]}'],
    ] as const) {
      const v = runLibraryCall(name, null, args).value as Record<string, unknown>;
      assert.equal(v.simulated, true, name);
      assert.doesNotMatch(String(v.status), /^not_/, `${name} answers like a success`);
    }
    const allOutputs = TOOL_LIBRARY.flatMap((ns) => ns.functions.map((f) => JSON.stringify(f.run({}))));
    assert.ok(allOutputs.every((o) => !/"status":"not_/.test(o)), "no failure-shaped statuses left");
    assert.equal(runLibraryCall("crm.list_open_orders", null, "{oops").ok, false);
  });

  it("knows the holidays it has and says so for the ones it doesn't", () => {
    const us = runLibraryCall("hr.list_holidays", null, '{"country":"US","year":2026}').value as { holidays: string[] };
    assert.equal(us.holidays.length, 11);
    assert.ok(us.holidays.includes("2026-11-26 Thanksgiving Day") && us.holidays.includes("2026-01-19 Martin Luther King Jr. Day"));
    const gb = runLibraryCall("hr.list_holidays", null, '{"country":"gb","year":2026}').value as { country: string; holidays: string[] };
    assert.equal(gb.country, "GB");
    assert.ok(gb.holidays.includes("2026-04-03 Good Friday"));
    const fr = runLibraryCall("hr.list_holidays", null, '{"country":"FR","year":2026}').value as { holidays: string[]; note: string };
    assert.deepEqual(fr.holidays, []);
    assert.match(fr.note, /US and GB only/);
    const later = runLibraryCall("hr.list_holidays", null, '{"country":"US","year":2027}').value as { year: number; holidays: string[] };
    assert.equal(later.year, 2027);
    assert.deepEqual(later.holidays, [], "never another year's dates");
  });

  it("searches the library the way a client-executed app would", () => {
    const hits = searchLibrary("Find the shipping ETA tool", TOOL_LIBRARY);
    assert.equal(hits[0].fn.name, "get_shipping_eta");
    assert.equal(searchLibrary("roll back the checkout deploy", TOOL_LIBRARY)[0].fn.name, "rollback_deployment");
    assert.equal(searchLibrary("how many vacation days do I have left", TOOL_LIBRARY)[0].fn.name, "get_time_off_balance");
    assert.deepEqual(searchLibrary("the and for", TOOL_LIBRARY), []);
  });
});

describe("tool search loop", () => {
  const base: TsBase = { model: MODEL, prompt: "List open orders for customer CUST-12345.", effort: "low", namespaces: TOOL_LIBRARY, keepLoaded: true };

  it("hosted: shows what was searched and loaded, runs the call, sends the result with previous_response_id", () => {
    const first = firstTsBody("hosted", base);
    assert.equal(first.parallel_tool_calls, false);
    const step1 = modelStepFrom(1, first, fixture("tool-search-hosted.json"));
    const search = step1.items.find((x) => x.type === "tool_search_call")!;
    assert.deepEqual(searchedFor(search), { paths: ["crm"], goal: null });
    const out = step1.items.find((x) => x.type === "tool_search_output")!;
    assert.deepEqual(loadedGroups(out), [{ namespace: "crm", functions: ["list_open_orders"] }]);
    assert.equal(clientSearches(step1).length, 0, "hosted searches are the server's to run");
    assert.equal(nextTsAction([step1], 6), "tools");
    const tools = toolsStepFor(step1);
    assert.equal(tools.results[0].run?.matched, "crm.list_open_orders");
    const steps: TsStep[] = [step1, tools];
    assert.equal(nextTsAction(steps, 6), "model");
    const next = nextTsBody("hosted", base, steps);
    assert.equal(next.previous_response_id, (fixture("tool-search-hosted.json") as { id: string }).id);
    assert.deepEqual((next.input as Array<{ type: string; call_id: string }>).map((x) => x.type), ["function_call_output"]);
    assert.ok(Array.isArray(next.tools), "tools are resent: they don't carry over with previous_response_id");
    assert.equal(nextTsAction(steps, 1), "limit");
  });

  it("client: runs the app's search on the goal, replays the turn with the question first, then chains the result", () => {
    const step1 = modelStepFrom(1, firstTsBody("client", { ...base, prompt: "Find the shipping ETA tool, then use it for order_42." }), fixture("tool-search-client-1.json"));
    assert.equal(nextTsAction([step1], 6), "search");
    const call = clientSearches(step1)[0];
    assert.equal(goalOf(call), "Find the shipping ETA tool");
    const search = searchStepFor(call, TOOL_LIBRARY);
    assert.equal(search.hits[0].fn.name, "get_shipping_eta");
    assert.equal((search.loaded[0] as { defer_loading?: boolean }).defer_loading, true);
    const clientBase = { ...base, prompt: "Find the shipping ETA tool, then use it for order_42." };
    const replay = nextTsBody("client", clientBase, [step1, search]);
    const input = replay.input as Array<Record<string, unknown>>;
    assert.deepEqual(input[0], { role: "user", content: clientBase.prompt }, "the user's question goes first");
    assert.equal(input[input.length - 1].type, "tool_search_output");
    assert.equal(input[input.length - 1].call_id, call.raw.call_id);
    assert.equal(replay.tools, undefined, "the page's second request sends no tools array");
    const step2 = modelStepFrom(2, replay, fixture("tool-search-client-2.json"));
    assert.equal(functionCalls(step2)[0].raw.name, "tool_get_shipping_eta");
    const tools = toolsStepFor(step2);
    assert.equal(tools.results[0].run?.matched, "shipping.get_shipping_eta", "the odd prefix still finds the tool");
    const third = nextTsBody("client", clientBase, [step1, search, step2, tools]);
    assert.equal(third.previous_response_id, (fixture("tool-search-client-2.json") as { id: string }).id);
  });

  it("unwraps a goal the model nested inside arguments, and reports savings both ways", () => {
    const item = { ...itemsOf(fixture("tool-search-client-1.json")).find((x) => x.type === "tool_search_call")! };
    item.raw = { ...item.raw, arguments: { arguments: '{"goal":"Load get_shipping_eta tool details"}' } };
    assert.equal(goalOf(item), "Load get_shipping_eta tool details");
    assert.deepEqual(savings(2751, 5226), { tokens: 2475, share: 2475 / 5226 });
    assert.ok(savings(1107, 757).tokens < 0, "the page's two-tool example costs more deferred");
    const two = modelStepFrom(1, {}, fixture("tool-search-library-two-namespaces.json"));
    assert.deepEqual(
      loadedGroups(two.items.find((x) => x.type === "tool_search_output")!).map((g) => g.namespace),
      ["billing", "crm"],
    );
    assert.equal(tsFinalAnswer([two]), "", "a turn that ends on a call has no answer yet");
  });
});

describe("efforts", () => {
  it("puts effort where each protocol takes it and leaves it out for the model's default", () => {
    assert.deepEqual(effortBody("responses", { model: MODEL, prompt: "p", effort: "high", summary: "auto", maxOutputTokens: 4000 }), {
      model: MODEL,
      reasoning: { effort: "high", summary: "auto" },
      input: "p",
      max_output_tokens: 4000,
    });
    assert.deepEqual(effortBody("chat", { model: MODEL, prompt: "p", effort: "low", summary: "auto", maxOutputTokens: null }), {
      model: MODEL,
      reasoning_effort: "low",
      messages: [{ role: "user", content: "p" }],
    });
    assert.deepEqual(effortBody("responses", { model: MODEL, prompt: "p", effort: "default", summary: null, maxOutputTokens: null }), { model: MODEL, input: "p" });
    assert.ok(!choicesFor(MODEL).includes("max"));
    assert.ok(choicesFor("muse-wonder-1.0").includes("max"));
  });

  it("reads tokens, the summary and the answer from real replies", () => {
    const low = effortResult("responses", fixture("reasoning-low.json"));
    assert.equal(low.reasoning, 505);
    assert.equal(low.output, 1009);
    assert.equal(low.visible, 504);
    assert.equal(low.summary.length, 3);
    assert.ok(low.answer.length > 200);
    const cut = effortResult("responses", fixture("reasoning-truncated.json"));
    assert.equal(cut.status, "incomplete");
    assert.equal(cut.incomplete, "max_output_tokens");
    assert.equal(cut.answer, "");
    const chat = effortResult("chat", fixture("reasoning-chat.json"));
    assert.equal(chat.reasoning, 178);
    assert.equal(chat.reasoningContent, "absent", "Chat Completions redacts the chain of thought");
  });

  it("builds both follow-ups the page describes", () => {
    const first = effortBody("responses", { model: MODEL, prompt: "Prove it.", effort: "low", summary: "auto", maxOutputTokens: 3000 });
    const chained = previousFollowUp(first, "resp_1", "Now for 3.");
    assert.equal(chained.previous_response_id, "resp_1");
    assert.equal(chained.input, "Now for 3.");
    const turn1 = replayFirstTurn(first);
    assert.deepEqual(turn1.include, ["reasoning.encrypted_content"]);
    assert.equal(turn1.store, false);
    const reply = fixture("reasoning-replay-first.json");
    assert.equal(encryptedItems(reply), 1);
    const turn2 = replayFollowUp(turn1, reply, "Now for 3.");
    const input = turn2.input as Array<Record<string, unknown>>;
    assert.deepEqual(input[0], { role: "user", content: "Prove it." });
    assert.equal(input[1].type, "reasoning");
    assert.deepEqual(input[input.length - 1], { role: "user", content: "Now for 3." });
  });

  it("lets a preset set everything, so nothing carries over from the one before", () => {
    const defaults = { prompt: "", followUp: "Explain.", model: MODEL, efforts: ["minimal", "low", "medium", "high"] as const, maxOutputTokens: 6000 };
    const wonder = presetSetup({ prompt: "Rank causes.", model: "muse-wonder-1.0", efforts: ["low", "max"], maxOutputTokens: 4000 }, { ...defaults, efforts: [...defaults.efforts] });
    assert.equal(wonder.model, "muse-wonder-1.0");
    const next = presetSetup({ prompt: "Logic puzzle", followUp: "What if?" }, { ...defaults, efforts: [...defaults.efforts] });
    assert.deepEqual(next, { prompt: "Logic puzzle", followUp: "What if?", model: MODEL, efforts: ["minimal", "low", "medium", "high"], maxOutputTokens: 6000 });
  });

  it("runs at most `limit` tasks at once and keeps their order", async () => {
    let live = 0;
    let peak = 0;
    const task = (v: number) => async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return v;
    };
    assert.deepEqual(await runLimited([1, 2, 3, 4, 5].map(task), 2), [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
  });
});

describe("schema size", () => {
  const nest = (levels: number, arrays = false): Record<string, unknown> => {
    let s: Record<string, unknown> = { type: "string" };
    for (let i = levels - 1; i >= 0; i--) {
      s = arrays && i % 2 === 1 ? { type: "array", items: s } : { type: "object", properties: { x: s }, required: ["x"], additionalProperties: false };
    }
    return s;
  };

  it("counts nesting the way the API did: ten levels pass, eleven fail, arrays count", () => {
    assert.equal(schemaStats(nest(10)).depth, 10);
    assert.equal(schemaStats(nest(11)).depth, 11);
    assert.equal(schemaStats(nest(11, true)).depth, 11);
    const checks = limitChecks(schemaStats(nest(11)));
    assert.equal(checks.find((c) => c.id === "depth")?.ok, false);
    assert.equal(limitChecks(schemaStats(nest(10))).every((c) => c.ok === true), true);
  });

  it("finds recursion without looping and says where it is", () => {
    const tree = {
      type: "object",
      properties: { root: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
    };
    const stats = schemaStats(tree);
    assert.equal(stats.recursive, true);
    assert.deepEqual(stats.cycle, ["#/$defs/node", "#/$defs/node"]);
    assert.equal(stats.expandedNodes, null);
    assert.equal(limitChecks(stats).find((c) => c.id === "recursive")?.ok, false);
    assert.equal(limitChecks(stats).find((c) => c.id === "depth")?.ok, null, "depth can't be measured on a recursive schema");
    assert.equal(limitChecks(stats).find((c) => c.id === "expandedNodes")?.ok, null);
  });

  it("adds up properties, strings and enums, and flags a big string enum", () => {
    const schema = {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "green"] }, size: { type: "string", const: "XL" } },
      $defs: { unused: { type: "string" } },
    };
    const stats = schemaStats(schema);
    assert.equal(stats.properties, 2);
    assert.equal(stats.enumValues, 2);
    assert.equal(stats.stringLength, "color".length + "size".length + "unused".length + "red".length + "green".length + "XL".length);
    const big = { type: "object", properties: { v: { type: "string", enum: Array.from({ length: 260 }, (_, i) => `${"x".repeat(60)}${i}`) } } };
    const checks = limitChecks(schemaStats(big));
    assert.equal(checks.find((c) => c.id === "bigEnumChars")?.ok, false);
    assert.equal(limitChecks(schemaStats(big), 3000).find((c) => c.id === "enumValues")?.limit, 3000);
    assert.equal(SCHEMA_LIMITS.depth, 10);
  });
});

describe("caching", () => {
  const book = "Intro.\n\nCHAPTER I.\nDown the hole.\n\nMore text here.\n\nCHAPTER II.\nPool of tears.\n\nThe end.";
  const setup: CacheSetup = {
    protocol: "responses",
    model: MODEL,
    book,
    part: "chapters-1-3",
    scenario: "same",
    tag: "Session 123456.",
    questions: ["Q1?", "Q2?"],
    cacheKey: "muse-docs-prompt-caching",
    retention: null,
    store: true,
    effort: "minimal",
    maxOutputTokens: 400,
  };
  const now = new Date("2026-10-30T12:00:00.000Z");

  it("keeps the stable prefix first and the question last, the same on both calls", () => {
    const one = cacheBody(setup, 1, now);
    const two = cacheBody(setup, 2, now);
    assert.equal(one.instructions, two.instructions);
    assert.ok(String(one.instructions).startsWith("Session 123456. You answer questions"));
    assert.equal(one.input, "Q1?");
    assert.equal(two.input, "Q2?");
    assert.equal(one.prompt_cache_key, "muse-docs-prompt-caching");
    assert.equal(one.store, undefined, "store is left at its default unless turned off");
    const chat = cacheBody({ ...setup, protocol: "chat" }, 1, now);
    assert.deepEqual((chat.messages as Array<{ role: string }>).map((m) => m.role), ["developer", "user"]);
    assert.deepEqual(chat.stream_options, { include_usage: true });
  });

  it("breaks the prefix the two ways the page warns about", () => {
    const later = new Date(now.getTime() + 1500);
    assert.notEqual(prefixFor({ ...setup, scenario: "timestamp" }, 1, now), prefixFor({ ...setup, scenario: "timestamp" }, 2, later));
    assert.ok(prefixFor({ ...setup, scenario: "timestamp" }, 1, now).startsWith("Current time: 2026-10-30T12:00:00.000Z."));
    const edited = prefixFor({ ...setup, scenario: "edit" }, 2, now);
    assert.ok(edited.includes(EDIT_NOTE));
    assert.ok(!prefixFor({ ...setup, scenario: "edit" }, 1, now).includes(EDIT_NOTE));
    assert.equal(editedMiddle("a\n\nb\n\nc").split(EDIT_NOTE).length, 2);
    assert.equal(bookPart(book, "chapter-1"), "Intro.\n\nCHAPTER I.\nDown the hole.\n\nMore text here.");
    assert.match(freshTag(() => 0.5), /^Session \d{6}\.$/);
  });

  it("prices a hit at the cached rate and reads the share the way the page does", () => {
    const hit = cacheRunFrom(2, MODEL, { input_tokens: 8296, input_tokens_details: { cached_tokens: 8177 }, output_tokens: 146 }, 1200, 2700);
    assert.equal(hit.cached, 8177);
    assert.ok(hit.usd < hit.usdUncached / 5, "contributor cached input is 50 times cheaper");
    assert.equal(cacheReading(hit), "hit");
    assert.equal(cacheReading({ input: 8311, cached: 2929 }), "partial");
    assert.equal(cacheReading({ input: 8296, cached: 0 }), "miss");
    assert.ok(Math.abs(cachedShare(hit) - 8177 / 8296) < 1e-9);
    const chat = cacheRunFrom(2, MODEL, { prompt_tokens: 8296, completion_tokens: 172, prompt_tokens_details: { cached_tokens: 8177 } }, null, 2260);
    assert.equal(chat.cached, 8177);
  });

  it("estimates a pair per model before it runs, Muse Wonder included", () => {
    const spark = pairCost(MODEL, "chapters-1-3");
    const wonder = pairCost("muse-wonder-1.0", "chapters-1-3");
    assert.ok(spark.hit < 0.002 && spark.hit > 0.0005, `Contributor about a tenth of a cent: ${spark.hit}`);
    assert.ok(wonder.hit > 0.04 && wonder.hit < 0.06, `Wonder about 5 cents with the cache: ${wonder.hit}`);
    assert.ok(wonder.miss > 0.07 && wonder.miss < 0.09, `about 8 cents when call 2 misses: ${wonder.miss}`);
    assert.ok(pairCost(MODEL, "chapter-1").hit < spark.hit);
  });
});

describe("token cases", () => {
  it("builds the page's example and the Anthropic-shaped equivalent", () => {
    assert.deepEqual(countBody("responses/input_tokens", "text", MODEL), { model: MODEL, input: "What is the capital of France?" });
    assert.deepEqual(countBody("messages/count_tokens", "text", MODEL), { model: MODEL, messages: [{ role: "user", content: "What is the capital of France?" }] });
    const conv = countBody("responses/input_tokens", "conversation", MODEL);
    const input = conv.input as Array<Record<string, unknown>>;
    assert.equal(input.find((x) => x.type === "function_call")?.call_id, input.find((x) => x.type === "function_call_output")?.call_id);
    const msgConv = countBody("messages/count_tokens", "conversation", MODEL);
    assert.ok(JSON.stringify(msgConv).includes('"tool_use_id":"toolu_1"'));
  });

  it("splits a data URL for the Messages image block", () => {
    const url = "data:image/png;base64,iVBORw0KGgo=";
    const msg = countBody("messages/count_tokens", "image", MODEL, { imageDataUrl: url });
    assert.ok(JSON.stringify(msg).includes('"media_type":"image/png","data":"iVBORw0KGgo="'));
    const resp = countBody("responses/input_tokens", "image", MODEL, { imageDataUrl: url });
    assert.ok(JSON.stringify(resp).includes('"image_url":"data:image/png;base64,iVBORw0KGgo="'));
    assert.deepEqual(displayCountBody({ image_url: `data:image/png;base64,${"A".repeat(500)}` }), { image_url: "data:image/png;base64,<BASE64>" });
  });

  it("measures against the context window and turns a count into the matching generation call", () => {
    assert.equal(CONTEXT_WINDOW, 1_048_576);
    assert.equal(shareLabel(windowShare(172)), "0.02%");
    assert.equal(shareLabel(windowShare(524_288)), "50.0%");
    assert.equal(shareLabel(0), "0%");
    assert.equal(countOf({ object: "response.input_tokens", input_tokens: 172 }), 172);
    assert.equal(countOf({}), null);
    const send = sendBodyFor("messages/count_tokens", { model: MODEL, messages: [] });
    assert.equal(send.path, "messages");
    assert.equal(send.body.max_tokens, 400);
    assert.deepEqual(sendBodyFor("responses/input_tokens", { model: MODEL, input: "x" }).body.reasoning, { effort: "low" });
  });

  it("keys a count by endpoint and exact body, so another case's count is never compared", () => {
    const question = countBody("responses/input_tokens", "text", MODEL);
    assert.equal(countKey("responses/input_tokens", question), countKey("responses/input_tokens", countBody("responses/input_tokens", "text", MODEL)));
    assert.notEqual(countKey("responses/input_tokens", question), countKey("responses/input_tokens", countBody("responses/input_tokens", "document", MODEL, { document: "Alice." })));
    assert.notEqual(countKey("responses/input_tokens", question), countKey("messages/count_tokens", question), "the endpoint counts too");
    assert.notEqual(countKey("responses/input_tokens", question), countKey("responses/input_tokens", countBody("responses/input_tokens", "text", "muse-wonder-1.0")));
    const small = countBody("responses/input_tokens", "image", MODEL, { imageDataUrl: "data:image/jpeg;base64,AAAA" });
    const big = countBody("responses/input_tokens", "image", MODEL, { imageDataUrl: "data:image/jpeg;base64,AAAABBBB" });
    assert.notEqual(countKey("responses/input_tokens", small), countKey("responses/input_tokens", big), "a resized image is another body");
  });
});

describe("chain retry", () => {
  it("retries a chained call once when Meta hasn't caught up with the response it names", async () => {
    const { isChainRace, withChainRetry } = await import("@/components/docs/playgrounds/text/chain");
    const race = { status: 400, error: { message: "referenced response not found or expired" } };
    assert.equal(isChainRace(race, { previous_response_id: "resp_1" }), true);
    assert.equal(isChainRace(race, { input: "x" }), false, "only chained calls");
    assert.equal(isChainRace({ status: 400, error: { message: "bad schema" } }, { previous_response_id: "resp_1" }), false);
    const store = { status: 503, error: { message: "persistence service error" } };
    assert.equal(isChainRace(store, { previous_response_id: "resp_1" }), true, "Meta's response store failing a follow-up");
    assert.equal(isChainRace(store, { input: "x" }), false, "a first call isn't retried");
    assert.equal(isChainRace({ status: 429, error: { message: "slow down" } }, { previous_response_id: "resp_1" }), false);
    let calls = 0;
    const ok = await withChainRetry(async () => (++calls === 1 ? race : { status: 200, error: null }), { previous_response_id: "resp_1" }, { pauseMs: 1 });
    assert.equal(ok.status, 200);
    assert.equal(calls, 2);
    calls = 0;
    const stopped = await withChainRetry(async () => (++calls, race), { previous_response_id: "resp_1" }, { pauseMs: 1, stopped: () => true });
    assert.equal(stopped.status, 400);
    assert.equal(calls, 1, "a stop during the pause doesn't retry");
  });
});

describe("money", () => {
  it("keeps small amounts readable instead of rounding them away", async () => {
    const { usdExact } = await import("@/components/docs/playgrounds/text/money");
    assert.equal(usdExact(0.000044), "$0.000044");
    assert.equal(usdExact(0.00084), "$0.00084");
    assert.equal(usdExact(0.0331), "$0.033");
    assert.equal(usdExact(1.234), "$1.23");
    assert.equal(usdExact(2), "$2.00");
    assert.equal(usdExact(1.5), "$1.50");
    assert.equal(usdExact(0.0104), "$0.010", "two significant digits, not a flat cent");
    assert.equal(usdExact(0.5), "$0.50");
    assert.equal(usdExact(0), "$0");
  });
});

describe("record", () => {
  it("records the body trimmed, the model the proxy ran, and the numbers the page is about", () => {
    const body = { model: MODEL, instructions: "x".repeat(5000), input: "Q2?" };
    const rec = recordOf("responses", body, { status: 200, model: MODEL }, "cache call 2: 8,177 of 8,297 input tokens cached (98.6%); output_text: DRINK ME");
    assert.equal(rec.method, "POST");
    assert.equal(rec.path, "responses");
    assert.equal(rec.model, undefined, "same model as the body: not repeated");
    assert.ok(String((rec.body as { instructions: string }).instructions).length < 700, "the book is trimmed");
    assert.match(rec.outcome ?? "", /^cache call 2: 8,177 of 8,297 input tokens cached/);
    assert.equal(recordOf("responses", { model: "muse-spark-1.3" }, { status: 200, model: MODEL }, "x").model, MODEL);
    assert.ok((recordOf("responses", body, { status: 200, model: null }, "y ".repeat(400)).outcome ?? "").length <= 300);
    assert.equal(failureOutcome({ status: 0, error: { code: "aborted", message: "Stopped." } }), "stopped before the reply finished");
    assert.match(failureOutcome({ status: 503, error: { message: "persistence service error" } }), /^error 503: persistence service error/);
  });
});

describe("markdown-lite", () => {
  it("reads the marks model answers use", () => {
    const [p] = parseMarkdown("The race was the **2026 United States Grand Prix**, won by *Kimi Antonelli* (`F1`).");
    assert.deepEqual(p, {
      t: "p",
      c: [
        { t: "text", v: "The race was the " },
        { t: "strong", c: [{ t: "text", v: "2026 United States Grand Prix" }] },
        { t: "text", v: ", won by " },
        { t: "em", c: [{ t: "text", v: "Kimi Antonelli" }] },
        { t: "text", v: " (" },
        { t: "code", v: "F1" },
        { t: "text", v: ")." },
      ],
    });
    const blocks = parseMarkdown("Open orders:\n\n* **Order A4648** - Trail running shoes\n* **Order A1042** - Headlamp\n  - shipped\n\n1. one\n2. two\n\n### Next\n> quoted\n\n---\n```\ncode here\n```");
    assert.deepEqual(blocks.map((b) => b.t), ["p", "list", "list", "h", "quote", "hr", "code"]);
    const list = blocks[1] as Extract<(typeof blocks)[number], { t: "list" }>;
    assert.equal(list.items.length, 2);
    assert.equal(list.items[1][1].t, "list", "the nested list stays in its item");
    assert.equal((blocks[2] as { ordered: boolean }).ordered, true);
    const table = parseMarkdown("| Effort | Tokens |\n|---|---:|\n| low | 1,190 |")[0] as { t: string; rows: unknown[] };
    assert.equal(table.t, "table");
    assert.equal(table.rows.length, 1);
  });

  it("leaves code names, prices and arithmetic alone", () => {
    assert.deepEqual(parseInlines("call list_open_orders and snake_case_name"), [{ t: "text", v: "call list_open_orders and snake_case_name" }]);
    assert.deepEqual(parseInlines("Refund $25 now and $30 later, 2 * 3 * 4"), [{ t: "text", v: "Refund $25 now and $30 later, 2 * 3 * 4" }]);
  });

  it("turns TeX into readable Unicode", () => {
    assert.equal(texToText("\\sqrt{2} = \\frac{p}{q}"), "√2 = p/q");
    assert.equal(texToText("p^2 = 2q^2"), "p² = 2q²");
    assert.equal(texToText("\\gcd(p, q) = 1 \\implies 2 \\mid p"), "gcd(p, q) = 1 ⟹ 2 | p");
    assert.equal(texToText("\\sqrt{a^2+b^2} \\leq \\frac{a+b}{2}"), "√(a²+b²) ≤ (a+b)/2");
    assert.equal(texToText("x \\in \\mathbb{Z}, x_{i}^{n+1}"), "x ∈ ℤ, xᵢⁿ⁺¹");
    const [p] = parseMarkdown("Suppose $\\sqrt{2}$ is rational: $$\\sqrt{2} = \\frac{p}{q}$$");
    assert.deepEqual((p as { c: unknown[] }).c, [{ t: "text", v: "Suppose " }, { t: "math", v: "√2" }, { t: "text", v: " is rational: " }, { t: "math", v: "√2 = p/q" }]);
  });

  it("links only http, https and mailto", () => {
    assert.deepEqual(parseInlines("[docs](https://dev.meta.ai/docs)"), [{ t: "link", href: "https://dev.meta.ai/docs", c: [{ t: "text", v: "docs" }] }]);
    assert.ok(!JSON.stringify(parseInlines("[x](javascript:alert(1))")).includes('"link"'));
    const bare = parseInlines("See https://example.com/a_(b). Then go.");
    assert.equal((bare[1] as { href: string }).href, "https://example.com/a_(b)");
  });

  it("keeps citation marks where they were put, through bold text and list markers", () => {
    const segments = [
      { text: "Intro ", cited: false, markers: [] },
      { text: "the **2026 United", cited: true, markers: [] },
      { text: " States Grand Prix**", cited: false, markers: [1] },
      { text: " was won.", cited: false, markers: [] },
    ];
    const text = encodeCitations(segments);
    assert.equal(text, `Intro ${CITE_OPEN}the **2026 United${CITE_CLOSE} States Grand Prix**${markerChar(1)} was won.`);
    const [p] = parseMarkdown(text) as Array<{ c: Array<{ t: string; c?: Array<{ v: string }>; v?: string }> }>;
    assert.equal(p.c[1].t, "strong");
    assert.equal(p.c[1].c?.[0].v, `2026 United${CITE_CLOSE} States Grand Prix`);
    assert.equal(p.c[2].v, `${markerChar(1)} was won.`);
    const [list] = parseMarkdown(`${CITE_OPEN}- a cited item${CITE_CLOSE}${markerChar(2)}\n- next`) as Array<{ t: string; items: Array<Array<{ c: Array<{ v: string }> }>> }>;
    assert.equal(list.t, "list", "a mark before the dash doesn't hide the list");
    assert.equal(list.items[0][0].c[0].v, `${CITE_OPEN}a cited item${CITE_CLOSE}${markerChar(2)}`);
  });

  it("is quick on a long answer", () => {
    const started = performance.now();
    parseMarkdown("word **bold** and *em* `code` $x^2$ ".repeat(3000));
    assert.ok(performance.now() - started < 500);
  });
});
