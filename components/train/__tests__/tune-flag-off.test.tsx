/**
 * With TUNE_COMPOSER off nothing outside the new pages and routes changes (docs/TRAINING.md "Fine-tune like a build"):
 * the Make page's composer and build setup, the build room and its plan card on its own (each brief it can pass, so
 * PlanView keeps the card as it was) and /fine-tuning render byte for byte
 * as they did before the composer's props, SetupPanel's rows and PlanView were added. Each render's SHA-256 and length
 * were taken from the code before those edits (fixtures/tune-flag-off.json) and every render must match them, with the
 * flag off and on, since none of these read it but /fine-tuning, whose header gets New with the flag on (and nothing
 * else: with that taken out it matches too). The clock is frozen, so dates render the same. Made-up data only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/tune-flag-off.test.tsx
 *
 * TUNE_GOLDEN_WRITE=1 rewrites the fixture; run it only on code from before the edits it guards.
 * Without --experimental-test-module-mocks, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, describe, it, mock } from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
const FIXTURE = new URL("./fixtures/tune-flag-off.json", import.meta.url);
const FROZEN = Date.parse("2026-11-01T12:00:00.000Z");
const savedEnv = { ...process.env };

const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const DS = "1b2c3d4e-0000-4000-8000-000000000002";
const t0 = FROZEN - 3 * 3_600_000;

let viewer: SessionUser | null = null;
const jobRow = {
  id: JOB,
  recipe: "glimmer-lora",
  title: "Bakery LoRA",
  status: "succeeded",
  params: { datasetId: DS, maxSteps: 120, learningRate: 0.0002, loraRank: 16, dryRun: 0 },
  instanceType: "gpu_1x_a100_sxm4",
  region: "us-east-1",
  priceCentsPerHour: 129,
  maxMinutes: 90,
  maxUsd: 5,
  instanceId: null,
  instanceIp: null,
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
  createdAt: new Date(t0),
  launchedAt: new Date(t0 + 60_000),
  firstHeartbeatAt: null,
  lastHeartbeatAt: new Date(t0 + 40 * 60_000),
  finishedAt: new Date(t0 + 44 * 60_000),
  terminatedAt: new Date(t0 + 45 * 60_000),
  evalSummary: { items: 20, tunedWins: 18, baseWins: 1, ties: 1, avgBaseScore: 3.1, avgTunedScore: 8.4, judgeCostUsd: 0.25 },
  judgeModel: "muse-wonder-1.0",
  hub: null,
};
const datasetRow = {
  id: DS,
  title: "a made-up bakery's counter helper",
  task: "Answer questions for a made-up bakery.",
  status: "ready",
  requested: 200,
  trainCount: 180,
  evalCount: 20,
  costUsd: 4.2,
  error: null,
  createdBy: null,
  workflowRunId: null,
  createdAt: new Date(t0 - 3_600_000),
  finishedAt: new Date(t0 - 3_000_000),
  writerModel: "muse-wonder-1.0",
};

const fakeStore = {
  listResultJobs: async () => [jobRow],
  getResultJob: async () => jobRow,
  listResultEvents: async () => [],
  listReadyDatasets: async () => [datasetRow],
  getReadyDataset: async () => datasetRow,
  datasetPage: async () => ({ status: "ready", total: 0, items: [] }),
  getLiveDemo: async () => null,
  getAdapterSource: async () => null,
  listAdapterOptions: async () => [],
  latestQuantSource: async () => null,
  getJob: async () => jobRow,
  listEvents: async () => [],
  getDataset: async () => datasetRow,
  listJobs: async () => [jobRow],
  listDatasets: async () => [datasetRow],
  datasetProgress: async () => null,
  activeJobCount: async () => 0,
  trainingSpendToday: async () => 0,
  lastSweepOkAt: async () => null,
  verifyJobToken: async () => false,
};

type Page = (props: { searchParams?: Promise<Record<string, string>> }) => Promise<ReactNode>;
let render: (c: ComponentType<never>, props: object) => string;
let renderNode: (node: ReactNode) => string;
let renders: Array<[string, () => Promise<string>]> = [];

const sha = (html: string) => ({ sha256: createHash("sha256").update(html).digest("hex"), length: html.length });

describe("with TUNE_COMPOSER off", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.timers.enable({ apis: ["Date"], now: FROZEN });
    process.env.DATABASE_URL = "postgres://tune-flag-off.invalid/db";
    delete process.env.MODEL_API_KEY;
    delete process.env.CRON_SECRET;
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
        },
        redirect: (to: string) => {
          throw new Error(`redirect ${to}`);
        },
        unstable_rethrow: () => {},
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/",
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module("@/components/camera/CameraCapture", { namedExports: { CameraCapture: () => null, useCameraSupported: () => false } });
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/train/store.ts"), { namedExports: fakeStore });

    const { renderToString } = await import("react-dom/server");
    render = (c, props) => renderToString(createElement(c, props as never));
    renderNode = (node) => renderToString(node as never);
    const { Composer } = await import("@/components/composer/Composer");
    const { SetupPanel } = await import("@/components/composer/SetupPanel");
    const { BuildRoom } = await import("@/components/build/BuildRoom");
    const { PlanCard } = await import("@/components/build/PlanCard");
    const { FIXTURES, brief, inspiration, tokens } = await import("@/components/build/__tests__/room-fixture");
    const listPage = (await import("@/app/fine-tuning/page")).default as unknown as Page;

    const examples = [{ label: "Receipt to spreadsheet", note: "Pull the items out of a receipt photo.", tag: "Photo", text: "Receipt to CSV.", image: "/examples/receipt.jpg" }];
    const room = (name: keyof typeof FIXTURES) => {
      const f = FIXTURES[name];
      return render(BuildRoom as ComponentType<never>, {
        build: f.build,
        product: f.product,
        inspiration,
        events: f.events,
        history: [],
        tokens,
        canRefine: name === "finished",
        canSteer: false,
        signedIn: true,
        origin: "https://musemuse.example",
        serverNow: Date.parse(f.build.startedAt) + 60_000,
        focusRefine: false,
        rebuild: null,
        maxFixRounds: 3,
      });
    };
    renders = [
      ["composer: Make page", async () => render(Composer as ComponentType<never>, { mode: "new", signedIn: true, examples, layout: "playground", targetOptions: ["phone"] })],
      ["composer: signed out", async () => render(Composer as ComponentType<never>, { mode: "new", signedIn: false, examples, layout: "playground" })],
      ["composer: refine", async () => render(Composer as ComponentType<never>, { mode: "refine", buildId: "b1", signedIn: true, floating: true })],
      ["composer: docs", async () => render(Composer as ComponentType<never>, { mode: "new", signedIn: true, examples, context: "From the docs.", blankNote: "Make a demo.", draftId: "docs" })],
      ["setup panel", async () => render(SetupPanel as ComponentType<never>, { facts: { buildModel: "muse-wonder-1.0", maxFixRounds: 3, publishOff: null } })],
      ["setup panel: publish off", async () => render(SetupPanel as ComponentType<never>, { facts: { buildModel: "muse-wonder-1.0", maxFixRounds: 3, publishOff: "VERCEL_TOKEN isn't set" } })],
      ["build room: running", async () => room("running")],
      ["build room: failed", async () => room("failed")],
      ["build room: finished", async () => room("finished")],
      // The plan card alone, now drawn from a PlanView (planViewFromBrief): each brief the build room can pass.
      ["plan card: part of it, running, with the brief link", async () => render(PlanCard as ComponentType<never>, { brief, art: "building", running: true, panelId: "steps", onReadBrief() {} })],
      ["plan card: all of it, finished", async () => render(PlanCard as ComponentType<never>, { brief: { ...brief, verdict: "yes" }, art: "shield", running: false })],
      ["plan card: no one it's for", async () => render(PlanCard as ComponentType<never>, { brief: { ...brief, user: " " }, art: "present", running: true, onReadBrief() {} })],
      ["plan card: no steps or tagline", async () => render(PlanCard as ComponentType<never>, { brief: { ...brief, verdict: "yes", tagline: "", primaryFlow: [" "] }, art: "present", running: false })],
      [
        "/fine-tuning: admin",
        async () => {
          viewer = { id: "u-admin", email: "owner@example.com", isAdmin: true };
          return renderNode(await listPage({ searchParams: Promise.resolve({}) }));
        },
      ],
      [
        "/fine-tuning: guest",
        async () => {
          viewer = { id: "u-guest", email: "guest@open-access.invalid", isAdmin: false, openAccess: true };
          return renderNode(await listPage({ searchParams: Promise.resolve({}) }));
        },
      ],
    ];
  });

  after(() => {
    mock.timers.reset();
    mock.restoreAll();
    process.env = savedEnv;
  });

  it("renders the build composer, the build setup, the build room and /fine-tuning exactly as before, flag off and on", async () => {
    delete process.env.TUNE_COMPOSER;
    const off: Record<string, { sha256: string; length: number }> = {};
    const html: Record<string, string> = {};
    for (const [name, fn] of renders) off[name] = sha((html[name] = await fn()));
    // Real pages, not error cards: what the hashes stand for.
    assert.match(html["/fine-tuning: admin"]!, /New job[\s\S]*New dataset/);
    assert.match(html["/fine-tuning: guest"]!, /Lab results/);
    assert.match(html["build room: running"]!, /class="plan-card" data-art="building"/);
    assert.match(html["composer: Make page"]!, /aria-label="Make it"/);
    if (process.env.TUNE_GOLDEN_WRITE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(off, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof off;
    assert.deepEqual(Object.keys(off), Object.keys(golden));
    for (const name of Object.keys(golden)) assert.deepEqual(off[name], golden[name], `${name} changed with the flag off`);
    process.env.TUNE_COMPOSER = "1";
    for (const [name, fn] of renders) {
      let page = await fn();
      if (name === "/fine-tuning: admin") {
        // The one thing the flag adds to the lab page: the header's New, the primary button, before New dataset (with
        // New job an outline button beside it). Without those it is the page as it was.
        const added = /<a class="btn btn-primary" href="\/fine-tuning\/new">[\s\S]*?New<\/a>/;
        assert.match(page, added, "the header has New with the flag on");
        assert.ok(page.indexOf('href="/fine-tuning/new"') < page.indexOf('href="#new-dataset"'), "New comes first");
        page = page.replace(added, "").replace('class="btn btn-outline" href="#new-job"', 'class="btn btn-primary" href="#new-job"');
      }
      assert.deepEqual(sha(page), golden[name], `${name} reads the flag`);
    }
  });
});
