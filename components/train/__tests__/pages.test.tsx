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

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;

const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const DS = "1b2c3d4e-0000-4000-8000-000000000002";
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
const SECRET_TEXT = /i-0a1b2c3d4e5f6789|203\.0\.113\.9|mm-train-|us-secret-1|hash-of-the-job-token|wrun_secret|secret-path|lambda\/nfs|token=abc|blob\.vercel-storage/;
const CONTROLS = /<form|<button[^>]*type="submit"|Stop job|Try stop again|Shut down GPU|New job|New dataset|Train on it|href="#new-job"|href="#new-dataset"/;

const summary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 4.5, avgTunedScore: 7.5, judgeCostUsd: 0.004 };

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
let calls: string[] = [];
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
  // Admin reads.
  getJob: fake("getJob", (id: string) => (job && job.id === id ? job : null)),
  listEvents: fake("listEvents", () => resultEvents),
  getDataset: fake("getDataset", (id: string) => (dataset && dataset.id === id ? dataset : null)),
  listJobs: fake("listJobs", () => (job ? [job] : [])),
  listDatasets: fake("listDatasets", () => (dataset ? [dataset] : [])),
  datasetProgress: fake("datasetProgress", () => null),
  activeJobCount: fake("activeJobCount", () => 0),
  trainingSpendToday: fake("trainingSpendToday", () => 0),
  lastSweepOkAt: fake("lastSweepOkAt", () => null),
  verifyJobToken: fake("verifyJobToken", () => false),
};

/** Reads that only the admin pages may make. */
const ADMIN_READS = ["getJob", "listEvents", "getDataset", "listJobs", "listDatasets", "datasetProgress", "activeJobCount", "trainingSpendToday", "lastSweepOkAt"];

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
    calls = [];
  });

  describe("for non-admins", () => {
    it("/fine-tuning shows the intro, the judged jobs and the ready datasets, with no controls", async () => {
      const html = await openList();
      clean(html);
      assert.match(html, /Lab results/);
      assert.match(html, /Muse Spark 1\.3 writes a training set, Muse Glimmer 30B learns it/);
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
      assert.deepEqual(calls.sort(), ["getReadyDataset", "getResultJob", "listResultEvents"]);
      assert.equal(calls.some((c) => ADMIN_READS.includes(c)), false);
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

    it("/fine-tuning/datasets/{id} keeps Train on it", async () => {
      const html = await openDataset();
      assert.match(html, /Train on it/);
    });
  });
});
