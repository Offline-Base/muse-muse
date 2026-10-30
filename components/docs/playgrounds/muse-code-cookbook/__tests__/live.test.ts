/**
 * The live-call helpers: request bodies for strict JSON and the tool loop, and the reply readers, against real
 * replies saved from the docs proxy (Oct 30, 2026; the hashed safety_identifier removed, and the two bash replies'
 * em dashes written as commas, since nothing Muse Muse ships carries one). Nothing calls the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/live.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BASH_TOOL, CHAIN_RETRY_PAUSES_MS, functionCalls, parseStrictReply, strictJsonBody, toolLoopFirstBody, toolLoopNextBody, unfinishedReply, withChainRetry } from "@/components/docs/playgrounds/muse-code-cookbook/logic/live";
import { containmentRequest, guardrailRequest, stagedRequest } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import type { DocsResult } from "@/lib/docs/client/api";
import { collectReply } from "@/lib/docs/client/stream";
import { RECOMMEND_SCHEMA, recommendInstructions, RECIPE_SLUGS } from "@/components/docs/playgrounds/muse-code-cookbook/logic/recipes";
import { strictSubsetProblems } from "@/lib/docs/client/schema";
import { QUESTION_SCHEMA, QUESTION_WITH_RECORD_SCHEMA, TASTE_SCHEMA } from "@/components/docs/playgrounds/muse-code-cookbook/logic/skills";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("bodies", () => {
  it("asks for strict JSON on Contributor with low effort and room to reason", () => {
    const body = strictJsonBody({ instructions: "Pick.", input: "I need approvals", name: "RecipePick", schema: RECOMMEND_SCHEMA });
    assert.equal(body.model, "muse-spark-1.3-contributor");
    assert.equal(body.instructions, "Pick.");
    assert.equal(body.input, "I need approvals");
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.max_output_tokens, 1200);
    assert.deepEqual(body.text, { format: { type: "json_schema", name: "RecipePick", schema: RECOMMEND_SCHEMA, strict: true } });
    const wonder = strictJsonBody({ model: "muse-wonder-1.0", instructions: "x", input: [{ role: "user", content: "hi" }], name: "X", schema: {}, maxOutputTokens: 800, previousResponseId: "resp_1" });
    assert.deepEqual(wonder.input, [{ role: "user", content: "hi" }]);
    assert.equal(wonder.previous_response_id, "resp_1");
    assert.equal(wonder.max_output_tokens, 800);
  });

  it("builds the tool loop's first and next calls", () => {
    const req = { instructions: "Run commands.", input: "Run ./build_info.sh", tools: [BASH_TOOL] };
    const first = toolLoopFirstBody(req);
    assert.equal(first.parallel_tool_calls, false);
    assert.deepEqual((first.tools as Array<{ name: string; type: string; strict: boolean }>).map((t) => [t.type, t.name, t.strict]), [["function", "bash", true]]);
    const next = toolLoopNextBody(req, "resp_abc", [{ callId: "call_1", output: '{"exit_code":0}' }]);
    assert.equal(next.previous_response_id, "resp_abc");
    assert.deepEqual(next.input, [{ type: "function_call_output", call_id: "call_1", output: '{"exit_code":0}' }]);
    assert.equal(next.instructions, "Run commands.", "instructions are resent");
    assert.ok(next.tools, "tools are resent");
  });

  it("keeps every strict schema inside what strict mode accepts", () => {
    for (const schema of [RECOMMEND_SCHEMA, QUESTION_SCHEMA, QUESTION_WITH_RECORD_SCHEMA, TASTE_SCHEMA]) assert.deepEqual(strictSubsetProblems(schema), []);
    assert.match(recommendInstructions(), /- side-chats: /);
    assert.equal(RECIPE_SLUGS.length, 10);
  });
});

describe("real replies", () => {
  it("parses a strict JSON reply", () => {
    const parsed = parseStrictReply<{ picks: Array<{ slug: string; why: string }> }>(fixture("recommend-reply.json"));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.picks[0].slug, "staged-approvals");
    assert.equal(parsed.reply.id, "resp_6ae465b13530d5e052cf488d");
  });

  it("reads the function call a tool-loop reply asks for", () => {
    const reply = collectReply("responses", fixture("bash-call-reply.json"));
    const [call] = functionCalls(reply);
    assert.equal(call.name, "bash");
    assert.equal(call.callId, "call_69fa2a8f-ffb1-433a-b466-71ad5dc4b949");
    assert.deepEqual(call.args, { command: "echo pwned > $HOME/sandbox_escape_probe.txt" });
    const final = collectReply("responses", fixture("bash-final-reply.json"));
    assert.deepEqual(functionCalls(final), []);
    assert.match(final.text, /Read-only file system/);
  });

  it("won't take a tool-loop reply cut off at the token limit for the agent's report", () => {
    const whole = collectReply("responses", fixture("bash-final-reply.json"));
    assert.equal(unfinishedReply(whole), null);
    const cut = collectReply("responses", { ...fixture("bash-final-reply.json"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    assert.match(unfinishedReply(cut) ?? "", /ran out of output tokens/);
    const failed = collectReply("responses", { ...fixture("bash-final-reply.json"), status: "failed", error: { code: "server_error", message: "boom" } });
    assert.match(unfinishedReply(failed) ?? "", /failed: boom/);
  });

  it("gives every tool loop the same room to reason as the other calls", () => {
    for (const r of [containmentRequest("x"), guardrailRequest("x", "muse-spark-1.3-contributor", "default"), stagedRequest("x")]) {
      assert.equal(toolLoopFirstBody(r).max_output_tokens, 4000);
    }
  });

  it("explains a reply cut off by max_output_tokens instead of failing to parse it", () => {
    const cut = { ...fixture("recommend-reply.json"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const parsed = parseStrictReply(cut);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.message, /ran out of output tokens/);
    assert.equal(parseStrictReply(null).ok, false);
  });
});

describe("chained retries", () => {
  const result = (status: number, message = ""): DocsResult => ({
    ok: status < 400,
    status,
    json: null,
    text: "",
    blob: null,
    headers: {},
    error: status < 400 ? null : { message },
    model: null,
    note: null,
    elapsedMs: 1,
  });

  it("retries a chained turn once when Meta can't find the previous response yet", async () => {
    let calls = 0;
    const retries: number[] = [];
    const res = await withChainRetry(async () => (++calls === 1 ? result(400, "referenced response not found or expired") : result(200)), { previous_response_id: "resp_1" }, { pausesMs: [1, 1], onRetry: (n) => retries.push(n) });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(retries, [1]);
    calls = 0;
    const stubborn = await withChainRetry(async () => (++calls, result(400, "referenced response not found or expired")), { previous_response_id: "resp_1" }, { pausesMs: [1, 1] });
    assert.equal(stubborn.status, 400);
    assert.equal(calls, 3, "two retries, then the error stands");
  });

  it("waits 1.5 s, 3 s and 5 s by default before giving up on a chained turn", async () => {
    assert.deepEqual(CHAIN_RETRY_PAUSES_MS, [1500, 3000, 5000]);
    let calls = 0;
    const stubborn = await withChainRetry(async () => (++calls, result(400, "referenced response not found or expired")), { previous_response_id: "resp_1" }, { pausesMs: [1, 1, 1] });
    assert.equal(stubborn.status, 400);
    assert.equal(calls, 4, "three retries, then the error stands");
  });

  it("leaves other failures and unchained requests alone", async () => {
    let calls = 0;
    const missing = async () => {
      calls++;
      return result(400, "referenced response not found or expired");
    };
    assert.equal((await withChainRetry(missing, { input: "hi" }, { pausesMs: [1] })).status, 400);
    assert.equal(calls, 1, "no previous_response_id, no retry");
    calls = 0;
    const other = async () => {
      calls++;
      return result(429, "Too many runs");
    };
    assert.equal((await withChainRetry(other, { previous_response_id: "resp_1" }, { pausesMs: [1] })).status, 429);
    assert.equal(calls, 1);
  });
});
