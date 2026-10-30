import { test } from "node:test";
import assert from "node:assert/strict";
import { waitText } from "@/lib/docs/proxy/errors";
import { backgroundWorstCase, estimateDocsCost, inlineTokens, PREVIOUS_RESPONSE_TOKENS, searchesAllowed } from "@/lib/docs/proxy/estimate";
import { matchEndpoint, type DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import { dayWindow, docsClientIp, holdSpend, minuteStart, secondsUntil, toMicros, DOCS_KEYS } from "@/lib/docs/proxy/limits";
import { isHttps, safetyIdentifier, visitorCookie, visitorHash, visitorOf } from "@/lib/docs/proxy/visitor";
import { usageCost } from "@/lib/meta/pricing";
import { fakeDocs, IP, NOW } from "./helpers";

const at = (method: string, p: string) => matchEndpoint(method, p.split("/")) as DocsEndpoint;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("windows: the minute's start, and the end of the UTC day where per-day rows live", () => {
  assert.equal(minuteStart(NOW).toISOString(), "2026-10-30T12:00:00.000Z");
  assert.equal(dayWindow(NOW).toISOString(), "2026-10-31T00:00:00.000Z");
  assert.equal(dayWindow(new Date("2026-10-30T23:59:59.999Z")).toISOString(), "2026-10-31T00:00:00.000Z");
  assert.equal(dayWindow(new Date("2026-10-31T00:00:00.000Z")).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(secondsUntil(dayWindow(NOW), NOW), 12 * 3600 - 30);
  assert.equal(secondsUntil(NOW, NOW), 1, "never zero");
});

test("money is held as whole micro-dollars, rounded up", () => {
  assert.equal(toMicros(0.0032769), 3277);
  assert.equal(toMicros(2), 2_000_000);
  assert.equal(toMicros(0.1 + 0.2), 300_000, "float noise doesn't add a micro-dollar");
  assert.equal(toMicros(0), 0);
  assert.equal(toMicros(-1), 0);
  assert.equal(toMicros(Number.NaN), 0);
});

test("the client IP: x-real-ip, else the first x-forwarded-for entry, IPv6 by its /64", () => {
  assert.equal(docsClientIp(new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })), "203.0.113.9");
  assert.equal(docsClientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
  assert.equal(docsClientIp(new Headers({ "x-real-ip": "garbage", "x-forwarded-for": "198.51.100.1" })), "198.51.100.1");
  assert.equal(docsClientIp(new Headers({ "x-real-ip": "2001:db8:aaaa:bbbb:1:2:3:4" })), "2001:db8:aaaa:bbbb::/64");
  assert.equal(docsClientIp(new Headers()), "unknown");
});

test("wait times read naturally", () => {
  assert.equal(waitText(12), "12 s");
  assert.equal(waitText(0.2), "1 s");
  assert.equal(waitText(240), "4 min");
  assert.equal(waitText(12 * 3600 - 30), "12 h");
  assert.equal(waitText(3 * 3600 + 20 * 60), "3 h 20 min");
});

test("holdSpend: free calls hold nothing; a held call settles to what it used; cancel gives everything back", async () => {
  const g = fakeDocs();
  const ctx = { source: "docs" as const, endpoint: "responses" };
  const free = await holdSpend(g.deps, ctx, null, 0, IP, NOW);
  assert.ok(!(free instanceof Response));
  await free.settle([]);
  assert.equal(g.usage.length + g.reservations.size, 0);

  const held = await holdSpend(g.deps, ctx, "muse-wonder-1.0", 0.5, IP, NOW);
  assert.ok(!(held instanceof Response));
  assert.equal(g.reservations.size, 1);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 500_000);
  const item = { model: "muse-wonder-1.0", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, costUsd: 0.006 };
  await held.settle([item]);
  assert.equal(g.reservations.size, 0);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 6000);

  const cancelled = await holdSpend(g.deps, ctx, "muse-wonder-1.0", 0.25, IP, NOW);
  assert.ok(!(cancelled instanceof Response));
  await cancelled.cancel();
  assert.equal(g.reservations.size, 0);
  assert.equal(g.counter(DOCS_KEYS.usd(IP), dayWindow(NOW)), 6000);

  // An estimate bigger than the whole daily allowance is refused without touching the counter.
  const huge = await holdSpend(g.deps, ctx, "muse-wonder-1.0", 5, IP, NOW);
  assert.ok(huge instanceof Response);
  assert.equal(huge.status, 429);
});

test("estimates: chat and messages count text, media and output; web search and chained turns add up", () => {
  const chat = at("POST", "chat/completions");
  const json = (model: string, body: Record<string, unknown>) => ({ kind: "json" as const, model, json: { model, ...body } });
  const text = "x".repeat(4000);
  // "user" and the 4,000 characters: 1,001 tokens in, and the output limit.
  const plain = estimateDocsCost(chat, json("muse-wonder-1.0", { messages: [{ role: "user", content: text }], max_completion_tokens: 4096 }), 0);
  close(plain, usageCost({ model: "muse-wonder-1.0", inputTokens: 1001, cachedInputTokens: 0, outputTokens: 4096 }));
  // An image data URL is about 3,000 tokens however many bytes it has.
  const image = estimateDocsCost(
    chat,
    json("muse-wonder-1.0", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(500_000)}` } }] }], max_tokens: 100 }),
    0,
  );
  close(image, usageCost({ model: "muse-wonder-1.0", inputTokens: 3000 + 4, cachedInputTokens: 0, outputTokens: 100 }));
  // Text sent as a data URL is read as text, so it counts by its decoded length.
  const smuggled = estimateDocsCost(
    at("POST", "responses"),
    json("muse-wonder-1.0", {
      input: [{ role: "user", content: [{ type: "input_file", filename: "a.txt", file_data: `data:text/plain;base64,${"QUJD".repeat(250_000)}` }] }],
      max_output_tokens: 16,
    }),
    0,
  );
  assert.ok(smuggled > 0.75, `750 KB of text is about 190,000 tokens: ${smuggled}`);
  // Messages' base64 sources are sized by their media type: a PDF by its pages, at least 20,000 tokens.
  const pdf = estimateDocsCost(
    at("POST", "messages"),
    json("muse-spark-1.2", {
      max_tokens: 1000,
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD".repeat(2_000_000) } }] }],
    }),
    0,
  );
  // 6 MB of PDF is about 120 pages; the labels ("user", "document", "base64", the media type) are 9 tokens.
  close(pdf, usageCost({ model: "muse-spark-1.2", inputTokens: 120_000 + 9, cachedInputTokens: 0, outputTokens: 1000 }));
  // Bare base64 file_data is sized by its filename's type.
  const bare = estimateDocsCost(
    at("POST", "responses"),
    json("muse-spark-1.2", { input: [{ role: "user", content: [{ type: "input_file", filename: "notes.csv", file_data: "QUJD".repeat(1000) }] }], max_output_tokens: 16 }),
    0,
  );
  assert.ok(bare >= usageCost({ model: "muse-spark-1.2", inputTokens: 750, cachedInputTokens: 0, outputTokens: 16 }), "a CSV is read as text");
  assert.equal(inlineTokens("image/webp", 9_000_000), 3000);
  assert.equal(inlineTokens("application/pdf", 100_000), 20_000);
  assert.equal(inlineTokens("text/plain", 4000), 1000);

  const responses = at("POST", "responses");
  const base = { input: "hi", max_output_tokens: 100 };
  const plainResponse = estimateDocsCost(responses, json("muse-spark-1.2", base), 0);
  const chained = estimateDocsCost(responses, json("muse-spark-1.2", { ...base, previous_response_id: "resp_1" }), 0);
  close(chained - plainResponse, usageCost({ model: "muse-spark-1.2", inputTokens: PREVIOUS_RESPONSE_TOKENS, cachedInputTokens: 0, outputTokens: 0 }));
  assert.equal(searchesAllowed({ tools: [{ type: "web_search" }] }), 5);
  assert.equal(searchesAllowed({ tools: [{ type: "web_search" }], max_tool_calls: 2 }), 2);
  assert.equal(searchesAllowed({ tools: [{ type: "function", name: "f" }] }), 0);
  const searching = estimateDocsCost(responses, json("muse-spark-1.2", { ...base, tools: [{ type: "web_search" }], max_tool_calls: 2 }), 0);
  assert.ok(searching - plainResponse > 2 * 0.0025, "two searches and their context");
  // Image and SAM models keep the gateway's per-image estimate.
  close(estimateDocsCost(responses, json("muse-image-1.0", { input: "a fox" }), 0), 0.01);
  close(estimateDocsCost(responses, json("sam-3.1", { input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }] }), 0), 0.0025);

  // Free endpoints estimate nothing.
  assert.equal(estimateDocsCost(at("POST", "responses/input_tokens"), json("muse-wonder-1.0", { input: text }), 0), 0);
  assert.equal(estimateDocsCost(at("POST", "files"), { kind: "raw", model: null }, 1000), 0);
  close(estimateDocsCost(at("POST", "images/generations"), json("muse-image-1.0", { n: 2 }), 0), 0.02);
});

test("the visitor: cookie id, stored hash, cookie attributes, safety identifier", () => {
  const req = (cookie?: string, proto?: string) =>
    new Request("http://localhost:3001/api/docs/v1/models", { headers: { ...(cookie ? { cookie } : {}), ...(proto ? { "x-forwarded-proto": proto } : {}) } });
  const known = visitorOf(req("a=1; mm_docs=visitorAAAAAAAAAAAAAAA; b=2"), () => "never");
  assert.deepEqual(known, { id: "visitorAAAAAAAAAAAAAAA", hash: visitorHash("visitorAAAAAAAAAAAAAAA"), isNew: false });
  assert.match(known.hash, /^[0-9a-f]{64}$/);
  assert.equal(known.hash.includes(known.id), false);
  const fresh = visitorOf(req("mm_docs=../../etc"), () => "visitorNNNNNNNNNNNNNNN");
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.id, "visitorNNNNNNNNNNNNNNN");
  assert.equal(isHttps(req(undefined, "https")), true);
  assert.equal(isHttps(req()), false, "plain http on localhost");
  assert.equal(visitorCookie("abc", false), "mm_docs=abc; Path=/api/docs; Max-Age=2592000; HttpOnly; SameSite=Lax");
  assert.match(safetyIdentifier(known), /^docs-[0-9a-f]{32}$/);
  assert.ok(safetyIdentifier(known).length <= 64, "Meta takes up to 64 characters");
});

test("a background call holds its worst case: the whole context window on every pass, the output cap and every search", () => {
  const responses = at("POST", "responses");
  const model = "muse-spark-1.3-contributor";
  const tokens = (inputTokens: number) => usageCost({ model, inputTokens, cachedInputTokens: 0, outputTokens: 16_384 });
  close(backgroundWorstCase(model, { input: "hi" }), tokens(1_048_576));
  // A previous_response_id, file ids or a URL bring input the body doesn't show; the context window bounds them all.
  const chained = { input: "more", previous_response_id: "resp_1", background: true };
  close(estimateDocsCost(responses, { kind: "json", model, json: { model, ...chained } }, 0), tokens(1_048_576));
  // Each built-in tool call is another pass over the context, and each search is billed.
  const searching = { input: "news", tools: [{ type: "web_search" }], max_tool_calls: 2 };
  close(backgroundWorstCase(model, searching), tokens(3 * 1_048_576) + 2 * 0.0025);
  close(backgroundWorstCase(model, { input: "news", tools: [{ type: "web_search" }] }), tokens(6 * 1_048_576) + 5 * 0.0025);
  // Function tools run on the reader's side, so they add no pass.
  close(backgroundWorstCase(model, { input: "x", tools: [{ type: "function", name: "f" }] }), tokens(1_048_576));
  // Muse Wonder's worst case is more than a reader's day of live demos.
  assert.ok(backgroundWorstCase("muse-wonder-1.0", { input: "hi" }) > 2);
  assert.equal(backgroundWorstCase("sam-3.1", { input: "hi" }), 0, "not priced by the token");
  // Without background, a chained call is still the usual estimate.
  assert.ok(estimateDocsCost(responses, { kind: "json", model, json: { model, input: "more", previous_response_id: "resp_1" } }, 0) < 0.01);
});

test("holdSpend: the hold's state is what a background response's row keeps to settle later", async () => {
  const g = fakeDocs();
  const held = await holdSpend(g.deps, { source: "docs", endpoint: "responses" }, "muse-spark-1.3-contributor", 0.1081344, IP, NOW);
  assert.ok(!(held instanceof Response));
  assert.deepEqual(held.state, {
    reservation: [...g.reservations.keys()][0],
    model: "muse-spark-1.3-contributor",
    micros: 108_135,
    usdKey: DOCS_KEYS.usd(IP),
    day: "2026-10-31T00:00:00.000Z",
  });
  const free = await holdSpend(g.deps, { source: "docs", endpoint: "models" }, null, 0, IP, NOW);
  assert.ok(!(free instanceof Response));
  assert.equal(free.state, null);
});
