/**
 * The run-locally page, /fine-tuning/{jobId}/run, and its link on the model's public page, with the viewer, the store
 * and localFilesFor faked: run 2's files as glimmer-quantize will make them (./fixtures.ts), or none, which is what
 * localFilesFor finds today. The fake store answers the Lab reads with whole rows, secrets and all, so the page is shown
 * to send only what it should. The modules are the real ones with these reads swapped, so nothing reaches Neon or the Hub.
 *
 *   npx tsx --test --experimental-test-module-mocks components/vibe/__tests__/pages.test.tsx
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";
import type { LocalFiles } from "@/lib/train/local-files";
import type { TrainEventView } from "@/lib/train/types";
import { RUN2_HELLO, RUN2_JOB, RUN2_REPO, RUN2_SYSTEM, RUN2_TITLE, run2Files } from "./fixtures";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const DS = "17c76f2c-0000-4000-8000-000000000002";
const t0 = Date.parse("2026-10-27T14:00:00.000Z");

/** What a public page must never show. */
const SECRET_TEXT = /203\.0\.113\.9|us-secret-1|hash-of-the-job-token|wrun_secret|secret-path|lambda\/nfs|c0de5eed|serveKey/;

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: RUN2_JOB,
    recipe: "glimmer-lora",
    title: RUN2_TITLE,
    status: "succeeded",
    params: { datasetId: DS, maxSteps: 120, studentPrompt: "short", dryRun: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    costUsd: 1.39,
    createdAt: new Date(t0 - 60_000),
    launchedAt: new Date(t0),
    finishedAt: new Date(t0 + 42 * 60_000),
    terminatedAt: new Date(t0 + 43 * 60_000),
    evalSummary: { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 },
    // A leaky store's extra columns: none may reach the page.
    instanceIp: "203.0.113.9",
    region: "us-secret-1",
    tokenHash: "hash-of-the-job-token",
    workflowRunId: "wrun_secret",
    error: "Traceback in /home/ubuntu/.cache/secret-path",
    ...over,
  };
}

const events: TrainEventView[] = [
  {
    id: 30,
    type: "eval",
    payload: { type: "eval", index: 0, prompt: RUN2_HELLO.prompt, reference: "A brief.", base: "I can't see any photo.", tuned: RUN2_HELLO.tuned },
    at: new Date(t0 + 30 * 60_000).toISOString(),
  },
  {
    id: 31,
    type: "eval",
    payload: { type: "eval", index: 1, prompt: "A habit tracker from my notebook sketch.", reference: "A brief.", base: "Sure.", tuned: "Habit grid" },
    at: new Date(t0 + 31 * 60_000).toISOString(),
  },
  { id: 32, type: "log", payload: { type: "log", text: "token=abc /home/ubuntu/.cache/secret-path" }, at: new Date(t0).toISOString() },
];

let viewer: SessionUser | null = null;
let job: Record<string, unknown> | null = null;
let files: LocalFiles | null = null;
let filesFail = false;
let liveDemo: Record<string, unknown> | null = null;
let calls: string[] = [];
const savedEnv = { ...process.env };

function fake<A extends unknown[], R>(name: string, fn: (...args: A) => R) {
  return async (...args: A) => {
    calls.push(name);
    return fn(...args);
  };
}

const fakeStore = {
  getResultJob: fake("getResultJob", (id: string) => (job && job.id === id ? job : null)),
  listResultEvents: fake("listResultEvents", () => events),
  getReadyDataset: fake("getReadyDataset", () => null),
  getLiveDemo: fake("getLiveDemo", (id: string) => (liveDemo && id === RUN2_JOB ? { ...liveDemo, ip: "203.0.113.9", tokenHash: "hash-of-the-job-token" } : null)),
};

const fakeLocalFiles = fake("localFilesFor", (id: string) => {
  if (filesFail) throw new Error("the quantize job's row couldn't be read");
  return files && id === RUN2_JOB ? files : null;
});

type Page = (props: { params: Promise<Record<string, string>> }) => Promise<ReactNode>;
let render: (node: ReactNode) => string;
let runPage: Page;
let modelPage: Page;

const guest: SessionUser = { id: "u-guest", email: "guest@open-access.invalid", isAdmin: false, openAccess: true };
const admin: SessionUser = { id: "u-admin", email: "owner@example.com", isAdmin: true };

const openRun = async (id = RUN2_JOB) => render(await runPage({ params: Promise.resolve({ jobId: id }) }));
const openModel = async (id = RUN2_JOB) => render(await modelPage({ params: Promise.resolve({ jobId: id }) }));

/** The props of the first element of a type in a server component's tree, or null. */
function propsOf(node: unknown, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = propsOf(n, type);
      if (found) return found;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? null;
  return propsOf(el.props?.children, type);
}

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, SECRET_TEXT);
  assert.doesNotMatch(html, /href="[^"]*\/resolve\/[^"]*\.gguf"/, "nothing downloads a model in the browser");
  assert.doesNotMatch(html, /\.command"|\.cmd"|\.ps1"|download="/, "no launchers from the web");
  assert.doesNotMatch(html, /localhost:9931\/v1|127\.0\.0\.1:9931\/v1|fetch\(/, "the page never calls a local app itself");
}

describe("run it on your computer", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    // safeQuery runs only with a database configured. Every read is faked, so nothing connects to this.
    process.env.DATABASE_URL = "postgres://vibe-pages-test.invalid/db";
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
    // The real modules with only these reads swapped, so whatever else the pages import is still there.
    const realStore = await import(at("../../../lib/train/store.ts"));
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/train/store.ts"), { namedExports: { ...realStore, ...fakeStore } });
    mock.module(at("../../../lib/train/local-files-server.ts"), { namedExports: { localFilesFor: fakeLocalFiles } });
    const { renderToString } = await import("react-dom/server");
    render = (node) => renderToString(node as never).replace(/<!-- -->/g, "");
    runPage = (await import(at("../../../app/fine-tuning/[jobId]/run/page.tsx"))).default as Page;
    modelPage = (await import(at("../../../app/fine-tuning/[jobId]/page.tsx"))).default as Page;
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    viewer = guest;
    job = jobRow();
    files = null;
    filesFail = false;
    liveDemo = null;
    calls = [];
  });

  describe("/fine-tuning/{id}/run", () => {
    it("says plainly that local files aren't made yet, which is what localFilesFor finds today", async () => {
      const html = await openRun();
      clean(html);
      assert.match(html, /<h1>Run it on your computer<\/h1>/);
      assert.match(html, /Muse Muse brief writer, the tuned Muse Glimmer 30B\./);
      assert.match(html, /<h2>No local files yet<\/h2>/);
      assert.match(html, /Local files aren&#x27;t made yet for this model\./);
      assert.match(html, new RegExp(`href="/fine-tuning/${RUN2_JOB}"[^>]*>Back to the model`));
      assert.match(html, /is not intended for individuals under the age of 18/);
      assert.match(html, /href="https:\/\/huggingface\.co\/meta-models\/Muse-Glimmer-30B\/blob\/main\/USAGE_POLICY\.md"/);
      assert.doesNotMatch(html, /Your computer|Get it running|Which file for my computer/);
      assert.deepEqual(calls.sort(), ["getLiveDemo", "getResultJob", "listResultEvents", "localFilesFor"]);
    });

    it("with run 2's public files: the sizes, the least it needs, the picker, the verdict waiting, and every build", async () => {
      files = run2Files();
      const html = await openRun();
      clean(html);
      // The least it needs, said the same way as the line under it: a Mac, a card, or RAM.
      assert.match(html, /in three builds from 13\.7 GB to 22\.9 GB\. It needs a Mac with 24 GB, a 16 GB graphics card, or 32 GB of RAM\./);
      assert.match(html, /It runs on a Mac with Apple silicon and 24 GB or more, or on a PC with a 16 GB graphics card, or slowly with 32 GB of RAM\./);
      assert.match(html, /is not intended for individuals under the age of 18/);
      assert.match(html, /<h2[^>]*>Your computer<\/h2>/);
      assert.match(html, /None of it is sent anywhere\./);
      assert.match(html, /Confirm your memory to see/);
      assert.match(html, /<h2 id="vibe-files-title">Which file for my computer<\/h2>/);
      assert.match(html, /<th scope="row">Q3_K_M<\/th><td class="num">13\.7 GB<\/td><td class="num">about 15 GB<\/td><td>a Mac with 24 GB, or a 16 GB graphics card<\/td>/);
      assert.match(html, /<th scope="row">Q4_K_M<\/th><td class="num">16\.9 GB<\/td><td class="num">about 18 GB<\/td><td>a Mac with 32 GB, or a 20 GB graphics card<\/td>/);
      assert.match(html, /<th scope="row">Q6_K<\/th><td class="num">22\.9 GB<\/td><td class="num">about 24 GB<\/td><td>a Mac with 48 GB, or a 32 GB graphics card<\/td>/);
      // On a phone the same facts come as a list, so "Needs at least" never sits off screen.
      assert.match(html, /<dl class="kv vibe-files-list"><div><dt>Q3_K_M<\/dt><dd>13\.7 GB file, about 15 GB to run\. Needs at least a Mac with 24 GB, or a 16 GB graphics card\.<\/dd>/);
      for (const f of files.files) assert.ok(html.includes(f.sha256) && html.includes(f.name), f.level);
      assert.ok(html.includes(`href="https://huggingface.co/${RUN2_REPO}"`), "the repo, once it is public");
      assert.doesNotMatch(html, /Private: only admins/);
      // The picker waits for the browser and the person: no build is picked on the server, so no guide yet.
      assert.doesNotMatch(html, /Get it running|lmstudio:/);
    });

    it("names the model as its repos do, not by the job's own title", async () => {
      job = { ...jobRow(), title: "Brief writer LoRA" };
      files = run2Files();
      const html = await openRun();
      assert.match(html, /<p class="subtitle">Muse Muse brief writer, the tuned Muse Glimmer 30B/);
      assert.doesNotMatch(html, /Brief writer LoRA/);
    });

    it("sends the browser only the builds, the repo, the system message exactly and held-out prompt 0", async () => {
      files = run2Files();
      const { RunLocally } = await import("@/components/vibe/RunLocally");
      const { LocalGuide } = await import("@/components/vibe/LocalGuide");
      const page = (await runPage({ params: Promise.resolve({ jobId: RUN2_JOB }) })) as { type: unknown; props: Record<string, unknown> };
      assert.equal(page.type, RunLocally);
      assert.equal(page.props.showPrivate, false);
      // LocalGuide is the client component: its props are what the browser gets.
      const guide = propsOf(RunLocally(page.props as never), LocalGuide);
      assert.ok(guide, "the guide is on the page");
      assert.deepEqual(Object.keys(guide.files as object).sort(), ["commit", "files", "needsTunedTemplate", "public", "repo", "slug", "systemLine"]);
      assert.equal((guide.files as LocalFiles).systemLine, RUN2_SYSTEM);
      assert.deepEqual(guide.hello, { prompt: RUN2_HELLO.prompt, tuned: RUN2_HELLO.tuned, index: 0, total: 2 });
      assert.deepEqual(guide.live, { open: false, modelHref: `/fine-tuning/${RUN2_JOB}` });
      assert.doesNotMatch(JSON.stringify(guide), /c0de5eed|quantJobId|adapterJobId|secret|203\.0\.113/);
      assert.equal(guide.driveHref, null, "drive orders are off by default");
    });

    it("offers a flash drive in the verdict only while DRIVE_ENABLED is on and the files are public", async () => {
      const { RunLocally } = await import("@/components/vibe/RunLocally");
      const { LocalGuide } = await import("@/components/vibe/LocalGuide");
      const guideOf = async () => {
        const page = (await runPage({ params: Promise.resolve({ jobId: RUN2_JOB }) })) as { props: Record<string, unknown> };
        return propsOf(RunLocally(page.props as never), LocalGuide);
      };
      process.env.DRIVE_ENABLED = "1";
      try {
        files = run2Files();
        assert.equal((await guideOf())?.driveHref, `/orders/new?model=${RUN2_JOB}`);
        files = run2Files({ commit: null });
        assert.equal((await guideOf())?.driveHref, null, "a drive needs the files at a commit");
        viewer = admin;
        files = run2Files({ public: false });
        assert.equal((await guideOf())?.driveHref, null, "never for files that aren't public");
      } finally {
        delete process.env.DRIVE_ENABLED;
      }
    });

    it("files that aren't public yet: guests are told so, admins get the guide with a warning", async () => {
      files = run2Files({ public: false });
      const guestHtml = await openRun();
      clean(guestHtml);
      assert.match(guestHtml, /<h2>Not public yet<\/h2>/);
      assert.match(guestHtml, /This model&#x27;s local files aren&#x27;t public yet\./);
      assert.doesNotMatch(guestHtml, /Your computer|Which file for my computer/);
      viewer = admin;
      const adminHtml = await openRun();
      assert.match(adminHtml, /Private: only admins see this guide/);
      assert.match(adminHtml, /Your computer/);
      assert.doesNotMatch(adminHtml, /All files on Hugging Face/, "a private repo isn't linked");
    });

    it("files with no repo or no builds count as not made yet", async () => {
      for (const over of [{ repo: null }, { files: [] }, { repo: "not a repo" }]) {
        files = run2Files(over);
        assert.match(await openRun(), /Local files aren&#x27;t made yet/, JSON.stringify(over));
      }
    });

    it("puts Try it live first while a live demo runs, with nothing about its GPU", async () => {
      files = run2Files();
      liveDemo = { serveJobId: "5e7e5e7e-0000-4000-8000-00000000000a", state: "live", minutes: 30, endsAt: new Date(Date.now() + 20 * 60_000).toISOString() };
      const html = await openRun();
      clean(html);
      assert.match(html, /<h2[^>]*>Try it live<\/h2>/);
      assert.ok(html.indexOf("Try it live") < html.indexOf("Your computer"), "the fallback comes first");
      assert.doesNotMatch(html, /5e7e5e7e/);
    });

    it("keeps the page when localFilesFor fails, and says the files aren't made yet", async () => {
      filesFail = true;
      const errors = mock.method(console, "error", () => {});
      try {
        const html = await openRun();
        clean(html);
        assert.match(html, /Local files aren&#x27;t made yet/);
        assert.equal(errors.mock.callCount(), 1);
        assert.match(String(errors.mock.calls[0].arguments.join(" ")), /\[run locally\] local files/);
      } finally {
        errors.mock.restore();
      }
    });

    it("ignores files that name another adapter", async () => {
      files = run2Files({ adapterJobId: "99999999-0000-4000-8000-000000000009" });
      assert.match(await openRun(), /Local files aren&#x27;t made yet/);
    });

    for (const [name, over] of [
      ["running", { status: "running", terminatedAt: null }],
      ["not judged", { evalSummary: null }],
      ["a dry run", { params: { datasetId: DS, dryRun: 1 } }],
      ["a live demo job", { recipe: "glimmer-serve" }],
    ] as const) {
      it(`is a 404 for a job that is ${name}, even if the store answered it`, async () => {
        job = jobRow(over);
        files = run2Files();
        await assert.rejects(openRun(), new RegExp(NOT_FOUND));
        assert.equal(calls.includes("localFilesFor"), false, "its files are never read");
      });
    }

    it("is a 404 for an unknown id", async () => {
      job = null;
      await assert.rejects(openRun(), new RegExp(NOT_FOUND));
    });
  });

  describe("the link on the model's public page", () => {
    const published = () =>
      jobRow({ hubLinks: { status: "published", modelUrl: `https://huggingface.co/muse-org/muse-glimmer-30b-brief-writer-lora-83d71f74`, datasetUrl: null } });

    it("comes right under the model's title once it has public local files, and opens the run-locally page", async () => {
      job = published();
      files = run2Files();
      const html = await openModel();
      clean(html);
      assert.match(html, new RegExp(`<a class="card vibe-run-link" href="/fine-tuning/${RUN2_JOB}/run">`));
      assert.match(html, /Three builds from 13\.7 GB to 22\.9 GB, for a Mac with 24 GB or more or a PC with a 16 GB graphics card\./);
      assert.ok(html.indexOf("<h1>") < html.indexOf("vibe-run-link"), "the title first");
      assert.ok(html.indexOf("vibe-run-link") < html.indexOf("The run</h2>"), "then the link, before the results");
      assert.match(html, /Tuned Glimmer beat base/, "the results stay as they were");
    });

    it("isn't there while the files aren't public, or for an adapter that isn't public on the Hub", async () => {
      job = published();
      files = run2Files({ public: false });
      assert.doesNotMatch(await openModel(), /Run it on your computer/);
      files = null;
      assert.doesNotMatch(await openModel(), /Run it on your computer/);
      job = jobRow();
      files = run2Files();
      calls = [];
      assert.doesNotMatch(await openModel(), /Run it on your computer/);
      assert.equal(calls.includes("localFilesFor"), false, "no public adapter, so no public GGUF repo to look for");
    });

    it("keeps the model page when the files can't be read", async () => {
      job = published();
      filesFail = true;
      const errors = mock.method(console, "error", () => {});
      try {
        const html = await openModel();
        assert.match(html, /Tuned Glimmer beat base/);
        assert.doesNotMatch(html, /Run it on your computer/);
        assert.equal(errors.mock.callCount(), 1);
      } finally {
        errors.mock.restore();
      }
    });
  });
});
