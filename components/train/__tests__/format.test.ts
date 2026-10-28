import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOT_PUBLIC_TEXT,
  artifactHref,
  autoGpu,
  clockUtc,
  doneMetrics,
  errorHeadline,
  eventLine,
  gpuErrorText,
  gpuName,
  gpuRowText,
  gpuRows,
  groupEvents,
  isSettled,
  jobElapsedMs,
  limitBounds,
  liveCostUsd,
  maxCostUsd,
  mergeEvents,
  pricePerHour,
  progressText,
  safeHref,
  startErrorText,
  stopControl,
  stopErrorText,
  sweepOffText,
  toRecipeView,
  trainStatusLabel,
  trainTone,
} from "@/components/train/format";
import type { GpuOption, Recipe, TrainEventBody, TrainEventView, TrainJobView } from "@/lib/train/types";

const recipe: Recipe = {
  id: "smoke",
  title: "Smoke test",
  description: "Checks the loop.",
  gpus: [
    { instanceType: "gpu_1x_a10", label: "1x A10 (24 GB)" },
    { instanceType: "gpu_1x_a6000", label: "1x A6000 (48 GB)" },
    { instanceType: "gpu_1x_a100", label: "1x A100 (40 GB)" },
  ],
  defaultMaxMinutes: 30,
  defaultMaxUsd: 1,
  params: [],
  script: "def run(ctx):\n    return {}\n",
};

const opt = (instanceType: string, priceCentsPerHour: number, regions: string[], description = ""): GpuOption => ({
  instanceType,
  description,
  priceCentsPerHour,
  regions,
  recipes: ["smoke"],
});

const ev = (id: number, payload: TrainEventBody, at = "2026-10-27T14:05:12.000Z"): TrainEventView => ({
  id,
  type: payload.type,
  payload,
  at,
});

const LIMITS = { maxActive: 1, dailyUsd: 20 };
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const t0 = Date.parse("2026-10-27T14:00:00.000Z");

function job(patch: Partial<TrainJobView> = {}): TrainJobView {
  return {
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
    instanceId: "inst-1",
    instanceIp: null,
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0,
    createdAt: new Date(t0 - 60_000).toISOString(),
    launchedAt: new Date(t0).toISOString(),
    lastHeartbeatAt: null,
    finishedAt: null,
    terminatedAt: null,
    ...patch,
  };
}

describe("status", () => {
  it("labels every status and says Stopping while a stop is pending", () => {
    assert.equal(trainStatusLabel("booting"), "Booting");
    assert.equal(trainStatusLabel("running", true), "Stopping");
    assert.equal(trainStatusLabel("stopped", true), "Stopped");
    assert.equal(trainStatusLabel("succeeded", true), "Succeeded");
  });

  it("colors the pill green, red, grey or blue", () => {
    assert.equal(trainTone("succeeded"), "live");
    assert.equal(trainTone("failed"), "failed");
    assert.equal(trainTone("stopped"), "neutral");
    for (const s of ["queued", "launching", "booting", "running"] as const) assert.equal(trainTone(s), "building");
  });
});

describe("recipes and limits", () => {
  it("drops the script from the recipe view", () => {
    const v = toRecipeView(recipe);
    assert.equal("script" in v, false);
    assert.equal(v.title, "Smoke test");
    assert.deepEqual(v.gpus, recipe.gpus);
  });

  it("starts the limits at the lower of the recipe defaults and the ceilings", () => {
    assert.deepEqual(limitBounds(recipe, { maxMinutes: 120, maxUsd: 5 }), { maxMinutes: 30, maxUsd: 1 });
    assert.deepEqual(limitBounds(recipe, { maxMinutes: 20, maxUsd: 0.5 }), { maxMinutes: 20, maxUsd: 0.5 });
    assert.deepEqual(limitBounds({ defaultMaxMinutes: 12.9, defaultMaxUsd: 1.159 }, { maxMinutes: 120, maxUsd: 5 }), {
      maxMinutes: 12,
      maxUsd: 1.15,
    });
    assert.deepEqual(limitBounds(recipe, { maxMinutes: 0, maxUsd: 0 }), { maxMinutes: 1, maxUsd: 0.1 });
  });

  it("estimates the most a job can cost: time at the price, capped by the dollar limit", () => {
    assert.equal(maxCostUsd(75, { maxMinutes: 30, maxUsd: 1 }), 0.38);
    assert.equal(maxCostUsd(199, { maxMinutes: 60, maxUsd: 1 }), 1);
    assert.equal(maxCostUsd(60, { maxMinutes: 30, maxUsd: 5 }), 0.3);
    assert.equal(maxCostUsd(0, { maxMinutes: 30, maxUsd: 1 }), 0);
  });

  it("formats an hourly price", () => {
    assert.equal(pricePerHour(75), "$0.75/h");
    assert.equal(pricePerHour(199), "$1.99/h");
  });
});

describe("GPU select", () => {
  const options = [
    opt("gpu_1x_a100", 129, ["us-east-1"]),
    opt("gpu_1x_a10", 75, [], "1x A10 (24 GB PCIe)"),
    opt("gpu_8x_h100", 3192, ["us-west-1"]),
  ];

  it("keeps the recipe's order, prefers Lambda's description and marks GPUs with no capacity", () => {
    const rows = gpuRows(recipe, options);
    assert.deepEqual(
      rows.map((r) => [r.instanceType, r.label, r.priceCentsPerHour, r.free]),
      [
        ["gpu_1x_a10", "1x A10 (24 GB PCIe)", 75, false],
        ["gpu_1x_a6000", "1x A6000 (48 GB)", null, false],
        ["gpu_1x_a100", "1x A100 (40 GB)", 129, true],
      ],
    );
    assert.equal(gpuRowText(rows[0]), "1x A10 (24 GB PCIe) · $0.75/h · no capacity");
    assert.equal(gpuRowText(rows[1]), "1x A6000 (48 GB) · not offered");
    assert.equal(gpuRowText(rows[2]), "1x A100 (40 GB) · $1.29/h");
  });

  it("treats a type the route lists at price 0 as not offered", () => {
    const rows = gpuRows(recipe, [opt("gpu_1x_a10", 0, [], "1x A10 (24 GB)"), opt("gpu_1x_a100", 129, ["us-east-1"])]);
    assert.equal(rows[0].priceCentsPerHour, null);
    assert.equal(rows[0].free, false);
    assert.equal(gpuRowText(rows[0]), "1x A10 (24 GB) · not offered");
    assert.equal(autoGpu(rows)?.instanceType, "gpu_1x_a100");
  });

  it("auto picks the first free GPU in the recipe's order, or nothing", () => {
    assert.equal(autoGpu(gpuRows(recipe, options))?.instanceType, "gpu_1x_a100");
    assert.equal(autoGpu(gpuRows(recipe, [opt("gpu_1x_a10", 75, [])])), null);
  });

  it("names a job's GPU by the recipe's label", () => {
    assert.equal(gpuName(recipe, "gpu_1x_a6000"), "1x A6000 (48 GB)");
    assert.equal(gpuName(recipe, "gpu_2x_a100"), "gpu_2x_a100");
    assert.equal(gpuName(null, "gpu_1x_a10"), "gpu_1x_a10");
  });
});

describe("error sentences", () => {
  it("turns each start refusal into a plain sentence", () => {
    assert.match(startErrorText(409, { error: "too_many_active" }, LIMITS), /only 1 job can hold one at a time/);
    assert.match(startErrorText(503, { error: "no_capacity", options: [] }, LIMITS), /no free GPU/);
    assert.match(startErrorText(503, { error: "daily_cap" }, LIMITS), /\$20\.00 daily cap/);
    assert.equal(startErrorText(503, { error: "platform_not_public" }, LIMITS), NOT_PUBLIC_TEXT);
    assert.match(startErrorText(503, { error: "lambda_not_configured" }, LIMITS), /LAMBDA_API_KEY/);
    assert.match(startErrorText(503, { code: "daily_cap", error: "Daily cap reached" }, LIMITS), /daily cap/);
    assert.match(startErrorText(503, { error: "sweep_not_configured", reason: "cron_secret_unset" }, LIMITS), /CRON_SECRET/);
    assert.match(startErrorText(503, { error: "sweep_not_configured", reason: "not_production" }, LIMITS), /production site/);
    assert.match(startErrorText(503, { error: "sweep_not_configured" }, LIMITS), /5-minute check/);
    assert.match(startErrorText(503, { error: "sweep_not_running", lastSweepAt: null }, LIMITS), /hasn't run in the last 15 minutes/);
  });

  it("uses the route's extras over the page's own limits", () => {
    assert.match(startErrorText(409, { error: "too_many_active", max: 2 }, LIMITS), /only 2 jobs can hold one/);
    assert.equal(
      startErrorText(503, { error: "daily_cap", spentUsd: 19.5, dailyUsd: 20, jobMaxUsd: 1 }, LIMITS),
      "Training has spent $19.50 of the $20.00 daily cap today, and this job's dollar limit would pass it. Lower the " +
        "dollar limit, or start it after midnight UTC.",
    );
    assert.equal(
      startErrorText(503, { error: "daily_cap", spentUsd: 3, committedUsd: 18, dailyUsd: 20, jobMaxUsd: 5 }, LIMITS),
      "Training has spent $3.00 of the $20.00 daily cap today, jobs still running could bring that to $18.00, and this " +
        "job's dollar limit would pass it. Lower the dollar limit, or start it after midnight UTC.",
    );
    assert.doesNotMatch(
      startErrorText(503, { error: "daily_cap", spentUsd: 19.5, committedUsd: 19.5, dailyUsd: 20 }, LIMITS),
      /still running/,
    );
    assert.match(startErrorText(502, { error: "lambda_unavailable" }, LIMITS), /Lambda didn't answer/);
    assert.match(startErrorText(500, { error: "start_failed" }, LIMITS), /no GPU was launched/);
  });

  it("shows a 400's own message, but not a bare code", () => {
    assert.equal(startErrorText(400, { error: "Unknown parameter: foo." }, LIMITS), "Unknown parameter: foo.");
    assert.equal(startErrorText(400, { error: "bad_input" }, LIMITS), "Check the fields and try again.");
    assert.equal(startErrorText(403, { error: "Admins only." }, LIMITS), "Only admins can start fine-tuning jobs.");
    assert.match(startErrorText(500, { error: "server_error" }, LIMITS), /\(server_error\)/);
    assert.match(startErrorText(502, null, LIMITS), /^Couldn't start the job\. /);
  });

  it("explains GPU list and Stop failures", () => {
    assert.match(gpuErrorText(503, { error: "lambda_not_configured" }), /LAMBDA_API_KEY/);
    assert.match(gpuErrorText(502, { error: "lambda_error" }), /Couldn't get GPU prices/);
    assert.match(gpuErrorText(502, { error: "lambda_unavailable" }), /Lambda didn't answer/);
    assert.equal(stopErrorText(409, { error: "already_ended" }), "This job already ended, and no GPU is left to shut down.");
    assert.equal(stopErrorText(403, {}), "Only admins can stop jobs.");
    assert.match(stopErrorText(500, { error: "server_error" }), /Lambda's dashboard/);
  });

  it("never puts an em dash in the copy", () => {
    const all = [
      startErrorText(409, { error: "too_many_active" }, LIMITS),
      startErrorText(503, { error: "no_capacity" }, LIMITS),
      startErrorText(503, { error: "daily_cap" }, LIMITS),
      NOT_PUBLIC_TEXT,
      startErrorText(503, { error: "lambda_not_configured" }, LIMITS),
      startErrorText(503, { error: "daily_cap", spentUsd: 3 }, LIMITS),
      startErrorText(502, { error: "lambda_unavailable" }, LIMITS),
      startErrorText(500, { error: "start_failed" }, LIMITS),
      gpuErrorText(500, {}),
      stopErrorText(500, {}),
      stopErrorText(409, {}),
      sweepOffText("cron_secret_unset"),
      sweepOffText("not_production"),
      sweepOffText("sweep_not_running"),
      ...[
        job(),
        job({ stopRequested: true }),
        job({ stopRequested: true, instanceId: null }),
        job({ status: "failed" }),
        job({ status: "stopped", stopRequested: true }),
      ].flatMap((j) => {
        const c = stopControl(j)!;
        return [c.label, c.note, c.confirm];
      }),
    ];
    for (const s of all) assert.equal(s.includes(String.fromCharCode(0x2014)), false, s);
  });
});

describe("stop control", () => {
  it("offers Stop until the GPU is confirmed shut down, and Stop again once one was asked for", () => {
    assert.equal(stopControl(job())!.label, "Stop job");
    const asked = stopControl(job({ stopRequested: true }))!;
    assert.equal(asked.label, "Try stop again");
    assert.doesNotMatch(asked.note, /within a minute/);
    assert.equal(stopControl(job({ stopRequested: true, instanceId: null, launchedAt: null }))!.label, "Try stop again");
    assert.equal(stopControl(job({ status: "stopped", stopRequested: true }))!.label, "Try stop again", "ended, GPU not gone");
    assert.equal(stopControl(job({ status: "failed" }))!.label, "Shut down GPU", "abandoned: ended without a terminate");
  });

  it("offers nothing once the GPU is gone or there never was one", () => {
    assert.equal(stopControl(job({ status: "succeeded", terminatedAt: new Date(t0).toISOString() })), null);
    assert.equal(stopControl(job({ stopRequested: true, terminatedAt: new Date(t0).toISOString() })), null);
    assert.equal(stopControl(job({ status: "failed", instanceId: null, launchedAt: null })), null);
  });
});

describe("time and cost", () => {
  it("counts GPU time from launch until terminated, else time since queued", () => {
    assert.equal(jobElapsedMs(job(), t0 + 90_000), 90_000);
    assert.equal(jobElapsedMs(job({ terminatedAt: new Date(t0 + 60_000).toISOString() }), t0 + 600_000), 60_000);
    const queued = job({ status: "queued", launchedAt: null, instanceId: null });
    assert.equal(jobElapsedMs(queued, t0), 60_000);
    const failedEarly = job({ status: "failed", launchedAt: null, instanceId: null, finishedAt: new Date(t0).toISOString() });
    assert.equal(jobElapsedMs(failedEarly, t0 + 3_600_000), 60_000);
  });

  it("shows the final cost once terminated, else a running estimate that never goes down", () => {
    assert.equal(liveCostUsd(job(), t0 + 30 * 60_000), 0.375);
    assert.equal(liveCostUsd(job({ costUsd: 0.5 }), t0 + 60_000), 0.5);
    assert.equal(liveCostUsd(job({ terminatedAt: new Date(t0).toISOString(), costUsd: 0.21 }), t0 + 3_600_000), 0.21);
    assert.equal(liveCostUsd(job({ launchedAt: null }), t0 + 60_000), 0);
  });

  it("settles once the job ended and its GPU is gone or never existed", () => {
    assert.equal(isSettled(job()), false);
    assert.equal(isSettled(job({ status: "succeeded" })), false);
    assert.equal(isSettled(job({ status: "succeeded", terminatedAt: new Date(t0).toISOString() })), true);
    assert.equal(isSettled(job({ status: "failed", instanceId: null })), true);
  });

  it("reads clock times in UTC", () => {
    assert.equal(clockUtc("2026-10-27T04:05:06.000Z"), "04:05:06");
    assert.equal(clockUtc("nope"), "");
  });
});

describe("event log", () => {
  it("writes progress as one short line", () => {
    assert.equal(progressText({ step: 3, totalSteps: 10, loss: 0.512345, message: "warming up" }), "Step 3 of 10 · loss 0.5123 · warming up");
    assert.equal(progressText({ step: 2 }), "Step 2");
    assert.equal(progressText({}), "Working");
  });

  it("describes each event type", () => {
    assert.deepEqual(eventLine({ type: "status", status: "booting", message: "Instance launched." }), {
      icon: "info",
      lead: "Booting",
      text: "Instance launched.",
      tone: undefined,
    });
    assert.equal(eventLine({ type: "status", status: "failed" }).tone, "bad");
    assert.match(
      eventLine({ type: "instance", instanceId: "0123456789abcdef", instanceType: "gpu_1x_a10", region: "us-east-1", ip: "1.2.3.4" }).text,
      /gpu_1x_a10 in us-east-1, IP 1\.2\.3\.4\. Instance 01234567\./,
    );
    assert.equal(eventLine({ type: "log", text: "hello\nworld" }).detail, "hello\nworld");
    assert.equal(eventLine({ type: "failed", error: "Traceback\nValueError: x" }).tone, "bad");
    assert.equal(eventLine({ type: "done" }).text, "The recipe finished.");
    const url = `https://store1.public.blob.vercel-storage.com/models/${JOB}/0123456789ab-adapter.safetensors`;
    const body: TrainEventBody = { type: "artifact", artifact: { name: "adapter.safetensors", kind: "adapter", url, bytes: 2048 } };
    const art = eventLine(body, JOB);
    assert.equal(art.text, "adapter.safetensors (adapter, 2 KB)");
    assert.equal(art.href, url);
    assert.equal(eventLine(body).href, undefined, "no link without the job it belongs to");
    assert.equal(eventLine(body, "ffffffff-0000-4000-8000-000000000000").href, undefined, "another job's file");
  });

  it("only links http and https URLs", () => {
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref("data:text/html,hi"), null);
    assert.equal(safeHref("not a url"), null);
    assert.equal(safeHref("https://x.example/a b"), "https://x.example/a%20b");
    const art = eventLine({ type: "artifact", artifact: { name: "a", kind: "other", url: "javascript:alert(1)", bytes: 1 } }, JOB);
    assert.equal(art.href, undefined);
  });

  it("links an artifact only to the job's own folder on a Vercel Blob public host", () => {
    const ok = `https://store1.public.blob.vercel-storage.com/models/${JOB}/a.bin`;
    assert.equal(artifactHref(ok, JOB), ok);
    for (const url of [
      "https://lambda-labs-login.example/a.bin",
      `https://blob.example/models/${JOB}/a.bin`,
      `http://store1.public.blob.vercel-storage.com/models/${JOB}/a.bin`,
      `https://store1.public.blob.vercel-storage.com/models/ffffffff-0000-4000-8000-000000000000/a.bin`,
      `https://store1.public.blob.vercel-storage.com/models/${JOB}/`,
      `https://store1.public.blob.vercel-storage.com/models/${JOB}/a.bin?download=1`,
      `https://u:p@store1.public.blob.vercel-storage.com/models/${JOB}/a.bin`,
      `https://store1.public.blob.vercel-storage.com.evil.example/models/${JOB}/a.bin`,
      "javascript:alert(1)",
    ]) {
      assert.equal(artifactHref(url, JOB), null, url);
    }
  });

  it("folds back-to-back heartbeats and progress reports, and nothing else", () => {
    const events = [
      ev(1, { type: "status", status: "booting" }),
      ev(2, { type: "heartbeat" }),
      ev(3, { type: "heartbeat" }),
      ev(4, { type: "progress", step: 1, totalSteps: 3 }),
      ev(5, { type: "progress", step: 2, totalSteps: 3 }),
      ev(6, { type: "heartbeat" }),
      ev(7, { type: "log", text: "x" }),
      ev(8, { type: "log", text: "y" }),
    ];
    const items = groupEvents(events);
    assert.deepEqual(
      items.map((i) => (i.kind === "one" ? i.event.id : `${i.type}:${i.events.map((e) => e.id).join(",")}`)),
      [1, "heartbeat:2,3", "progress:4,5", "heartbeat:6", 7, 8],
    );
    assert.equal(events.length, 8, "the input is left alone");
  });

  it("merges polled events in id order without duplicates", () => {
    const a = [ev(1, { type: "heartbeat" }), ev(2, { type: "heartbeat" })];
    assert.equal(mergeEvents(a, [ev(2, { type: "heartbeat" })]), a);
    assert.deepEqual(
      mergeEvents(a, [ev(4, { type: "log", text: "b" }), ev(3, { type: "log", text: "a" })]).map((e) => e.id),
      [1, 2, 3, 4],
    );
  });

  it("reads the last done event's metrics", () => {
    const events = [
      ev(1, { type: "done", metrics: { old: 1 } }),
      ev(2, { type: "done", summary: "ok", metrics: { gpu: "A10", matmulMs: 1.23456789, cuda: "yes" } }),
      ev(3, { type: "terminated", reason: "Finished" }),
    ];
    assert.deepEqual(doneMetrics(events), [
      ["gpu", "A10"],
      ["matmulMs", "1.23457"],
      ["cuda", "yes"],
    ]);
    assert.deepEqual(doneMetrics([ev(1, { type: "heartbeat" })]), []);
  });

  it("takes a traceback's last line as its headline", () => {
    assert.equal(errorHeadline("Traceback (most recent call last):\n  File x\nValueError: bad\n\n"), "ValueError: bad");
    assert.equal(errorHeadline(null), "");
  });
});
