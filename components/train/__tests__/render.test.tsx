import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { DatasetView, EvalSummary, RecipeView, TrainEventView, TrainJobView } from "@/lib/train/types";

// Server-renders the fine-tuning components with sample data, outside Next: the router and Link are stand-ins.
mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-10-27T14:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

const base: TrainJobView = {
  id: "8f1d2c3b-0000-4000-8000-000000000001",
  recipe: "smoke",
  title: "Smoke test",
  status: "running",
  params: {},
  instanceType: "gpu_1x_a10",
  region: "us-east-1",
  priceCentsPerHour: 75,
  maxMinutes: 30,
  maxUsd: 1,
  instanceId: "0123456789abcdef",
  instanceIp: "1.2.3.4",
  stopRequested: false,
  progress: { step: 2, totalSteps: 3, loss: 0.5 },
  artifacts: [
    {
      name: "metrics.json",
      kind: "metrics",
      url: "https://store1.public.blob.vercel-storage.com/models/8f1d2c3b-0000-4000-8000-000000000001/0123456789ab-m.json",
      bytes: 900,
    },
    { name: "login.html", kind: "other", url: "https://lambda-labs-login.example/x", bytes: 1 },
  ],
  summary: null,
  error: null,
  costUsd: 0.05,
  createdAt: at(-60),
  launchedAt: at(0),
  lastHeartbeatAt: at(60),
  finishedAt: null,
  terminatedAt: null,
  evalSummary: null,
};

const events: TrainEventView[] = [
  { id: 1, type: "status", payload: { type: "status", status: "queued", message: "Job queued." }, at: at(0) },
  {
    id: 2,
    type: "instance",
    payload: { type: "instance", instanceId: "0123456789abcdef", instanceType: "gpu_1x_a10", region: "us-east-1" },
    at: at(5),
  },
  { id: 3, type: "heartbeat", payload: { type: "heartbeat" }, at: at(60) },
  { id: 4, type: "heartbeat", payload: { type: "heartbeat" }, at: at(120) },
  ...[1, 2, 3, 4, 5].map(
    (step, i): TrainEventView => ({
      id: 5 + i,
      type: "progress",
      payload: { type: "progress", step, totalSteps: 5 },
      at: at(130 + i),
    }),
  ),
  { id: 20, type: "log", payload: { type: "log", text: "nvidia-smi\nNVIDIA A10" }, at: at(140) },
  {
    id: 21,
    type: "artifact",
    payload: { type: "artifact", artifact: { name: "evil", kind: "other", url: "javascript:alert(1)", bytes: 1 } },
    at: at(141),
  },
  {
    id: 22,
    type: "done",
    payload: { type: "done", summary: "All checks passed.", metrics: { gpu: "NVIDIA A10", cuda: "yes" } },
    at: at(150),
  },
];

let render: (c: ComponentType<never>, props: object) => string;
let recipes: RecipeView[];
let JobRoom: ComponentType<never>;
let JobsTable: ComponentType<never>;
let NewJobCard: ComponentType<never>;
let AdminsOnly: ComponentType<never>;
let DatasetsTable: ComponentType<never>;
let NewDatasetCard: ComponentType<never>;
let DatasetDetail: ComponentType<never>;
let LabIntro: ComponentType<never>;
let ResultsTable: ComponentType<never>;
let ReadyDatasetsTable: ComponentType<never>;
let JobResults: ComponentType<never>;
let results: typeof import("@/components/train/results");
let evalRowsOf: typeof import("@/components/train/format").evalRows;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  // React separates adjacent text with <!-- -->; drop it so assertions read like the page.
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  const { toRecipeView } = await import("@/components/train/format");
  const { RECIPES } = await import("@/lib/train/recipes");
  recipes = RECIPES.map(toRecipeView);
  JobRoom = (await import("@/components/train/JobRoom")).JobRoom as ComponentType<never>;
  JobsTable = (await import("@/components/train/JobsTable")).JobsTable as ComponentType<never>;
  NewJobCard = (await import("@/components/train/NewJobCard")).NewJobCard as ComponentType<never>;
  AdminsOnly = (await import("@/components/train/AdminsOnly")).AdminsOnly as ComponentType<never>;
  DatasetsTable = (await import("@/components/train/DatasetsTable")).DatasetsTable as ComponentType<never>;
  NewDatasetCard = (await import("@/components/train/NewDatasetCard")).NewDatasetCard as ComponentType<never>;
  DatasetDetail = (await import("@/components/train/DatasetDetail")).DatasetDetail as ComponentType<never>;
  const lab = await import("@/components/train/LabResults");
  LabIntro = lab.LabIntro as ComponentType<never>;
  ResultsTable = lab.ResultsTable as ComponentType<never>;
  ReadyDatasetsTable = lab.ReadyDatasetsTable as ComponentType<never>;
  JobResults = (await import("@/components/train/JobResults")).JobResults as ComponentType<never>;
  results = await import("@/components/train/results");
  evalRowsOf = (await import("@/components/train/format")).evalRows;
});

function room(job: TrainJobView): string {
  return render(JobRoom, { job, events, recipe: recipes[0], serverNow: t0 + 300_000 });
}

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.equal(html.includes("javascript:"), false, "no javascript: link");
}

describe("job page", () => {
  it("shows a running job with its log, progress, cost and Stop", () => {
    const html = room(base);
    clean(html);
    assert.match(html, /role="log"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /<strong>Heartbeat<\/strong> 2 reports, the last at 14:02:00/);
    assert.match(html, /\(5 reports\)/);
    assert.match(html, /2 of 3/);
    assert.match(html, /Stop job/);
    assert.match(html, /Running on the GPU/);
    assert.match(html, /\$0\.06 est\./, "5 started minutes at $0.75 an hour");
    assert.match(html, /href="https:\/\/store1\.public\.blob\.vercel-storage\.com\/models\/8f1d2c3b-[^"]+\/0123456789ab-m\.json"/);
    assert.match(html, /login\.html/, "an artifact from elsewhere still shows");
    assert.doesNotMatch(html, /lambda-labs-login/, "but never as a link");
    assert.match(html, /href="\/fine-tuning"/);
  });

  it("keeps Stop available after a stop request, without promising when the GPU goes", () => {
    const html = room({ ...base, stopRequested: true });
    clean(html);
    assert.match(html, /<button[^>]*class="btn btn-block train-stop"[^>]*>(?:(?!<\/button>)[\s\S])*Try stop again/);
    assert.equal(html.match(/Try stop again/g)?.length, 2, "the toolbar and the panel");
    assert.doesNotMatch(html, /<button[^>]*(train-stop|train-toolbar-stop)[^>]*disabled/);
    assert.doesNotMatch(html, /within a minute/);
  });

  it("ends with the summary and metrics when it succeeded", () => {
    const html = room({ ...base, status: "succeeded", summary: "All checks passed.", terminatedAt: at(200), costUsd: 0.05 });
    clean(html);
    assert.match(html, /Finished/);
    assert.match(html, /NVIDIA A10/);
    assert.doesNotMatch(html, /Stop job/);
    assert.doesNotMatch(html, /\$0\.05 est\./);
  });

  it("shows the error's last line when it failed", () => {
    const html = room({ ...base, status: "failed", error: "Traceback\n  File x\nValueError: no GPU", terminatedAt: at(200) });
    clean(html);
    assert.match(html, /callout-bad[^>]*><svg[\s\S]*?<p>ValueError: no GPU<\/p>/);
  });

  it("says when a job ended but its GPU isn't shut down yet, and lets an admin try again", () => {
    const html = room({ ...base, status: "stopped", stopRequested: true });
    clean(html);
    assert.match(html, /Shutting down the GPU/);
    assert.match(html, /Stopped/);
    assert.match(html, /Try stop again/);
    const abandoned = room({ ...base, status: "failed", error: "Lambda did not confirm the terminate." });
    assert.match(abandoned, /Shut down GPU/);
  });

  it("offers no Stop once the GPU is confirmed shut down", () => {
    const html = room({ ...base, status: "stopped", stopRequested: true, terminatedAt: at(200) });
    assert.doesNotMatch(html, /Try stop again|Shut down GPU|Stop job/);
  });

  it("renders a queued job that has no instance yet", () => {
    const html = room({ ...base, status: "queued", instanceId: null, launchedAt: null, progress: null, artifacts: [] });
    clean(html);
    assert.match(html, /Waiting to start/);
    assert.match(html, /Not launched/);
    assert.match(html, /Files the job uploads/);
  });
});

describe("list page pieces", () => {
  it("lists jobs with status, GPU and the failed job's error", () => {
    const html = render(JobsTable, {
      jobs: [base, { ...base, id: "x", status: "failed", error: "Traceback\nValueError: b" }],
      recipes,
      now: t0 + 300_000,
      caption: "Jobs",
    });
    clean(html);
    assert.match(html, /href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001"/);
    assert.match(html, /1x A10 \(24 GB\)/);
    assert.match(html, /ValueError: b/);
    assert.match(html, /Running/);
  });

  it("labels every New job field and warns on a local run", () => {
    const html = render(NewJobCard, {
      recipes,
      ceilings: { maxMinutes: 120, maxUsd: 5 },
      maxActive: 1,
      dailyUsd: 20,
      platformPublic: false,
    });
    clean(html);
    for (const label of ["Recipe", "Name", "GPU", "Time limit (minutes)", "Dollar limit (USD)"]) {
      assert.match(html, new RegExp(`<label[^>]*for="[^"]+"[^>]*>${label.replace(/[()]/g, "\\$&")}`), label);
    }
    assert.match(html, /value="30"/);
    assert.match(html, /value="1\.00"/);
    assert.match(html, /runs on a local address/);
    assert.match(html, /<button type="submit"[^>]*disabled/);
  });

  it("blocks Start when the 5-minute sweep can't run here", () => {
    const props = { recipes, ceilings: { maxMinutes: 120, maxUsd: 5 }, maxActive: 1, dailyUsd: 20, platformPublic: true };
    const unset = render(NewJobCard, { ...props, sweepOff: "cron_secret_unset" });
    clean(unset);
    assert.match(unset, /CRON_SECRET isn&#x27;t set on this deployment/);
    assert.match(unset, /<button type="submit"[^>]*disabled/);
    assert.match(render(NewJobCard, { ...props, sweepOff: "not_production" }), /production site/);
    const stale = render(NewJobCard, { ...props, sweepOff: "sweep_not_running" });
    assert.match(stale, /hasn&#x27;t run in the last 15 minutes/);
    assert.match(stale, /<button type="submit"[^>]*disabled/);
    assert.doesNotMatch(render(NewJobCard, props), /CRON_SECRET|production site|last 15 minutes/);
  });

  it("tells non-admins what only admins can do, with a sign-in link when signed out", () => {
    const html = render(AdminsOnly, { signedIn: false });
    clean(html);
    assert.match(html, /Only admins can start jobs or make datasets/);
    assert.match(html, /href="\/sign-in\?next=%2Ffine-tuning"/);
    assert.doesNotMatch(render(AdminsOnly, { signedIn: true }), /Sign in/, "the shared guest has no sign-in to offer");
  });
});

// ---------- Datasets and eval results ----------

const DS = "1b2c3d4e-0000-4000-8000-000000000002";

function dataset(patch: Partial<DatasetView> = {}): DatasetView {
  return {
    id: DS,
    title: "Bakery helper",
    task: "Answer customer questions for a small bakery: hours, allergens, custom cake orders.",
    status: "ready",
    requested: 300,
    trainCount: 270,
    evalCount: 30,
    costUsd: 1.42,
    error: null,
    createdAt: at(-3600),
    finishedAt: at(-2400),
    ...patch,
  };
}

const longAnswer = `${"Our sourdough is baked fresh every morning. ".repeat(12)}The end.`;

const evalEvents: TrainEventView[] = [
  {
    id: 30,
    type: "eval",
    payload: { type: "eval", index: 0, prompt: "How late are you open on Sunday?", reference: "Until 4 pm.", base: "We are open.", tuned: longAnswer },
    at: at(160),
  },
  {
    id: 31,
    type: "eval",
    payload: { type: "eval", index: 1, prompt: "Do you have nut-free cakes?", reference: "Yes, by order.", base: "Yes.", tuned: "Yes, order two days ahead." },
    at: at(161),
  },
];

const judgements: TrainEventView[] = [
  {
    id: 40,
    type: "judgement",
    payload: { type: "judgement", index: 0, baseScore: 3, tunedScore: 9, better: "tuned", note: "Gives the Sunday hours." },
    at: at(400),
  },
  {
    id: 41,
    type: "judgement",
    payload: { type: "judgement", index: 1, baseScore: 6, tunedScore: 6, better: "tie", note: "Both say yes." },
    at: at(401),
  },
];

const summary: EvalSummary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 4.5, avgTunedScore: 7.5, judgeCostUsd: 0.004 };

const glimmerJob: TrainJobView = {
  ...base,
  recipe: "glimmer-lora",
  title: "Bakery LoRA",
  instanceType: "gpu_1x_h100_pcie",
  params: { datasetId: DS, maxSteps: 120 },
  progress: null,
  artifacts: [],
};

/** The job page of a glimmer-lora job on the Bakery helper dataset, which has no writer recorded unless `writerModel`. */
function glimmerRoom(job: TrainJobView, list: TrainEventView[], serverNow = t0 + 600_000, writerModel: string | null = null): string {
  const glimmer = recipes.find((r) => r.id === "glimmer-lora");
  return render(JobRoom, { job, events: list, recipe: glimmer, dataset: { id: DS, title: "Bakery helper", writerModel }, serverNow });
}

describe("eval results on the job page", () => {
  it("shows eval items as they arrive while the job runs, folded in the log", () => {
    const html = glimmerRoom(glimmerJob, [...events.slice(0, 4), ...evalEvents]);
    clean(html);
    assert.match(html, /id="eval-results"/);
    assert.match(html, /<strong>Eval items<\/strong> 2 sent/);
    assert.match(html, /Muse Wonder judges them once the GPU shuts down/, "the judge a job not judged yet will get");
    assert.match(html, /<th scope="col">Muse Spark 1\.3 reference<\/th><th scope="col">Base Glimmer<\/th><th scope="col">Tuned Glimmer<\/th>/, "a dataset with no writer recorded");
    assert.match(html, /<th scope="rowgroup" colSpan="4"><span class="train-eval-num">Prompt 1<\/span>/);
    assert.match(html, /How late are you open on Sunday\?/);
    assert.match(html, /<details class="train-long"><summary>/, "a long answer folds");
    assert.match(html, /Show all/);
    assert.match(html, /Not judged/);
    assert.match(html, /href="\/fine-tuning\/datasets\/1b2c3d4e-0000-4000-8000-000000000002"[^>]*>Bakery helper/, "the panel names the dataset");
  });

  it("says Judging... with a count once the job succeeded and the GPU is gone", () => {
    const done = { ...glimmerJob, status: "succeeded" as const, finishedAt: at(300), terminatedAt: at(310), judgeModel: "muse-wonder-1.0" };
    const html = glimmerRoom(done, [...evalEvents, judgements[0]]);
    clean(html);
    assert.match(html, /Judging\.\.\./);
    assert.match(html, /1 of 2 judged by Muse Wonder/, "the judge saved on the job");
    assert.match(html, /<div aria-live="polite">/);
  });

  it("shows the summary strip and every verdict once judged", () => {
    const done = { ...glimmerJob, status: "succeeded" as const, finishedAt: at(300), terminatedAt: at(310), evalSummary: summary };
    const html = glimmerRoom(done, [...evalEvents, ...judgements]);
    clean(html);
    assert.match(html, /Tuned Glimmer beat base on <strong>1 of 2<\/strong>, base won <strong>0<\/strong>, ties <strong>1<\/strong>/);
    assert.match(html, /Average score base <strong>4\.5<\/strong>, tuned <strong>7\.5<\/strong>, judged by Muse Spark 1\.3\./, "no judge recorded: Muse Spark 1.3");
    assert.match(html, /against Muse Spark 1\.3&#x27;s reference answer/);
    assert.doesNotMatch(html, /Muse Wonder/, "a run from before the change is never credited to Muse Wonder");
    assert.match(html, /Judging cost \$0\.004/);
    assert.match(html, /class="pill pill-live">Tuned better/);
    assert.match(html, /class="pill pill-neutral">Tie/);
    assert.match(html, /Base 3 · Tuned 9/);
    assert.match(html, /Gives the Sunday hours\./);
    assert.match(html, /<td class="train-eval-win">/, "the winning answer is marked");
    assert.doesNotMatch(html, /Judging\.\.\./);
    assert.match(html, /Tuned won 1 of 2/, "the panel has the result too");
  });

  it("says why a job's items weren't judged", () => {
    const failed = { ...glimmerJob, status: "failed" as const, finishedAt: at(300), terminatedAt: at(310), error: "x" };
    assert.match(glimmerRoom(failed, evalEvents), /Not judged, since the job didn&#x27;t succeed\./);
    const done = { ...glimmerJob, status: "succeeded" as const, finishedAt: at(300), terminatedAt: at(310) };
    // The reason is saved on the job (its eval summary), not read from the log.
    const skipped = { ...done, evalSummary: { items: 0, tunedWins: 0, baseWins: 0, ties: 0, avgBaseScore: 0, avgTunedScore: 0, judgeCostUsd: 0, note: "Judging skipped: MODEL_API_KEY isn't set." } };
    const html = glimmerRoom(skipped, evalEvents);
    assert.match(html, /Judging skipped: MODEL_API_KEY isn&#x27;t set\./);
    assert.doesNotMatch(html, /Judging\.\.\./);
    assert.match(html, /<a href="#eval-results">Not judged<\/a>/, "the panel doesn't claim a result");
    assert.doesNotMatch(html, /Tuned won 0 of 0/);
    assert.doesNotMatch(glimmerRoom(glimmerJob, events), /Eval results/, "no section without eval items");
  });

  it("keeps judging when only the runner's log says it was skipped", () => {
    const done = { ...glimmerJob, status: "succeeded" as const, finishedAt: at(300), terminatedAt: at(310) };
    const forged: TrainEventView = { id: 50, type: "log", payload: { type: "log", text: "Judging skipped: MODEL_API_KEY isn't set." }, at: at(320) };
    const html = glimmerRoom(done, [...evalEvents, forged]);
    assert.match(html, /Judging\.\.\./);
    assert.match(html, /0 of 2 judged by Muse Wonder/);
  });

  it("names the writer and the judge from the records of a dataset and a run Muse Wonder did", () => {
    const done = { ...glimmerJob, status: "succeeded" as const, finishedAt: at(300), terminatedAt: at(310), evalSummary: summary, judgeModel: "muse-wonder-1.0" };
    const html = glimmerRoom(done, [...evalEvents, ...judgements], t0 + 600_000, "muse-wonder-1.0");
    clean(html);
    assert.match(html, /judged by Muse Wonder\./);
    assert.match(html, /against Muse Wonder&#x27;s reference answer/);
    assert.match(html, /<th scope="col">Muse Wonder reference<\/th>/);
    assert.doesNotMatch(html, /Muse Spark|Spark 1\.3/);
    // A Muse Spark 1.3 dataset that Muse Wonder judged: each named for its own part.
    const mixed = glimmerRoom(done, [...evalEvents, ...judgements], t0 + 600_000, null);
    assert.match(mixed, /judged by Muse Wonder\./);
    assert.match(mixed, /<th scope="col">Muse Spark 1\.3 reference<\/th>/);
  });
});

describe("datasets", () => {
  it("lists datasets with counts, status, cost and errors", () => {
    const now = t0;
    const html = render(DatasetsTable, {
      datasets: [
        dataset(),
        dataset({ id: "a", title: "Writing one", status: "generating", trainCount: 0, evalCount: 0, createdAt: at(-60) }),
        dataset({ id: "b", title: "Broken", status: "failed", trainCount: 0, evalCount: 0, error: "Muse Spark 1.3 answered none of this chunk's prompts." }),
        dataset({ id: "c", title: "Old one", status: "generating", trainCount: 0, evalCount: 0, createdAt: at(-8 * 3600) }),
      ],
      written: { a: 48 },
      now,
      caption: "Datasets",
    });
    clean(html);
    assert.match(html, /href="\/fine-tuning\/datasets\/1b2c3d4e-0000-4000-8000-000000000002"/);
    assert.match(html, /270 train · 30 eval/);
    assert.match(html, /48 of 300 answered/);
    assert.match(html, /class="pill pill-live"><span class="pill-dot" aria-hidden="true"><\/span>Ready/);
    assert.match(html, /class="pill pill-building"><span class="pill-dot" aria-hidden="true"><\/span>Writing/);
    assert.match(html, /answered none of this chunk/);
    assert.match(html, /Stalled/);
    assert.match(html, /\$1\.42/);
  });

  it("labels every New dataset field, starts at 300 and shows the cost", () => {
    const html = render(NewDatasetCard, {});
    clean(html);
    assert.match(html, /id="new-dataset"/);
    for (const label of ["Task", "Name", "Examples"]) {
      assert.match(html, new RegExp(`<label[^>]*for="[^"]+"[^>]*>${label}`), label);
    }
    assert.match(html, /<textarea[^>]*placeholder="Answer customer questions for a small bakery: hours, allergens, custom cake orders, in a warm two-sentence style"/);
    assert.match(html, /<input[^>]*type="number"[^>]*min="20"[^>]*max="1000"[^>]*value="300"/);
    assert.match(html, /About \$\d+\.\d\d to \$\d+\.\d\d on Meta&#x27;s API/);
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /<button type="submit"[^>]*disabled/);
    const blocked = render(NewDatasetCard, { blocked: "meta_not_configured" });
    assert.match(blocked, /MODEL_API_KEY/);
    assert.match(blocked, /<button type="submit"[^>]*disabled/);
    assert.match(render(NewDatasetCard, { blocked: "paused" }), /daily spend cap/);
  });

  it("offers ready datasets in the New job card, and a way to make one when none is ready", () => {
    const props = { recipes, ceilings: { maxMinutes: 120, maxUsd: 5 }, maxActive: 1, dailyUsd: 20, platformPublic: true };
    const writing = dataset({ id: "a", title: "Writing one", status: "generating" });
    const html = render(NewJobCard, { ...props, datasets: [dataset(), writing], initialDatasetId: DS });
    clean(html);
    assert.match(html, /<option value="glimmer-lora" selected="">/, "a dataset link picks the recipe that takes one");
    assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Dataset<\/label><select/);
    assert.match(html, /<option value="1b2c3d4e-0000-4000-8000-000000000002" selected="">Bakery helper · 270 train, 30 eval<\/option>/);
    assert.match(html, /<option value="a" disabled="">Writing one · still writing<\/option>/);
    assert.match(html, /Auto: a free GPU near the model cache/);
    assert.doesNotMatch(html, /<button type="submit"[^>]*disabled/);

    const none = render(NewJobCard, { ...props, datasets: [writing], initialDatasetId: DS });
    clean(none);
    assert.match(none, /No dataset is ready yet/);
    assert.match(none, /<a href="#new-dataset">Make a dataset<\/a>, or wait for the one being written to finish\./);
    assert.match(none, /none is ready yet\. Make one under Datasets first\./);
    assert.match(none, /<button type="submit"[^>]*disabled/);

    const smoke = render(NewJobCard, { ...props, datasets: [] });
    assert.match(smoke, /<option value="smoke" selected="">/, "without a dataset link the first recipe stays");
    assert.doesNotMatch(smoke, /model cache/);
  });

  it("lets a job ask past the recipe's defaults up to the ceilings", () => {
    const html = render(NewJobCard, {
      recipes,
      ceilings: { maxMinutes: 300, maxUsd: 40 },
      maxActive: 1,
      dailyUsd: 60,
      platformPublic: true,
      datasets: [dataset()],
      initialDatasetId: DS,
    });
    clean(html);
    assert.match(html, /<input[^>]*type="number"[^>]*max="300"[^>]*value="150"/, "starts at glimmer's 150 minutes, up to 300");
    assert.match(html, /<input[^>]*type="number"[^>]*max="40"[^>]*value="14\.00"/);
    assert.match(html, /This recipe starts at 150 minutes and \$14\.00, and a job can ask for up to 300 minutes and \$40\.00\./);
    // Before Lambda's prices load, Auto's estimate uses the slowest of the recipe's GPUs.
    assert.match(html, /120 training steps on Auto \(up to 1x A100 SXM4 \(40 GB\)\): about 44 minutes in a region with the model cache, about 69 without it/);
    assert.doesNotMatch(html, /train-callout-warn/, "it fits");

    const tight = render(NewJobCard, {
      recipes,
      ceilings: { maxMinutes: 60, maxUsd: 40 },
      maxActive: 1,
      dailyUsd: 60,
      platformPublic: true,
      datasets: [dataset()],
      initialDatasetId: DS,
    });
    assert.match(tight, /train-callout-warn[\s\S]*stop it after 60 minutes, so it is refused if it lands in a region without the cache/);
  });

  it("shows a ready dataset's task, samples and eval prompts", () => {
    const system = "You are an assistant for this task: bakery.";
    const sampleTrain = [1, 2].map((i) => ({
      messages: [
        { role: "system" as const, content: system },
        { role: "user" as const, content: `Question ${i}?` },
        { role: "assistant" as const, content: i === 1 ? longAnswer : `Answer ${i}.` },
      ],
    }));
    const html = render(DatasetDetail, {
      dataset: dataset(),
      sampleTrain,
      sampleEval: [{ prompt: "Open Sunday?", reference: "Until 4 pm." }],
      written: null,
      now: t0,
    });
    clean(html);
    assert.match(html, /<h1>Bakery helper<\/h1>/);
    assert.match(html, /<strong>270<\/strong> train · <strong>30<\/strong> eval/);
    assert.match(html, /href="\/fine-tuning\?dataset=1b2c3d4e-0000-4000-8000-000000000002#new-job"/);
    assert.equal(html.split(system).length - 1, 1, "the system message shows once");
    assert.match(html, /Question 2\?/);
    assert.match(html, /Answer \(Muse Spark 1\.3\)/, "a dataset with no writer recorded");
    assert.match(html, /Written by Muse Spark 1\.3 · created/);
    assert.match(html, /<th scope="col">Muse Spark 1\.3 reference<\/th>/);
    assert.match(html, /the job&#x27;s judge \(Muse Wonder for a job trained now\) scores both against the reference/);
    assert.match(html, /<details class="train-long">/);
    assert.match(html, /Open Sunday\?/);
    assert.match(html, /Until 4 pm\./);
    assert.match(html, /The first 2 of 270/);
  });

  it("shows a dataset being written, and a failed one's error", () => {
    const writing = render(DatasetDetail, {
      dataset: dataset({ status: "generating", trainCount: 0, evalCount: 0, finishedAt: null }),
      sampleTrain: [],
      sampleEval: [],
      written: 24,
      now: t0,
    });
    clean(writing);
    assert.match(writing, /<strong>24<\/strong> of 300 answered/);
    assert.match(writing, /role="status" aria-live="polite"/);
    assert.match(writing, /updates every 10 seconds/);
    const wonder = render(DatasetDetail, {
      dataset: dataset({ status: "generating", trainCount: 0, evalCount: 0, finishedAt: null, writerModel: "muse-wonder-1.0" }),
      sampleTrain: [{ messages: [{ role: "user" as const, content: "Q?" }, { role: "assistant" as const, content: "A." }] }],
      sampleEval: [],
      written: 1,
      now: t0,
    });
    clean(wonder);
    assert.match(wonder, /Written by Muse Wonder · created/);
    assert.match(wonder, /Muse Wonder writes the prompts first, then answers them in chunks\./);
    assert.match(wonder, /Answer \(Muse Wonder\)/);
    assert.doesNotMatch(wonder, /Muse Spark|Spark 1\.3/);
    assert.doesNotMatch(writing, /Train on it/);
    assert.match(writing, /held out once every answer is written/);
    const failed = render(DatasetDetail, {
      dataset: dataset({ status: "failed", trainCount: 0, evalCount: 0, error: "The platform's daily spend cap is reached, so the dataset stopped." }),
      sampleTrain: [],
      sampleEval: [],
      written: null,
      now: t0,
    });
    assert.match(failed, /callout-bad[\s\S]*daily spend cap is reached/);
  });

  it("shows why a ready dataset stopped early, in the list and on its page", () => {
    const note = "Stopped early, once 180 of the 300 examples asked for were answered. The platform's daily spend cap is reached, so the dataset stopped.";
    const partial = dataset({ trainCount: 162, evalCount: 18, error: note });
    const page = render(DatasetDetail, { dataset: partial, sampleTrain: [], sampleEval: [], written: null, now: t0 });
    clean(page);
    assert.match(page, /train-callout-warn[\s\S]*Stopped early, once 180 of the 300 examples asked for were answered\./);
    assert.doesNotMatch(page, /callout-bad/);
    assert.match(page, /Train on it/, "it can still be trained on");
    const list = render(DatasetsTable, { datasets: [partial], now: t0, caption: "Datasets" });
    assert.match(list, /Stopped early, once 180 of the 300/);
    assert.match(list, /162 train · 18 eval/);
  });
});

// ---------- Lab results: what everyone sees, read-only ----------

describe("Lab results", () => {
  /** Values a public page must never show, as the full job row holds them. */
  const SECRETS = {
    instanceId: "i-0a1b2c3d4e5f6789",
    instanceIp: "203.0.113.9",
    instanceName: "mm-train-8f1d2c3b-glimmer-lora",
    region: "us-secret-1",
    tokenHash: "hash-of-the-job-token",
    error: "Traceback in /home/ubuntu/.cache/secret-path",
    summary: "adapter at /lambda/nfs/muse-muse-cache-us-secret-1/models",
  };
  const SECRET_TEXT = /i-0a1b2c3d4e5f6789|203\.0\.113\.9|mm-train-|us-secret-1|hash-of-the-job-token|secret-path|lambda\/nfs|token=/;

  /** A judged glimmer-lora job as getJob would read it, every column filled. */
  function row(over: Record<string, unknown> = {}) {
    return {
      id: glimmerJob.id,
      recipe: "glimmer-lora" as const,
      title: "Bakery LoRA",
      status: "succeeded" as const,
      params: { datasetId: DS, maxSteps: 120, learningRate: 0.0002, loraRank: 16, dryRun: 0, studentPrompt: "You help a small bakery's customers." },
      instanceType: "gpu_1x_h100_pcie",
      priceCentsPerHour: 249,
      maxMinutes: 120,
      maxUsd: 5,
      costUsd: 1.66,
      createdAt: new Date(t0 - 60_000),
      launchedAt: new Date(t0),
      finishedAt: new Date(t0 + 39 * 60_000),
      terminatedAt: new Date(t0 + 40 * 60_000),
      evalSummary: summary,
      artifacts: [{ name: "adapter.tar.gz", kind: "adapter", url: "https://x.public.blob.vercel-storage.com/models/a/b", bytes: 1 }],
      ...SECRETS,
      ...over,
    };
  }

  const glimmer = () => recipes.find((r) => r.id === "glimmer-lora")!;
  const view = (over: Record<string, unknown> = {}) => results.toResultView(row(over) as never, glimmer());

  it("maps only judged jobs that aren't dry runs, and only the allowed fields", () => {
    const v = view();
    assert.ok(v);
    assert.deepEqual(Object.keys(v).sort(), [
      "costUsd",
      "datasetId",
      "finishedAt",
      "gpu",
      "gpuMinutes",
      "hub",
      "id",
      "judgeModel",
      "model",
      "recipe",
      "recipeTitle",
      "settings",
      "summary",
      "title",
    ]);
    assert.equal(v.hub, null, "the Hugging Face links only once it is published");
    assert.equal(SECRET_TEXT.test(JSON.stringify(v)), false, "nothing hidden is carried over");
    assert.equal(v.model, "Muse Glimmer 30B");
    assert.equal(v.judgeModel, "muse-spark-1.3", "no judge recorded: judged before Oct 29, 2026, by Muse Spark 1.3");
    assert.equal(view({ judgeModel: "muse-wonder-1.0" })!.judgeModel, "muse-wonder-1.0");
    assert.equal(v.gpu, "1x H100 PCIe (80 GB)");
    assert.equal(v.gpuMinutes, 40);
    assert.deepEqual(
      v.settings.map((s) => [s.key, s.value]),
      [
        ["maxSteps", "120"],
        ["loraRank", "16"],
        ["learningRate", "0.0002"],
        ["studentPrompt", "You help a small bakery's customers."],
      ],
      "never the dataset id or dryRun",
    );
    assert.deepEqual(results.toResultView({ ...row(), evalSummary: { ...summary, note: "x" } } as never, glimmer())?.summary, summary, "no extra keys");
    for (const status of ["running", "failed", "stopped", "booting"]) assert.equal(view({ status }), null, status);
    assert.equal(view({ terminatedAt: null }), null, "the GPU isn't confirmed gone");
    assert.equal(view({ evalSummary: null }), null, "not judged yet");
    assert.equal(view({ evalSummary: { ...summary, items: 0, note: "Judging skipped." } }), null, "an unjudged summary");
    assert.equal(view({ params: { datasetId: DS, dryRun: 1 } }), null, "a dry run's answers are fake");
    assert.equal(results.isDryRun({ dryRun: "1" }), true);
    assert.equal(results.isDryRun({}), false);
  });

  it("keeps Fine-tuning in everyone's nav", async () => {
    const { NAV_GROUPS } = await import("@/components/shell/nav");
    const item = NAV_GROUPS.flat().find((i) => i.href === "/fine-tuning");
    assert.equal(item?.label, "Fine-tuning");
    assert.deepEqual(Object.keys(item!).sort(), ["href", "icon", "label"], "no role or flag hides it");
  });

  it("explains the lab in three steps", () => {
    const html = render(LabIntro, {});
    clean(html);
    assert.match(html, /Lab results/);
    assert.match(html, /Muse Wonder writes a training set, Muse Glimmer 30B learns it, and Muse Wonder judges base against tuned on held-out prompts\./);
    assert.match(html, /Muse Spark 1\.3 wrote and judged the runs before Oct 29, 2026, and each result&#x27;s page names the models that did its work\./);
    assert.match(html, /Muse Wonder writes a training set for a task/);
    assert.match(html, /Muse Wonder scores base and tuned Glimmer/);
    assert.match(html, /<span class="how-num">1\.<\/span> Write/);
    assert.match(html, /<span class="how-num">3\.<\/span> Judge/);
  });

  it("lists judged jobs with the model, wins, scores, GPU, minutes and cost", () => {
    const html = render(ResultsTable, { results: [view()], caption: "Results" });
    clean(html);
    assert.match(html, /href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001"[^>]*>Bakery LoRA/);
    assert.match(html, /Muse Glimmer LoRA/);
    assert.match(html, /Muse Glimmer 30B/);
    assert.match(html, /Tuned won <strong>1<\/strong> of 2/);
    assert.match(html, /Base won 0, 1 tie/);
    assert.match(html, /Base 4\.5 · Tuned <strong>7\.5<\/strong>/);
    assert.match(html, /1x H100 PCIe \(80 GB\)/);
    assert.match(html, /40 min/);
    assert.match(html, /\$1\.66/);
    assert.doesNotMatch(html, SECRET_TEXT);
  });

  it("lists ready datasets with counts and cost, linking to their read-only page", () => {
    const html = render(ReadyDatasetsTable, { datasets: [dataset()], now: t0, caption: "Datasets" });
    clean(html);
    assert.match(html, /href="\/fine-tuning\/datasets\/1b2c3d4e-0000-4000-8000-000000000002"[^>]*>Bakery helper/);
    assert.match(html, /270 train · 30 eval/);
    assert.match(html, /\$1\.42/);
    assert.doesNotMatch(html, /Status|pill/);
  });

  it("shows a judged job's run, summary and side-by-side answers, with no controls or hidden fields", () => {
    const log: TrainEventView = { id: 60, type: "log", payload: { type: "log", text: "token=abc /home/ubuntu/.cache/secret-path" }, at: at(500) };
    const html = render(JobResults, {
      result: view(),
      rows: evalRowsOf([...evalEvents, ...judgements, log]),
      dataset: { id: DS, title: "Bakery helper" },
    });
    clean(html);
    assert.match(html, /<h1>Bakery LoRA<\/h1>/);
    assert.match(html, /Tuned Glimmer beat base on <strong>1 of 2<\/strong>, base won <strong>0<\/strong>, ties <strong>1<\/strong>/);
    assert.match(html, /Average score base <strong>4\.5<\/strong>, tuned <strong>7\.5<\/strong>/);
    assert.match(html, /<th scope="col">Muse Spark 1\.3 reference<\/th><th scope="col">Base Glimmer<\/th><th scope="col">Tuned Glimmer<\/th><th scope="col">Verdict<\/th>/);
    assert.match(html, /judged by Muse Spark 1\.3\./, "the run's records name no judge");
    assert.match(html, /Muse Spark 1\.3 saw the two answers in random order/);
    assert.doesNotMatch(html, /Muse Wonder/, "a run from before the change says Muse Spark 1.3 everywhere");
    assert.match(html, /How late are you open on Sunday\?/);
    assert.match(html, /class="pill pill-live">Tuned better/);
    assert.match(html, /Gives the Sunday hours\./);
    assert.match(html, /<dt>Training steps<\/dt><dd>120<\/dd>/);
    assert.match(html, /<dt>LoRA rank<\/dt><dd>16<\/dd>/);
    assert.match(html, /<dt>Learning rate<\/dt><dd>0\.0002<\/dd>/);
    assert.match(html, /You help a small bakery&#x27;s customers\./);
    assert.match(html, /<dt>GPU<\/dt><dd>1x H100 PCIe \(80 GB\)<\/dd>/);
    assert.match(html, /<dt>GPU time<\/dt><dd>40 min<\/dd>/);
    assert.match(html, /<dt>GPU cost<\/dt><dd>\$1\.66<\/dd>/);
    assert.match(html, /href="\/fine-tuning\/datasets\/1b2c3d4e-0000-4000-8000-000000000002">Bakery helper/);
    assert.doesNotMatch(html, SECRET_TEXT);
    assert.doesNotMatch(html, /<button|<form|Stop|Shut down|Event log|Instance|Region|IP<|Dry run|dryRun|adapter\.tar|\/api\/train/);
  });

  it("keeps model text as plain text: no markup and no links from it", () => {
    const evil: TrainEventView = {
      id: 70,
      type: "eval",
      payload: {
        type: "eval",
        index: 0,
        prompt: "<script>alert(1)</script> see https://evil.example",
        reference: "<img src=x onerror=alert(1)>",
        base: "[click](javascript:alert(1))",
        tuned: "<a href=\"https://evil.example\">win</a>",
      },
      at: at(160),
    };
    const html = render(JobResults, { result: view(), rows: evalRowsOf([evil]), dataset: null });
    assert.doesNotMatch(html, /<script|<img|<a href="https:\/\/evil|href="javascript/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; see https:\/\/evil\.example/);
    assert.match(html, /&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;win&lt;\/a&gt;/);
    assert.doesNotMatch(html, /<dt>Dataset<\/dt>/, "no dataset row when it isn't ready");
    assert.match(html, /<th scope="col">Reference<\/th>/, "no writer named without the dataset's record");
  });

  it("names Muse Wonder on the public page of a run it judged on a dataset it wrote", () => {
    const html = render(JobResults, {
      result: view({ judgeModel: "muse-wonder-1.0" }),
      rows: evalRowsOf([...evalEvents, ...judgements]),
      dataset: { id: DS, title: "Bakery helper", writerModel: "muse-wonder-1.0" },
    });
    clean(html);
    assert.match(html, /judged by Muse Wonder\./);
    assert.match(html, /Muse Wonder saw the two answers in random order/);
    assert.match(html, /<th scope="col">Muse Wonder reference<\/th>/);
    assert.doesNotMatch(html, /Muse Spark|Spark 1\.3/);
  });

  it("shows a ready dataset read-only: no Train on it and no note", () => {
    const html = render(DatasetDetail, {
      dataset: dataset({ error: "Stopped early, once 180 of the 300 examples asked for were answered." }),
      sampleTrain: [],
      sampleEval: [{ prompt: "Open Sunday?", reference: "Until 4 pm." }],
      written: null,
      now: t0,
      readOnly: true,
    });
    clean(html);
    assert.match(html, /<h1>Bakery helper<\/h1>/);
    assert.match(html, /Open Sunday\?/);
    assert.doesNotMatch(html, /Train on it|new-job|Stopped early|left out/);
  });
});
