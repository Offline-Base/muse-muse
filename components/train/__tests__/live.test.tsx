/**
 * The live demo's UI (docs/TRAINING.md "Live demo"), server-rendered with sample data outside Next: the Try it live box
 * in each state, the answers as plain text, Start a live demo, the adapter select in the New job card, and a serve
 * job's page. The router and Link are stand-ins. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/live.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { AdapterOption, EvalSummary, RecipeView, TrainJobView } from "@/lib/train/types";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-10-27T14:00:00.000Z");
const iso = (ms: number) => new Date(t0 + ms).toISOString();
const ADAPTER = "8f1d2c3b-0000-4000-8000-000000000001";
const SERVE = "5e7e5e7e-0000-4000-8000-00000000000a";
const won: EvalSummary = { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 };
const ceilings = { maxMinutes: 120, maxUsd: 5 };

let render: (c: ComponentType<never>, props: object) => string;
let recipes: RecipeView[];
let TryLiveCard: ComponentType<never>;
let LiveAnswers: ComponentType<never>;
let StartLiveDemo: ComponentType<never>;
let NewJobCard: ComponentType<never>;
let JobRoom: ComponentType<never>;
let JobResults: ComponentType<never>;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  const { toRecipeView } = await import("@/components/train/format");
  const { RECIPES } = await import("@/lib/train/recipes");
  recipes = RECIPES.map(toRecipeView);
  const live = await import("@/components/train/LiveDemo");
  TryLiveCard = live.TryLiveCard as ComponentType<never>;
  LiveAnswers = live.LiveAnswers as ComponentType<never>;
  StartLiveDemo = live.StartLiveDemo as ComponentType<never>;
  NewJobCard = (await import("@/components/train/NewJobCard")).NewJobCard as ComponentType<never>;
  JobRoom = (await import("@/components/train/JobRoom")).JobRoom as ComponentType<never>;
  JobResults = (await import("@/components/train/JobResults")).JobResults as ComponentType<never>;
});

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, /\/api\/train|5e7e5e7e|8443|serveKey|certSha256|203\.0\.113\.9/, "nothing about the GPU");
}

const serveRecipe = () => recipes.find((r) => r.id === "glimmer-serve")!;
const loraRecipe = () => recipes.find((r) => r.id === "glimmer-lora")!;

describe("Try it live", () => {
  const card = (demo: object, extra: object = {}) =>
    render(TryLiveCard, { adapterJobId: ADAPTER, demo, serverNow: t0, ...extra });

  it("opens the box while the demo is live, with the time left", () => {
    const html = card({ state: "live", minutes: 30, endsAt: iso(23 * 60_000 + 10_000) });
    clean(html);
    assert.match(html, /<section class="card section-card lab-try" id="try-live" aria-labelledby="[^"]+">/);
    assert.match(html, /<h2 id="[^"]+">Try it live<\/h2>/);
    assert.match(html, /class="pill pill-live"><span class="pill-dot" aria-hidden="true"><\/span>Live<\/span>/);
    assert.match(html, /<span class="muted small lab-try-left">23 minutes left<\/span>/);
    assert.match(html, /Muse Glimmer 30B with 2026 knowledge answers it twice on the same GPU, once on its own and once with this job&#x27;s adapter/);
    assert.match(html, /<strong>Built with Muse Spark Open\.<\/strong> For people 18 and over only\./, "the demo runs r30b, a Derivative of Muse Spark Open");
    assert.match(html, /<label class="train-label" for="([^"]+)">Your app idea<\/label><textarea id="\1"/);
    assert.match(html, /maxLength="600"/);
    assert.match(html, /placeholder="A menu board for my bakery that updates from a photo of today&#x27;s chalkboard, with prices and allergens\."/);
    assert.match(html, /0 \/ 600/);
    // The button waits for an idea; the form posts by fetch, never to an action URL.
    assert.match(html, /<button type="submit" class="btn btn-primary" disabled="">.*Ask both models/);
    assert.doesNotMatch(html, /action=|method=/);
    assert.doesNotMatch(html, /<textarea[^>]*disabled/);
    assert.doesNotMatch(html, /Open the demo/, "no serve job link on the public page");
  });

  it("holds Ask while the demo starts, and says how long the model takes to load", () => {
    const html = card({ state: "starting", minutes: 45, endsAt: iso(60 * 60_000) });
    clean(html);
    assert.match(html, /class="pill pill-building">.*Starting<\/span>/);
    assert.match(html, /A live demo is starting\. The GPU boots and loads the model, which takes up to about 15 minutes, then this box opens for 45 minutes\./);
    assert.match(html, /<button type="submit" class="btn btn-primary" disabled="">/);
    assert.doesNotMatch(html, /minutes left/, "no countdown before it serves");
    assert.doesNotMatch(html, /<textarea[^>]*disabled/, "an idea can be typed while it starts");
  });

  it("closes once the demo's time is up", () => {
    const html = card({ state: "live", minutes: 30, endsAt: iso(-1_000) });
    clean(html);
    assert.match(html, /class="pill pill-neutral">.*Ended<\/span>/);
    assert.match(html, /This live demo has ended, and its GPU shuts down like every other job&#x27;s\./);
    assert.match(html, /<textarea[^>]*disabled=""/);
    assert.match(html, /<button type="submit" class="btn btn-primary" disabled="">/);
  });

  it("links an admin to the serve job", () => {
    const html = card({ state: "live", minutes: 30, endsAt: iso(600_000) }, { serveJobId: SERVE });
    assert.match(html, /<a href="\/fine-tuning\/5e7e5e7e-0000-4000-8000-00000000000a">Open the demo&#x27;s job<\/a> for its GPU, log and Stop\./);
  });

  it("shows both answers side by side as Markdown without markup or links, labeled Base and Tuned Glimmer", () => {
    const html = render(LiveAnswers, {
      idBase: "t",
      answer: {
        prompt: "<script>alert(1)</script> a bakery app",
        base: "[click](javascript:alert(1))\nI can't see any photo.",
        tuned: '<a href="https://evil.example">brief</a>\n## Models\n- Muse Spark 1.3',
        ms: 41_200,
      },
    });
    assert.match(html, /<h3 class="train-role">Your idea<\/h3><p class="train-text">&lt;script&gt;alert\(1\)&lt;\/script&gt; a bakery app<\/p>/);
    assert.match(
      html,
      /<section class="lab-try-answer" aria-labelledby="t-base"><h3 class="train-role" id="t-base">2026 Glimmer \(r30b\)<\/h3><div class="md train-text"><p><span>click<\/span><br\/>I can&#x27;t see any photo\.<\/p><\/div>/,
    );
    assert.match(
      html,
      /<section class="lab-try-answer lab-try-tuned" aria-labelledby="t-tuned"><h3 class="train-role" id="t-tuned">Tuned Glimmer<\/h3><div class="md train-text">.*&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;brief&lt;\/a&gt;/s,
    );
    assert.ok(html.indexOf("Base Glimmer") < html.indexOf("Tuned Glimmer"), "base on the left");
    assert.match(html, /Both answered in 41\.2 s on the demo&#x27;s GPU\./);
    assert.doesNotMatch(html, /<script|<a |<img/);
    const empty = render(LiveAnswers, { idBase: "e", answer: { prompt: "x", base: "  ", tuned: "t", ms: 0 } });
    assert.match(empty, /<p class="train-text muted">\(empty\)<\/p>/);
  });

  it("comes first on the public result page while a demo runs, and isn't there otherwise", () => {
    const result = {
      id: ADAPTER,
      title: "Brief writer",
      recipe: "glimmer-lora",
      recipeTitle: "Muse Glimmer LoRA",
      model: "Muse Glimmer 30B",
      gpu: "1x A100 SXM4 (40 GB)",
      gpuMinutes: 42,
      costUsd: 1.39,
      finishedAt: iso(0),
      summary: won,
      settings: [],
      datasetId: null,
    };
    const live = render(JobResults, { result, rows: [], dataset: null, live: { state: "live", minutes: 30, endsAt: iso(600_000) }, serverNow: t0 });
    clean(live);
    assert.ok(live.indexOf("Try it live") > 0 && live.indexOf("Try it live") < live.indexOf("The run"));
    const none = render(JobResults, { result, rows: [], dataset: null });
    assert.doesNotMatch(none, /Try it live|<form|<textarea/);
  });
});

describe("Start a live demo", () => {
  const props = { adapterJobId: ADAPTER, adapterTitle: "Brief writer", ceilings, maxActive: 1, dailyUsd: 20 };

  it("offers minutes that fit the ceilings, starting at 30, with the limits the job gets", () => {
    const html = render(StartLiveDemo, props);
    clean(html);
    assert.match(html, /<h2 id="[^"]+">Live demo<\/h2>/);
    assert.match(html, /Anyone with this page&#x27;s link can then type an app idea and see base and tuned Glimmer answer it side by side, with no sign-in\./);
    assert.match(html, /<label class="train-label" for="([^"]+)">Minutes live<\/label><select id="\1"/);
    for (const m of [10, 15, 20, 45, 60, 90]) assert.match(html, new RegExp(`<option value="${m}">${m} minutes</option>`));
    assert.match(html, /<option value="30" selected="">30 minutes<\/option>/);
    assert.match(html, /<option value="120" disabled="">120 minutes \(needs 135, over the 120-minute ceiling\)<\/option>/);
    assert.match(html, /The job stops at 45 minutes or \$3\.29, whichever comes first: about 15 to boot and load the model, then 30 live\./);
    assert.match(html, /<button type="submit" class="btn btn-primary" aria-describedby="[^"]+">.*Start a live demo<\/span><\/button>/);
    assert.doesNotMatch(html, /train-callout-warn/);
  });

  it("is held, with the reason, when the jobs route would refuse", () => {
    const html = render(StartLiveDemo, { ...props, blocked: "CRON_SECRET isn't set on this deployment." });
    assert.match(html, /callout train-callout-warn[^>]*>.*CRON_SECRET isn&#x27;t set/);
    assert.match(html, /<button type="submit" class="btn btn-primary" disabled=""/);
  });

  it("says only admins can try a demo of a job that isn't judged", () => {
    const html = render(StartLiveDemo, { ...props, publicPage: false });
    assert.match(html, /This job isn&#x27;t judged yet, so its public result page doesn&#x27;t exist and only admins can try the demo here\./);
  });

  it("starts at the longest choice that fits when 30 doesn't, and says when none does", () => {
    const tight = render(StartLiveDemo, { ...props, ceilings: { maxMinutes: 40, maxUsd: 5 } });
    assert.match(tight, /<option value="20" selected="">20 minutes<\/option>/);
    assert.match(tight, /<option value="30" disabled="">30 minutes \(needs 45, over the 40-minute ceiling\)<\/option>/);
    const none = render(StartLiveDemo, { ...props, ceilings: { maxMinutes: 20, maxUsd: 5 } });
    assert.match(none, /The 20-minute time ceiling leaves no room for a demo: even 10 minutes live needs 25\./);
    assert.match(none, /<button type="submit" class="btn btn-primary" disabled=""/);
  });
});

describe("New job card with glimmer-serve", () => {
  const adapters: AdapterOption[] = [
    { jobId: ADAPTER, title: "Brief writer", region: "us-east-1", datasetTitle: "Muse Muse brief writer", finishedAt: iso(0), evalSummary: won },
    { jobId: "8f1d2c3b-0000-4000-8000-000000000002", title: "First run", region: "us-west-1", datasetTitle: null, finishedAt: null, evalSummary: null },
  ];
  const card = (extra: object = {}) =>
    render(NewJobCard, {
      recipes: [serveRecipe(), loraRecipe()],
      ceilings,
      maxActive: 1,
      dailyUsd: 20,
      platformPublic: true,
      adapters,
      ...extra,
    });

  it("lists the trained adapters, pins Auto to the first one's region, and sizes the limits from the minutes", () => {
    const html = card();
    assert.match(html, /<label class="train-label" for="([^"]+)">Adapter<\/label><select id="\1" class="train-select" required=""/);
    assert.match(html, /<option value="8f1d2c3b-0000-4000-8000-000000000001" selected="">Brief writer · tuned won 40 of 40 · Oct 27 · us-east-1 · Muse Muse brief writer<\/option>/);
    assert.match(html, /<option value="8f1d2c3b-0000-4000-8000-000000000002">First run · us-west-1<\/option>/);
    assert.match(html, /Minutes live/);
    assert.match(html, /<option value="" selected="">Auto: a free GPU in us-east-1, with the adapter<\/option>/);
    assert.match(html, /id="[^"]+-minutes"[^>]*value="45"/);
    assert.match(html, /id="[^"]+-dollars"[^>]*value="3\.29"/);
    assert.match(html, /This recipe starts at 45 minutes and \$3\.29/);
    assert.doesNotMatch(html, /<button type="submit"[^>]*disabled/);
  });

  it("is held when no adapter can be served, or the adapters couldn't load", () => {
    const none = card({ adapters: [] });
    assert.match(none, /<option value="" selected="">No trained adapter yet<\/option>/);
    assert.match(none, /This recipe serves a trained adapter, and none is on a model cache yet\. Train one with Muse Glimmer LoRA first\./);
    assert.match(none, /<button type="submit"[^>]*disabled/);
    const failed = card({ adapters: null });
    assert.match(failed, /Couldn&#x27;t load the trained adapters/);
  });
});

describe("serve job page", () => {
  const job: TrainJobView = {
    id: SERVE,
    recipe: "glimmer-serve",
    title: "Live demo: Brief writer",
    status: "running",
    params: { adapterJobId: ADAPTER, minutes: 30 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 129,
    maxMinutes: 45,
    maxUsd: 3.29,
    instanceId: "0123456789abcdef",
    instanceIp: "198.51.100.7",
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0.1,
    createdAt: iso(-60_000),
    launchedAt: iso(0),
    lastHeartbeatAt: iso(600_000),
    finishedAt: null,
    terminatedAt: null,
    evalSummary: null,
    serving: { startedAt: iso(9 * 60_000), endsAt: iso(39 * 60_000) },
  };
  const page = (patch: Partial<TrainJobView> = {}) =>
    render(JobRoom, {
      job: { ...job, ...patch },
      events: [],
      recipe: serveRecipe(),
      adapter: { id: ADAPTER, title: "Brief writer" },
      serverNow: t0 + 14 * 60_000,
    });

  it("shows the demo's state in the panel, with the adapter it serves", () => {
    const html = page();
    assert.match(html, /Serving the live demo/);
    assert.match(html, /<h3 class="panel-label" id="[^"]+">Live demo<\/h3><p class="panel-note">Serving since 14:09 UTC, until about 14:39 UTC \(25 minutes left\)\.<\/p>/);
    assert.match(html, /The Try it live box is on <a href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001">Brief writer<\/a>&#x27;s page\./);
    assert.match(html, /<dt>Adapter<\/dt><dd><a href="\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001">Brief writer<\/a><\/dd>/);
    assert.match(html, /<dt>Minutes live<\/dt><dd>30<\/dd>/);
  });

  it("says the model is loading before the server is up, and what it served once it ended", () => {
    assert.match(page({ serving: null }), /Loading the model for the live demo/);
    assert.match(page({ serving: null }), /Not serving yet\. The GPU boots, mounts the model cache and loads the model/);
    const ended = page({ status: "succeeded", finishedAt: iso(39 * 60_000), terminatedAt: iso(40 * 60_000), summary: "Served 12 ideas." });
    assert.match(ended, /Served from 14:09 to 14:39 UTC\./);
    assert.doesNotMatch(ended, /Try it live box is on/);
  });

  it("puts Start a live demo on a trained adapter's admin page, and the box once one runs", () => {
    const lora: TrainJobView = { ...job, id: ADAPTER, recipe: "glimmer-lora", title: "Brief writer", status: "succeeded", params: {}, serving: undefined, finishedAt: iso(0), terminatedAt: iso(60_000), evalSummary: won };
    const start = render(JobRoom, {
      job: lora,
      events: [],
      recipe: loraRecipe(),
      liveDemo: { kind: "start", adapterTitle: "Brief writer", ceilings, maxActive: 1, dailyUsd: 20, blocked: null, publicPage: true },
      serverNow: t0,
    });
    assert.match(start, /Start a live demo/);
    assert.doesNotMatch(start, /Try it live/);
    const running = render(JobRoom, {
      job: lora,
      events: [],
      recipe: loraRecipe(),
      liveDemo: { kind: "demo", demo: { serveJobId: SERVE, state: "live", minutes: 30, endsAt: iso(30 * 60_000) } },
      serverNow: t0,
    });
    assert.match(running, /Try it live/);
    assert.match(running, /href="\/fine-tuning\/5e7e5e7e-0000-4000-8000-00000000000a"/);
    assert.doesNotMatch(running, /Start a live demo/);
    assert.doesNotMatch(render(JobRoom, { job: lora, events: [], recipe: loraRecipe(), serverNow: t0 }), /Live demo|Try it live/);
  });
});
