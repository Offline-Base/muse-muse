/**
 * Stored eval answers the site doesn't show (lib/train/hidden-answers.ts): the one unsafe answer is replaced, its score
 * and every other answer stay as they are.
 *
 *   npx tsx --test lib/train/__tests__/hidden-answers.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { withoutHiddenAnswers } from "@/lib/train/hidden-answers";
import type { TrainEventBody } from "@/lib/train/types";

const JOB = "83d71f74-d84b-40bf-925a-cd36c90b6de5";
const item = (index: number): TrainEventBody => ({ type: "eval", index, prompt: "Empty formula shelf", reference: "A brief.", base: "Use what you have plus water.", tuned: "A calm brief." });

describe("hidden answers", () => {
  it("replace the base answer of prompt 40 in that job, and nothing else", () => {
    const hidden = withoutHiddenAnswers(JOB, item(39));
    assert.ok(hidden.type === "eval");
    assert.match(hidden.base, /^Hidden: this answer gave unsafe advice about feeding a baby/);
    assert.doesNotMatch(hidden.base, /water/);
    assert.equal(hidden.tuned, "A calm brief.");
    assert.equal(hidden.prompt, "Empty formula shelf");
    assert.deepEqual(withoutHiddenAnswers(JOB, item(38)), item(38));
    assert.deepEqual(withoutHiddenAnswers("00000000-0000-4000-8000-000000000000", item(39)), item(39));
    const judgement: TrainEventBody = { type: "judgement", index: 39, baseScore: 2, tunedScore: 9, better: "tuned", note: "Tuned is safer." };
    assert.deepEqual(withoutHiddenAnswers(JOB, judgement), judgement, "scores stay");
  });

  it("are applied by both of the store's readers of eval events", () => {
    const store = readFileSync("lib/train/store.ts", "utf8");
    assert.equal(store.match(/payload: withoutHiddenAnswers\(jobId, r\.payload\)/g)?.length, 2);
    assert.doesNotMatch(store, /payload: r\.payload/);
  });
});
