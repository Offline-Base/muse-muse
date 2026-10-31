import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogTool } from "@/lib/tools/catalog";
import { applyOutputRules, extractSources, trimOutput } from "@/lib/tools/output";

const tool = (id: string) => {
  const t = catalogTool(id);
  assert.ok(t);
  return t;
};
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

test("scholar keeps only its results, without provider links or noise keys", () => {
  const out = applyOutputRules(tool("scholar"), {
    results: {
      search_metadata: { json_endpoint: "https://serpapi.com/searches/abc.json" },
      organic_results: [{ title: "T", link: "https://papers.test/1", inline_links: { x: 1 }, serpapi_cite: "https://serpapi.com/search?id=1", thumbnail: "t" }],
    },
  });
  assert.deepEqual(out, { results: { organic_results: [{ title: "T", link: "https://papers.test/1" }] } });
});

test("events keep both lists, directly under data", () => {
  const out = applyOutputRules(tool("events"), { events_results: [{ title: "E" }], organic_results: [{ title: "W" }], ai_overview: { big: "x".repeat(50_000) } });
  assert.deepEqual(out, { events_results: [{ title: "E" }], organic_results: [{ title: "W" }] });
});

test("the rules run before the trim, so a 130 KB events reply keeps its results", () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ title: `Event ${i}`, link: `https://events.test/${i}`, date: "Nov 1" }));
  const data = { ai_overview: { text: "x".repeat(130_000) }, events_results: events };
  assert.ok(size(data) > 130_000);
  const kept = applyOutputRules(tool("events"), data);
  const { output, truncated } = trimOutput(kept);
  assert.equal(truncated, false);
  assert.deepEqual(output, { events_results: events });
});

test("read_page keeps text, title and address", () => {
  const out = applyOutputRules(tool("read_page"), { data: { markdown: "# Hi", metadata: { title: "T", url: "https://a.example/", scrapeId: "s", favicon: "f" } }, success: true });
  assert.deepEqual(out, { data: { markdown: "# Hi", metadata: { title: "T", url: "https://a.example/" } } });
});

test("no keep path matching: a verified tool has no results, an unverified one keeps the whole reply", () => {
  assert.deepEqual(applyOutputRules(tool("scholar"), { results: { error: "none", link: "https://serpapi.com/x" } }), {});
  const gmail = tool("gmail_read");
  assert.equal(gmail.outputVerified, false);
  const wrapped = { response_data: { messages: [{ messageId: "1", payload: { big: true } }] } };
  assert.deepEqual(applyOutputRules(gmail, wrapped), { response_data: { messages: [{ messageId: "1" }] } });
});

test("sources come from the rule's path, http(s) only, without repeats or a missing link", () => {
  const sources = extractSources(tool("events").sources, {
    events_results: [{ title: "No link" }, { title: "E", link: "https://a.test/1", date: "Nov 1" }, { title: "Bad", link: "javascript:alert(1)" }],
    organic_results: [{ title: "E again", link: "https://a.test/1" }, { title: "W", link: "https://a.test/2", snippet: "Words" }],
  });
  assert.deepEqual(sources, [
    { url: "https://a.test/1", title: "E", date: "Nov 1" },
    { url: "https://a.test/2", title: "W", snippet: "Words" },
  ]);
});

test("a single-object source works, and sources are capped", () => {
  assert.deepEqual(extractSources(tool("read_page").sources, { data: { metadata: { title: "T", url: "https://a.example/" } } }), [{ url: "https://a.example/", title: "T" }]);
  const many = { results: { organic_results: Array.from({ length: 40 }, (_, i) => ({ title: `${i}`, link: `https://a.test/${i}` })) } };
  assert.equal(extractSources(tool("scholar").sources, many).length, 20);
});

test("trim: small output untouched, and big output stays valid JSON under the limit, keeping what comes first", () => {
  assert.deepEqual(trimOutput({ a: 1 }), { output: { a: 1 }, truncated: false });

  const list = trimOutput({ items: Array.from({ length: 2000 }, (_, i) => ({ i, text: "words ".repeat(10) })) }, 4096);
  assert.equal(list.truncated, true);
  assert.ok(size(list.output) <= 4096);
  const items = (list.output as { items: Array<{ i: number }> }).items;
  assert.ok(items.length > 10);
  assert.equal(items[0].i, 0);

  const text = trimOutput({ data: { markdown: "é\"\n".repeat(20_000), metadata: { title: "T" } } }, 4096);
  assert.ok(size(text.output) <= 4096);
  assert.ok((text.output as { data: { markdown: string } }).data.markdown.length > 100);

  const raw = trimOutput("x".repeat(10_000), 1024);
  assert.ok(size(raw.output) <= 1024);
  const single = trimOutput([{ blob: "y".repeat(100_000) }], 2048);
  assert.ok(size(single.output) <= 2048);
  assert.ok(JSON.stringify(single.output).includes("yyy"));
});
