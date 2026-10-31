import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedToolIds, CATALOG, catalogTool, denialOf, findFunction, functionDefinition, functionNameProblem, namespaceDefinition } from "@/lib/tools/catalog";
import { agentModels } from "@/lib/tools/__tests__/helpers";
import type { CatalogFunction, CatalogTool } from "@/lib/tools/composio/sync";
import { COMPOSIO_CALL_USD, COMPOSIO_MANAGED_APP_USD, chargeOf, estimateToolUsd, settledToolUsd, toolUsage } from "@/lib/tools/pricing";
import { TOOL_CHECKS, TOOL_LIMITS } from "@/lib/tools/policy";

test("every function has a name Meta accepts and no reserved one", () => {
  assert.equal(functionNameProblem("GMAIL_SEND_EMAIL"), null);
  assert.equal(functionNameProblem("a.b"), null);
  assert.ok(functionNameProblem("a.b.c"));
  assert.ok(functionNameProblem("has space"));
  for (const reserved of ["browser.search", "browser.open", "browser.find"]) assert.ok(functionNameProblem(reserved), reserved);
  for (const tool of CATALOG.tools) for (const fn of tool.functions) assert.equal(functionNameProblem(fn.name), null, fn.name);
});

test("nothing denied is in the catalog, and the check holds if something ever was", () => {
  for (const tool of CATALOG.tools) for (const fn of tool.functions) assert.equal(denialOf(tool, fn), null, fn.name);
  const tool = catalogTool("scholar") as CatalogTool;
  const fn = tool.functions[0] as CatalogFunction;
  for (const name of ["EXA_SEARCH", "COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT", "COMPOSIO_SEARCH_EXA_ANSWER", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "SOME_PROXY_EXECUTE", "GMAIL_DELETE_DRAFT", "GMAIL_SEND_DRAFT", "SLACK_REMOVE_THING"]) {
    assert.ok(denialOf(tool, { ...fn, name }), name);
    assert.equal(findFunction(name), null, name);
  }
  assert.ok(denialOf({ ...tool, toolkit: "exa" }, fn));
  assert.ok(denialOf(tool, { ...fn, hints: ["destructiveHint"] }));
});

test("the catalog holds no finder, workbench, proxy or delete tool", () => {
  const names = CATALOG.tools.flatMap((t) => t.functions.map((f) => f.name));
  for (const name of names) assert.doesNotMatch(name, /^COMPOSIO_|WORKBENCH|PROXY|DELETE|REMOVE|TRASH|EXA/);
});

test("writes say they need confirming, and reads don't", () => {
  for (const tool of CATALOG.tools) {
    for (const fn of tool.functions) {
      if (tool.access === "read") assert.doesNotMatch(fn.description, /confirmation/i, fn.name);
      else assert.match(fn.description, /Needs the user's confirmation/, fn.name);
    }
  }
});

test("a listed function carries no version, price or sample", () => {
  const fn = findFunction("SERPAPI_SCHOLAR_SEARCH")?.fn as CatalogFunction;
  const listed = functionDefinition(fn, false);
  assert.deepEqual(Object.keys(listed).sort(), ["description", "name", "parameters", "strict", "type"]);
  assert.equal(functionDefinition(fn, true).defer_loading, true);
  const ns = namespaceDefinition("serpapi", [functionDefinition(fn, true)]);
  assert.equal(ns.type, "namespace");
  assert.ok(ns.description);
});

test("allowed tools need the agent marker, and a live manifest only narrows", () => {
  const live = (ids: string[]) => ({ scope: "live", allowedModels: ids });
  assert.deepEqual(allowedToolIds(live(["muse-wonder-1.0", "tool:scholar"]), null), []);
  assert.deepEqual(allowedToolIds(live(agentModels("scholar", "places")), null), ["scholar", "places"]);
  assert.deepEqual(allowedToolIds(live(agentModels("scholar", "places")), { agent: { tools: [{ id: "places" }, { id: "gmail_send" }] } }), ["places"]);
  assert.deepEqual(allowedToolIds(live(agentModels("scholar")), { agent: { tools: [] } }), []);
  assert.deepEqual(allowedToolIds(live(agentModels("scholar")), { name: "no agent block" }), ["scholar"]);
  assert.deepEqual(allowedToolIds({ scope: "build", allowedModels: agentModels("scholar") }, { agent: { tools: [] } }), ["scholar"]);
  assert.deepEqual(allowedToolIds(live([...agentModels("scholar"), "tool:scholar", "tool:exa_search"]), null), ["scholar"]);
});

test("estimates: list price plus the call fee for Instant, the fees for personal tools", () => {
  const instant = findFunction("FIRECRAWL_SCRAPE")?.fn as CatalogFunction;
  const personal = findFunction("GMAIL_FETCH_EMAILS")?.fn as CatalogFunction;
  assert.equal(estimateToolUsd(instant), 0.003 + COMPOSIO_CALL_USD);
  assert.equal(estimateToolUsd(personal), COMPOSIO_CALL_USD + COMPOSIO_MANAGED_APP_USD);
});

test("settling: the charge plus the fee, $0 for a failure with no charge, and the estimate when a success has none", () => {
  const instant = findFunction("FIRECRAWL_SCRAPE")?.fn as CatalogFunction;
  assert.equal(chargeOf({ instantCharge: { amount: "0.000798" } }), 0.000798);
  assert.equal(chargeOf({ instantCharge: { amount: "nope" } }), null);
  assert.equal(chargeOf({}), null);
  assert.equal(settledToolUsd(instant, { resultType: "completed", instantCharge: { amount: "0.000798" } }), 0.000798 + COMPOSIO_CALL_USD);
  assert.equal(settledToolUsd(instant, { resultType: "failed" }), 0);
  assert.equal(settledToolUsd(instant, { resultType: "failed", instantCharge: { amount: "0.001" } }), 0.001 + COMPOSIO_CALL_USD);
  assert.equal(settledToolUsd(instant, { resultType: "completed" }), estimateToolUsd(instant));
  assert.deepEqual(toolUsage("X", 0), { model: "composio:X", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 });
});

test("the limits and the check order are the contract's", () => {
  assert.equal(TOOL_LIMITS.argumentsMaxBytes, 16 * 1024);
  assert.equal(TOOL_LIMITS.outputMaxBytes, 32 * 1024);
  assert.equal(TOOL_LIMITS.perTokenPerMinute, 60);
  assert.equal(TOOL_LIMITS.perVisitorPerMinute, 20);
  assert.equal(TOOL_LIMITS.perToolkitPerMinute, 120);
  assert.equal(TOOL_LIMITS.perTokenInFlight, 6);
  assert.equal(TOOL_LIMITS.executeTimeoutMs, 30_000);
  assert.equal(TOOL_LIMITS.recipientsMax, 5);
  assert.deepEqual(TOOL_CHECKS, ["token", "allowlist", "principal", "arguments", "rate_limit", "budget", "reserve", "execute", "settle"]);
});
