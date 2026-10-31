/**
 * Decide mode on the platform's side (docs/DECISION_MODELS.md, "A mode, not a new recipe" and "Lambda, the default"):
 * the glimmer-lora recipe's mode, epochs and scoreOnly params as validateParams checks them (a chat job's params stay
 * exactly as before), the dataset kind each mode trains on, the run estimate from a decision dataset's renderings and
 * scored prompts, the sentence when a run doesn't fit, and the decide callback's cap. After the run (D5): a decision
 * model stays off the Hub (publish 0 by default, and refused by hubJobProblem) and gets no local files (quantProblem),
 * and its scored summary names no judge. Pure: nothing here does I/O.
 *
 *   npx tsx --test lib/train/__tests__/decide-mode.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DecideSplitCounts, DecisionSpec, DecisionSummary } from "@/lib/decide/types";
import { checkDecisionUpload, decideRunSize, decisionPartSize, isDecideMode } from "@/lib/train/decision-datasets";
import { hubJobProblem, publishOff } from "@/lib/train/hub-cards";
import {
  adapterProblem,
  capEventBody,
  datasetModeProblem,
  DECIDE_CALLBACK_ITEMS_MAX,
  DECIDE_SCORE_PROMPTS_PER_SECOND,
  DECIDE_TRAIN_ROWS_PER_SECOND,
  GLIMMER_OVERHEAD_MINUTES,
  GLIMMER_OVERHEAD_NO_CACHE_MINUTES,
  jobMode,
  quantProblem,
  runEstimate,
  runFitProblem,
  validateParams,
} from "@/lib/train/logic";
import { isDecisionSummary, judgeModelOf, UNRECORDED_MODEL } from "@/lib/train/models";
import { recipeById } from "@/lib/train/recipes";
import type { EvalSummary } from "@/lib/train/types";
import { TICKET_LABELS, TICKET_QUESTION, ticketRows } from "./decision-fixture";

const lora = recipeById("glimmer-lora")!;
const DS = "dddddddd-0000-4000-8000-000000000000";
const A100 = "gpu_1x_a100_sxm4";

/** A spec with `labels` labels of the same counts, for estimates (the layout only needs the labels and counts). */
function handSpec(labels: number, each: DecideSplitCounts): DecisionSpec {
  const list = Array.from({ length: labels }, (_, i) => ({ id: `label-${i}`, name: `Label ${i}`, description: "" }));
  return {
    version: 1,
    question: TICKET_QUESTION,
    labels: list,
    seed: "estimate-seed",
    split: { train: each.train * labels, dev: each.dev * labels, test: each.test * labels },
    perLabel: Object.fromEntries(list.map((l) => [l.id, { ...each }])),
    source: "person",
  };
}

const error = (r: ReturnType<typeof validateParams>) => (r.ok ? null : r.error);

describe("decide mode params (validateParams)", () => {
  it("leaves a chat job's params exactly as they were before decide mode", () => {
    assert.deepEqual(validateParams(lora, { datasetId: DS }), {
      ok: true,
      value: { datasetId: DS, maxSteps: 120, learningRate: 0.0002, loraRank: 16, studentPrompt: "short", dryRun: 0, publish: 1 },
    });
    const asked = validateParams(lora, { datasetId: DS, mode: " CHAT ", maxSteps: 300, publish: 0 });
    assert.deepEqual(asked, {
      ok: true,
      value: { datasetId: DS, mode: "chat", maxSteps: 300, learningRate: 0.0002, loraRank: 16, studentPrompt: "short", dryRun: 0, publish: 0 },
    });
    assert.equal(jobMode({ datasetId: DS }), "chat");
  });

  it("fills decide mode's own params, drops chat's, and keeps publish at 0", () => {
    assert.deepEqual(validateParams(lora, { datasetId: DS, mode: " Decide " }), {
      ok: true,
      value: { datasetId: DS, mode: "decide", epochs: 2, learningRate: 0.0002, loraRank: 16, scoreOnly: 0, dryRun: 0, publish: 0 },
    });
    const asked = validateParams(lora, { datasetId: DS, mode: "decide", epochs: "3", scoreOnly: 1, dryRun: 1, publish: "0", maxSteps: "", studentPrompt: " " });
    assert.ok(asked.ok);
    assert.deepEqual([asked.value.epochs, asked.value.scoreOnly, asked.value.dryRun, asked.value.publish], [3, 1, 1, 0]);
    assert.ok(!("maxSteps" in asked.value) && !("studentPrompt" in asked.value), "blank chat fields are fine and left out");
    assert.equal(jobMode(asked.value), "decide");
    assert.equal(isDecideMode(asked.value), true);
  });

  it("refuses a mode it doesn't know, the other mode's params, epochs that aren't whole, and publishing in decide mode", () => {
    const decide = { datasetId: DS, mode: "decide" };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ datasetId: DS, mode: "train" }, "Mode must be chat or decide."],
      [{ datasetId: DS, mode: 3 }, "Mode must be text."],
      [{ ...decide, maxSteps: 200 }, "Training steps is only for chat mode."],
      [{ ...decide, studentPrompt: "full" }, "Student prompt is only for chat mode."],
      [{ datasetId: DS, epochs: 2 }, "Epochs is only for decide mode."],
      [{ datasetId: DS, mode: "chat", scoreOnly: 1 }, "Score only is only for decide mode."],
      [{ ...decide, epochs: 2.5 }, "Epochs must be a whole number."],
      [{ ...decide, epochs: 0 }, "Epochs must be at least 1."],
      [{ ...decide, epochs: 5 }, "Epochs must be at most 4."],
      [{ ...decide, scoreOnly: 0.5 }, "Score only must be a whole number."],
      [{ ...decide, scoreOnly: 2 }, "Score only must be at most 1."],
      [
        { ...decide, publish: 1 },
        "Publish to Hugging Face must be 0 in decide mode: a person's rows are never published, and publishing a decision model on its own comes later.",
      ],
    ];
    for (const [params, want] of cases) assert.equal(error(validateParams(lora, params)), want, JSON.stringify(params));
  });
});

describe("the dataset each mode trains on", () => {
  it("takes a decision dataset in decide mode only, and a chat dataset in chat mode only", () => {
    assert.equal(datasetModeProblem({ mode: "decide" }, "decision"), null);
    assert.equal(datasetModeProblem({}, "chat"), null);
    assert.equal(datasetModeProblem({}, undefined), null, "a dataset from before kinds is a chat dataset");
    assert.equal(datasetModeProblem({ mode: "decide" }, "chat"), "decide mode trains on a decision dataset, and that one is a chat dataset.");
    assert.equal(datasetModeProblem({ mode: "chat" }, "decision"), "that is a decision dataset, so it trains in decide mode: set Mode to decide.");
  });
});

describe("decide run estimates", () => {
  // The two runs in docs/DECISION_MODELS.md "Lambda, the default".
  const small = handSpec(4, { train: 70, dev: 10, test: 20 });
  const large = handSpec(8, { train: 175, dev: 25, test: 50 });
  const decide = (over: Record<string, string | number> = {}) => ({ datasetId: DS, mode: "decide", epochs: 2, ...over });

  it("sizes a run from its dataset: renderings at its epochs, and dev and test prompts with the decline check", () => {
    assert.deepEqual(decideRunSize(small, { epochs: 2 }), { renderings: 560, scored: 200 });
    assert.deepEqual(decideRunSize(large, { epochs: 2 }), { renderings: 2800, scored: 1300 }, "2 groups a row");
    assert.deepEqual(decideRunSize(small, { epochs: 1 }), { renderings: 280, scored: 200 });
    const checked = checkDecisionUpload({ question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows([100, 20, 20, 20]) }, "size-seed");
    assert.ok(checked.ok);
    const size = decideRunSize(checked.spec, { epochs: 3 });
    assert.equal(size.renderings, decisionPartSize(checked.spec, "train", 3), "balancing copies included");
    assert.equal(size.scored, decisionPartSize(checked.spec, "dev", 3) + decisionPartSize(checked.spec, "test", 3));
    assert.ok(size.renderings > 3 * checked.spec.split.train, "the smaller labels' copies");
  });

  it("adds training, scoring twice and the overhead, as the doc's table has them", () => {
    assert.deepEqual(runEstimate("glimmer-lora", decide(), A100, true, decideRunSize(small, decide())), {
      steps: 18,
      secondsPerStep: 8,
      trainMinutes: 3,
      overheadMinutes: GLIMMER_OVERHEAD_MINUTES,
      minutes: 25,
      cached: true,
      what: "decide",
      renderings: 560,
      scored: 200,
      scoreMinutes: 2,
      scoreOnly: false,
    });
    assert.equal(runEstimate("glimmer-lora", decide(), A100, true, decideRunSize(large, decide()))!.minutes, 43, "12 + 11 + 20");
    const base = runEstimate("glimmer-lora", decide({ scoreOnly: 1 }), A100, true, decideRunSize(small, decide()))!;
    assert.deepEqual([base.minutes, base.trainMinutes, base.scoreMinutes, base.steps, base.renderings], [21, 0, 1, 0, 0], "score only: 1 + 20");
    const cold = runEstimate("glimmer-lora", decide(), A100, false, decideRunSize(small, decide()))!;
    assert.equal(cold.minutes, 3 + 2 + GLIMMER_OVERHEAD_NO_CACHE_MINUTES);
    const fast = runEstimate("glimmer-lora", decide(), "gpu_1x_h100_sxm5", true, { renderings: 8400, scored: 960 })!;
    assert.deepEqual([fast.trainMinutes, fast.scoreMinutes], [Math.ceil(8400 / DECIDE_TRAIN_ROWS_PER_SECOND.gpu_1x_h100_sxm5! / 60), Math.ceil(1920 / DECIDE_SCORE_PROMPTS_PER_SECOND.gpu_1x_h100_sxm5! / 60)]);
    const unknown = runEstimate("glimmer-lora", decide(), "gpu_8x_mystery", true, { renderings: 2400, scored: 240 })!;
    assert.deepEqual([unknown.trainMinutes, unknown.scoreMinutes], [10, 2], "an unknown GPU counts as the slowest");
    const huge = runEstimate("glimmer-lora", decide(), A100, true, { renderings: 100_000, scored: 0 })!;
    assert.deepEqual([huge.steps, huge.trainMinutes], [2000, Math.ceil(64_000 / 4 / 60)], "2,000 steps of 32 at most, as the GPU trains");
  });

  it("has no estimate without the dataset's size, or for a dry run, and leaves chat estimates as they were", () => {
    assert.equal(runEstimate("glimmer-lora", decide(), A100, true), null);
    assert.equal(runEstimate("glimmer-lora", decide({ dryRun: 1 }), A100, true, decideRunSize(small, decide())), null);
    assert.deepEqual(runEstimate("glimmer-lora", { maxSteps: 120 }, A100, true, { renderings: 99, scored: 99 }), runEstimate("glimmer-lora", { maxSteps: 120 }, A100, true));
  });

  it("says why a decide run doesn't fit its limits", () => {
    const e = runEstimate("glimmer-lora", decide(), A100, true, decideRunSize(large, decide()))!;
    assert.equal(runFitProblem(e, 43, "1x A100 SXM4 (40 GB)"), null);
    assert.equal(
      runFitProblem(e, 30, "1x A100 SXM4 (40 GB)"),
      "Training on 2800 renderings and scoring 1300 prompts before and after on 1x A100 SXM4 (40 GB) needs about 43 minutes (12 of training, 11 of scoring, plus about 20 for booting and loading the model), but this job's limits stop it after 30 minutes. Lower the epochs, raise the time or dollar limit, or pick a faster GPU.",
    );
    const cold = runEstimate("glimmer-lora", decide({ scoreOnly: 1 }), A100, false, decideRunSize(large, decide()))!;
    const problem = runFitProblem(cold, 30, "1x A100 SXM4 (40 GB)")!;
    assert.equal(
      problem,
      "Scoring 1300 prompts with base Glimmer on 1x A100 SXM4 (40 GB) needs about 51 minutes (6 of scoring, plus about 45 for booting, installing the packages and downloading the model, since this region has no model cache yet), but this job's limits stop it after 30 minutes. Raise the time or dollar limit, or pick a faster GPU.",
    );
    assert.equal(problem.includes(String.fromCharCode(0x2014)), false, "no em dash");
  });
});

describe("decide callbacks and adapters", () => {
  it("keeps a logged decide callback to its cap of items", () => {
    const items = Array.from({ length: 130 }, (_, index) => ({ index, base: [-0.1, -2.5], tuned: null, baseMass: 0.99, tunedMass: null }));
    const capped = capEventBody({ type: "decide", part: "test", items });
    assert.equal(capped.type === "decide" && capped.items.length, DECIDE_CALLBACK_ITEMS_MAX);
    assert.deepEqual(capEventBody({ type: "decide", part: "dev", items: items.slice(0, 2) }), { type: "decide", part: "dev", items: items.slice(0, 2) });
  });

  it("keeps decision adapters out of the chat demo, publishing and local files until their decide versions exist", () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000000";
    const metrics = { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${id}` };
    const chat = { id, recipe: "glimmer-lora" as const, status: "succeeded" as const, params: { datasetId: DS } };
    assert.equal(adapterProblem(chat, metrics), null);
    const trained = { ...chat, params: { datasetId: DS, mode: "decide", epochs: 2, scoreOnly: 0 } };
    assert.equal(adapterProblem(trained, metrics), "that job trained a decision model, and serving, publishing and local files for decision models aren't built yet.");
    assert.equal(adapterProblem({ ...trained, params: { ...trained.params, scoreOnly: 1 } }, metrics), "that job only scored base Glimmer, so it trained no adapter.");
  });
});

describe("after a decide run: no judge, no publishing, no local files", () => {
  const id = "aaaaaaaa-0000-4000-8000-000000000000";
  const scored: DecisionSummary = {
    items: 48,
    tunedWins: 10,
    baseWins: 2,
    ties: 36,
    avgBaseScore: 0,
    avgTunedScore: 0,
    judgeCostUsd: 0,
    kind: "decision",
  } as DecisionSummary;
  const decideParams = { datasetId: DS, mode: "decide", epochs: 2, scoreOnly: 0, dryRun: 0, publish: 0 };
  const job = {
    id,
    recipe: "glimmer-lora" as const,
    status: "succeeded" as const,
    params: decideParams as Record<string, string | number>,
    terminatedAt: new Date(),
    evalSummary: scored as EvalSummary,
  };

  it("keeps a decision model off the Hub, whatever its summary or a missing publish param says", () => {
    assert.equal(
      hubJobProblem(job),
      "It is a decision model, and publishing one (the adapter alone, with a decision card, never the person's rows) isn't built yet.",
    );
    assert.equal(hubJobProblem({ ...job, params: { datasetId: DS }, evalSummary: { ...scored, kind: undefined } as EvalSummary }), null, "a judged chat job still publishes");
    assert.equal(publishOff(decideParams), true);
    assert.equal(publishOff({ datasetId: DS, mode: "decide" }), true, "unset is 0 in decide mode");
    assert.equal(publishOff({ datasetId: DS, mode: "decide", publish: 1 }), false, "the param is still read as it is");
    assert.equal(publishOff({ datasetId: DS }), false, "unset still publishes in chat mode");
    assert.equal(publishOff({ datasetId: DS, mode: "chat" }), false);
  });

  it("refuses local files for a decision model's adapter until the decision check exists", () => {
    const problem = "that job trained a decision model, and its local files need a decision check (Q4_K_M's picks against the adapter's) that isn't built yet.";
    assert.equal(quantProblem(job, { student_prompt: "short" }), problem);
    assert.equal(quantProblem({ ...job, terminatedAt: null, evalSummary: null }, null), problem, "before the judged check");
    assert.equal(quantProblem({ ...job, params: { datasetId: DS, studentPrompt: "short" } }, { student_prompt: "short" }), null, "a chat adapter as before");
  });

  it("names no judge for a scored decision summary, and Muse Spark 1.3 for a judged one from before the record", () => {
    assert.equal(isDecisionSummary(scored), true);
    assert.equal(isDecisionSummary({ ...scored, kind: undefined } as EvalSummary), false);
    assert.equal(isDecisionSummary(null), false);
    assert.equal(judgeModelOf({ judgeModel: null, evalSummary: scored }), null);
    assert.equal(judgeModelOf({ judgeModel: null, evalSummary: { ...scored, kind: undefined } as EvalSummary }), UNRECORDED_MODEL);
    assert.equal(judgeModelOf({ judgeModel: "muse-wonder-1.0", evalSummary: scored }), "muse-wonder-1.0", "a recorded judge is kept");
  });
});
