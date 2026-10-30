/**
 * The protocols page's three-format comparison as data: the bodies a question becomes in each format, turn by turn,
 * and what the table says the next turn sends. Each format carries only its own conversation: a turn that failed on
 * one format is left out of that format's history, and Responses chains from the latest response it stored, never from
 * another format's reply. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/protocols/__tests__/compare.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareBodies, nextTurnNote, responsesChain, WIRE, type CompareTurn } from "@/components/docs/playgrounds/protocols/compare";

const input = { model: "muse-spark-1.3-contributor", system: "", question: "How does that compare to London?", effort: "low" as const, maxOutputTokens: 1500, stream: false };
const blocks = [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "About 2.1 million." }];
const ok = (question: string, id: string): CompareTurn => ({ question, responsesId: id, chatText: `${question} answered`, messagesContent: blocks });

describe("compareBodies", () => {
  it("sends Responses only the new input, chained from the last turn", () => {
    const history = [ok("What is the capital of France?", "resp_1"), ok("What is its population?", "resp_2")];
    const b = compareBodies(input, history);
    assert.equal(b.responses.previous_response_id, "resp_2");
    assert.equal(b.responses.input, input.question);
    assert.equal((b.chat.messages as unknown[]).length, 5, "two turns of history, then the question");
    assert.equal((b.messages.messages as unknown[]).length, 5);
    assert.equal(b.messages.max_tokens, 1500, "max_tokens is required on Messages");
  });

  it("chains Responses from its latest stored response when the last turn failed there", () => {
    const history = [ok("What is the capital of France?", "resp_1"), { ...ok("What is its population?", "resp_x"), responsesId: null }];
    assert.deepEqual(responsesChain(history), { id: "resp_1", turn: 1 });
    const b = compareBodies(input, history);
    assert.equal(b.responses.previous_response_id, "resp_1");
    assert.equal(b.responses.input, input.question, "only the new input: no other format's reply as history");
    assert.match(nextTurnNote("responses", history), /previous_response_id from turn 1: turn 2 failed on Responses/);
  });

  it("starts the Responses conversation over when no turn stored a response, without borrowing Chat's answers", () => {
    const history = [{ ...ok("What is the capital of France?", "x"), responsesId: null }];
    assert.equal(responsesChain(history), null);
    const b = compareBodies(input, history);
    assert.equal(b.responses.previous_response_id, undefined);
    assert.equal(JSON.stringify(b.responses).includes("answered"), false, "Chat Completions' reply isn't replayed as a Responses turn");
    assert.match(nextTurnNote("responses", history), /as a new conversation/);
  });

  it("leaves a failed turn out of Chat Completions and Messages, and says so", () => {
    const history = [ok("What is the capital of France?", "resp_1"), { ...ok("What is its population?", "resp_2"), chatText: null, messagesContent: null }];
    const b = compareBodies(input, history);
    assert.equal((b.chat.messages as unknown[]).length, 3, "turn 1 and the question");
    assert.equal((b.messages.messages as unknown[]).length, 3);
    assert.match(nextTurnNote("chat", history), /without turn 2: it failed on Chat Completions/);
    assert.match(nextTurnNote("messages", history), /without turn 2: it failed on Messages/);
    assert.equal(nextTurnNote("responses", history), WIRE.responses.nextTurn);
  });

  it("describes the plain cases with the table's own words", () => {
    for (const p of ["responses", "chat", "messages"] as const) {
      assert.equal(nextTurnNote(p, []), WIRE[p].nextTurn);
      assert.equal(nextTurnNote(p, [ok("Q", "resp_1")]), WIRE[p].nextTurn);
    }
  });
});
