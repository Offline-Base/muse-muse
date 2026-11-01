/**
 * The decision model pages (docs/DECISION_MODELS.md "The results page"), server-rendered with made-up data outside
 * Next: the router and Link are stand-ins. The New decision dataset card, the dataset page, the mode and estimate on the
 * New job card, DecisionResults on the admin job page and the public result page, and the Lab results line. Nothing
 * here calls a model, Lambda, the Hub or a database.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/decision.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { DecisionSummary } from "@/lib/decide/types";
import type { DatasetView, RecipeView, TrainEventView, TrainJobView } from "@/lib/train/types";
import { ticketDecision, type TicketDecision } from "./decision-fixture";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-11-02T14:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const JOB = "8f1d2c3b-0000-4000-8000-0000000000d1";
const DS = "1b2c3d4e-0000-4000-8000-0000000000d2";
const CHAT_DS = "1b2c3d4e-0000-4000-8000-0000000000c3";

let render: (c: ComponentType<never>, props: object) => string;
let recipes: RecipeView[];
let fmt: typeof import("@/components/train/format");
let results: typeof import("@/components/train/results");
let logic: typeof import("@/lib/train/logic");
let datasets: typeof import("@/lib/train/decision-datasets");
let C: Record<string, ComponentType<never>>;
let tickets: TicketDecision;
let baseOnly: TicketDecision;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  fmt = await import("@/components/train/format");
  results = await import("@/components/train/results");
  logic = await import("@/lib/train/logic");
  datasets = await import("@/lib/train/decision-datasets");
  const { RECIPES } = await import("@/lib/train/recipes");
  recipes = RECIPES.map(fmt.toRecipeView);
  const lab = await import("@/components/train/LabResults");
  C = {
    DecisionResults: (await import("@/components/train/DecisionResults")).DecisionResults as ComponentType<never>,
    DecisionStatus: (await import("@/components/train/DecisionResults")).DecisionStatus as ComponentType<never>,
    NewDecisionCard: (await import("@/components/train/NewDecisionCard")).NewDecisionCard as ComponentType<never>,
    NewJobCard: (await import("@/components/train/NewJobCard")).NewJobCard as ComponentType<never>,
    DatasetDetail: (await import("@/components/train/DatasetDetail")).DatasetDetail as ComponentType<never>,
    DatasetsTable: (await import("@/components/train/DatasetsTable")).DatasetsTable as ComponentType<never>,
    JobRoom: (await import("@/components/train/JobRoom")).JobRoom as ComponentType<never>,
    JobResults: (await import("@/components/train/JobResults")).JobResults as ComponentType<never>,
    ResultsTable: lab.ResultsTable as ComponentType<never>,
    ReadyDatasetsTable: lab.ReadyDatasetsTable as ComponentType<never>,
  };
  tickets = ticketDecision();
  baseOnly = ticketDecision([40, 30, 20, 25], { tuned: false });
});

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.equal(html.includes("javascript:"), false, "no javascript: link");
}

/** The ticket dataset as the pages get it (toDatasetView of its head). */
function decisionDataset(t: TicketDecision = tickets, patch: Partial<DatasetView> = {}): DatasetView {
  return {
    id: DS,
    title: "Ticket router",
    task: t.spec.question,
    status: "ready",
    requested: t.spec.split.train + t.spec.split.dev + t.spec.split.test,
    trainCount: t.spec.split.train,
    evalCount: t.spec.split.test,
    costUsd: 0,
    error: null,
    createdAt: at(-3600),
    finishedAt: at(-3600),
    writerModel: "person",
    kind: "decision",
    decision: t.spec,
    ...patch,
  };
}

function chatDataset(): DatasetView {
  return {
    id: CHAT_DS,
    title: "Bakery helper",
    task: "Answer customer questions for a small bakery.",
    status: "ready",
    requested: 300,
    trainCount: 270,
    evalCount: 30,
    costUsd: 1.2,
    error: null,
    createdAt: at(-7200),
    finishedAt: at(-7000),
    writerModel: "muse-wonder-1.0",
  };
}

/** A decide job of the ticket dataset, as toJobView shows it. */
function decideJob(patch: Partial<TrainJobView> = {}): TrainJobView {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    title: "Ticket router LoRA",
    status: "succeeded",
    params: { datasetId: DS, mode: "decide", epochs: 2, learningRate: 0.0002, loraRank: 16, scoreOnly: 0, dryRun: 0, publish: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 150,
    maxUsd: 14,
    instanceId: "0123456789abcdef",
    instanceIp: "1.2.3.4",
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: "Decide mode: LoRA r=16 on Muse Glimmer 30B, 336 renderings in 11 steps, final loss 0.42, 192 decision items scored before and after training.",
    error: null,
    costUsd: 0.83,
    createdAt: at(-1800),
    launchedAt: at(-1700),
    lastHeartbeatAt: at(-200),
    finishedAt: at(-120),
    terminatedAt: at(-60),
    evalSummary: tickets.summary,
    ...patch,
  };
}

function decideEvents(t: TicketDecision = tickets): TrainEventView[] {
  const out: TrainEventView[] = [{ id: 1, type: "status", payload: { type: "status", status: "running" }, at: at(-1600) }];
  let id = 2;
  for (const part of ["dev", "test"] as const) {
    for (let i = 0; i < t.sent[part].length; i += 100) {
      out.push({ id: id++, type: "decide", payload: { type: "decide", part, items: t.sent[part].slice(i, i + 100) }, at: at(-300 + id) });
    }
  }
  out.push({ id: id++, type: "done", payload: { type: "done", summary: "Decide mode", metrics: { mode: "decide", too_long: 0 } }, at: at(-130) });
  return out;
}

const ceilings = { maxMinutes: 120, maxUsd: 5 };

describe("format helpers for decision models", () => {
  it("says the counts, rates and intervals plainly", () => {
    assert.equal(fmt.decisionCountsText(tickets.spec), "168 train · 24 dev · 48 test");
    assert.equal(fmt.percentText(0.8541), "85%");
    assert.equal(fmt.percentText(Number.NaN), "0%");
    assert.equal(fmt.intervalText(tickets.summary.tuned!.accuracy), "73% to 93%");
    assert.equal(fmt.rightText(tickets.summary.tuned!.accuracy), "right on 41 of 48 held-out examples (85%)");
    assert.equal(fmt.eceText(0.0341), "3.4%");
    assert.equal(fmt.twoPlaces(0.86), "0.86");
    assert.equal(
      fmt.decisionHeadline(tickets.summary),
      "The tuned model was right on 41 of 48 held-out examples (85%); base Glimmer was right on 32 (67%).",
    );
    assert.equal(fmt.decisionHeadline(baseOnly.summary), "Base Glimmer was right on 16 of 24 held-out examples (67%), with nothing trained.");
    assert.match(fmt.decisionSummaryText(tickets.summary), /^Accuracy on 48 held-out rows: tuned 85% \(73% to 93%\), macro F1 0\.86; base 67%/);
  });

  it("says when confidence is calibrated and when it isn't, and what the numbers rest on", () => {
    assert.match(fmt.calibrationText(tickets.summary.tuned!, 24), /^Confidence is calibrated on 24 dev rows \(T = 0\.89\)/);
    assert.equal(
      fmt.calibrationText({ ...tickets.summary.tuned!, calibrated: false, T: 1 }, 12),
      "Fewer than 20 dev rows were scored, so confidence is the model's own probability, not calibrated.",
    );
    const notes = fmt.decisionNotes({ ...tickets.summary, unscoredRows: 2, groups: 3 }, { trainRows: 168, succeeded: false });
    assert.equal(notes[0], "The job didn't succeed, so these are only the scores its GPU sent before it stopped.");
    assert.match(notes[1]!, /small LoRA adapter on Muse Glimmer 30B, trained on 168 of this dataset's examples/);
    assert.match(notes[2]!, /^2 of the 48 test rows had no usable score/);
    assert.match(notes.join(" "), /asked as 3 prompts/);
    assert.equal(notes.at(-1), "It can be wrong: check anything that matters.");
    const small = fmt.decisionNotes(baseOnly.summary);
    assert.ok(small.includes("Billing, Shipping, Account and Returns have under 10 test rows, so one row moves their scores by 10 points or more."));
    assert.equal(small.some((n) => /LoRA adapter/.test(n)), false, "a score-only job trained nothing");
  });

  it("names a person's dataset, lists it with its splits, and reads decide events", () => {
    const d = decisionDataset();
    assert.equal(fmt.writerName(d), "The person who uploaded it");
    assert.equal(fmt.writerName({ writerModel: "muse-wonder-1.0" }), "Muse Wonder");
    assert.equal(fmt.datasetCountsText(d), "168 train · 24 dev · 48 test");
    assert.equal(fmt.datasetOptionText(d), "Ticket router · 4 labels, 168 train, 48 test");
    assert.equal(fmt.datasetOptionText(chatDataset()), "Bakery helper · 270 train, 30 eval", "chat datasets read as before");
    const line = fmt.eventLine({ type: "decide", part: "test", items: tickets.sent.test.slice(0, 100) });
    assert.deepEqual(line, { icon: "chart", lead: "Scores", text: "96 test items scored, base and tuned." });
    assert.equal(fmt.eventLine({ type: "decide", part: "dev", items: baseOnly.sent.dev.slice(0, 1) }).text, "1 dev item scored, base only.");
    assert.equal(fmt.groupEvents(decideEvents()).filter((g) => g.kind === "fold").length, 1, "back-to-back scores fold");
  });

  it("shows the mode's own params and datasets, and leaves publishing out of decide mode", () => {
    const glimmer = recipes.find((r) => r.id === "glimmer-lora")!;
    const shown = (mode: "chat" | "decide") => glimmer.params.filter((f) => fmt.paramShown(f, mode)).map((f) => f.key);
    assert.deepEqual(shown("chat"), ["datasetId", "mode", "maxSteps", "learningRate", "loraRank", "studentPrompt", "dryRun", "publish", "why"]);
    assert.deepEqual(shown("decide"), ["datasetId", "mode", "epochs", "learningRate", "loraRank", "scoreOnly", "dryRun"]);
    assert.equal(fmt.formMode({ mode: "Decide " }), "decide");
    assert.equal(fmt.formMode({}), "chat");
    const both = [chatDataset(), decisionDataset()];
    assert.deepEqual(fmt.datasetsForMode(both, "decide").map((d) => d.id), [DS]);
    assert.deepEqual(fmt.datasetsForMode(both, "chat").map((d) => d.id), [CHAT_DS]);
  });

  it("estimates a decide run from its dataset, as the jobs route does", () => {
    const size = datasets.decideRunSize(tickets.spec, { epochs: 2 });
    const gpu = { instanceType: "gpu_1x_a100_sxm4", label: "1x A100 SXM4 (40 GB)", priceCentsPerHour: 199, free: true };
    const hint = fmt.runTimeHint({ id: "glimmer-lora" }, { mode: "decide", epochs: "2" }, gpu, { maxMinutes: 120, maxUsd: 5 }, false, size)!;
    const warm = logic.runEstimate("glimmer-lora", { mode: "decide", epochs: "2" }, gpu.instanceType, true, size)!;
    assert.equal(hint.warn, false);
    assert.equal(
      hint.text,
      `Training on ${size.renderings} renderings (${warm.steps} steps of 32) and scoring ${size.scored} prompts before and after on 1x A100 SXM4 (40 GB): ` +
        `about ${warm.minutes} minutes in a region with the model cache, about ${warm.minutes + 25} without it (${warm.trainMinutes} of training and ` +
        `${warm.scoreMinutes} of scoring, plus 20 or 45 to boot and load the model). The rates are estimates until a real run measures them.`,
    );
    const only = fmt.runTimeHint({ id: "glimmer-lora" }, { mode: "decide", scoreOnly: "1" }, gpu, { maxMinutes: 120, maxUsd: 5 }, false, size)!;
    assert.match(only.text, /^Scoring \d+ prompts with base Glimmer on 1x A100 SXM4 \(40 GB\), with nothing trained: about 21 minutes/);
    const tight = fmt.runTimeHint({ id: "glimmer-lora" }, { mode: "decide" }, gpu, { maxMinutes: 30, maxUsd: 5 }, false, size)!;
    assert.equal(tight.warn, true);
    assert.match(tight.text, /refused if it lands in a region without the cache/);
    assert.equal(fmt.runTimeHint({ id: "glimmer-lora" }, { mode: "decide" }, gpu, ceilings), null, "no estimate without the dataset's size");
  });

  it("follows a decide job from running to scored, and says why when there are no numbers", () => {
    const now = t0;
    assert.deepEqual(fmt.decisionState(decideJob({ status: "running", evalSummary: null, terminatedAt: null }), now, true), { state: "running" });
    assert.deepEqual(fmt.decisionState(decideJob({ evalSummary: null }), now, true), { state: "scoring" });
    assert.equal(fmt.decisionState(decideJob(), now, true).state, "scored");
    assert.deepEqual(fmt.decisionState(decideJob({ status: "failed", evalSummary: null }), now, false), {
      state: "unscored",
      reason: "The job ended before its GPU sent any scores, so there is nothing to score.",
      summary: null,
    });
    assert.equal(fmt.decisionState(decideJob({ evalSummary: null }), now + 25 * 60_000, true).state, "unscored");
    const noted = logic.unjudgedSummary("Scoring skipped: the job's decision dataset is gone.");
    assert.deepEqual(fmt.decisionState(decideJob({ evalSummary: noted }), now, true), {
      state: "unscored",
      reason: "Scoring skipped: the job's decision dataset is gone.",
      summary: null,
    });
    const empty: DecisionSummary = { ...tickets.summary, items: 0, note: "No held-out row had usable scores." };
    assert.equal((fmt.decisionState(decideJob({ evalSummary: empty }), now, true) as { reason: string }).reason, "No held-out row had usable scores.");
  });

  it("keeps decision models off the Hub card and names their scores in the adapter list", () => {
    assert.match(fmt.hubJobBlock(decideJob())!, /^It is a decision model/);
    assert.equal(fmt.hubControl(decideJob(), null), null, "no Publish button");
    const option = fmt.adapterOptionText({ title: "Ticket router LoRA", datasetTitle: "Ticket router", region: "us-east-1", finishedAt: at(0), evalSummary: tickets.summary });
    assert.match(option, /^Ticket router LoRA · tuned right on 41 of 48 · /);
  });

  it("explains a refused upload with each problem's line", () => {
    const body = {
      error: "The upload has 2 problems. The first: Line 3 has 3 fields, but the header has 2.",
      problems: [
        { line: 3, message: "Line 3 has 3 fields, but the header has 2. Put text that has commas in double quotes." },
        { line: null, message: '"Billing" has 12 examples; each label needs at least 20.' },
      ],
    };
    assert.deepEqual(fmt.decisionUploadErrorText(400, body), {
      error: body.error,
      problems: [body.problems[0]!.message, body.problems[1]!.message],
    });
    assert.match(fmt.decisionUploadErrorText(413, {}).error, /over 4 MB/);
    assert.match(fmt.decisionUploadErrorText(500, { error: "boom_x" }).error, /\(boom_x\)/);
  });
});

describe("wrong answers", () => {
  it("lists exactly the misses behind the accuracy, the most confident first", () => {
    const s = tickets.summary;
    const picks = logic.decisionRowPicks(tickets.input, { base: s.base.T, tuned: s.tuned!.T });
    assert.equal(picks.length, s.items, "the rows the summary counts");
    assert.equal(picks.filter((p) => p.tuned!.pick === p.label).length, s.tuned!.accuracy.right);
    assert.equal(picks.filter((p) => p.base.pick === p.label).length, s.base.accuracy.right);
    const wrong = fmt.wrongAnswers(picks, tickets.rows.test, 3);
    assert.equal(wrong.model, "tuned");
    assert.equal(wrong.total, s.items - s.tuned!.accuracy.right);
    assert.equal(wrong.shown.length, 3);
    for (const w of wrong.shown) {
      assert.notEqual(w.pick, w.label);
      assert.equal(w.input, tickets.rows.test[w.row]!.input);
      assert.equal(typeof w.base?.right, "boolean");
    }
    assert.ok(wrong.shown[0]!.confidence >= wrong.shown[1]!.confidence && wrong.shown[1]!.confidence >= wrong.shown[2]!.confidence);
    const b = baseOnly.summary;
    const basePicks = logic.decisionRowPicks(baseOnly.input, { base: b.base.T, tuned: null });
    const baseWrong = fmt.wrongAnswers(basePicks, baseOnly.rows.test, 100);
    assert.equal(baseWrong.model, "base");
    assert.equal(baseWrong.total, b.items - b.base.accuracy.right);
    assert.equal(baseWrong.shown.every((w) => w.base === undefined), true);
  });

  it("leaves out rows with a missing score, as the summary does", () => {
    const sent = { dev: tickets.sent.dev, test: tickets.sent.test.slice(1) };
    const input = datasets.decisionScoringInput(tickets.spec, tickets.rows, sent);
    const summary = logic.summarizeDecisions(input);
    assert.equal(logic.decisionRowPicks(input, { base: 1, tuned: 1 }).length, summary.items);
    assert.equal(summary.items, 47);
  });
});

describe("DecisionResults", () => {
  it("shows the strip, per label scores, the matrices, the chart, the baselines and health, and no inputs", () => {
    const html = render(C.DecisionResults, { summary: tickets.summary, trainRows: 168 });
    clean(html);
    assert.match(html, /id="decision-results"/);
    assert.match(html, /Tuned accuracy<\/p><p class="stat-num">85%<\/p><p class="stat-sub">41 of 48 · 95% interval 73% to 93%/);
    assert.match(html, /Base Glimmer accuracy<\/p><p class="stat-num">67%<\/p>/);
    assert.match(html, /Macro F1<\/p><p class="stat-num">0\.86<\/p><p class="stat-sub">base 0\.69 · each label counts the same/);
    assert.match(html, /Calibration error<\/p><p class="stat-num">11\.1%<\/p><p class="stat-sub">10\.0% before T = 0\.89/);
    assert.match(html, /The tuned model was right on 41 of 48 held-out examples \(85%\); base Glimmer was right on 32 \(67%\)\./);
    assert.match(html, /trained on 168 of this dataset&#x27;s examples/);
    assert.match(html, /It can be wrong: check anything that matters\./);
    for (const name of ["Billing", "Shipping", "Account", "Returns"]) assert.match(html, new RegExp(`<th scope="row">${name}</th>`));
    assert.match(html, /<th scope="col" class="num">None<\/th>/);
    assert.match(html, /<details class="decide-more"><summary>Base Glimmer&#x27;s matrix<\/summary>/);
    assert.match(html, /<svg class="decide-chart"[^>]*role="img"[^>]*aria-label="Reliability: Tuned, calibration error 11\.1% with T, 10\.0% before; Base Glimmer/);
    assert.match(html, /<line class="decide-ideal"/);
    assert.equal(html.match(/<circle class="decide-dot"/g)?.length, tickets.summary.tuned!.reliability.filter((b) => b.rows).length + tickets.summary.base.reliability.filter((b) => b.rows).length);
    assert.match(html, /<title>Tuned: 15 rows at 90% to 100% confidence/);
    assert.match(html, /Always Billing<span class="row-sub muted">the commonest training label/);
    assert.match(html, /Word overlap<span class="row-sub muted">a stand-in, not a model/);
    assert.match(html, /<dt>Letter mass, median and lowest<\/dt><dd>tuned 0\.98, 0\.98 · base Glimmer 0\.80, 0\.80<\/dd>/);
    assert.match(html, /<dt>Decline check \(right label taken out\)<\/dt><dd>tuned 48 of 48 \(100%\) · base Glimmer 48 of 48 \(100%\)<\/dd>/);
    assert.doesNotMatch(html, /Wrong answers/);
    for (const r of tickets.rows.test) assert.equal(html.includes(r.input), false, "never an input without the admin's list");
  });

  it("shows a score-only job's base numbers alone", () => {
    const html = render(C.DecisionResults, { summary: baseOnly.summary });
    clean(html);
    assert.doesNotMatch(html, /Tuned accuracy|Base Glimmer&#x27;s matrix/);
    assert.match(html, /Base Glimmer was right on 16 of 24 held-out examples \(67%\), with nothing trained\./);
    assert.match(html, /have under 10 test rows/);
  });

  it("lists the wrong answers with their inputs only when the admin page passes them", () => {
    const s = tickets.summary;
    const wrong = fmt.wrongAnswers(logic.decisionRowPicks(tickets.input, { base: s.base.T, tuned: s.tuned!.T }), tickets.rows.test, 100);
    const html = render(C.DecisionResults, { summary: s, wrong });
    clean(html);
    assert.match(html, /Wrong answers<\/h3><span class="muted small">Admins only<\/span>/);
    assert.equal(wrong.total, 7);
    assert.equal(html.match(/% sure<\/span>/g)?.length, wrong.total, "one row per miss");
    for (const w of wrong.shown) assert.ok(html.includes(w.input), "the admin sees each missed input");
    assert.match(html, /also wrong|right/);
  });

  it("says where a decide job's numbers stand before they exist", () => {
    assert.match(render(C.DecisionStatus, { state: { state: "running" }, succeeded: false }), /The numbers show here once its GPU shuts down/);
    assert.match(render(C.DecisionStatus, { state: { state: "scoring" }, succeeded: true }), /Scoring\.\.\./);
    assert.match(render(C.DecisionStatus, { state: { state: "unscored", reason: "Scoring didn't finish.", summary: null }, succeeded: true }), /Scoring didn&#x27;t finish\./);
  });
});

describe("the admin job page of a decide job", () => {
  function room(job: TrainJobView, extra: object = {}) {
    return render(C.JobRoom, {
      job,
      events: decideEvents(),
      recipe: recipes.find((r) => r.id === "glimmer-lora"),
      dataset: { id: DS, title: "Ticket router", writerModel: "person" },
      hub: { offReason: null, maxActive: 1, dailyUsd: 20 },
      serverNow: t0,
      ...extra,
    });
  }

  it("shows its scores in place of judged eval results, with no local files and no Publish", () => {
    const html = room(decideJob(), { decision: { trainRows: 168, wrong: null } });
    clean(html);
    assert.match(html, /<h2 id="decide-results-title">Decision results<\/h2>/);
    assert.doesNotMatch(html, /Eval results|judged by/);
    assert.match(html, /<strong>Scores<\/strong> 2 reports, 120 items/);
    assert.match(html, /<dt>Scores<\/dt><dd><a href="#decision-results">Tuned right on 41 of 48<\/a>/);
    assert.match(html, /It is a decision model, and publishing one/);
    assert.doesNotMatch(html, /Publish to Hugging Face<\/span><\/button>|Make local files/);
  });

  it("says it is scoring once the GPU is gone, and while it runs", () => {
    assert.match(room(decideJob({ evalSummary: null })), /Scoring\.\.\./);
    assert.match(room(decideJob({ status: "running", evalSummary: null, terminatedAt: null, finishedAt: null })), /once its GPU shuts down/);
  });
});

describe("the public result page and the Lab results line", () => {
  function resultRow(over: Record<string, unknown> = {}) {
    return {
      id: JOB,
      recipe: "glimmer-lora",
      title: "Ticket router LoRA",
      status: "succeeded",
      params: { datasetId: DS, mode: "decide", epochs: 2, learningRate: 0.0002, loraRank: 16, scoreOnly: 0, dryRun: 0, publish: 0 },
      instanceType: "gpu_1x_a100_sxm4",
      costUsd: 0.83,
      createdAt: new Date(t0 - 1800_000),
      launchedAt: new Date(t0 - 1700_000),
      finishedAt: new Date(t0 - 120_000),
      terminatedAt: new Date(t0 - 60_000),
      evalSummary: { ...tickets.summary, secret: "a person's input" } as DecisionSummary,
      judgeModel: null,
      ...over,
    };
  }

  it("maps a decision summary field by field and shows the settings it ran with", () => {
    const view = results.toResultView(resultRow() as never, recipes.find((r) => r.id === "glimmer-lora")!)!;
    assert.ok(view.decision);
    assert.equal("secret" in view.decision!, false);
    assert.deepEqual(view.decision, results.decisionSummaryOf(tickets.summary));
    assert.deepEqual(JSON.parse(JSON.stringify(view.decision)), JSON.parse(JSON.stringify(tickets.summary)), "every number kept");
    assert.deepEqual(
      view.settings.map((s) => [s.label, s.value]),
      [
        ["LoRA rank", "16"],
        ["Learning rate", "0.0002"],
        ["Mode", "decide"],
        ["Epochs", "2"],
        ["Score only", "0"],
      ],
    );
  });

  it("shows the results read-only with no inputs, and how it was scored", () => {
    const view = results.toResultView(resultRow() as never, recipes.find((r) => r.id === "glimmer-lora")!)!;
    const html = render(C.JobResults, { result: view, rows: [], dataset: { id: DS, title: "Ticket router", writerModel: "person", trainCount: 168 } });
    clean(html);
    assert.match(html, /No judge and no model call: the scores are counted, not graded\./);
    assert.match(html, /Decision results/);
    assert.match(html, /trained on 168 of this dataset/);
    assert.doesNotMatch(html, /Wrong answers|judged by|Muse Wonder/);
    for (const r of [...tickets.rows.test, ...tickets.rows.train]) assert.equal(html.includes(r.input), false);
  });

  it("puts a decide job's accuracy and macro F1 in the results table", () => {
    const view = results.toResultView(resultRow() as never, recipes.find((r) => r.id === "glimmer-lora")!)!;
    const html = render(C.ResultsTable, { results: [view], caption: "Results" });
    clean(html);
    assert.match(html, /Muse Glimmer LoRA · decision model/);
    assert.match(html, /Tuned right on <strong>41<\/strong> of 48 \(85%\)<span class="row-sub muted">Base right on 32 \(67%\)<\/span>/);
    assert.match(html, /Macro F1 base 0\.69 · tuned <strong>0\.86<\/strong>/);
    assert.doesNotMatch(html, /Tuned won/);
  });

  it("maps a ready decision dataset with its labels and counts, never a seed or a row", () => {
    const row = {
      id: DS,
      title: "Ticket router",
      task: tickets.spec.question,
      status: "ready",
      requested: 240,
      trainCount: 168,
      evalCount: 48,
      costUsd: 0,
      createdAt: new Date(t0),
      finishedAt: new Date(t0),
      writerModel: "person",
      kind: "decision",
      decision: { ...tickets.spec, seed: undefined, rows: tickets.rows },
    };
    const view = results.toReadyDatasetView(row as never);
    assert.equal(view.kind, "decision");
    assert.equal(view.decision!.seed, "");
    assert.deepEqual(view.decision!.labels, tickets.spec.labels);
    assert.deepEqual(view.decision!.perLabel, tickets.spec.perLabel);
    assert.equal(JSON.stringify(view).includes(tickets.rows.train[0]!.input), false);
    const chat = results.toReadyDatasetView({ ...row, kind: "chat", decision: null } as never);
    assert.equal("kind" in chat || "decision" in chat, false, "a chat dataset's view is as it was");
    const html = render(C.ReadyDatasetsTable, { datasets: [view], now: t0, caption: "Datasets" });
    assert.match(html, /168 train · 24 dev · 48 test/);
  });
});

describe("the dataset page and list", () => {
  const sampleRows = () =>
    Object.fromEntries(tickets.spec.labels.map((l) => [l.id, tickets.rows.train.filter((r) => r.label === l.id).slice(0, 2)]));

  it("shows an admin the question, the labels with their splits and a few rows of each", () => {
    const html = render(C.DatasetDetail, { dataset: decisionDataset(), sampleTrain: [], sampleEval: [], written: null, now: t0, sampleRows: sampleRows() });
    clean(html);
    assert.match(html, /Decision dataset · uploaded/);
    assert.match(html, /<strong>4 labels<\/strong> · 168 train · 24 dev · 48 test/);
    assert.match(html, /<h2 id="ds-question">Question<\/h2><p class="train-text">Which team should handle this support ticket\?<\/p>/);
    assert.match(html, /<th scope="row">Billing<span class="row-sub muted">Charges, refunds and invoices<\/span><\/th><td class="num">42<\/td><td class="num">6<\/td><td class="num">12<\/td>/);
    assert.match(html, /Test rows \(a fifth of each label, at least 5\) were held out first/);
    assert.match(html, /href="\/fine-tuning\?dataset=1b2c3d4e-0000-4000-8000-0000000000d2#new-job"[^>]*>.*Train on it/);
    assert.ok(html.includes(sampleRows().billing![0]!.input));
    assert.doesNotMatch(html, /Eval prompts|Written by/);
  });

  it("shows anyone else the labels and counts only", () => {
    const html = render(C.DatasetDetail, { dataset: decisionDataset(), sampleTrain: [], sampleEval: [], written: null, now: t0, readOnly: true });
    clean(html);
    assert.match(html, /Their inputs stay private/);
    assert.doesNotMatch(html, /Sample rows|Train on it/);
    for (const r of tickets.rows.train) assert.equal(html.includes(r.input), false);
  });

  it("warns when one label has more than 5 times another's rows, and when a label has few test rows", () => {
    const lopsided = ticketDecision([130, 20, 20, 20], { tuned: false });
    const html = render(C.DatasetDetail, { dataset: decisionDataset(lopsided), sampleTrain: [], sampleEval: [], written: null, now: t0 });
    assert.match(html, /more than 5 times the rows of the smallest/);
    assert.match(html, /Shipping, Account, Returns have under 10 test rows/);
  });

  it("lists a decision dataset with its splits", () => {
    const html = render(C.DatasetsTable, { datasets: [decisionDataset(), chatDataset()], now: t0, caption: "Datasets" });
    assert.match(html, /168 train · 24 dev · 48 test/);
    assert.match(html, /270 train · 30 eval/);
  });
});

describe("the New decision dataset card", () => {
  it("labels every field, starts with two labels and costs nothing", () => {
    const html = render(C.NewDecisionCard, {});
    clean(html);
    assert.match(html, /id="new-decision-dataset"/);
    for (const label of ["Question", "Name", "Label 1", "Label 2", "Rows"]) {
      assert.match(html, new RegExp(`<label[^>]*for="[^"]+"[^>]*>${label}`), label);
    }
    assert.equal(html.match(/>Description <span class="muted">\(optional\)<\/span>/g)?.length, 2);
    assert.match(html, /<legend class="train-label">Labels<\/legend>/);
    assert.match(html, /Choose a file<\/span><input type="file" class="sr-only" accept="\.csv,\.jsonl/);
    assert.match(html, /Saving generates nothing and costs nothing/);
    assert.match(html, /<button type="submit" class="btn btn-primary"[^>]*>.*Save dataset/);
    assert.doesNotMatch(html, /<button type="submit"[^>]*disabled/);
    assert.match(html, /disabled="" aria-label="Remove label 1" title="Remove"/, "two labels is the least");
    assert.doesNotMatch(html, /Meta&#x27;s API|\$\d/);
  });

  it("reads pasted rows the way the route does, CSV or JSONL", async () => {
    const { rowsFormat, rowsPreview } = await import("@/components/train/NewDecisionCard");
    const labels = tickets.spec.labels;
    const csv = ["input,label", '"I was charged twice",Billing', '"Where is my parcel",shipping', '"Hello",Sales', 'broken,"x'].join("\n");
    assert.equal(rowsFormat(csv), "csv");
    assert.deepEqual(rowsPreview(csv, labels), {
      format: "csv",
      rows: 3,
      perLabel: [
        { name: "Billing", rows: 1 },
        { name: "Shipping", rows: 1 },
        { name: "Account", rows: 0 },
        { name: "Returns", rows: 0 },
      ],
      unknown: 1,
      problems: 1,
    });
    const jsonl = '\n{"input":"Reset my password","label":"Account"}\n{"input":"Send it back","label":"returns"}';
    assert.equal(rowsFormat(jsonl), "jsonl");
    assert.deepEqual(rowsPreview(jsonl, labels)!.perLabel.map((l) => l.rows), [0, 0, 1, 1]);
    assert.equal(rowsPreview("  \n", labels), null);
  });
});

describe("the mode on the New job card", () => {
  const base = { recipes: [], ceilings, maxActive: 1, dailyUsd: 20, platformPublic: true, adapters: [] };
  const glimmer = () => recipes.filter((r) => r.id === "glimmer-lora");

  it("starts in decide mode for a decision dataset, with its params and its estimate", () => {
    const html = render(C.NewJobCard, { ...base, recipes: glimmer(), datasets: [chatDataset(), decisionDataset()], initialDatasetId: DS });
    clean(html);
    assert.match(html, /<option value="decide" selected="">Decide: pick one label for each input<\/option>/);
    assert.match(html, /<option value="1b2c3d4e-0000-4000-8000-0000000000d2" selected="">Ticket router · 4 labels, 168 train, 48 test<\/option>/);
    assert.doesNotMatch(html, /Bakery helper/, "chat datasets aren't offered in decide mode");
    for (const label of ["Epochs", "Score only"]) assert.match(html, new RegExp(`>${label}<span class="muted"> \\(optional\\)`), label);
    for (const label of ["Training steps", "Student prompt", "Publish to Hugging Face", "Why this model"]) {
      assert.doesNotMatch(html, new RegExp(`>${label}<`), label);
    }
    assert.match(html, /Publish to Hugging Face is off in decide mode, and a person&#x27;s rows are never published/);
    assert.match(html, /Training on \d+ renderings \(\d+ steps of 32\) and scoring \d+ prompts before and after on Auto/);
  });

  it("keeps chat mode as it was, with chat datasets only", () => {
    const html = render(C.NewJobCard, { ...base, recipes: glimmer(), datasets: [chatDataset(), decisionDataset()] });
    clean(html);
    assert.match(html, /<option value="chat" selected="">Chat: learn a chat dataset&#x27;s answers<\/option>/);
    assert.match(html, /Bakery helper · 270 train, 30 eval/);
    assert.doesNotMatch(html, /Ticket router/);
    for (const label of ["Training steps", "Student prompt", "Publish to Hugging Face"]) assert.match(html, new RegExp(`>${label}<`), label);
    assert.doesNotMatch(html, />Epochs<|>Score only</);
    assert.match(html, /120 training steps on Auto/);
  });
});
