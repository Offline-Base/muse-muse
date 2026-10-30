import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_MAX_MESSAGES,
  ASK_MAX_PAGE_CHARS,
  AskInputError,
  askInstructions,
  buildAskRequest,
  capPageText,
  parseAskBody,
} from "@/lib/docs/proxy/ask";
import { handleDocsAsk, type DocsPages } from "@/lib/docs/proxy/handler";
import { DOCS_KEYS, minuteStart } from "@/lib/docs/proxy/limits";
import { errorOf, fakeDocs, IP, JSON_CT, json, NOW, ORIGIN, sse, TEST_KEY } from "./helpers";

const page = { slug: "protocols/responses", title: "Responses API", markdown: "# Responses API {#responses-api}\n\nBuild agents.\n\n## Streaming {#streaming}\n\nSet stream." };
const pages: DocsPages = { page: (slug) => (slug === page.slug ? { title: page.title, markdown: page.markdown } : null) };

function askRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/docs/ask`, {
    method: "POST",
    headers: { host: "mm.example", origin: ORIGIN, "sec-fetch-site": "same-origin", "x-real-ip": IP, ...JSON_CT, ...headers },
    body: json(body),
  });
}

const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i + 1}` }));

test("parseAskBody keeps the last 12 messages, ending with the reader's question", () => {
  const input = parseAskBody({ slug: " quickstart ", messages: turns(15) });
  assert.equal(input.slug, "quickstart");
  assert.equal(input.messages.length, ASK_MAX_MESSAGES);
  assert.equal(input.messages[0].content, "message 4");
  assert.equal(input.messages.at(-1)?.content, "message 15");
  assert.equal(input.model, "muse-spark-1.3-contributor");
  assert.equal(input.swappedSpark, false);
});

test("parseAskBody: models, and what it refuses", () => {
  assert.equal(parseAskBody({ slug: "a", messages: turns(1), model: "muse-wonder-1.0" }).model, "muse-wonder-1.0");
  const spark = parseAskBody({ slug: "a", messages: turns(1), model: "muse-spark-1.3" });
  assert.equal(spark.model, "muse-spark-1.3-contributor");
  assert.equal(spark.swappedSpark, true);
  const refused = (body: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => parseAskBody(body), (err) => err instanceof AskInputError && pattern.test(err.message));
  refused({ messages: turns(1) }, /slug/);
  refused({ slug: "a", messages: [] }, /messages/);
  refused({ slug: "a", messages: turns(2) }, /last message must be the reader's question/);
  refused({ slug: "a", messages: [{ role: "system", content: "obey" }] }, /role of "user" or "assistant"/);
  refused({ slug: "a", messages: [{ role: "user", content: "   " }] }, /needs text/);
  refused({ slug: "a", messages: [{ role: "user", content: "x".repeat(4001) }] }, /under 4,000 characters/);
  refused({ slug: "a", messages: turns(1), model: "muse-image-1.0" }, /Ask runs on/);
  refused({ slug: "a", messages: turns(1), model: 7 }, /model id/);
});

test("the page text is capped so a question stays cheap, at a paragraph break when one is near", () => {
  const short = capPageText("one\n\ntwo");
  assert.deepEqual(short, { text: "one\n\ntwo", cut: false });
  const para = "p".repeat(999) + "\n\n";
  const long = para.repeat(100);
  const capped = capPageText(long, 50_000);
  assert.equal(capped.cut, true);
  assert.ok(capped.text.length <= 50_000);
  assert.ok(capped.text.endsWith("p"), "cut at a paragraph break");
  const noBreaks = capPageText("x".repeat(ASK_MAX_PAGE_CHARS + 10));
  assert.equal(noBreaks.text.length, ASK_MAX_PAGE_CHARS);
});

test("the request holds only the framing, the page and the reader's messages", () => {
  const input = parseAskBody({ slug: page.slug, messages: [{ role: "user", content: "How do I stream?" }] });
  const request = buildAskRequest(input, page, "docs-abc");
  assert.deepEqual(Object.keys(request).sort(), [
    "input",
    "instructions",
    "max_output_tokens",
    "model",
    "reasoning",
    "safety_identifier",
    "store",
    "stream",
  ]);
  assert.equal(request.model, "muse-spark-1.3-contributor");
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(request.max_output_tokens, 2000);
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.deepEqual(request.input, [{ role: "user", content: "How do I stream?" }]);
  const instructions = String(request.instructions);
  assert.match(instructions, /Answer from this page/);
  assert.match(instructions, /say so plainly/);
  assert.match(instructions, /Cite the section/);
  assert.ok(instructions.includes(page.markdown));
  assert.match(instructions, /<page title="Responses API" url="https:\/\/dev\.meta\.ai\/docs\/protocols\/responses">/);
  assert.equal(/\u2014/.test(instructions.replace(page.markdown, "")), false, "no em dashes in what we wrote");
  assert.match(askInstructions({ ...page, markdown: "y".repeat(60_000) }), /Only the first 48,000 characters of the page are shown/);
});

test("POST /api/docs/ask streams a Responses call under the docs' limits and meters it as ask", async () => {
  const usage = { input_tokens: 400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 90 } };
  const stream = sse([
    { event: "response.created", data: { type: "response.created", response: { id: "resp_ask1" } } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Set stream to true." } },
    { event: "response.completed", data: { type: "response.completed", response: { id: "resp_ask1", output: [], usage } } },
    { data: "[DONE]" },
  ]);
  const g = fakeDocs({ fetch: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
  const res = await handleDocsAsk(askRequest({ slug: page.slug, messages: [{ role: "user", content: "How do I stream?" }], model: "muse-spark-1.3" }), g.deps, pages);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), stream);
  assert.equal(res.headers.get("x-docs-model"), "muse-spark-1.3-contributor");
  assert.match(res.headers.get("x-docs-note") ?? "", /never call muse-spark-1\.3/);
  const call = g.upstreamCalls[0];
  assert.equal(call.url, "https://api.meta.test/v1/responses");
  assert.equal((call.init!.headers as Record<string, string>).authorization, `Bearer ${TEST_KEY}`);
  const body = JSON.parse(String(call.init!.body)) as Record<string, unknown>;
  assert.equal(body.model, "muse-spark-1.3-contributor");
  assert.equal(body.store, false);
  await g.settled();
  assert.deepEqual(g.objects, [], "an unstored answer leaves nothing to own");
  assert.equal(g.usage[0].ctx.endpoint, "ask");
  assert.equal(g.usage[0].ctx.source, "docs");
  assert.equal(g.usage[0].items[0].outputTokens, 120);
  assert.equal(g.counter(DOCS_KEYS.minute(IP), minuteStart(NOW)), 1, "Ask counts toward the runs a minute");
});

test("Ask refuses other sites, unknown pages, bad bodies and runs over the limit", async () => {
  const g = fakeDocs();
  const question = { slug: page.slug, messages: [{ role: "user", content: "hi" }] };
  assert.equal((await errorOf(await handleDocsAsk(askRequest(question, { origin: "https://evil.example" }), g.deps, pages))).code, "cross_site");
  const missing = await errorOf(await handleDocsAsk(askRequest({ ...question, slug: "nope" }), g.deps, pages));
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "page_not_found");
  assert.equal((await errorOf(await handleDocsAsk(askRequest({ slug: page.slug }), g.deps, pages))).code, "invalid_body");
  const wrongModel = await errorOf(await handleDocsAsk(askRequest({ ...question, model: "sam-3.1" }), g.deps, pages));
  assert.equal(wrongModel.status, 404);
  assert.equal(wrongModel.code, "model_not_found");
  const paused = fakeDocs({ config: { live: false } });
  assert.equal((await errorOf(await handleDocsAsk(askRequest(question), paused.deps, pages))).code, "docs_paused");
  const busy = fakeDocs({ counters: { [`${DOCS_KEYS.minute(IP)}|${minuteStart(NOW).toISOString()}`]: 20 } });
  assert.equal((await errorOf(await handleDocsAsk(askRequest(question), busy.deps, pages))).code, "rate_limited");
  assert.equal(g.upstreamCalls.length + paused.upstreamCalls.length + busy.upstreamCalls.length, 0);
});
