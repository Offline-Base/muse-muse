import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { documentText, estimateTokens, fitSections, slidingWindow, type Section } from "../skills/recipe-api/helpers/context";
import { footnotes } from "../skills/recipe-api/helpers/footnotes";
import { backoffMs, retryDecision, withRetries } from "../skills/recipe-api/helpers/retry";
import { ndjsonStream, readNdjson, type StreamEvent } from "../skills/recipe-api/helpers/stream";
import { addTokens, cacheLine, costUsd, readTokens } from "../skills/recipe-api/helpers/usage";

const apiError = (status: number, code: string | null = null, retryAfter?: string) =>
  Object.assign(new Error(`${status}`), { status, code, headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}) });

async function* events(list: Array<Record<string, unknown>>, failAfter?: number) {
  let i = 0;
  for (const e of list) {
    if (failAfter !== undefined && i++ === failAfter) throw new Error("socket hang up");
    yield e as { type: string };
  }
}

describe("recipe-api helpers", () => {
  it("retries a 429 and a 503, never a 400, a 413 or a budget stop", async () => {
    assert.equal(retryDecision(apiError(429)).retry, true);
    assert.equal(retryDecision(apiError(503)).retry, true);
    assert.equal(retryDecision(apiError(400)).retry, false);
    assert.equal(retryDecision(apiError(413)).retry, false);
    assert.equal(retryDecision(apiError(429, "budget_exceeded")).retry, false);
    assert.equal(retryDecision(apiError(429, "run_limit")).retry, false);
    assert.equal(retryDecision(apiError(429, null, "3")).retryAfterS, 3);
    assert.equal(backoffMs(1, { retry: true, reason: "", retryAfterS: 3 }), 3000);
    assert.ok(backoffMs(3, { retry: true, reason: "" }, () => 0.999) <= 2000);

    const sleeps: number[] = [];
    let calls = 0;
    const ok = await withRetries(async () => {
      calls++;
      if (calls < 3) throw apiError(503);
      return "fine";
    }, { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    assert.equal(ok.value, "fine");
    assert.deepEqual(ok.attempts.map((a) => a.status), [503, 503, 200]);
    assert.equal(sleeps.length, 2);

    calls = 0;
    await assert.rejects(
      withRetries(async () => {
        calls++;
        throw apiError(400);
      }, { sleep: async () => {} }),
      (err: Error & { attempts?: unknown[] }) => err.attempts?.length === 1,
    );
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(withRetries(async () => {
      calls++;
      throw apiError(429, "budget_exceeded");
    }, { sleep: async () => {} }));
    assert.equal(calls, 1, "a budget stop is a 429 that never retries");

    calls = 0;
    await assert.rejects(withRetries(async () => {
      calls++;
      throw apiError(502);
    }, { sleep: async () => {}, simulated: () => true, onAttempt: (a) => assert.equal(a.simulated, true) }));
    assert.equal(calls, 3, "at most 3 tries");
  });

  it("streams deltas then usage, and keeps a broken stream's text marked cut off", async () => {
    const done = ndjsonStream(events([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hello — " },
      { type: "response.output_text.delta", delta: "there." },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
    ]));
    const seen: StreamEvent[] = [];
    let t = 0;
    const end = await readNdjson(new Response(done), (e) => seen.push(e), () => (t += 10));
    assert.equal(end.text, "Hello ,  there.");
    assert.equal(end.cutOff, false);
    assert.deepEqual(readTokens(end.usage as never), { input: 10, output: 5, cached: 0, reasoning: 0 });
    assert.ok(end.firstTextMs !== null && end.firstTextMs < end.totalMs);
    assert.deepEqual(seen.map((e) => e.type), ["delta", "delta", "done"]);

    const broken = await readNdjson(new Response(ndjsonStream(events([{ type: "response.output_text.delta", delta: "Part" }, { type: "response.output_text.delta", delta: "x" }], 1))), () => {});
    assert.equal(broken.text, "Part");
    assert.equal(broken.cutOff, true);
    assert.match(broken.error ?? "", /socket hang up/);

    const unfinished = await readNdjson(new Response(ndjsonStream(events([{ type: "response.output_text.delta", delta: "Half" }]))), () => {});
    assert.equal(unfinished.cutOff, true);
  });

  it("counts cached and reasoning tokens from real usage, and never claims a cache hit that didn't happen", () => {
    const a = readTokens({ input_tokens: 3000, output_tokens: 400, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 300 } });
    const b = readTokens({ input_tokens: 3010, output_tokens: 380, input_tokens_details: { cached_tokens: 2944 } });
    assert.deepEqual(addTokens(a, b), { input: 6010, output: 780, cached: 2944, reasoning: 300 });
    assert.match(cacheLine(a, { firstCallWithThisPrefix: true }), /first call/);
    assert.match(cacheLine(a, { firstCallWithThisPrefix: false }), /No cache hit/);
    assert.match(cacheLine(b, { firstCallWithThisPrefix: false }), /2,944 of 3,010/);
    const prices = { input: 4, cachedInput: 0.2, output: 20 };
    assert.ok(costUsd(b, prices) < costUsd({ ...b, cached: 0 }, prices));
    assert.deepEqual(readTokens(undefined), { input: 0, output: 0, cached: 0, reasoning: 0 });
  });

  it("builds footnotes from annotations, else from search results, else says plainly there are none", () => {
    const cited = footnotes([
      { type: "reasoning" },
      { type: "web_search_call", results: [{ url: "https://a.example/x", title: "A" }] },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: "One fact. Two fact.",
          annotations: [
            { type: "url_citation", url: "https://b.example/y", title: "B", start_index: 10, end_index: 19 },
            { type: "url_citation", url: "https://a.example/x", title: "A", start_index: 0, end_index: 9 },
          ],
        }],
      },
    ]);
    assert.equal(cited.kind, "cited");
    assert.equal(cited.text, "One fact.[1] Two fact.[2]");
    assert.deepEqual(cited.sources.map((s) => s.url), ["https://a.example/x", "https://b.example/y"]);

    const searched = footnotes([
      { type: "web_search_call", results: [{ url: "https://a.example/x", title: "A" }, { url: "https://a.example/x" }, { url: "javascript:alert(1)" }] },
      { type: "message", content: [{ type: "output_text", text: "Answer.", annotations: [] }] },
    ]);
    assert.equal(searched.kind, "searched");
    assert.equal(searched.sources.length, 1);
    assert.equal(searched.searches, 1);

    const none = footnotes([{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "Answer." }] }]);
    assert.equal(none.note, "No sources were returned for this answer.");
    assert.match(footnotes([{ type: "message", content: [{ type: "output_text", text: "Paris." }] }]).note, /No search ran/);
  });

  it("fits sections to a budget, names what was left out, and keeps the prefix byte-identical", () => {
    const sections: Section[] = Array.from({ length: 10 }, (_, i) => ({ id: `s${i + 1}`, title: `Section ${i + 1}`, text: "x".repeat(4000) }));
    const fit = fitSections(sections, 3_100, ["s9"]);
    assert.ok(fit.kept.some((s) => s.id === "s9"), "a first pass's pick goes in first");
    assert.ok(fit.estTokens <= 3_100);
    assert.equal(fit.kept.length + fit.leftOut.length, 10);
    assert.deepEqual(fit.kept.map((s) => s.id), ["s1", "s2", "s9"]);
    assert.equal(documentText(fit.kept), documentText(fitSections(sections, 3_100, ["s9"]).kept));
    assert.equal(estimateTokens("abcd".repeat(10)), 10);

    const turns = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `turn ${i} ${"y".repeat(396)}` }));
    const w = slidingWindow(turns, 330);
    assert.equal(w.dropped, 5);
    assert.equal(w.turns.at(-1)?.text, turns.at(-1)?.text);
  });

  it("the skill points at every helper and keeps the audit's caching and sample rules", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "skills", "recipe-api", "SKILL.md"), "utf8");
    for (const f of ["usage.ts", "stream.ts", "retry.ts", "footnotes.ts", "context.ts"]) assert.ok(text.includes(f), f);
    assert.match(text, /at least about 2,000 tokens/);
    assert.match(text, /maxRetries: 0/);
    assert.match(text, /Never send `tool_choice` other than `"auto"`/);
    assert.match(text, /Never SVG/);
    assert.match(text, /Never show text labeled as the model's thinking/);
  });
});
