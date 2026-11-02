/**
 * The fine-tuning pages themselves, with the viewer and the store faked: what a non-admin (the shared guest on the live
 * site, or a signed-out visitor) gets at /fine-tuning, /fine-tuning/{id} and /fine-tuning/datasets/{id}, and that admins
 * keep the full pages. The fake store answers the Lab reads with whole rows, secrets and all, and with jobs and datasets
 * the real SQL would leave out, so the pages are shown to filter and map on their own too. Nothing reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/pages.test.tsx
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";
import type { TrainEventView } from "@/lib/train/types";
import { ticketDecision } from "./decision-fixture";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;

const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const DS = "1b2c3d4e-0000-4000-8000-000000000002";
/** A glimmer-serve job serving JOB's adapter, and its pinned certificate: neither may reach a public page. */
const SERVE = "5e7e5e7e-0000-4000-8000-00000000000a";
const CERT = "c3".repeat(32);
const t0 = Date.parse("2026-10-27T14:00:00.000Z");
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

/** What a public page must never show. */
const SECRETS = {
  instanceId: "i-0a1b2c3d4e5f6789",
  instanceIp: "203.0.113.9",
  instanceName: "mm-train-8f1d2c3b-glimmer-lora",
  region: "us-secret-1",
  tokenHash: "hash-of-the-job-token",
  workflowRunId: "wrun_secret",
  error: "Traceback in /home/ubuntu/.cache/secret-path",
  summary: "adapter at /lambda/nfs/muse-muse-cache-us-secret-1/models",
};
const SECRET_TEXT = /i-0a1b2c3d4e5f6789|203\.0\.113\.9|mm-train-|us-secret-1|hash-of-the-job-token|wrun_secret|secret-path|lambda\/nfs|token=abc|blob\.vercel-storage|5e7e5e7e|c3c3c3c3|serveKey|8443/;
const CONTROLS = /<form|<button[^>]*type="submit"|Stop job|Try stop again|Shut down GPU|New job|New dataset|Train on it|href="#new-job"|href="#new-dataset"/;

const summary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 4.5, avgTunedScore: 7.5, judgeCostUsd: 0.004 };

/**
 * A scored decide job of a person's decision dataset (made-up tickets): the job row, and the dataset row as the
 * database holds it, its split rows included, as a store that leaked them would answer.
 */
const tickets = ticketDecision();
const decideParams = { datasetId: DS, mode: "decide", epochs: 2, learningRate: 0.0002, loraRank: 16, scoreOnly: 0, dryRun: 0, publish: 0 };
const ticketInputs = [...tickets.rows.train, ...tickets.rows.dev, ...tickets.rows.test].map((r) => r.input);

/** A glimmer-lora job row as the database holds it, every column filled. */
function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    title: "Bakery LoRA",
    status: "succeeded",
    params: { datasetId: DS, maxSteps: 120, learningRate: 0.0002, loraRank: 16, dryRun: 0 },
    instanceType: "gpu_1x_h100_pcie",
    priceCentsPerHour: 249,
    maxMinutes: 120,
    maxUsd: 5,
    stopRequested: false,
    progress: null,
    artifacts: [{ name: "adapter.tar.gz", kind: "adapter", url: "https://x.public.blob.vercel-storage.com/models/a/b", bytes: 1 }],
    costUsd: 1.66,
    createdBy: null,
    createdAt: new Date(t0 - 60_000),
    launchedAt: new Date(t0),
    firstHeartbeatAt: new Date(t0 + 60_000),
    lastHeartbeatAt: new Date(t0 + 38 * 60_000),
    finishedAt: new Date(t0 + 39 * 60_000),
    terminatedAt: new Date(t0 + 40 * 60_000),
    evalSummary: summary,
    ...SECRETS,
    ...over,
  };
}

function datasetRow(over: Record<string, unknown> = {}) {
  return {
    id: DS,
    title: "Bakery helper",
    task: "Answer customer questions for a small bakery: hours, allergens, custom cake orders.",
    status: "ready",
    requested: 40,
    trainCount: 30,
    evalCount: 8,
    costUsd: 0.14,
    error: "Stopped early, once 38 of the 40 examples asked for were answered.",
    createdBy: "u-secret-author",
    workflowRunId: "wrun_secret",
    createdAt: new Date(t0 - 3_600_000),
    finishedAt: new Date(t0 - 3_000_000),
    ...over,
  };
}

const resultEvents: TrainEventView[] = [
  {
    id: 30,
    type: "eval",
    payload: { type: "eval", index: 0, prompt: "How late are you open on Sunday?", reference: "Until 4 pm.", base: "We are open.", tuned: "Until 4 pm on Sundays." },
    at: new Date(t0 + 30 * 60_000).toISOString(),
  },
  {
    id: 31,
    type: "eval",
    payload: { type: "eval", index: 1, prompt: "Do you have nut-free cakes?", reference: "Yes, by order.", base: "Yes.", tuned: "Yes, order two days ahead." },
    at: new Date(t0 + 31 * 60_000).toISOString(),
  },
  // Only eval items and judgements belong here. These two stand for a store that let the rest of the log through.
  { id: 32, type: "log", payload: { type: "log", text: "token=abc /home/ubuntu/.cache/secret-path" }, at: new Date(t0).toISOString() },
  { id: 33, type: "failed", payload: { type: "failed", error: SECRETS.error }, at: new Date(t0).toISOString() },
  {
    id: 40,
    type: "judgement",
    payload: { type: "judgement", index: 0, baseScore: 3, tunedScore: 9, better: "tuned", note: "Gives the Sunday hours." },
    at: new Date(t0 + 45 * 60_000).toISOString(),
  },
  {
    id: 41,
    type: "judgement",
    payload: { type: "judgement", index: 1, baseScore: 6, tunedScore: 6, better: "tie", note: "Both say yes." },
    at: new Date(t0 + 45 * 60_000).toISOString(),
  },
];

let viewer: SessionUser | null = null;
let job: Record<string, unknown> | null = null;
let dataset: Record<string, unknown> | null = null;
/** Rows the list reads answer besides `job` and `dataset`: ones the real SQL would leave out. */
let otherJobs: Array<Record<string, unknown>> = [];
let otherDatasets: Array<Record<string, unknown>> = [];
/** What getLiveDemo answers for JOB (a LiveDemoView), or null; `liveDemoFails` makes it throw. */
let liveDemo: Record<string, unknown> | null = null;
let liveDemoFails = false;
/** What getAdapterSource answers for JOB: the job and its done metrics. */
let adapterSource: { job: Record<string, unknown>; metrics: Record<string, unknown> | null } | null = null;
let lastSweep: Date | null = null;
let calls: string[] = [];
/** A decision dataset's split rows (DS) and its decide job's scores (JOB), for the decision page tests. */
let decisionRows: { train: Array<{ input: string; label: string }>; dev: Array<{ input: string; label: string }>; test: Array<{ input: string; label: string }> } | null = null;
let decideSent: { dev: unknown[]; test: unknown[] } = { dev: [], test: [] };
const savedEnv = { ...process.env };

const sample = {
  train: [1, 2, 3].map((i) => ({
    messages: [
      { role: "system", content: "You are an assistant for this task: bakery." },
      { role: "user", content: `Question ${i}?` },
      { role: "assistant", content: `Answer ${i}.` },
    ],
  })),
  eval: [{ prompt: "Open Sunday?", reference: "Until 4 pm." }],
};

/** Records the call, then answers. */
function fake<A extends unknown[], R>(name: string, fn: (...args: A) => R) {
  return async (...args: A) => {
    calls.push(name);
    return fn(...args);
  };
}

const fakeStore = {
  // The GPU budget and own-runs reads the pages added later. Nothing here tests them.
  gpuBudgetFor: async () => ({ capUsd: 0, spentUsd: 0, remainingUsd: 0 }),
  listOwnRuns: async () => [],
  // Lab reads. They answer whatever the test set, whole rows included, as if the SQL filter were missing.
  listResultJobs: fake("listResultJobs", () => [...(job ? [job] : []), ...otherJobs]),
  getResultJob: fake("getResultJob", (id: string) => (job && job.id === id ? job : null)),
  listResultEvents: fake("listResultEvents", () => resultEvents),
  listReadyDatasets: fake("listReadyDatasets", () => [...(dataset ? [dataset] : []), ...otherDatasets]),
  getReadyDataset: fake("getReadyDataset", (id: string) => (dataset && dataset.id === id ? dataset : null)),
  datasetPage: fake("datasetPage", (_id: string, part: "train" | "eval", offset: number, limit: number) => ({
    status: "ready",
    total: sample[part].length,
    items: sample[part].slice(offset, offset + limit),
  })),
  // The live demo. getLiveDemo answers with more than a LiveDemoView, as a leaky store would, so the page must map it.
  getLiveDemo: fake("getLiveDemo", (id: string) => {
    if (liveDemoFails) throw new Error("the database is down");
    return liveDemo && id === JOB ? { ...liveDemo, ip: SECRETS.instanceIp, certSha256: CERT, tokenHash: SECRETS.tokenHash } : null;
  }),
  getAdapterSource: fake("getAdapterSource", (id: string) => (adapterSource && id === JOB ? adapterSource : null)),
  listAdapterOptions: fake("listAdapterOptions", () => []),
  // The model page asks for a published adapter's local files (localFilesFor); these tests make none.
  latestQuantSource: fake("latestQuantSource", () => null),
  // Admin reads.
  getJob: fake("getJob", (id: string) => [job, ...otherJobs].find((j) => j && j.id === id) ?? null),
  listEvents: fake("listEvents", () => resultEvents),
  getDataset: fake("getDataset", (id: string) => (dataset && dataset.id === id ? dataset : null)),
  listJobs: fake("listJobs", () => (job ? [job] : [])),
  listDatasets: fake("listDatasets", () => (dataset ? [dataset] : [])),
  datasetProgress: fake("datasetProgress", () => null),
  activeJobCount: fake("activeJobCount", () => 0),
  trainingSpendToday: fake("trainingSpendToday", () => 0),
  lastSweepOkAt: fake("lastSweepOkAt", () => lastSweep),
  verifyJobToken: fake("verifyJobToken", () => false),
  // A decide job's scores and a decision dataset's rows: the admin pages' wrong answers and sample rows only.
  decideScores: fake("decideScores", (id: string) => (id === JOB ? decideSent : { dev: [], test: [] })),
  decisionSplitRows: fake("decisionSplitRows", (id: string, part: "train" | "dev" | "test", indexes?: number[]) => {
    const rows = id === DS ? decisionRows?.[part] : undefined;
    if (!rows) return null;
    const wanted = indexes ?? rows.map((_, i) => i);
    return { total: rows.length, rows: new Map(wanted.filter((i) => i >= 0 && i < rows.length).map((i) => [i, rows[i]!])) };
  }),
};

/** Reads that only the admin pages may make. */
const ADMIN_READS = ["getJob", "listEvents", "getDataset", "listJobs", "listDatasets", "datasetProgress", "activeJobCount", "trainingSpendToday", "lastSweepOkAt", "getAdapterSource", "listAdapterOptions", "decideScores", "decisionSplitRows"];

type Page = (props: { params?: Promise<Record<string, string>>; searchParams?: Promise<Record<string, string>> }) => Promise<ReactNode>;
let render: (node: ReactNode) => string;
let listPage: Page;
let jobPage: Page;
let datasetPage: Page;

const guest: SessionUser = { id: "u-guest", email: "guest@open-access.invalid", isAdmin: false, openAccess: true };
const admin: SessionUser = { id: "u-admin", email: "owner@example.com", isAdmin: true };

async function openList(): Promise<string> {
  return render(await listPage({ searchParams: Promise.resolve({}) }));
}
async function openJob(id = JOB): Promise<string> {
  return render(await jobPage({ params: Promise.resolve({ jobId: id }) }));
}
async function openDataset(id = DS): Promise<string> {
  return render(await datasetPage({ params: Promise.resolve({ id }) }));
}

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, SECRET_TEXT);
}

/** Makes JOB the scored decide job and DS its decision dataset, rows and all. */
function useTickets() {
  job = jobRow({ title: "Ticket router LoRA", params: decideParams, evalSummary: tickets.summary, judgeModel: null, instanceType: "gpu_1x_a100_sxm4" });
  dataset = datasetRow({
    title: "Ticket router",
    task: tickets.spec.question,
    kind: "decision",
    decision: tickets.spec,
    decisionRows: tickets.rows,
    writerModel: "person",
    requested: 240,
    trainCount: 168,
    evalCount: 48,
    costUsd: 0,
    error: null,
  });
  decisionRows = tickets.rows;
  decideSent = tickets.sent;
}

describe("fine-tuning pages", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    // safeQuery runs only with a database configured. Every read is faked, so nothing connects to this.
    process.env.DATABASE_URL = "postgres://pages-test.invalid/db";
    delete process.env.MODEL_API_KEY;
    delete process.env.CRON_SECRET;
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error(NOT_FOUND);
        },
        redirect: (to: string) => {
          throw new Error(`redirect ${to}`);
        },
        unstable_rethrow: (err: unknown) => {
          if (err instanceof Error && err.message === NOT_FOUND) throw err;
        },
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/fine-tuning",
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/train/store.ts"), { namedExports: fakeStore });
    const { renderToString } = await import("react-dom/server");
    render = (node) => renderToString(node as never).replace(/<!-- -->/g, "");
    listPage = (await import("@/app/fine-tuning/page")).default as unknown as Page;
    jobPage = (await import(at("../../../app/fine-tuning/[jobId]/page.tsx"))).default as Page;
    datasetPage = (await import(at("../../../app/fine-tuning/datasets/[id]/page.tsx"))).default as Page;
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    viewer = guest;
    job = jobRow();
    dataset = datasetRow();
    otherJobs = [jobRow({ id: "8f1d2c3b-0000-4000-8000-000000000009", title: "Still running", status: "running", terminatedAt: null })];
    otherDatasets = [datasetRow({ id: "a", title: "Still writing", status: "generating" })];
    liveDemo = null;
    liveDemoFails = false;
    adapterSource = null;
    lastSweep = null;
    calls = [];
    decisionRows = null;
    decideSent = { dev: [], test: [] };
  });

  describe("for non-admins", () => {
    it("/fine-tuning shows the intro, the judged jobs and the ready datasets, with no controls", async () => {
      const html = await openList();
      clean(html);
      assert.match(html, /Lab results/);
      assert.match(html, /Muse Wonder writes a training set, Muse Glimmer 30B learns it/);
      assert.match(html, /Muse Spark 1\.3 wrote and judged the runs before Oct 29, 2026/);
      assert.match(html, /href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001"[^>]*>Bakery LoRA/);
      assert.match(html, /Tuned won <strong>1<\/strong> of 2/);
      assert.match(html, /href="\/fine-tuning\/datasets\/1b2c3d4e-0000-4000-8000-000000000002"[^>]*>Bakery helper/);
      assert.match(html, /30 train · 8 eval/);
      assert.match(html, /Only admins can start jobs or make datasets/);
      assert.doesNotMatch(html, /Sign in/, "the shared guest is already in");
      assert.doesNotMatch(html, CONTROLS);
      assert.doesNotMatch(html, /Still running|Still writing/, "only judged jobs and ready datasets");
      assert.doesNotMatch(html, /GPUs? in use|spent today|Stopped early|u-secret-author/);
      assert.deepEqual(calls.sort(), ["listReadyDatasets", "listResultJobs"]);
    });

    it("/fine-tuning offers a signed-out visitor a sign-in link, and says when nothing is judged yet", async () => {
      viewer = null;
      job = null;
      otherJobs = [];
      const html = await openList();
      clean(html);
      assert.match(html, /href="\/sign-in\?next=%2Ffine-tuning"/);
      assert.match(html, /No results yet/);
      assert.doesNotMatch(html, CONTROLS);
    });

    it("/fine-tuning/{id} shows a judged job's results and safe settings, and nothing hidden", async () => {
      job = jobRow({ params: { ...jobRow().params, studentPrompt: "You help a small bakery's customers." } });
      const html = await openJob();
      clean(html);
      assert.match(html, /<h1>Bakery LoRA<\/h1>/);
      assert.match(html, /Tuned Glimmer beat base on <strong>1 of 2<\/strong>/);
      assert.match(html, /<th scope="col">Muse Spark 1\.3 reference<\/th><th scope="col">Base Glimmer<\/th><th scope="col">Tuned Glimmer<\/th>/);
      assert.match(html, /judged by Muse Spark 1\.3\./, "no models on the records: Muse Spark 1.3 did the work");
      assert.doesNotMatch(html, /Muse Wonder/);
      assert.match(html, /How late are you open on Sunday\?/);
      assert.match(html, /Gives the Sunday hours\./);
      assert.match(html, /<dt>Training steps<\/dt><dd>120<\/dd>/);
      assert.match(html, /<dt>LoRA rank<\/dt><dd>16<\/dd>/);
      assert.match(html, /<dt>Learning rate<\/dt><dd>0\.0002<\/dd>/);
      assert.match(html, /You help a small bakery&#x27;s customers\./);
      assert.match(html, /<dt>GPU<\/dt><dd>1x H100 PCIe \(80 GB\)<\/dd>/);
      assert.match(html, /<dt>GPU time<\/dt><dd>40 min<\/dd>/);
      assert.match(html, /<dt>GPU cost<\/dt><dd>\$1\.66<\/dd>/);
      assert.match(html, /href="\/fine-tuning\/datasets\/1b2c3d4e-0000-4000-8000-000000000002">Bakery helper/);
      assert.doesNotMatch(html, CONTROLS);
      assert.doesNotMatch(html, /<button|Event log|Region|Instance|Last heartbeat|Dry run|adapter\.tar|Traceback|\/api\/train/);
      assert.doesNotMatch(html, /Try it live|Live demo|<textarea/, "no live demo box while none runs");
      assert.deepEqual(calls.sort(), ["getLiveDemo", "getReadyDataset", "getResultJob", "listResultEvents"]);
      assert.equal(calls.some((c) => ADMIN_READS.includes(c)), false);
    });

    it("/fine-tuning/{id} names the writer and the judge its records name", async () => {
      job = jobRow({ judgeModel: "muse-wonder-1.0" });
      dataset = datasetRow({ writerModel: "muse-wonder-1.0" });
      const html = await openJob();
      clean(html);
      assert.match(html, /<th scope="col">Muse Wonder reference<\/th>/);
      assert.match(html, /judged by Muse Wonder\./);
      assert.match(html, /Muse Wonder saw the two answers in random order/);
      assert.doesNotMatch(html, /Muse Spark|Spark 1\.3/);
      const page = await openDataset();
      assert.match(page, /Written by Muse Wonder · created/);
    });

    it("/fine-tuning/{id} shows Try it live while its adapter's demo serves, with nothing about the GPU", async () => {
      liveDemo = { serveJobId: SERVE, state: "live", minutes: 30, endsAt: new Date(Date.now() + 20 * 60_000).toISOString() };
      const html = await openJob();
      clean(html);
      assert.match(html, /<h2[^>]*>Try it live<\/h2>/);
      assert.match(html, /class="pill pill-live"><span class="pill-dot" aria-hidden="true"><\/span>Live<\/span>/);
      assert.match(html, /(19|20) minutes left/);
      assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Your app idea<\/label><textarea[^>]*maxLength="600"/);
      assert.match(html, /placeholder="A menu board for my bakery/);
      assert.match(html, /Ask both models/);
      assert.match(html, /Tuned Glimmer beat base on <strong>1 of 2<\/strong>/, "the results stay");
      assert.ok(html.indexOf("Try it live") < html.indexOf("The run"), "the box comes first");
      assert.doesNotMatch(html, /Stop job|Try stop again|Shut down GPU|Start a live demo|Open the demo|\/api\/train|\/fine-tuning\/5e7e/);
      assert.deepEqual(calls.sort(), ["getLiveDemo", "getReadyDataset", "getResultJob", "listResultEvents"]);
    });

    it("/fine-tuning/{id} says a demo is starting, with Ask held until it is live", async () => {
      liveDemo = { serveJobId: SERVE, state: "starting", minutes: 45, endsAt: null };
      const html = await openJob();
      clean(html);
      assert.match(html, /Try it live/);
      assert.match(html, />Starting<\/span>/);
      assert.match(html, /A live demo is starting\. The GPU boots and loads the model, which takes up to about 15 minutes, then this box opens for 45 minutes\./);
      assert.match(html, /<button type="submit" class="btn btn-primary" disabled/);
      assert.doesNotMatch(html, /minutes? left/);
    });

    it("/fine-tuning/{id} shows On Hugging Face and both repos once the job is published there, and nothing else of it", async () => {
      const modelUrl = "https://huggingface.co/muse-org/muse-glimmer-30b-bakery-helper-lora-8f1d2c3b";
      const datasetUrl = "https://huggingface.co/datasets/muse-org/muse-muse-bakery-helper-1b2c3d4e";
      // The store's hubLinks, and a leaky store's whole hub state beside it.
      job = jobRow({
        hubLinks: { status: "published", modelUrl, datasetUrl },
        hub: { status: "published", reason: "hub-secret-reason", small: { "adapter_config.json": "c2VjcmV0" }, why: "hub-secret-why", modelUrl },
      });
      const html = await openJob();
      clean(html);
      assert.match(html, /<a class="chip" href="https:\/\/huggingface\.co\/muse-org\/muse-glimmer-30b-bakery-helper-lora-8f1d2c3b"[^>]*>On Hugging Face/);
      assert.match(html, /<dt>On Hugging Face<\/dt>/);
      assert.ok(html.includes(datasetUrl));
      assert.doesNotMatch(html, /hub-secret|c2VjcmV0/);
      job = jobRow({ hub: { status: "published", modelUrl, datasetUrl, public: true } });
      assert.doesNotMatch(await openJob(), /Hugging Face/, "only the store's hubLinks count, never the hub state");
      job = jobRow();
      assert.doesNotMatch(await openJob(), /Hugging Face/);
    });

    it("/fine-tuning puts the On Hugging Face chip on a published job", async () => {
      job = jobRow({ hubLinks: { status: "published", modelUrl: "https://huggingface.co/muse-org/m", datasetUrl: null } });
      const html = await openList();
      clean(html);
      assert.match(html, /<span class="chip">On Hugging Face<\/span>/);
    });

    it("/fine-tuning/{id} keeps the results when the live demo can't be read", async () => {
      liveDemoFails = true;
      const errors = mock.method(console, "error", () => {});
      try {
        const html = await openJob();
        clean(html);
        assert.match(html, /Tuned Glimmer beat base/);
        assert.doesNotMatch(html, /Try it live/);
        assert.equal(errors.mock.callCount(), 1);
      } finally {
        errors.mock.restore();
      }
    });

    for (const [name, over] of [
      ["running", { status: "running", finishedAt: null, terminatedAt: null }],
      ["booting", { status: "booting", finishedAt: null, terminatedAt: null, evalSummary: null }],
      ["failed", { status: "failed" }],
      ["stopped", { status: "stopped" }],
      ["not judged", { evalSummary: null }],
      ["judging skipped", { evalSummary: { ...summary, items: 0, tunedWins: 0, ties: 0, note: "Judging skipped: MODEL_API_KEY isn't set." } }],
      ["a dry run", { params: { datasetId: DS, dryRun: 1 } }],
    ] as const) {
      it(`/fine-tuning/{id} is a 404 for a job that is ${name}, even if the store answered it`, async () => {
        job = jobRow(over);
        await assert.rejects(openJob(), new RegExp(NOT_FOUND));
        assert.equal(calls.includes("listResultEvents"), false, "its eval items are never read");
        assert.equal(calls.some((c) => ADMIN_READS.includes(c)), false);
      });
    }

    it("/fine-tuning/{id} is a 404 for an unknown or malformed id", async () => {
      job = null;
      await assert.rejects(openJob(), new RegExp(NOT_FOUND));
      await assert.rejects(openJob("not-a-uuid"), new RegExp(NOT_FOUND));
    });

    it("/fine-tuning/datasets/{id} shows a ready dataset read-only, with a few samples", async () => {
      const html = await openDataset();
      clean(html);
      assert.match(html, /<h1>Bakery helper<\/h1>/);
      assert.match(html, /Answer customer questions for a small bakery/);
      assert.match(html, /<strong>30<\/strong> train · <strong>8<\/strong> eval/);
      assert.match(html, /Question 3\?/);
      assert.match(html, /Open Sunday\?/);
      assert.match(html, /The first 3 of 30/);
      assert.doesNotMatch(html, CONTROLS);
      assert.doesNotMatch(html, /Stopped early|u-secret-author/);
      assert.equal(calls.some((c) => ADMIN_READS.includes(c)), false);
    });

    it("/fine-tuning/{id} of a decide job shows its scores, never an input, and reads no rows or scores", async () => {
      useTickets();
      const html = await openJob();
      clean(html);
      assert.match(html, /<h2 id="decide-results-title">Decision results<\/h2>/);
      assert.match(html, /The tuned model was right on 41 of 48 held-out examples \(85%\); base Glimmer was right on 32 \(67%\)\./);
      assert.match(html, /No judge and no model call/);
      assert.match(html, /<dt>Mode<\/dt><dd>decide<\/dd>/);
      assert.doesNotMatch(html, /Wrong answers|judged by|Tuned Glimmer beat base/);
      for (const input of ticketInputs) assert.equal(html.includes(input), false, "a person's inputs never reach the public page");
      assert.equal(calls.some((c) => ADMIN_READS.includes(c)), false);
    });

    it("/fine-tuning lists a decide job with its accuracy, and its dataset with its splits", async () => {
      useTickets();
      const html = await openList();
      clean(html);
      assert.match(html, /Tuned right on <strong>41<\/strong> of 48 \(85%\)/);
      assert.match(html, /168 train · 24 dev · 48 test/);
      assert.match(html, /Decision models are scored instead of judged/);
    });

    it("/fine-tuning/datasets/{id} of a decision dataset shows its labels and counts, never a row", async () => {
      useTickets();
      const html = await openDataset();
      clean(html);
      assert.match(html, /<h1>Ticket router<\/h1>/);
      assert.match(html, /Which team should handle this support ticket\?/);
      assert.match(html, /Charges, refunds and invoices/);
      assert.match(html, /Their inputs stay private/);
      for (const input of ticketInputs) assert.equal(html.includes(input), false);
      assert.doesNotMatch(html, CONTROLS);
      assert.doesNotMatch(html, /page-fixture-seed/, "never the seed");
      assert.equal(calls.includes("datasetPage"), false);
      assert.equal(calls.some((c) => ADMIN_READS.includes(c)), false);
    });

    for (const status of ["generating", "failed"]) {
      it(`/fine-tuning/datasets/{id} is a 404 for a dataset that is ${status}, even if the store answered it`, async () => {
        dataset = datasetRow({ status });
        await assert.rejects(openDataset(), new RegExp(NOT_FOUND));
        assert.equal(calls.includes("datasetPage"), false, "its examples are never read");
      });
    }
  });

  describe("for admins", () => {
    beforeEach(() => {
      viewer = admin;
    });

    it("/fine-tuning keeps the jobs, the New job and New dataset cards, plus the results", async () => {
      const html = await openList();
      assert.match(html, /New job/);
      assert.match(html, /New dataset/);
      assert.match(html, /GPU in use/);
      assert.match(html, /<h2 id="jobs-title">Jobs<\/h2>/);
      assert.match(html, /<h2 id="results-title">Results<\/h2>/);
      assert.match(html, /Anyone can see these, read-only\./);
      assert.doesNotMatch(html, /Only admins can start jobs/);
    });

    it("/fine-tuning/{id} keeps the full job page for any job", async () => {
      job = jobRow({ status: "running", finishedAt: null, terminatedAt: null, evalSummary: null });
      const html = await openJob();
      assert.match(html, /Event log/);
      assert.match(html, /Stop job/);
      assert.match(html, /203\.0\.113\.9/, "admins still see the IP");
      assert.ok(calls.includes("getJob"));
      assert.equal(calls.includes("getResultJob"), false);
    });

    it("/fine-tuning/{id} offers Start a live demo for a trained adapter, held while the sweep can't run", async () => {
      adapterSource = { job: jobRow(), metrics: { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${JOB}`, base_model: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } };
      const html = await openJob();
      assert.match(html, /<h2[^>]*>Live demo<\/h2>/);
      assert.match(html, /Anyone with this page&#x27;s link can then type an app idea/);
      assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Minutes live<\/label><select/);
      assert.match(html, /<option value="30" selected="">30 minutes<\/option>/);
      assert.match(html, /<option value="120" disabled="">120 minutes \(needs 135, over the 120-minute ceiling\)<\/option>/);
      assert.match(html, /The job stops at 45 minutes or \$3\.29, whichever comes first/);
      assert.match(html, /runs on a local address|CRON_SECRET isn&#x27;t set/);
      assert.match(html, /<button type="submit" class="btn btn-primary" disabled[^>]*>.*Start a live demo/);
      assert.doesNotMatch(html, /Try it live/);
      assert.ok(calls.includes("getLiveDemo") && calls.includes("getAdapterSource"));
    });

    it("/fine-tuning/{id} lets Start a live demo go once the platform is public and the sweep runs", async () => {
      process.env.PLATFORM_URL = "https://muse-muse.example";
      process.env.CRON_SECRET = "test-cron";
      process.env.VERCEL_ENV = "production";
      lastSweep = new Date();
      adapterSource = { job: jobRow(), metrics: { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${JOB}/`, base_model: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } };
      try {
        const html = await openJob();
        assert.match(html, /Start a live demo/);
        assert.doesNotMatch(html, /<button type="submit" class="btn btn-primary" disabled/);
        assert.doesNotMatch(html, /local address|CRON_SECRET|last 15 minutes/);
      } finally {
        delete process.env.PLATFORM_URL;
        delete process.env.CRON_SECRET;
        delete process.env.VERCEL_ENV;
      }
    });

    it("/fine-tuning/{id} offers no live demo for an adapter that isn't on a model cache", async () => {
      adapterSource = { job: jobRow(), metrics: { cache_used: "no", adapter_dir: "/home/ubuntu/work/adapter" } };
      const html = await openJob();
      assert.doesNotMatch(html, /Live demo|Try it live|Start a live demo/);
      // On the cache, but trained on plain Glimmer before the switch: the demo GPU loads r30b, so no demo is offered.
      adapterSource = { job: jobRow(), metrics: { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${JOB}` } };
      assert.doesNotMatch(await openJob(), /Start a live demo/);
      job = jobRow({ status: "failed" });
      adapterSource = { job, metrics: { cache_used: "yes", adapter_dir: `/x/models/${JOB}` } };
      calls = [];
      assert.doesNotMatch(await openJob(), /Live demo|Try it live/);
      assert.equal(calls.includes("getLiveDemo"), false, "a job that didn't succeed has no adapter to look for");
    });

    it("/fine-tuning/{id} shows an admin the live demo with a link to its serve job", async () => {
      liveDemo = { serveJobId: SERVE, state: "live", minutes: 30, endsAt: new Date(Date.now() + 10 * 60_000).toISOString() };
      const html = await openJob();
      assert.match(html, /Try it live/);
      assert.match(html, /href="\/fine-tuning\/5e7e5e7e-0000-4000-8000-00000000000a">Open the demo&#x27;s job<\/a>/);
      assert.doesNotMatch(html, /Start a live demo/);
      assert.equal(calls.includes("getAdapterSource"), false);
    });

    it("/fine-tuning/{id} of a serve job shows its serving state and the adapter it serves", async () => {
      const started = new Date(Date.now() - 5 * 60_000);
      job = jobRow({
        id: SERVE,
        recipe: "glimmer-serve",
        title: "Live demo: Bakery LoRA",
        status: "running",
        params: { adapterJobId: JOB, minutes: 30 },
        maxMinutes: 45,
        maxUsd: 3.29,
        launchedAt: new Date(started.getTime() - 8 * 60_000),
        finishedAt: null,
        terminatedAt: null,
        evalSummary: null,
        serveEndpoint: { ip: SECRETS.instanceIp, port: 8443, certSha256: CERT, startedAt: started.toISOString() },
      });
      otherJobs = [jobRow()];
      const html = await openJob(SERVE);
      assert.match(html, /<h3[^>]*>Live demo<\/h3><p class="panel-note">Serving since \d\d:\d\d UTC, until about \d\d:\d\d UTC \((24|25) minutes left\)\./);
      assert.match(html, /The Try it live box is on <a href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001">Bakery LoRA<\/a>/);
      assert.match(html, /<dt>Adapter<\/dt><dd><a href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001">Bakery LoRA<\/a><\/dd>/);
      assert.match(html, /Serving the live demo/);
      assert.doesNotMatch(html, new RegExp(CERT), "the page never shows the whole certificate");
      assert.equal(calls.includes("getLiveDemo"), false, "a serve job has no live demo of its own");
    });

    it("/fine-tuning/{id} of a Muse Glimmer LoRA job has its Hugging Face card, and says when publishing is off", async () => {
      delete process.env.HF_TOKEN;
      job = jobRow({ hub: { status: "uploaded", modelRepo: "muse-org/m", files: [{ path: "adapter_model.safetensors", size: 1, sha256: "a".repeat(64) }], uploaded: ["a".repeat(64)], small: { "adapter_config.json": "c2VjcmV0" } } });
      const html = await openJob();
      assert.match(html, /<h2[^>]*>Hugging Face<\/h2>/);
      assert.match(html, /Publishing to Hugging Face is off here: HF_TOKEN isn&#x27;t set\./);
      assert.doesNotMatch(html, /c2VjcmV0/, "never the small files");
      job = jobRow({ recipe: "smoke", title: "Smoke test", params: {}, evalSummary: null });
      assert.doesNotMatch(await openJob(), /<h2[^>]*>Hugging Face<\/h2>/, "only Muse Glimmer LoRA jobs publish");
    });

    it("/fine-tuning/{id} of a decide job lists the test rows it got wrong, with their inputs", async () => {
      useTickets();
      const html = await openJob();
      assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
      assert.match(html, /Wrong answers<\/h3><span class="muted small">Admins only<\/span>/);
      assert.equal(html.match(/% sure<\/span>/g)?.length, 7);
      const missed = tickets.rows.test.filter((r) => html.includes(r.input));
      assert.equal(missed.length, 7, "the misses' inputs, and no other row's");
      assert.match(html, /trained on 168 of this dataset&#x27;s examples/);
      assert.ok(calls.includes("decideScores") && calls.includes("decisionSplitRows"));
    });

    it("/fine-tuning/{id} of a decide job still shows its numbers when its rows can't be read", async () => {
      useTickets();
      decisionRows = null;
      const html = await openJob();
      assert.match(html, /Decision results/);
      assert.doesNotMatch(html, /Wrong answers/);
    });

    it("/fine-tuning/datasets/{id} of a decision dataset shows an admin a few rows of each label", async () => {
      useTickets();
      const html = await openDataset();
      assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
      assert.match(html, /Sample rows/);
      assert.match(html, /Train on it/);
      for (const l of tickets.spec.labels) {
        const first = tickets.rows.train.find((r) => r.label === l.id)!;
        assert.ok(html.includes(first.input), l.name);
      }
      assert.equal(html.includes(tickets.rows.test[0]!.input), false, "never a test row");
      assert.ok(calls.includes("decisionSplitRows"));
      assert.equal(calls.includes("datasetPage"), false);
    });

    it("/fine-tuning offers the New decision dataset card and starts the New job card on ?dataset=", async () => {
      useTickets();
      const html = render(await listPage({ searchParams: Promise.resolve({ dataset: DS }) }));
      assert.match(html, /id="new-decision-dataset"/);
      assert.match(html, /<option value="decide" selected="">/);
    });

    it("/fine-tuning/datasets/{id} keeps Train on it", async () => {
      const html = await openDataset();
      assert.match(html, /Train on it/);
    });
  });
});
