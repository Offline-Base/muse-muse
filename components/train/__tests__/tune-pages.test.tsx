/**
 * The new fine-tune pages, server-rendered outside Next with the viewer and the run's reads faked: /fine-tuning/new
 * (the one box, the Training setup, the honest cost line) and /fine-tuning/runs/{id} (the room for a run that writes,
 * waits with Ready to train, is ready with its verdict, or failed). With TUNE_COMPOSER off both are a 404 for everyone;
 * on, non-admins go to /fine-tuning and its read-only Lab. Also the pieces they're built from: Composer's new props,
 * SetupPanel's rows, the training plan on the plan card, Where it runs, and the composer's error sentences. Made-up data.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/tune-pages.test.tsx
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import type { JobLiveDemo } from "@/components/train/LiveDemo";
import type { SessionUser } from "@/lib/auth";
import type { DatasetHead, TrainJobRow } from "@/lib/train/logic";
import type { TrainEventView } from "@/lib/train/types";
import type { TuneRunView } from "@/lib/train/tune/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const DS = "1b2c3d4e-0000-4000-8000-000000000002";
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const t0 = Date.parse("2026-11-01T12:00:00.000Z");
const savedEnv = { ...process.env };

let viewer: SessionUser | null = null;
let camera = false;
let run: TuneRunView | null = null;
let liveDemo: JobLiveDemo | null = null;
const liveDemoAsked: string[] = [];
const admin: SessionUser = { id: "u-admin", email: "owner@example.com", isAdmin: true };
const guest: SessionUser = { id: "u-guest", email: "guest@open-access.invalid", isAdmin: false, openAccess: true };

function dataset(over: Partial<DatasetHead> = {}): DatasetHead {
  return {
    id: DS,
    title: "a made-up bakery's counter helper",
    task: "Answer questions for a made-up bakery: hours and cakes.\n\nWrite in the style of these examples, which are the person's own:\n- Q: Open Sunday?\n  A: 8 to 2.",
    status: "ready",
    requested: 200,
    trainCount: 180,
    evalCount: 20,
    costUsd: 4.2,
    error: null,
    createdBy: null,
    createdAt: new Date(t0),
    finishedAt: new Date(t0 + 20 * 60_000),
    workflowRunId: null,
    writerModel: "muse-wonder-1.0",
    ...over,
  } as DatasetHead;
}

function job(over: Partial<TrainJobRow> = {}): TrainJobRow {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    title: "a made-up bakery's counter helper",
    status: "succeeded",
    params: { datasetId: DS, maxSteps: 120, learningRate: 0.0002, loraRank: 16, dryRun: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 129,
    maxMinutes: 90,
    maxUsd: 5,
    instanceId: null,
    instanceIp: "203.0.113.9",
    instanceName: "mm-train-8f1d2c3b-glimmer-lora",
    tokenHash: null,
    workflowRunId: null,
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 1.5,
    createdBy: null,
    createdAt: new Date(t0 + 21 * 60_000),
    launchedAt: new Date(t0 + 22 * 60_000),
    firstHeartbeatAt: null,
    lastHeartbeatAt: null,
    finishedAt: new Date(t0 + 66 * 60_000),
    terminatedAt: new Date(t0 + 67 * 60_000),
    evalSummary: { items: 20, tunedWins: 18, baseWins: 1, ties: 1, avgBaseScore: 3.1, avgTunedScore: 8.4, judgeCostUsd: 0.25 },
    judgeModel: "muse-wonder-1.0",
    hub: null,
    ...over,
  } as unknown as TrainJobRow;
}

const evalEvents: TrainEventView[] = [
  { id: 1, type: "eval", payload: { type: "eval", index: 0, prompt: "Nut-free cupcakes?", reference: "On Fridays.", base: "Maybe.", tuned: "On Fridays, order ahead." }, at: new Date(t0).toISOString() },
  { id: 2, type: "judgement", payload: { type: "judgement", index: 0, baseScore: 3, tunedScore: 9, better: "tuned", note: "Gives the day." }, at: new Date(t0).toISOString() },
];

type Page = (props: { params?: Promise<Record<string, string>> }) => Promise<ReactNode>;
let render: (node: ReactNode) => string;
let renderC: (c: ComponentType<never>, props: object) => string;
let newPage: Page;
let runPage: Page;
let view: typeof import("@/lib/train/tune/view");
let roomPlan: typeof import("@/components/train/room/plan");
let composer: typeof import("@/components/train/compose/TrainComposer");

async function open(page: Page, params: Record<string, string> = {}): Promise<string> {
  return render(await page({ params: Promise.resolve(params) }));
}

async function fails(page: Page, params: Record<string, string> = {}): Promise<string> {
  try {
    await page({ params: Promise.resolve(params) });
  } catch (err) {
    return (err as Error).message;
  }
  return "rendered";
}

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, /203\.0\.113\.9|mm-train-/, "no instance details in the room");
}

describe("the new fine-tune pages", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    process.env.DATABASE_URL = "postgres://tune-pages.invalid/db";
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error(NOT_FOUND);
        },
        redirect: (to: string) => {
          throw new Error(`redirect ${to}`);
        },
        unstable_rethrow: (err: unknown) => {
          if (err instanceof Error && (err.message === NOT_FOUND || err.message.startsWith("redirect "))) throw err;
        },
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/fine-tuning/new",
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module("@/components/camera/CameraCapture", { namedExports: { CameraCapture: () => null, useCameraSupported: () => camera } });
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/train/tune/store.ts"), { namedExports: { loadTuneRun: async (id: string) => (id === DS ? run : null) } });
    mock.module(at("../../../app/fine-tuning/runs/live.ts"), {
      namedExports: {
        runLiveDemo: async (j: { id: string } | null) => {
          if (j) liveDemoAsked.push(j.id);
          return liveDemo;
        },
      },
    });
    const { renderToString } = await import("react-dom/server");
    render = (node) => renderToString(node as never).replace(/<!-- -->/g, "");
    renderC = (c, props) => render(createElement(c, props as never));
    newPage = (await import(at("../../../app/fine-tuning/new/page.tsx"))).default as Page;
    runPage = (await import(at("../../../app/fine-tuning/runs/[id]/page.tsx"))).default as Page;
    view = await import("@/lib/train/tune/view");
    roomPlan = await import("@/components/train/room/plan");
    composer = await import("@/components/train/compose/TrainComposer");
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    process.env.TUNE_COMPOSER = "1";
    delete process.env.TUNE_DEFAULT_EXAMPLES;
    viewer = admin;
    camera = false;
    liveDemo = null;
    liveDemoAsked.length = 0;
    run = view.tuneRunView({ dataset: dataset(), written: null, job: null, events: [] }, new Date(t0 + 30 * 60_000), { maxMinutes: 120, maxUsd: 5 });
  });

  describe("with TUNE_COMPOSER off", () => {
    it("are a 404 for admins and everyone else", async () => {
      process.env.TUNE_COMPOSER = "0";
      for (const v of [admin, guest, null]) {
        viewer = v;
        assert.equal(await fails(newPage), NOT_FOUND);
        assert.equal(await fails(runPage, { id: DS }), NOT_FOUND);
      }
    });
  });

  describe("with TUNE_COMPOSER on", () => {
    it("send non-admins to /fine-tuning, which shows them the read-only Lab", async () => {
      for (const v of [guest, null]) {
        viewer = v;
        assert.equal(await fails(newPage), "redirect /fine-tuning");
        assert.equal(await fails(runPage, { id: DS }), "redirect /fine-tuning");
      }
    });

    it("/fine-tuning/new is one box with the Make page's look, the Training setup and an honest cost line", async () => {
      const html = await open(newPage);
      clean(html);
      assert.match(html, /<div class="play tune-compose"><div class="play-main">/);
      assert.match(html, /<h1>What should your model do\?<\/h1>/);
      assert.match(html, /<form class="composer" aria-label="What your model should do">/);
      assert.match(html, /aria-label="Add examples" title="Add a CSV or JSONL of examples"/);
      assert.match(html, /accept="\.csv,\.jsonl,\.json,\.txt,\.tsv,/);
      assert.match(html, /aria-label="Plan it"/);
      assert.match(html, /<span class="examples-label">Try<\/span>[\s\S]*Bakery helper[\s\S]*Ticket sorter[\s\S]*Plant care coach/);
      assert.match(html, /Muse Wonder writes about 200 examples, Muse Glimmer 30B trains on one GPU, and the tuned model is\s+scored against the base\. About an hour, up to about \$12\.\d\d in all\s+\(the GPU is a hard limit; Meta&#x27;s part is an estimate\)\./);
      assert.match(html, /<span>Training setup<\/span>/);
      assert.match(html, /<dt>Training steps<\/dt><dd><span>120<\/span>/);
      assert.match(html, /<dt>Publish<\/dt><dd><span>Off<\/span>/);
      assert.doesNotMatch(html, /Take a photo|camera/i, "no camera for examples");
      process.env.TUNE_DEFAULT_EXAMPLES = "300";
      assert.match(await open(newPage), /writes about 300 examples/);
    });

    it("a waiting run's room has the plan card building and Ready to train, which opens the full form until U3", async () => {
      const html = await open(runPage, { id: DS });
      clean(html);
      assert.match(html, /<h1 class="chat-title-chip">A made-up bakery&#x27;s counter helper<\/h1>/);
      assert.match(html, /<p class="chat-bubble-text">Answer questions for a made-up bakery: hours and cakes\.<\/p>/, "the person's words, without the folded rows");
      assert.match(html, /<div class="plan-card" data-art="building">/);
      assert.match(html, /<h3>How it&#x27;s made<\/h3><ol><li>Muse Wonder writes 200 examples, and keeps 20 aside to score it\.<\/li>/);
      assert.match(html, /The examples and the scoring are estimates: what Muse Wonder costs per example hasn&#x27;t been measured yet\./);
      assert.match(html, new RegExp(`<div class="row-actions" data-u3="ready-to-train"><a class="btn btn-primary" href="/fine-tuning\\?dataset=${DS}#new-job">Ready to train`));
      assert.doesNotMatch(html, /class="room-working"/, "nothing runs while it waits on a person");
    });

    it("a run still writing shows the working step with its count and cost", async () => {
      run = view.tuneRunView({ dataset: dataset({ status: "generating", trainCount: 0, evalCount: 0, costUsd: 1.4, finishedAt: null }), written: 84, job: null, events: [] }, new Date(t0 + 10 * 60_000), { maxMinutes: 120, maxUsd: 5 });
      const html = await open(runPage, { id: DS });
      clean(html);
      assert.match(html, /<li class="room-working">[\s\S]*Writing examples[\s\S]*Muse Wonder has written 84 of 200\./);
      assert.match(html, /\$1\.40 so far/);
      assert.match(html, /aria-controls="tune-steps-panel">Show steps/);
      assert.doesNotMatch(html, /Ready to train/);
    });

    it("a scored run is ready with the pair, the verdict, the eval results and where it runs", async () => {
      run = view.tuneRunView({ dataset: dataset(), written: null, job: job(), events: evalEvents }, new Date(t0 + 90 * 60_000), { maxMinutes: 120, maxUsd: 5 });
      const html = await open(runPage, { id: DS });
      clean(html);
      assert.match(html, /<div class="plan-card" data-art="shield">/);
      assert.match(html, /Ready\. Tuned won 18 of 20 kept-aside prompts \(8\.4 vs 3\.1\)\./);
      assert.match(html, /id="eval-results"/);
      assert.match(html, new RegExp(`The GPU&#x27;s log and the job&#x27;s settings are on <a href="/fine-tuning/${JOB}">the job&#x27;s page</a>\\.`));
      assert.match(html, /id="hugging-face"/, "the Hugging Face card, as on the job's page");
      assert.match(html, /id="local-files"/);
      assert.deepEqual(liveDemoAsked, [JOB], "the page reads the job's live demo");
      assert.doesNotMatch(html, /id="live-demo"/, "none to show");
      assert.match(html, /Not on a Jetson Orin Nano\.<\/strong> Muse Glimmer 30B needs more memory than the board&#x27;s 8 GB\./);
      assert.match(html, /a small open model \(Qwen3\.5 0\.8B\) on the same\s+examples, on the board&#x27;s GPU\. It isn&#x27;t Muse Glimmer\./);
      assert.match(html, /href="\/device">Open the board/);
      assert.match(html, /\$5\.95 in all/);
      liveDemo = { kind: "start", adapterTitle: "a made-up bakery's counter helper", ceilings: { maxMinutes: 120, maxUsd: 5 }, maxActive: 1, dailyUsd: 20, blocked: null, publicPage: true };
      assert.match(await open(runPage, { id: DS }), /<section class="card section-card lab-try" id="live-demo"[\s\S]*Start a live demo/);
    });

    it("a failed run says why, presenting, with Start another", async () => {
      run = view.tuneRunView({ dataset: dataset({ status: "failed", error: "The platform's daily spend cap is reached, so the dataset stopped." }), written: null, job: null, events: [] }, new Date(t0 + 30 * 60_000), { maxMinutes: 120, maxUsd: 5 });
      const html = await open(runPage, { id: DS });
      clean(html);
      assert.match(html, /<div class="plan-card" data-art="present">/);
      assert.match(html, /This run didn&#x27;t finish\.[\s\S]*daily spend cap/);
      assert.match(html, /href="\/fine-tuning\/new"/);
    });

    it("an unknown run is a 404", async () => {
      assert.equal(await fails(runPage, { id: "1b2c3d4e-0000-4000-8000-0000000000ff" }), NOT_FOUND);
    });
  });

  describe("the pieces", () => {
    it("Composer takes its own words, accept list and file check, and drops the camera for them", async () => {
      const { Composer } = await import("@/components/composer/Composer");
      camera = true;
      const props = {
        mode: "new",
        signedIn: true,
        send: async () => null,
        accept: ".csv",
        acceptFile: () => ({ kind: "pdf" }),
        keepFilesLocal: true,
        copy: { form: "Form name", field: "Field label", attach: "Add rows", attachTitle: "Add a CSV", hint: "A hint.", send: "Plan it" },
      };
      const html = renderC(Composer as ComponentType<never>, props);
      assert.match(html, /<form class="composer" aria-label="Form name">/);
      assert.match(html, /class="sr-only">Field label<\/label>/);
      assert.match(html, /aria-label="Add rows" title="Add a CSV"/);
      assert.match(html, /accept="\.csv"/);
      assert.match(html, /class="composer-hint">A hint\.<\/p>/);
      assert.match(html, /aria-label="Plan it"/);
      assert.doesNotMatch(html, /Take a photo/);
      const build = renderC(Composer as ComponentType<never>, { mode: "new", signedIn: true });
      assert.match(build, /aria-haspopup|Attach inspo files/, "the muse box keeps its camera menu");
      // Each word left out keeps the muse box's, and the inspo types stay without `accept`.
      const some = renderC(Composer as ComponentType<never>, { mode: "new", signedIn: true, send: async () => null, copy: { send: "Plan it" } });
      assert.match(some, /<form class="composer" aria-label="Your muse">/);
      assert.match(some, /aria-label="Plan it"/);
      assert.match(some, /class="sr-only">Describe it, or drop in your inspo<\/label>/);
      assert.match(some, /accept="image\//);
      camera = false;
    });

    it("SetupPanel folds any page's facts under its own title and note", async () => {
      const { SetupPanel } = await import("@/components/composer/SetupPanel");
      const html = renderC(SetupPanel as ComponentType<never>, { title: "Training setup", rows: [["GPU", "1x A100", "A hint"]], note: "Set for every run." });
      assert.match(html, /<span>Training setup<\/span>/);
      assert.match(html, /<dt>GPU<\/dt><dd><span>1x A100<\/span><span class="setup-hint">A hint<\/span><\/dd>/);
      assert.match(html, /<p class="panel-note">Set for every run\.<\/p>/);
    });

    it("puts a training plan on the plan card: how it's made, a sample, and the cost with its estimates named", async () => {
      const { planCost, planSettings } = await import("@/lib/train/tune/cost");
      const settings = planSettings(200, { maxMinutes: 120, maxUsd: 5 });
      const pv = roomPlan.planViewFromTrainPlan({
        name: "a plant care coach",
        tagline: "Keeps houseplants alive.",
        samples: ["My fern is going brown, help?"],
        examples: { given: 24, used: 24 },
        settings,
        cost: planCost(settings),
      });
      assert.equal(pv.name, "A plant care coach");
      assert.equal(pv.sections[0]!.steps![0], "Muse Wonder writes 200 examples in the style of your 24, and keeps 20 aside to score it.");
      assert.equal(pv.sections[0]!.steps![2], "Muse Glimmer 30B trains on one GPU, about 45 minutes.");
      assert.equal(pv.sections[1]!.text, '"My fern is going brown, help?"');
      assert.match(pv.sections[2]!.text!, /hasn't been measured yet\. About an hour in all\.$/);
      assert.match(pv.sections[2]!.text!, /^Up to about \$12\.\d\d: examples \$3\.08 to \$6\.76, the GPU up to \$5\.00 \(a hard limit\), scoring \$0\.\d\d to \$0\.\d\d\. The examples and the scoring are estimates/);
      const { PlanViewCard } = await import("@/components/build/PlanCard");
      const html = renderC(PlanViewCard as ComponentType<never>, { view: pv, art: "present", running: false, actions: createElement("p", { className: "x" }, "Start") });
      assert.match(html, /<h2 class="plan-card-name"><span class="sr-only">The plan: <\/span>A plant care coach<\/h2>/);
      assert.match(html, /<h3>It might be asked<\/h3><p>&quot;My fern is going brown, help\?&quot;<\/p>/);
      assert.match(html, /<p class="x">Start<\/p><\/div><\/div>$/, "the actions end the summary");
      assert.equal(html.split("<img").length - 1, 1, "a card that won't change loads one picture");
    });

    it("says each refusal in a plain sentence", () => {
      const t = composer.tuneErrorText;
      assert.equal(t(422, { error: "refused", refusal: "Not this one." }), "Not this one.");
      assert.match(t(429, { error: "rate_limited", retryAfterSeconds: 1500 }), /20 plans this hour\. Try again in about 25 minutes\./);
      assert.match(t(400, { error: "plan_expired" }), /more than two hours old/);
      assert.match(t(403, { error: "plan_invalid" }), /changed after it was drafted/);
      assert.match(t(503, { error: "paused" }), /daily spend cap/);
      assert.match(t(403, { error: "Admins only." }), /Only admins/);
      assert.equal(t(400, { error: "Say what the model should do." }), "Say what the model should do.");
      assert.equal(t(413, { error: "body_too_large" }), "Those examples are too long to send. Use shorter rows or fewer of them.");
    });
  });
});
