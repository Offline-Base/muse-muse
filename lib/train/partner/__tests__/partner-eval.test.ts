/**
 * Partner evals on fakes: the real workflow function (runPartnerEval), the real steps, the real hosting service and the
 * real Baseten adapter, with Baseten's API, the Truss sandbox, the database, the judge and the clock faked. Nothing
 * reaches Baseten, Hugging Face, Meta or a database, and nothing is spent.
 *
 *   npx tsx --experimental-test-module-mocks --test lib/train/partner/__tests__/partner-eval.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LAB_BASE_MODEL } from "@/lib/train/base";
import { basetenAdapter } from "@/lib/train/host/baseten";
import { chatBody } from "@/lib/train/host/openai-chat";
import type { HostChatDeps, NewEndpoint } from "@/lib/train/host/service";
import type { HostAdapter, HostEndpoint } from "@/lib/train/host/types";
import { json } from "@/lib/train/host/__tests__/helpers";
import type { PartnerDeps } from "@/lib/train/partner/deps";
import { partnerBudget, partnerEvalView, latencyOf, partnerProblem, PARTNER_MAX_TOKENS } from "@/lib/train/partner/logic";
import { usePartnerDepsForTests } from "@/lib/train/partner/deps";
import { runPartnerEval } from "@/lib/train/partner/workflow";
import { tuneRunView } from "@/lib/train/tune/view";
import type { DatasetHead, DoneMetrics, TrainJobRow } from "@/lib/train/logic";
import type { PartnerEvalBody, TrainEventBody } from "@/lib/train/types";

const JOB = "aaaaaaaa-0000-4000-8000-0000000000aa";
const DATASET = "ebad9aad-0000-4000-8000-000000000001";
const T0 = Date.parse("2026-11-04T03:00:00Z");
const SYSTEM = "You are a cold-room handoff summarizer.";
const PROMPTS = [0, 1, 2, 3, 4, 5].map((i) => ({ index: i, prompt: `walk-in note ${i}: 39F, door alarm`, reference: `Checklist ${i}` }));

function job(over: Partial<TrainJobRow> = {}): TrainJobRow {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    status: "succeeded",
    title: "Cold-room handoff summarizer",
    instanceType: "gpu_1x_h100_pcie",
    region: "us-east-1",
    priceCentsPerHour: 329,
    maxMinutes: 60,
    maxUsd: 5,
    instanceId: "i-1",
    instanceIp: null,
    instanceName: "mm-train-aaaaaaaa-glimmer-lora",
    tokenHash: null,
    workflowRunId: null,
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 1.75,
    createdAt: new Date(T0 - 60 * 60_000),
    launchedAt: new Date(T0 - 59 * 60_000),
    firstHeartbeatAt: null,
    lastHeartbeatAt: null,
    finishedAt: new Date(T0 - 20 * 60_000),
    terminatedAt: new Date(T0 - 20 * 60_000),
    createdBy: "u-owner",
    judgeModel: "muse-spark-1.3-contributor",
    params: { baseModel: LAB_BASE_MODEL, loraRank: 16, datasetId: DATASET },
    evalSummary: { items: 20, tunedWins: 19, baseWins: 1, ties: 0, avgBaseScore: 4.8, avgTunedScore: 8.4, judgeCostUsd: 0.005 },
    hub: { status: "published", modelRepo: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-Cold-Room-LoRA", modelCommit: "c".repeat(40) },
    ...over,
  } as unknown as TrainJobRow;
}

// ---- The world: rows, events, the clock, Baseten.
let now: number;
let rows: HostEndpoint[];
let events: TrainEventBody[];
let theJob: TrainJobRow;
let metrics: DoneMetrics | null;
let settings: ReturnType<PartnerDeps["settings"]>;
let judgeReady: string | null;
let judged: Array<{ model: string; index: number; base: string; tuned: string }>;
let judgeThrows: boolean;
let pushes: number;
let pushFails: boolean;
/** What Baseten's production deployment says, one per status call; the last repeats. */
let statuses: string[];
/** Chat calls: the body sent and the URL path. */
let chats: Array<{ model: string; temperature: unknown; maxTokens: unknown; messages: Array<{ role: string; content: string }> }>;
/** Chat replies by call number: a status to answer instead of 200. */
let chatStatus: (n: number, model: string, prompt: string) => number;
let deletes: number;
let deleteOk: boolean;
let settled: Array<{ id: string; costUsd: number | null }>;
let waits: number[];

function fetchFake(): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (input.includes("/v1/secrets")) return json({ ok: true });
    if (method === "GET" && input.endsWith("/v1/models")) return json({ models: [] });
    if (input.includes("/deployments/production")) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return json({ status });
    }
    if (method === "DELETE" && input.includes("/v1/models/abc123")) {
      deletes += 1;
      return new Response(null, { status: deleteOk ? 200 : 500 });
    }
    if (input.includes("/chat/completions")) {
      const body = JSON.parse(String(init?.body)) as { model: string; temperature: unknown; max_tokens: unknown; messages: Array<{ role: string; content: string }> };
      chats.push({ model: body.model, temperature: body.temperature, maxTokens: body.max_tokens, messages: body.messages });
      const status = chatStatus(chats.length, body.model, body.messages.at(-1)?.content ?? "");
      if (status !== 200) return new Response("busy", { status });
      const who = body.model === "tuned" ? "TUNED" : "BASE";
      return json({ choices: [{ message: { content: `${who}: ${body.messages.at(-1)?.content}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    }
    throw new Error(`unexpected ${method} ${input}`);
  }) as unknown as typeof fetch;
}

function adapter(): HostAdapter {
  return basetenAdapter({
    apiKey: () => "bt-test-key-not-real",
    hfToken: () => "hf-test-token-not-real",
    fetch: fetchFake(),
    runner: {
      async run() {
        pushes += 1;
        if (pushFails) throw new Error("The deploy tool stopped with exit 1: no capacity");
        return "Model pushed: https://model-abc123.api.baseten.co/environments/production/sync";
      },
    },
  });
}

let ids = 0;
function host(limits: Record<string, number> = {}): HostChatDeps {
  const a = adapter();
  return {
    on: () => true,
    limits: () => ({ dailyUsd: 25, maxLive: 2, idleMinutes: 15, maxMinutes: 240, ...limits }),
    platformCapUsd: () => 100,
    platformSpend: async () => 0,
    adapter: () => a,
    adapters: () => [a],
    rows: async () => rows,
    async insert(r: NewEndpoint) {
      const saved: HostEndpoint = { ...r, status: "starting", ref: null, costUsd: null, stopReason: null, readyAt: null, lastUsedAt: null, stoppedAt: null };
      rows.push(saved);
      return saved;
    },
    async patch(id, patch) {
      rows = rows.map((e) => (e.id === id ? { ...e, ...patch } : e));
    },
    async touch(id, at) {
      rows = rows.map((e) => (e.id === id ? { ...e, lastUsedAt: at } : e));
    },
    takeDeployLock: async () => true,
    reserveSpend: async () => "res-1",
    async settleSpend(id, item) {
      settled.push({ id, costUsd: item?.costUsd ?? null });
    },
    hashToken: (raw) => `h:${raw.length}`,
    newId: () => `bbbbbbbb-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`,
  };
}

const fakeDeps = (): PartnerDeps => ({
  settings: () => settings,
  source: async (id) => (id === JOB ? { job: theJob, metrics } : null),
  evalIndexes: async () => PROMPTS.map((p) => p.index),
  evalItem: async (_id, index) => PROMPTS.find((p) => p.index === index) ?? null,
  datasetTask: async () => "Summarize a cold-room handoff note as a checklist.",
  results: async () => events.filter((e): e is PartnerEvalBody => e.type === "partner_eval"),
  record: async (_id, body) => {
    events.push(body);
  },
  judgeReady: async () => judgeReady,
  async judge(input) {
    if (judgeThrows) throw new Error("judge down");
    judged.push({ model: input.model, index: input.index, base: input.base, tuned: input.tuned });
    return { baseScore: 5, tunedScore: input.index === 3 ? 5 : 9, better: input.index === 3 ? "tie" : "tuned", costUsd: 0.0003, note: "n" };
  },
  host,
  now: () => new Date(now),
  clock: () => now,
});

const clock = {
  async wait(ms: number) {
    waits.push(ms);
    now += ms;
  },
  now: () => now,
};

const partnerEvents = () => events.filter((e): e is PartnerEvalBody => e.type === "partner_eval");
const last = () => partnerEvents().at(-1)!;

beforeEach(() => {
  now = T0;
  rows = [];
  events = [];
  theJob = job();
  metrics = { system: SYSTEM } as unknown as DoneMetrics;
  settings = { provider: "baseten", hostOn: true, maxUsd: 8, maxMinutes: 60 };
  judgeReady = null;
  judged = [];
  judgeThrows = false;
  pushes = 0;
  pushFails = false;
  statuses = ["BUILDING", "LOADING_MODEL", "ACTIVE"];
  chats = [];
  chatStatus = () => 200;
  deletes = 0;
  deleteOk = true;
  settled = [];
  waits = [];
  usePartnerDepsForTests(fakeDeps());
});
afterEach(() => usePartnerDepsForTests(null));

describe("a partner eval on Baseten", () => {
  it("deploys, answers base and tuned greedily, stops before judging, and records scores, latency and cost", async () => {
    // The first answer finds it waking (503): it waits and asks again.
    chatStatus = (n) => (n === 1 ? 503 : 200);
    const out = await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(out.status, "done");
    assert.equal(pushes, 1);
    assert.equal(rows.length, 1);
    const ep = rows[0]!;
    assert.equal(ep.status, "stopped");
    assert.equal(ep.provider, "baseten");
    // Its stop time is set from the eval's own budget: 60 minutes at $6.50 an hour fits $8.
    assert.equal(ep.stopsAt.getTime() - ep.createdAt.getTime(), 60 * 60_000);
    assert.equal(deletes, 1);
    assert.deepEqual(settled.map((s) => s.id), ["res-1"]);

    // 6 prompts x base and tuned, plus the one waking retry. Every one under the job's own system message, at temperature 0.
    assert.equal(chats.length, 13);
    assert.ok(chats.every((c) => c.temperature === 0 && c.maxTokens === PARTNER_MAX_TOKENS));
    assert.ok(chats.every((c) => c.messages[0]?.role === "system" && c.messages[0].content === SYSTEM));
    assert.deepEqual([...new Set(chats.map((c) => c.model))].sort(), ["/models/base", "tuned"]);

    // Judged by the job's own judge, after the endpoint was down.
    assert.equal(judged.length, 6);
    assert.ok(judged.every((j) => j.model === "muse-spark-1.3-contributor"));
    assert.ok(judged.every((j) => j.base.startsWith("BASE") && j.tuned.startsWith("TUNED")));

    const statuses_ = partnerEvents().map((e) => e.status);
    assert.deepEqual(statuses_, ["started", "done"]);
    const done = last();
    assert.equal(done.items, 6);
    assert.equal(done.tunedWins, 5);
    assert.equal(done.ties, 1);
    assert.equal(done.gpu, "H100");
    assert.equal(done.stopped, true);
    assert.equal(done.latency?.base?.answers, 6);
    assert.equal(done.costSource, "clock");
    assert.ok(typeof done.costUsd === "number" && done.costUsd > 0 && done.costUsd <= 8);
    assert.ok(typeof done.coldStartSeconds === "number" && done.coldStartSeconds >= 60);
    // Nothing about where it ran is kept.
    assert.doesNotMatch(JSON.stringify(events), /baseten\.co|abc123|test-key|test-token/);
    // The job itself is untouched.
    assert.equal(theJob.evalSummary?.tunedWins, 19);
  });

  it("does nothing at all with PARTNER_EVALS off", async () => {
    settings = { ...settings, provider: null };
    assert.equal((await runPartnerEval({ jobId: JOB }, clock)).status, "skipped");
    assert.equal(pushes, 0);
    assert.equal(events.length, 0);
  });

  it("skips, with the reason in the log, an adapter that isn't on the Hub, and says it only once", async () => {
    theJob = job({ hub: { status: "off" } as TrainJobRow["hub"] });
    await runPartnerEval({ jobId: JOB }, clock);
    await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(pushes, 0);
    assert.equal(partnerEvents().length, 1);
    assert.equal(last().status, "skipped");
    assert.match(last().reason ?? "", /Publish it to Hugging Face first/);
  });

  it("skips without HOST_TUNED, a judge that can't run, or a model that didn't pass", async () => {
    settings = { ...settings, hostOn: false };
    await runPartnerEval({ jobId: JOB }, clock);
    assert.match(last().reason ?? "", /HOST_TUNED is off/);
    settings = { ...settings, hostOn: true };
    judgeReady = "MODEL_API_KEY isn't set, so the answers couldn't be judged.";
    await runPartnerEval({ jobId: JOB }, clock);
    assert.match(last().reason ?? "", /MODEL_API_KEY/);
    judgeReady = null;
    theJob = job({ evalSummary: { items: 20, tunedWins: 4, baseWins: 16, ties: 0, avgBaseScore: 8, avgTunedScore: 4, judgeCostUsd: 0 } });
    await runPartnerEval({ jobId: JOB }, clock);
    assert.match(last().reason ?? "", /didn't pass/);
    assert.equal(pushes, 0);
  });

  it("caps its minutes at what PARTNER_EVAL_MAX_USD buys, and refuses under 30 minutes", async () => {
    settings = { ...settings, maxUsd: 4 };
    await runPartnerEval({ jobId: JOB }, clock);
    const ep = rows[0]!;
    // $4 at $6.50 an hour is 36 minutes.
    assert.equal(ep.stopsAt.getTime() - ep.createdAt.getTime(), 36 * 60_000);
    assert.equal(partnerEvents()[0]?.maxUsd, 3.9);

    rows = [];
    events = [];
    pushes = 0;
    settings = { ...settings, maxUsd: 3 };
    await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(pushes, 0);
    assert.match(last().reason ?? "", /under 30 minutes/);
  });

  it("is idempotent: a finished one isn't run again unless asked, and a running one blocks a second", async () => {
    await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(pushes, 1);
    await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(pushes, 1);
    assert.match(last().reason ?? "", /already evaluated/);

    events.push({ type: "partner_eval", provider: "baseten", status: "started", startedAt: new Date(now).toISOString() });
    await runPartnerEval({ jobId: JOB, again: true }, clock);
    assert.equal(pushes, 1);
    assert.match(last().reason ?? "", /already running/);

    // A started one left by a run that died hours ago doesn't block.
    now += 4 * 60 * 60_000;
    await runPartnerEval({ jobId: JOB, again: true }, clock);
    assert.equal(pushes, 2);
    assert.equal(last().status, "done");
  });

  it("started by the training workflow, passes over a job that was never a tuned chat model without a word", async () => {
    for (const over of [{ recipe: "glimmer-quantize" }, { params: { baseModel: LAB_BASE_MODEL, datasetId: DATASET, mode: "decide" } }, { params: { baseModel: LAB_BASE_MODEL, datasetId: DATASET, dryRun: 1 } }]) {
      theJob = job(over as Partial<TrainJobRow>);
      assert.equal((await runPartnerEval({ jobId: JOB, auto: true }, clock)).status, "skipped");
    }
    assert.equal(events.length, 0);
    assert.equal(pushes, 0);
    // An admin's start of the same job says why.
    await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(last().status, "skipped");
  });

  it("a plan that fails after its checks, and is retried, never leaves its own started in the way", async () => {
    let fails = 1;
    usePartnerDepsForTests({
      ...fakeDeps(),
      async datasetTask() {
        if (fails-- > 0) throw new Error("db blip");
        return "Summarize a cold-room handoff note as a checklist.";
      },
    });
    await assert.rejects(runPartnerEval({ jobId: JOB }, clock));
    assert.equal(partnerEvents().length, 0, "nothing recorded before the task was read");
    assert.equal((await runPartnerEval({ jobId: JOB }, clock)).status, "done");
  });

  it("the room calls a started one with no ending after 3 hours unfinished, not running", () => {
    const started: PartnerEvalBody = { type: "partner_eval", provider: "baseten", status: "started", gpu: "H100", minutes: 60, maxUsd: 6.5, startedAt: new Date(T0).toISOString() };
    assert.equal(partnerEvalView([started], (m) => m, new Date(T0 + 60_000))?.title, "Evaluating on Baseten");
    const stale = partnerEvalView([started], (m) => m, new Date(T0 + 4 * 60 * 60_000));
    assert.equal(stale?.title, "Evaluation on Baseten didn't finish");
    assert.equal(stale?.status, "failed");
  });

  it("a failed deploy records why, leaves nothing running, and judges nothing", async () => {
    pushFails = true;
    const out = await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(out.status, "failed");
    assert.equal(rows[0]?.status, "failed");
    assert.equal(judged.length, 0);
    assert.match(last().reason ?? "", /couldn't deploy it/);
    assert.equal(last().stopped, true);
  });

  it("stops an endpoint that is never ready, at the ready window, and records the clock's cost", async () => {
    statuses = ["BUILDING"];
    const out = await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(out.status, "failed");
    assert.match(last().reason ?? "", /wasn't ready to answer within 45 minutes/);
    assert.equal(rows[0]?.status, "stopped");
    assert.equal(deletes, 1);
    assert.equal(chats.length, 0);
    assert.ok((last().costUsd ?? 0) > 0);
  });

  it("tears down even when judging fails, and an unconfirmed stop is said, for the sweep", async () => {
    judgeThrows = true;
    deleteOk = false;
    const out = await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(out.status, "failed");
    assert.equal(deletes, 5);
    assert.equal(rows[0]?.status, "stopping");
    assert.equal(last().stopped, false);
    assert.match(partnerEvalView(partnerEvents(), (m) => m)?.words ?? "", /hosting sweep keeps trying/);
  });

  it("a prompt the endpoint can't take is left out, and the rest are judged", async () => {
    chatStatus = (_n, model, prompt) => (model === "tuned" && /note [45]/.test(prompt) ? 400 : 200);
    const out = await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(out.status, "done");
    assert.equal(last().items, 4);
    assert.equal(last().asked, 6);
    assert.equal(deletes, 1);
  });

  it("an endpoint that closes partway stops the answers, keeps what was judged, and is torn down", async () => {
    // Past its stop time the hosting code refuses traffic: the next answer stops everything else.
    chatStatus = (_n, _model, prompt) => {
      if (/note 4/.test(prompt)) rows = rows.map((e) => ({ ...e, stopsAt: new Date(now - 1) }));
      return 200;
    };
    const out = await runPartnerEval({ jobId: JOB }, clock);
    assert.equal(out.status, "failed");
    assert.match(last().reason ?? "", /reached a limit and stopped/);
    assert.equal(last().items, 4);
    assert.equal(rows[0]?.status, "stopped");
  });
});

describe("partner eval pieces", () => {
  it("latency is median and 90th percentile by nearest rank", () => {
    assert.deepEqual(latencyOf([100, 300, 200, 400, 1000]), { answers: 5, medianMs: 300, p90Ms: 1000 });
    assert.equal(latencyOf([]), null);
  });

  it("the budget never runs past what the money buys", () => {
    assert.deepEqual(partnerBudget({ hourlyUsd: 4.85, gpu: "H100" }, { maxUsd: 8, maxMinutes: 60 }), { ok: true, minutes: 60, maxUsd: 4.85 });
    assert.equal(partnerBudget({ hourlyUsd: 6.5, gpu: "H100" }, { maxUsd: 0, maxMinutes: 60 }).ok, false);
  });

  it("greedy only changes the temperature", () => {
    const input = { messages: [{ role: "user" as const, content: "hi" }], family: "glimmer" as const, adapterJobId: JOB, trainChannel: 0 as const, stop: [] };
    const sampled = chatBody("tuned", input);
    const greedy = chatBody("tuned", { ...input, greedy: true });
    assert.equal(greedy.temperature, 0);
    assert.deepEqual({ ...greedy, temperature: sampled.temperature }, sampled);
  });

  it("partnerProblem names the hosting refusal first", () => {
    const facts = { problem: null } as Parameters<typeof partnerProblem>[0]["facts"];
    assert.equal(partnerProblem({ facts, refusal: "Baseten isn't set up here: BASETEN_API_KEY isn't set.", items: 5, results: [], judgeReady: null, now: new Date(T0) }), "Baseten isn't set up here: BASETEN_API_KEY isn't set.");
    assert.equal(partnerProblem({ facts, refusal: null, items: 0, results: [], judgeReady: null, now: new Date(T0) }), "This job has no held-out prompts to answer.");
  });

  it("the run room says Evaluated on Baseten, and counts its cost", async () => {
    await runPartnerEval({ jobId: JOB }, clock);
    const dataset = {
      id: DATASET,
      title: "Cold-room handoff summarizer",
      task: "Summarize a cold-room handoff note.",
      status: "ready",
      requested: 200,
      trainCount: 180,
      evalCount: 20,
      costUsd: 0.03,
      error: null,
      createdBy: null,
      createdAt: new Date(T0 - 2 * 60 * 60_000),
      finishedAt: new Date(T0 - 90 * 60_000),
      workflowRunId: "wrun_1",
      writerModel: "muse-spark-1.3-contributor",
    } as unknown as DatasetHead;
    const view = tuneRunView({ dataset, written: null, job: theJob, events: [], partnerEvals: partnerEvents() }, new Date(now), { maxMinutes: 120, maxUsd: 5 });
    assert.equal(view.partnerEval?.title, "Evaluated on Baseten");
    assert.match(view.partnerEval?.words ?? "", /better on 5 of 6/);
    assert.doesNotMatch(view.partnerEval?.words ?? "", /\u2014/);
    const without = tuneRunView({ dataset, written: null, job: theJob, events: [] }, new Date(now), { maxMinutes: 120, maxUsd: 5 });
    assert.equal(without.partnerEval, undefined);
    assert.ok(view.costSoFarUsd > without.costSoFarUsd);
  });
});
