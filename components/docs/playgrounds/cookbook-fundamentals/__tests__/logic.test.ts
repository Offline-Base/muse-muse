/**
 * The cookbook-fundamentals demos' pure logic: the line diff, the search-and-replace contract, footnotes from
 * url_citation annotations, the retry loop and circuit breaker, context strategies, long-context arithmetic, prompt
 * caching bodies, the vision request shapes and PNG maker, and the stream analysis (on a real streamed reply).
 * Nothing here reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-fundamentals/__tests__/logic.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { diffLines, diffStats, toHunks, unifiedDiff } from "@/components/docs/playgrounds/cookbook-fundamentals/diff";
import { applyEdit, countOccurrences, editFeedback, parseEditCall, pythonProblems, resolvePath, withEdit } from "@/components/docs/playgrounds/cookbook-fundamentals/edits";
import { DOCUMENTED_SEARCH_REPLY, finalAnswerBlock, outputItemTypes, passages, renderWithFootnotes, sourceList } from "@/components/docs/playgrounds/cookbook-fundamentals/footnotes";
import { backoffSchedule, backoffSeconds, breakerCall, CircuitBreaker, classify, withRetry, type AttemptOutcome } from "@/components/docs/playgrounds/cookbook-fundamentals/retry";
import {
  COMPACT_AT,
  compactionMessages,
  defaultDeclaredWindow,
  extractState,
  meterWarnAt,
  numberFactsHistory,
  planRequest,
  shouldCompact,
  trimHistory,
  type Transcript,
} from "@/components/docs/playgrounds/cookbook-fundamentals/context";
import { CONTEXT_WINDOW, costBeforeSending, denseFiller, repeatDocument, standInDocument, tokensLabel, utf8Bytes, windowCheck } from "@/components/docs/playgrounds/cookbook-fundamentals/long-context";
import { acmePrefix, cacheBody, cacheStat, requestUuid, shortId } from "@/components/docs/playgrounds/cookbook-fundamentals/caching";
import { crc32, inputTokensBody, isPublicImageUrl, RECIPE_TEST_IMAGE, solidPng, visionChatBody } from "@/components/docs/playgrounds/cookbook-fundamentals/vision";
import { analyzeStream, chunkLabel, naiveAccumulate, visibleTokensPerSecond, type TimedEvent } from "@/components/docs/playgrounds/cookbook-fundamentals/stream-timing";
import { SAM_FILES, BROKEN_EDITS } from "@/components/docs/playgrounds/cookbook-fundamentals/sam-files";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const BUILD = "segment_anything/build_sam.py";

describe("diff", () => {
  it("finds a one-line change and writes the recipe's hunk header", () => {
    const before = SAM_FILES[BUILD];
    const after = before.replace("    image_size = 1024\n", "    image_size = 512\n");
    const ops = diffLines(before, after);
    assert.deepEqual(diffStats(ops), { added: 1, removed: 1 });
    const hunks = toHunks(ops);
    assert.equal(hunks.length, 1);
    // The recipe's task 1 diff: @@ -60,7 +60,7 @@ at the pinned commit.
    assert.equal(unifiedDiff(BUILD, before, after).split("\n")[2], "@@ -60,7 +60,7 @@");
  });

  it("diffs a new file from /dev/null and an unchanged file to nothing", () => {
    const d = unifiedDiff("v.py", null, "a\nb\n");
    assert.match(d, /^--- \/dev\/null\n\+\+\+ b\/v\.py\n@@ -0,0 \+1,2 @@\n\+a\n\+b$/);
    assert.equal(unifiedDiff("x", "same\n", "same\n"), "");
  });

  it("merges nearby changes into one hunk and keeps far ones apart", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const near = a.replace("line 10", "LINE 10").replace("line 13", "LINE 13");
    assert.equal(toHunks(diffLines(a, near)).length, 1);
    const far = a.replace("line 2", "LINE 2").replace("line 30", "LINE 30");
    assert.equal(toHunks(diffLines(a, far)).length, 2);
  });
});

describe("search-and-replace edits", () => {
  it("applies an edit that matches exactly once", () => {
    const r = applyEdit(SAM_FILES, { tool: "edit", filePath: BUILD, oldString: "    prompt_embed_dim = 256\n    image_size = 1024", newString: "    prompt_embed_dim = 256\n    image_size = 512" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.matches, 1);
      assert.match(withEdit(SAM_FILES, r)[BUILD], /image_size = 512/);
    }
  });

  it("rejects zero matches, ambiguity, no-ops and missing files, with reasons the model can act on", () => {
    const [whitespace, ambiguous, replaceAll, overwrite] = BROKEN_EDITS.map((b) => applyEdit(SAM_FILES, b.call));
    assert.equal(whitespace.ok, false);
    assert.equal(!whitespace.ok && whitespace.problem, "no_match");
    assert.equal(!ambiguous.ok && ambiguous.problem, "ambiguous");
    assert.equal(!ambiguous.ok && ambiguous.matches, 2);
    assert.equal(replaceAll.ok && replaceAll.matches, 2);
    assert.equal(replaceAll.ok && countOccurrences(replaceAll.after, "encoder_num_heads=8,"), 2);
    assert.equal(overwrite.ok && overwrite.warnings.length, 1);
    const same = applyEdit(SAM_FILES, { tool: "edit", filePath: BUILD, oldString: "torch", newString: "torch" });
    assert.equal(!same.ok && same.problem, "unchanged");
    const missing = applyEdit(SAM_FILES, { tool: "edit", filePath: "segment_anything/nope.py", oldString: "a", newString: "b" });
    assert.equal(!missing.ok && missing.problem, "missing_file");
    assert.match(editFeedback(whitespace, SAM_FILES), /^Rejected: oldString matches 0 times[\s\S]*The file as it is now:/);
  });

  it("reads OpenCode's argument names and absolute paths", () => {
    const call = parseEditCall("edit", JSON.stringify({ filePath: `/work/${BUILD}`, oldString: "a", newString: "b", replaceAll: true }));
    assert.deepEqual(call, { tool: "edit", filePath: `/work/${BUILD}`, oldString: "a", newString: "b", replaceAll: true });
    assert.equal(resolvePath(SAM_FILES, `/work/${BUILD}`), BUILD);
    assert.equal(resolvePath(SAM_FILES, `./${BUILD}`), BUILD);
    assert.deepEqual(parseEditCall("write", '{"file_path":"v.py","content":"x"}'), { tool: "write", filePath: "v.py", content: "x" });
    assert.ok("error" in parseEditCall("delete", "{}"));
    assert.ok("error" in parseEditCall("edit", "not json"));
  });

  it("creates a new file with write, as the recipe's task 4 does", () => {
    const r = applyEdit(SAM_FILES, { tool: "write", filePath: "segment_anything/version.py", content: '__version__ = "1.0"\n' });
    assert.equal(r.ok && r.before, null);
    assert.equal(r.ok && r.warnings.length, 0);
  });

  it("checks Python lightly: the sample files are clean, broken ones aren't", () => {
    for (const [path, text] of Object.entries(SAM_FILES)) assert.deepEqual(pythonProblems(text), [], path);
    assert.match(pythonProblems("def f(x:\n    return x\n").join(" "), /never closes/);
    assert.match(pythonProblems("def f(x)\n    return x\n").join(" "), /colon/);
    assert.match(pythonProblems("if x:\nreturn 1\n").join(" "), /indented/);
    assert.match(pythonProblems('s = "open\n').join(" "), /string/);
    assert.match(pythonProblems("x = 1)\n").join(" "), /no matching/);
    assert.match(pythonProblems("if x:\n\treturn 1\n").join(" "), /tab/);
    assert.deepEqual(pythonProblems('if x: return 1\nd = {"a": 1}\n'), []);
  });
});

describe("footnotes", () => {
  const text = "Fusion hit a record. ITER is delayed. NIF repeated ignition.";
  const ann = [
    { type: "url_citation", url: "https://a.example", title: "A", start_index: 0, end_index: 20 },
    { type: "url_citation", url: "https://b.example", title: "B", start_index: 21, end_index: 37 },
    { type: "url_citation", url: "https://a.example", title: "A", start_index: 38, end_index: 60 },
    { type: "file_citation", url: "x", start_index: 0, end_index: 1 },
  ];

  it("numbers each unique URL once, in order of first appearance, and inserts back to front", () => {
    const f = renderWithFootnotes(text, ann);
    assert.equal(f.marked, "Fusion hit a record.[1] ITER is delayed.[2] NIF repeated ignition.[1]");
    assert.deepEqual(f.sources.map((s) => s.n), [1, 2]);
    assert.equal(f.segments.map((s) => s.text + s.marks.map((m) => `[${m}]`).join("")).join(""), f.marked);
    assert.equal(sourceList(f.sources), "  [1] A, https://a.example\n  [2] B, https://b.example");
  });

  it("writes markers that share an end the way the recipe's stable reverse sort does", () => {
    const f = renderWithFootnotes("abc", [
      { type: "url_citation", url: "u1", start_index: 0, end_index: 3 },
      { type: "url_citation", url: "u2", start_index: 1, end_index: 3 },
    ]);
    assert.equal(f.marked, "abc[2][1]");
    assert.deepEqual(f.segments, [{ text: "abc", marks: [2, 1] }]);
  });

  it("clamps bad offsets and keeps text with no citations whole", () => {
    assert.equal(renderWithFootnotes("hi", [{ type: "url_citation", url: "u", start_index: -5, end_index: 99 }]).marked, "hi[1]");
    assert.deepEqual(renderWithFootnotes("plain", []).segments, [{ text: "plain", marks: [] }]);
    assert.deepEqual(passages(text, ann).map((p) => p.passage), ["Fusion hit a record.", "ITER is delayed.", "NIF repeated ignition."]);
  });

  it("reads a real web search reply: the item order, and the final message as the answer", () => {
    const real = fixture("web-search-response.json");
    assert.deepEqual(outputItemTypes(real), ["reasoning", "message", "web_search_call", "web_search_call", "reasoning", "message"]);
    const answer = finalAnswerBlock(real);
    assert.ok(answer && answer.text.startsWith("## Nuclear Fusion"));
    // This reply came back with no url_citation annotations: the demo has to handle that case.
    assert.deepEqual(answer?.annotations, []);
  });

  it("replays Meta's documented example: two sources, and the page cited twice keeps [1]", () => {
    assert.deepEqual(outputItemTypes(DOCUMENTED_SEARCH_REPLY), ["web_search_call", "message"]);
    const a = finalAnswerBlock(DOCUMENTED_SEARCH_REPLY)!;
    const f = renderWithFootnotes(a.text, a.annotations);
    assert.deepEqual(f.sources.map((s) => [s.n, new URL(s.url).hostname]), [[1, "www.techtarget.com"], [2, "www.thehindubusinessline.com"]]);
    assert.equal((f.marked.match(/\[1\]/g) ?? []).length, 2);
    assert.equal((f.marked.match(/\[2\]/g) ?? []).length, 1);
    // Back to front, so each marker sits at its own end_index: the first one at 76 of the original text.
    assert.equal(f.marked.indexOf("[1]"), 76);
    assert.equal(passages(a.text, a.annotations).length, 3);
    assert.equal(JSON.stringify(DOCUMENTED_SEARCH_REPLY).includes(String.fromCharCode(0x2014)), false);
  });

  it("shifts offsets when a message has several output_text blocks", () => {
    const msg = {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "One. ", annotations: [] },
            { type: "output_text", text: "Two.", annotations: [{ type: "url_citation", url: "u", start_index: 0, end_index: 4 }] },
          ],
        },
      ],
    };
    const a = finalAnswerBlock(msg)!;
    assert.equal(renderWithFootnotes(a.text, a.annotations).marked, "One. Two.[1]");
  });
});

describe("retry", () => {
  it("classifies failures as the recipe's table does", () => {
    assert.equal(classify({ kind: "status", status: 429 }).retry, true);
    assert.equal(classify({ kind: "status", status: 503 }).exception, "APIStatusError");
    assert.equal(classify({ kind: "timeout" }).retry, true);
    assert.equal(classify({ kind: "connection" }).exception, "APIConnectionError");
    assert.equal(classify({ kind: "status", status: 400 }).exception, "BadRequestError");
    assert.equal(classify({ kind: "status", status: 401 }).retry, false);
    assert.equal(classify({ kind: "status", status: 404 }).exception, "NotFoundError");
    assert.equal(classify({ kind: "status", status: 422 }).retry, false);
  });

  it("backs off 0.5 * 2^attempt plus up to 0.5 s of jitter", () => {
    assert.equal(backoffSeconds(0, undefined, () => 0), 0.5);
    assert.equal(backoffSeconds(2, undefined, () => 1), 2.5);
    assert.deepEqual(backoffSchedule(3), [
      { attempt: 1, min: 0.5, max: 1 },
      { attempt: 2, min: 1, max: 1.5 },
    ]);
  });

  const run = (plan: Array<"ok" | 429 | 400 | 503 | "timeout">, opts: { maxRetries: number; naive?: boolean }) => {
    const waits: number[] = [];
    return withRetry<string>(
      async (attempt): Promise<AttemptOutcome<string>> => {
        const step = plan[Math.min(attempt, plan.length - 1)];
        if (step === "ok") return { ok: true, value: `ok on ${attempt + 1}` };
        if (step === "timeout") return { ok: false, failure: { kind: "timeout" } };
        return { ok: false, failure: { kind: "status", status: step } };
      },
      { ...opts, random: () => 0.5, sleep: async (s) => void waits.push(s) },
    ).then((r) => ({ ...r, waits }));
  };

  it("retries 429s and 5xx with growing waits, then succeeds", async () => {
    const r = await run([429, 503, "ok"], { maxRetries: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 3);
    assert.deepEqual(r.waits, [0.75, 1.25]);
    assert.deepEqual(r.events.map((e) => e.outcome), ["retry", "retry", "ok"]);
  });

  it("raises a 400 at once, and gives up on timeouts after max_retries", async () => {
    const bad = await run([400], { maxRetries: 5 });
    assert.equal(bad.ok, false);
    assert.equal(bad.attempts, 1);
    assert.deepEqual(bad.waits, []);
    const slow = await run(["timeout"], { maxRetries: 3 });
    assert.equal(slow.attempts, 3);
    assert.equal(slow.events[2].outcome, "raise");
  });

  it("the naive loop retries the 400 every time and never succeeds", async () => {
    const naive = await run([400], { maxRetries: 4, naive: true });
    assert.equal(naive.attempts, 4);
    assert.deepEqual(naive.waits, [0.3, 0.3, 0.3]);
    await assert.rejects(() => withRetry(async () => ({ ok: true, value: 1 }), { maxRetries: 0 }), RangeError);
  });

  it("the circuit breaker replays the recipe's sequence line for line", () => {
    let now = 0;
    const b = new CircuitBreaker(2, 30, () => now);
    assert.equal(breakerCall(b, "call 1", false), "call 1: ok=False -> failures=1, circuit closed");
    assert.equal(breakerCall(b, "call 2", false), "call 2: ok=False -> failures=2, circuit open");
    assert.equal(b.state(), "open");
    assert.equal(breakerCall(b, "call 3", true), "call 3: circuit open -> skipped");
    now += 30;
    assert.equal(b.state(), "half-open");
    assert.equal(breakerCall(b, "call 4", true), "call 4: ok=True -> failures=0, circuit closed");
    // A failed trial opens it again at once.
    breakerCall(b, "x", false);
    breakerCall(b, "y", false);
    now += 30;
    assert.equal(breakerCall(b, "trial", false), "trial: ok=False -> failures=3, circuit open");
  });
});

describe("context strategies", () => {
  it("trim_history keeps instructions and the newest turns", () => {
    const h = numberFactsHistory(20);
    assert.equal(h.length, 42);
    const t = trimHistory(h, 8);
    assert.equal(t.length, 8);
    assert.equal(t[0].role, "developer");
    assert.equal(t[t.length - 1].content, "Give me one fact about the number 19.");
    assert.deepEqual(trimHistory(h, 1), [h[0]], "no room for turns keeps none (the recipe's Python would keep them all)");
  });

  it("finds the STATE.md block in a reply", () => {
    const reply = "Plan updated.\n\n```state\n# Working Memory\n## Goal\nA proxy.\n```\n";
    assert.deepEqual(extractState(reply), { state: "# Working Memory\n## Goal\nA proxy.", rest: "Plan updated." });
    assert.equal(extractState("```markdown\n# HTTP Proxy STATE\n- x\n```").state, "# HTTP Proxy STATE\n- x");
    assert.equal(extractState("no block").state, null);
  });

  const t: Transcript = {
    instructions: "Be brief.",
    turns: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ],
    state: "# STATE\n- d1",
    summary: "s",
    summaryUpTo: 2,
  };

  it("plans each strategy's request", () => {
    assert.equal(planRequest("full", t, { windowMessages: 4 }).messages.length, 6);
    const w = planRequest("window", t, { windowMessages: 3 });
    assert.deepEqual(w.messages.map((m) => m.content), ["Be brief.", "a2", "u3"]);
    assert.equal(w.dropped, 3);
    const s = planRequest("state", t, { windowMessages: 4 });
    assert.deepEqual(s.messages.map((m) => m.role), ["developer", "developer", "assistant", "user"]);
    assert.match(s.messages[1].content, /# STATE/);
    const c = planRequest("summary", t, { windowMessages: 4 });
    assert.deepEqual(c.messages.map((m) => m.content.slice(0, 7)), ["Be brie", "Summary", "u2", "a2", "u3"]);
    assert.equal(shouldCompact(4000, 8000), true);
    assert.equal(shouldCompact(3999, 8000), false);
    assert.match(compactionMessages(t, 4)[1].content, /USER: u1[\s\S]*ASSISTANT: a2/);
  });

  it("sends STATE.md once: the kept reply loses the block the developer message already carries", () => {
    const block = "```state\n# Working Memory\n## Key Decisions\n- round-robin first\n```";
    const withState: Transcript = {
      instructions: "Be brief.",
      turns: [
        { role: "user", content: "Initial spec." },
        { role: "assistant", content: `Plan: config, pool, proxy.\n\n${block}` },
        { role: "user", content: "Change 1." },
      ],
      state: "# Working Memory\n## Key Decisions\n- round-robin first",
      summary: null,
      summaryUpTo: 0,
    };
    const s = planRequest("state", withState, { windowMessages: 4 });
    assert.deepEqual(s.messages.map((m) => m.role), ["developer", "developer", "assistant", "user"]);
    assert.equal(s.messages[2].content, "Plan: config, pool, proxy.");
    assert.equal(s.messages.filter((m) => m.content.includes("round-robin first")).length, 1, "the state goes out once");
    assert.match(s.note, /left out 1 older message\.$/);
    // A reply that was only the block leaves nothing to keep; before any STATE.md the conversation goes as it is.
    const onlyBlock = { ...withState, turns: [withState.turns[0], { role: "assistant" as const, content: block }, withState.turns[2]] };
    assert.deepEqual(planRequest("state", onlyBlock, { windowMessages: 4 }).messages.map((m) => m.role), ["developer", "developer", "user"]);
    assert.equal(planRequest("state", { ...withState, state: null }, { windowMessages: 4 }).messages.length, 4);
    assert.equal(planRequest("full", { ...withState, turns: withState.turns.slice(0, 1) }, { windowMessages: 4 }).note, "Sent the whole conversation: 1 message.");
  });

  it("starts each strategy on a window it can show, and warns where it matters", () => {
    assert.equal(defaultDeclaredWindow("state"), 2000);
    assert.equal(defaultDeclaredWindow("full"), 2000);
    assert.equal(defaultDeclaredWindow("summary"), 1000);
    assert.equal(meterWarnAt("summary"), COMPACT_AT);
    assert.equal(meterWarnAt("state"), 0.8);
  });
});

describe("long context", () => {
  it("checks input plus output against the window and prices it first", () => {
    assert.deepEqual(windowCheck(1_000_000, 48_576), { input: 1_000_000, output: 48_576, total: CONTEXT_WINDOW, fits: true, over: 0, share: 1 });
    assert.equal(windowCheck(1_080_164, 400).over, 31_988);
    const usd = costBeforeSending("muse-spark-1.3-contributor", 1_000_000, 0);
    assert.ok(usd !== null && Math.abs(usd - 0.1) < 1e-9);
    assert.equal(costBeforeSending("not-a-model", 10, 10), null);
  });

  it("builds the stand-in, copies and a dense, repeatable filler", () => {
    assert.equal(standInDocument().length, 61 * 800);
    assert.match(repeatDocument("x", 3, "f"), /=== f, copy 3 of 3 ===\nx$/);
    assert.equal(repeatDocument("x", 1), "x");
    const f = denseFiller(10_000, 3);
    assert.equal(f.length, 10_000);
    assert.equal(f, denseFiller(10_000, 3));
    assert.match(f.slice(0, 20), /^\d{3} \d{3} \d{3} \d{3} /);
    assert.equal(utf8Bytes("a°é€😀"), 1 + 2 + 2 + 3 + 4);
    assert.equal(tokensLabel(1_080_164), "1.08M");
    assert.equal(tokensLabel(8421), "8,421");
  });
});

describe("prompt caching", () => {
  const base = { model: "m", question: "Q?", prefix: acmePrefix(2), requestId: "rid" } as const;

  it("lays out the recipe's three variants", () => {
    const stable = cacheBody({ ...base, layout: "stable", cacheKey: "k" });
    const first = cacheBody({ ...base, layout: "volatile-first" });
    const last = cacheBody({ ...base, layout: "volatile-last", retention: "24h" });
    const msgs = (b: Record<string, unknown>) => b.messages as Array<{ content: string }>;
    assert.equal(msgs(stable)[0].content, base.prefix);
    assert.equal(stable.prompt_cache_key, "k");
    assert.match(msgs(first)[0].content, /^Request ID: rid\nACME/);
    assert.equal(msgs(last)[1].content, "Q? (request rid)");
    assert.equal(last.prompt_cache_retention, "24h");
    assert.equal("prompt_cache_key" in first, false);
    assert.ok(acmePrefix().startsWith("ACME SUPPORT KNOWLEDGE BASE\nYou are a support agent"));
  });

  it("reads cached tokens from Chat usage", () => {
    assert.deepEqual(cacheStat({ prompt_tokens: 4467, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4465 } }), {
      prompt: 4467,
      cached: 4465,
      ratio: 4465 / 4467,
    });
    assert.equal(shortId(() => 0.99).length, 8);
    assert.match(requestUuid(() => 0.3), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("vision", () => {
  it("makes a valid solid PNG, as the recipe's solid_png does", () => {
    const url = solidPng([220, 30, 30], 4);
    assert.ok(url.startsWith("data:image/png;base64,"));
    const png = Buffer.from(url.split(",")[1], "base64");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: 4 x 4, 8-bit RGB, with a correct CRC.
    assert.equal(png.readUInt32BE(16), 4);
    assert.equal(png.readUInt32BE(20), 4);
    assert.equal(png.readUInt32BE(29), crc32(png.subarray(12, 29)));
    // The IDAT inflates to 4 rows of a filter byte and 4 red pixels.
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    assert.equal(raw.length, 4 * 13);
    assert.deepEqual([...raw.subarray(0, 4)], [0, 220, 30, 30]);
    assert.ok(RECIPE_TEST_IMAGE.startsWith("data:image/png;base64,iVBOR"));
  });

  it("builds the recipe's request shapes", () => {
    const user = visionChatBody({ model: "m", question: "Q", images: ["https://x/a.jpg", "data:image/png;base64,AA"], effort: "minimal" });
    assert.deepEqual(user.messages, [
      { role: "user", content: [{ type: "text", text: "Q" }, { type: "image_url", image_url: { url: "https://x/a.jpg" } }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
    ]);
    assert.equal(user.reasoning_effort, "minimal");
    const dev = visionChatBody({ model: "m", question: "Q", images: ["u"], role: "developer", structured: true });
    assert.equal((dev.messages as Array<{ role: string }>)[0].role, "developer");
    assert.equal((dev.response_format as { type: string }).type, "json_schema");
    assert.deepEqual(inputTokensBody("m", "Q", ["u"]).input, [{ role: "user", content: [{ type: "input_text", text: "Q" }, { type: "input_image", image_url: "u" }] }]);
    assert.equal(isPublicImageUrl("https://raw.githubusercontent.com/a.jpg"), true);
    assert.equal(isPublicImageUrl("http://example.com/a.jpg"), false);
    assert.equal(isPublicImageUrl("https://localhost/a.jpg"), false);
  });
});

describe("stream timing", () => {
  const events: TimedEvent[] = (fixture("chat-stream.json").events as Array<{ at: number; data: string }>).map((e) => {
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { at: e.at, event: { event: null, data: e.data, json } };
  });

  it("reads a real stream: first token, text, the finish chunk with usage, and [DONE]", () => {
    const a = analyzeStream(events);
    assert.equal(a.chunks.length, 14);
    assert.equal(a.firstChunkMs, 1006);
    assert.equal(a.firstTokenMs, 1006);
    assert.equal(a.text, "Cache frequently accessed data for O(1) lookup by key.\nCount frequencies of items like words or votes.\nIndex database records or objects by unique ID.");
    assert.equal(a.finishReason, "stop");
    assert.equal(a.finishIndex, 12);
    assert.equal(a.usageIndex, 12, "Meta puts usage on the finish chunk, which still has a choice");
    assert.equal(a.sawDone, true);
    assert.equal(chunkLabel(a.chunks[12]), "no content, finish_reason: stop, usage");
    assert.equal(chunkLabel(a.chunks[13]), "[DONE]");
    const tps = visibleTokensPerSecond(a);
    assert.ok(tps && tps > 10);
  });

  it("shows where the recipe's naive loop crashes", () => {
    const a = analyzeStream(events);
    assert.equal(a.naive.crashIndex, 12);
    assert.match(a.naive.error ?? "", /^TypeError/);
    assert.equal(a.naive.collected, a.text);
    const usageOnly = naiveAccumulate([{ index: 0, at: 0, kind: "usage", content: undefined, finishReason: null, usage: {}, choices: 0, role: null }]);
    assert.match(usageOnly.error ?? "", /^IndexError/);
  });
});
