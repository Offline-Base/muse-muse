import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { RecipeView, TrainEventView, TrainJobView } from "@/lib/train/types";

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

  it("asks non-admins to sign in", () => {
    const html = render(AdminsOnly, { signedIn: false });
    assert.match(html, /Admins only/);
    assert.match(html, /href="\/sign-in\?next=%2Ffine-tuning"/);
    assert.doesNotMatch(render(AdminsOnly, { signedIn: true }), /Sign in/);
  });
});
