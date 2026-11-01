/**
 * Who uploads to Hugging Face by itself (lib/train/tune/auto-publish.ts). All examples are made up.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/tune/__tests__/auto-publish.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepDatasetPrivate } from "@/lib/train/hub-cards";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import { autoPublishOk, taskHoldsPersonRows, type AutoPublishInput } from "@/lib/train/tune/auto-publish";
import { foldExamples } from "@/lib/train/tune/examples";

const OK: AutoPublishInput = { flag: true, hubOff: null, asked: true, dataset: { kind: "chat", productId: null, task: "Answer bakery questions" }, runProductId: null };
const folded = foldExamples("Answer bakery questions", [{ prompt: "Open Sunday?", answer: "Yes, until noon." }], 2000).task;

describe("autoPublishOk", () => {
  it("uploads an admin's plain chat run", () => assert.equal(autoPublishOk(OK), true));
  it("stays off without the flag, the Hub, or the ask (visitors never ask)", () => {
    assert.equal(autoPublishOk({ ...OK, flag: false }), false);
    assert.equal(autoPublishOk({ ...OK, hubOff: "HF_TOKEN isn't set" }), false);
    assert.equal(autoPublishOk({ ...OK, asked: false }), false);
  });
  it("never uploads a product's run, owner rows, a person's rows or a decision model", () => {
    assert.equal(autoPublishOk({ ...OK, runProductId: "p" }), false);
    assert.equal(autoPublishOk({ ...OK, dataset: { ...OK.dataset, productId: "p" } }), false);
    assert.equal(autoPublishOk({ ...OK, dataset: { ...OK.dataset, task: folded } }), false);
    assert.equal(autoPublishOk({ ...OK, dataset: { ...OK.dataset, kind: "decision" } }), false);
  });
});

describe("what ownerRowsProblem reads", () => {
  it("sees a folded task", () => {
    assert.equal(taskHoldsPersonRows(folded), true);
    assert.equal(taskHoldsPersonRows("Answer bakery questions"), false);
    assert.equal(taskHoldsPersonRows(null), false);
  });
});

describe("keepDatasetPrivate", () => {
  it("is only Spark 1.3 Contributor's datasets", () => {
    assert.equal(keepDatasetPrivate({ writerModel: SPARK_STANDIN }), true);
    assert.equal(keepDatasetPrivate({ writerModel: "muse-wonder-1.0" }), false);
    assert.equal(keepDatasetPrivate({ writerModel: null }), false);
  });
});
