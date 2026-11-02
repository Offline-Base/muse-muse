/**
 * The 5-minute training sweep with the Lambda client and the store faked: which instances it terminates (by name, saved
 * id or job tag, and by saved id when Lambda's listing fails), which jobs it fails or stops, how it counts an
 * instance that outlived its job, and that one failure doesn't stop the rest. Nothing here calls Lambda or a database.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/sweep.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { LambdaInstance } from "../lambda";
import type { TrainJobRow } from "../logic";
import { staleReason, sweepReason, sweepTraining, UNLISTED_GRACE_MS, type TrainSweepDeps } from "../sweep";

const MIN = 60_000;
const NOW = new Date(Date.UTC(2026, 9, 27, 12, 0, 0));
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);

let seq = 0;
function job(over: Partial<TrainJobRow> = {}): TrainJobRow {
  seq += 1;
  const id = over.id ?? `${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    id,
    recipe: "smoke",
    title: "Smoke test",
    status: "running",
    params: {},
    instanceType: "gpu_1x_a10",
    region: "us-east-1",
    priceCentsPerHour: 75,
    maxMinutes: 30,
    maxUsd: 1,
    instanceId: null,
    instanceName: `mm-train-${id.slice(0, 8)}-smoke`,
    instanceIp: null,
    tokenHash: "hash",
    workflowRunId: "run",
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0,
    createdBy: null,
    createdAt: ago(10),
    launchedAt: ago(9),
    firstHeartbeatAt: ago(8),
    lastHeartbeatAt: ago(1),
    finishedAt: null,
    terminatedAt: null,
    evalSummary: null,
    serveEndpoint: null,
    hub: null,
    judgeModel: null,
    productId: null,
    ...over,
  };
}

function instance(over: Partial<LambdaInstance> & { id: string; name: string | null }): LambdaInstance {
  return { status: "active", ip: "1.2.3.4", instanceType: "gpu_1x_a10", region: "us-east-1", ...over };
}

/** A job and the instance it launched. */
function launched(over: Partial<TrainJobRow> = {}): { row: TrainJobRow; inst: LambdaInstance } {
  const row = job(over);
  const id = row.instanceId ?? `inst-${row.id.slice(0, 8)}`;
  row.instanceId = id;
  return { row, inst: instance({ id, name: row.instanceName }) };
}

type Call = { fn: string; args: unknown[] };

function fakes(opts: { instances?: LambdaInstance[] | Error; jobs?: TrainJobRow[]; terminateFails?: string[] }) {
  const calls: Call[] = [];
  const jobs = opts.jobs ?? [];
  const deps: TrainSweepDeps = {
    listInstances: async () => {
      calls.push({ fn: "listInstances", args: [] });
      if (opts.instances instanceof Error) throw opts.instances;
      return opts.instances ?? [];
    },
    getInstance: async (id) => {
      calls.push({ fn: "getInstance", args: [id] });
      if (opts.instances instanceof Error) throw opts.instances;
      return (opts.instances ?? []).find((i) => i.id === id) ?? null;
    },
    terminateInstances: async (ids) => {
      calls.push({ fn: "terminateInstances", args: [ids] });
      if (ids.some((id) => opts.terminateFails?.includes(id))) throw new Error(`Lambda API refused ${ids.join(",")}`);
    },
    openJobs: async () => jobs.filter((j) => !["succeeded", "failed", "stopped"].includes(j.status)),
    jobsForInstances: async ({ names, instanceIds, jobIds }) => {
      calls.push({ fn: "jobsForInstances", args: [{ names, instanceIds, jobIds }] });
      return jobs.filter(
        (j) => names.includes(j.instanceName) || (j.instanceId !== null && instanceIds.includes(j.instanceId)) || jobIds.includes(j.id),
      );
    },
    unterminatedJobs: async () =>
      jobs.filter((j) => ["succeeded", "failed", "stopped"].includes(j.status) && !j.terminatedAt && j.launchedAt),
    finishJob: async (jobId, input) => {
      calls.push({ fn: "finishJob", args: [jobId, input] });
      return null;
    },
    extendTermination: async (jobId, input) => {
      calls.push({ fn: "extendTermination", args: [jobId, input] });
      return null;
    },
    setStatus: async (jobId, status, o) => {
      calls.push({ fn: "setStatus", args: [jobId, status, o] });
      return true;
    },
    recordEvent: async (jobId, body) => {
      calls.push({ fn: "recordEvent", args: [jobId, body] });
    },
  };
  const named = (fn: string) => calls.filter((c) => c.fn === fn);
  const terminatedIds = () => named("terminateInstances").flatMap((c) => c.args[0] as string[]);
  const finished = (jobId: string) =>
    named("finishJob")
      .filter((c) => c.args[0] === jobId)
      .map((c) => c.args[1] as { status: string; reason: string; terminatedAt: Date; launchedAt?: Date });
  return { deps, calls, named, terminatedIds, finished };
}

beforeEach(() => {
  seq = 0;
});

describe("sweepReason", () => {
  it("leaves a healthy job's instance alone", () => {
    const { row, inst } = launched();
    assert.equal(sweepReason(inst, row, NOW), null);
  });

  it("terminates an instance with no job, or whose job ended", () => {
    const { row, inst } = launched({ status: "succeeded" });
    assert.equal(sweepReason(inst, null, NOW), "No training job has this instance.");
    assert.equal(sweepReason(inst, row, NOW), "The job already ended.");
  });

  it("terminates 10 minutes past the time limit, not before", () => {
    const early = launched({ maxMinutes: 30, launchedAt: ago(39) });
    assert.equal(sweepReason(early.inst, early.row, NOW), null);
    const late = launched({ maxMinutes: 30, launchedAt: ago(40) });
    assert.equal(sweepReason(late.inst, late.row, NOW), "Ran 10 minutes past the job's 30-minute limit.");
  });

  it("terminates once the cost passes the dollar limit by 10%", () => {
    // $6/hour against a $1 limit: $1.10 is reached at 11 minutes.
    const under = launched({ priceCentsPerHour: 600, maxUsd: 1, maxMinutes: 120, launchedAt: ago(10) });
    assert.equal(sweepReason(under.inst, under.row, NOW), null);
    const over = launched({ priceCentsPerHour: 600, maxUsd: 1, maxMinutes: 120, launchedAt: ago(11) });
    assert.equal(sweepReason(over.inst, over.row, NOW), "Cost passed the job's $1.00 limit by 10%.");
  });

  it("starts the clock at creation when the launch was never saved", () => {
    const row = job({ status: "launching", launchedAt: null, createdAt: ago(41), maxMinutes: 30 });
    const inst = instance({ id: "orphan", name: row.instanceName });
    assert.equal(sweepReason(inst, row, NOW), "Ran 10 minutes past the job's 30-minute limit.");
  });

  it("terminates a second instance for the same job", () => {
    const { row } = launched();
    const dup = instance({ id: "dup", name: row.instanceName });
    assert.equal(sweepReason(dup, row, NOW), "A second instance for the same job.");
  });

  it("terminates the instance of a job an admin asked to stop", () => {
    const { row, inst } = launched({ stopRequested: true, maxMinutes: 300, launchedAt: ago(20) });
    assert.equal(sweepReason(inst, row, NOW), "Someone asked to stop the job.");
  });

  it("holds a job whose workflow is gone to the boot grace and the silence rule", () => {
    const booting = launched({ status: "booting", maxMinutes: 300, maxUsd: 40, launchedAt: ago(24), firstHeartbeatAt: null, lastHeartbeatAt: null });
    assert.equal(sweepReason(booting.inst, booting.row, NOW), null);
    const neverBooted = launched({ status: "booting", maxMinutes: 300, maxUsd: 40, launchedAt: ago(25), firstHeartbeatAt: null, lastHeartbeatAt: null });
    assert.equal(sweepReason(neverBooted.inst, neverBooted.row, NOW), "No heartbeat 25 minutes after launch.");
    const quiet = launched({ maxMinutes: 300, maxUsd: 40, launchedAt: ago(60), firstHeartbeatAt: ago(50), lastHeartbeatAt: ago(10) });
    assert.equal(sweepReason(quiet.inst, quiet.row, NOW), "No heartbeat for 10 minutes.");
  });

  it("leaves the time and dollar limits to the workflow until the sweep's grace", () => {
    // decideCheck alone would stop this at 30 minutes; the sweep waits 10 more.
    const { row, inst } = launched({ maxMinutes: 30, launchedAt: ago(35) });
    assert.equal(sweepReason(inst, row, NOW), null);
  });
});

describe("staleReason", () => {
  it("fails jobs queued or launching for 15 minutes", () => {
    assert.equal(staleReason(job({ status: "queued", launchedAt: null, createdAt: ago(14) }), NOW), null);
    assert.equal(
      staleReason(job({ status: "queued", launchedAt: null, createdAt: ago(15) }), NOW),
      "Still queued 15 minutes after it was created.",
    );
    assert.equal(
      staleReason(job({ status: "launching", launchedAt: null, createdAt: ago(20) }), NOW),
      "Still launching 15 minutes after it was created.",
    );
  });

  it("fails a launched job left open 30 minutes past its limit", () => {
    assert.equal(staleReason(job({ maxMinutes: 30, launchedAt: ago(59) }), NOW), null);
    assert.equal(staleReason(job({ maxMinutes: 30, launchedAt: ago(60) }), NOW), "The job stopped being checked, so it was ended.");
    assert.equal(staleReason(job({ status: "booting", createdAt: ago(16), launchedAt: ago(15) }), NOW), null);
  });
});

describe("sweepTraining", () => {
  it("only touches live mm-train- instances", async () => {
    const f = fakes({
      instances: [
        instance({ id: "a", name: "someone-elses-box" }),
        instance({ id: "b", name: null }),
        instance({ id: "c", name: "mm-train-deadbeef-smoke", status: "terminated" }),
        instance({ id: "d", name: "mm-train-deadbeef-smoke", status: "terminating" }),
        instance({ id: "e", name: "MM-TRAIN-upper" }),
      ],
    });
    const result = await sweepTraining(f.deps, NOW);
    assert.equal(result.instances, 0);
    assert.deepEqual(f.terminatedIds(), []);
    assert.deepEqual(result.errors, []);
  });

  it("terminates an instance with no job and leaves a healthy one", async () => {
    const healthy = launched();
    const f = fakes({
      instances: [healthy.inst, instance({ id: "stray", name: "mm-train-12345678-smoke" })],
      jobs: [healthy.row],
    });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), ["stray"]);
    assert.deepEqual(result.terminated, [
      { instanceId: "stray", name: "mm-train-12345678-smoke", jobId: null, reason: "No training job has this instance." },
    ]);
    assert.equal(f.named("finishJob").length, 0);
    assert.equal(result.instances, 2);
  });

  it("terminates an ended job's instance and stamps terminatedAt, keeping the job's status", async () => {
    const done = launched({ status: "succeeded", finishedAt: ago(2) });
    const f = fakes({ instances: [done.inst], jobs: [done.row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [done.inst.id]);
    assert.deepEqual(f.named("finishJob")[0]!.args, [
      done.row.id,
      { status: "succeeded", reason: "The sweep terminated the instance: The job already ended.", terminatedAt: NOW },
    ]);
    assert.deepEqual(result.failedJobs, []);
  });

  it("stamps terminatedAt on an ended job whose instance is already gone", async () => {
    const gone = launched({ status: "succeeded", finishedAt: ago(3) });
    const stillUp = launched({ status: "failed", finishedAt: ago(1) });
    const neverLaunched = job({ status: "failed", launchedAt: null, finishedAt: ago(2) });
    const f = fakes({
      instances: [{ ...gone.inst, status: "terminated" }, stillUp.inst],
      jobs: [gone.row, stillUp.row, neverLaunched],
    });
    await sweepTraining(f.deps, NOW);
    const finished = f.named("finishJob").map((c) => c.args as [string, { status: string; reason: string; terminatedAt: Date }]);
    assert.deepEqual(
      finished.find(([id]) => id === gone.row.id)?.[1],
      { status: "succeeded", reason: "The instance was already gone.", terminatedAt: ago(3) },
    );
    // The one still up is terminated by the instance pass instead, and the one that never launched is left alone.
    assert.deepEqual(f.terminatedIds(), [stillUp.inst.id]);
    assert.equal(finished.filter(([id]) => id === stillUp.row.id).length, 1);
    assert.equal(finished.filter(([id]) => id === neverLaunched.id).length, 0);
  });

  it("counts the time of an instance that outlived its job's terminatedAt", async () => {
    const done = launched({ status: "failed", finishedAt: ago(10), terminatedAt: ago(10) });
    const f = fakes({ instances: [done.inst], jobs: [done.row] });
    await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [done.inst.id]);
    assert.equal(f.named("finishJob").length, 0);
    const [extend] = f.named("extendTermination");
    assert.equal(extend!.args[0], done.row.id);
    const input = extend!.args[1] as { terminatedAt: Date; reason: string };
    assert.equal(input.terminatedAt, NOW);
    assert.match(input.reason, new RegExp(done.inst.id));
  });

  it("counts a late-listed instance of a job that ended thinking nothing launched", async () => {
    // terminateStep finished the job before Lambda listed its instance: no launchedAt, cost 0.
    const ended = job({ status: "failed", launchedAt: null, finishedAt: ago(6), terminatedAt: ago(6) });
    const late = instance({ id: "late", name: ended.instanceName });
    const f = fakes({ instances: [late], jobs: [ended] });
    await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), ["late"]);
    assert.deepEqual(f.named("extendTermination").map((c) => c.args[0]), [ended.id]);
  });

  it("counts a duplicate of a job that already has terminatedAt", async () => {
    const done = launched({ status: "succeeded", finishedAt: ago(4), terminatedAt: ago(4) });
    const dup = instance({ id: "dup", name: done.row.instanceName });
    const f = fakes({ instances: [dup], jobs: [done.row] });
    await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), ["dup"]);
    assert.equal(f.named("extendTermination").length, 1);
  });

  it("fails an open job whose instance ran past the time limit plus 10 minutes", async () => {
    const late = launched({ maxMinutes: 30, launchedAt: ago(41) });
    const f = fakes({ instances: [late.inst], jobs: [late.row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [late.inst.id]);
    assert.deepEqual(f.named("finishJob")[0]!.args, [
      late.row.id,
      {
        status: "failed",
        reason: "The sweep terminated the instance: Ran 10 minutes past the job's 30-minute limit.",
        terminatedAt: NOW,
      },
    ]);
    assert.deepEqual(result.failedJobs, [{ jobId: late.row.id, reason: "Ran 10 minutes past the job's 30-minute limit." }]);
  });

  it("fails an open job whose cost passed its dollar limit by 10%", async () => {
    const pricey = launched({ priceCentsPerHour: 1200, maxUsd: 1, maxMinutes: 120, launchedAt: ago(6) });
    const f = fakes({ instances: [pricey.inst], jobs: [pricey.row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [pricey.inst.id]);
    assert.equal(result.failedJobs.length, 1);
  });

  it("terminates a duplicate instance without failing its job", async () => {
    const { row, inst } = launched();
    const dup = instance({ id: "dup", name: row.instanceName });
    const f = fakes({ instances: [inst, dup], jobs: [row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), ["dup"]);
    assert.equal(f.named("finishJob").length, 0);
    assert.deepEqual(result.failedJobs, []);
    const event = f.named("recordEvent")[0]!.args[1] as { type: string; reason: string };
    assert.equal(event.type, "terminated");
    assert.match(event.reason, /dup/);
  });

  it("fails jobs stuck before launch and terminates an instance under their name", async () => {
    const queued = job({ status: "queued", launchedAt: null, firstHeartbeatAt: null, lastHeartbeatAt: null, createdAt: ago(16) });
    const fresh = job({ status: "queued", launchedAt: null, firstHeartbeatAt: null, lastHeartbeatAt: null, createdAt: ago(5) });
    const launching = job({ status: "launching", launchedAt: null, firstHeartbeatAt: null, lastHeartbeatAt: null, createdAt: ago(20) });
    const unsaved = instance({ id: "unsaved", name: launching.instanceName });
    const f = fakes({ instances: [unsaved], jobs: [queued, fresh, launching] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(
      result.failedJobs.map((j) => j.jobId).sort(),
      [queued.id, launching.id].sort(),
    );
    assert.deepEqual(f.terminatedIds(), ["unsaved"]);
    const finished = f.named("finishJob").map((c) => c.args[0]);
    assert.deepEqual(finished.sort(), [queued.id, launching.id].sort());
    // The unsaved instance was handled with its job, not terminated a second time.
    assert.equal(f.named("terminateInstances").length, 1);
    // Its cost counts from when the job was created, since the launch time was never saved.
    const inputs = new Map(f.named("finishJob").map((c) => [c.args[0], c.args[1] as { launchedAt?: Date }]));
    assert.equal(inputs.get(launching.id)?.launchedAt?.getTime(), launching.createdAt.getTime());
    assert.equal(inputs.get(queued.id)?.launchedAt, undefined, "no instance, no cost");
  });

  it("fails a launched job left open past its limit with no instance left", async () => {
    const orphan = job({ status: "running", instanceId: "gone", maxMinutes: 30, launchedAt: ago(61) });
    const f = fakes({ instances: [], jobs: [orphan] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(result.failedJobs, [{ jobId: orphan.id, reason: "The job stopped being checked, so it was ended." }]);
    assert.deepEqual(f.terminatedIds(), []);
    assert.equal(f.named("finishJob").length, 1);
  });

  it("when the listing fails, ends a stuck job with no saved id without terminatedAt and terminates nothing for it", async () => {
    const queued = job({ status: "queued", launchedAt: null, createdAt: ago(30) });
    const f = fakes({ instances: new Error("Lambda API GET /instances timed out after 20 s"), jobs: [queued] });
    const result = await sweepTraining(f.deps, NOW);
    assert.equal(result.instances, null);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /timed out/);
    assert.equal(f.named("terminateInstances").length, 0);
    assert.equal(f.named("finishJob").length, 0);
    assert.deepEqual(f.named("setStatus")[0]!.args.slice(0, 2), [queued.id, "failed"]);
  });

  it("keeps a stuck launch's GPU slot when Lambda doesn't list its instance yet", async () => {
    // launchStep took the launch claim; its instance may still show up in the listing, or be saved late.
    const sent = job({ status: "launching", instanceId: null, launchedAt: null, firstHeartbeatAt: null, lastHeartbeatAt: null, createdAt: ago(20) });
    const unclaimed = job({ status: "launching", tokenHash: null, launchedAt: null, firstHeartbeatAt: null, lastHeartbeatAt: null, createdAt: ago(20) });
    for (const listing of [[], new Error("Lambda API GET /instances failed (502)")]) {
      const f = fakes({ instances: listing, jobs: [sent, unclaimed] });
      const result = await sweepTraining(f.deps, NOW);
      assert.deepEqual(result.failedJobs.map((j) => j.jobId).sort(), [sent.id, unclaimed.id].sort());
      const ended = f.named("setStatus").find((c) => c.args[0] === sent.id);
      assert.ok(ended, "ended without terminatedAt");
      assert.equal(ended.args[1], "failed");
      const set = (ended.args[2] as { set: { launchedAt?: Date } }).set;
      assert.equal(set.launchedAt?.getTime(), sent.createdAt.getTime(), "its cost counts from createdAt and it holds its slot");
      assert.equal(f.finished(sent.id).length, 0);
      // With no claim, nothing was launched: the listing case stamps terminatedAt with no cost.
      if (Array.isArray(listing)) assert.equal(f.finished(unclaimed.id)[0]?.launchedAt, undefined);
    }
  });

  it("when the listing fails, still terminates instances by their saved ids", async () => {
    const orphan = launched({ status: "running", maxMinutes: 30, launchedAt: ago(61) });
    const unconfirmed = launched({ status: "succeeded", finishedAt: ago(20) });
    const stopped = launched({ stopRequested: true, maxMinutes: 300, launchedAt: ago(20) });
    const healthy = launched();
    const f = fakes({
      instances: new Error("Lambda API GET /instances failed (502)"),
      jobs: [orphan.row, unconfirmed.row, stopped.row, healthy.row],
    });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds().sort(), [orphan.inst.id, unconfirmed.inst.id, stopped.inst.id].sort());
    assert.equal(f.finished(orphan.row.id)[0]?.status, "failed");
    assert.equal(f.finished(orphan.row.id)[0]?.terminatedAt, NOW);
    assert.equal(f.finished(unconfirmed.row.id)[0]?.status, "succeeded");
    assert.equal(f.finished(unconfirmed.row.id)[0]?.terminatedAt, NOW);
    assert.equal(f.finished(stopped.row.id)[0]?.status, "stopped");
    assert.equal(f.finished(healthy.row.id).length, 0);
    assert.deepEqual(result.failedJobs.map((j) => j.jobId), [orphan.row.id]);
    assert.deepEqual(result.stoppedJobs.map((j) => j.jobId), [stopped.row.id]);
  });

  it("when the listing fails and a terminate by id fails too, records nothing for that job", async () => {
    const unconfirmed = launched({ status: "failed", finishedAt: ago(20) });
    const f = fakes({
      instances: new Error("Lambda API GET /instances failed (502)"),
      jobs: [unconfirmed.row],
      terminateFails: [unconfirmed.inst.id],
    });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [unconfirmed.inst.id]);
    assert.equal(f.named("finishJob").length, 0);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[1]!, /saved id/);
  });

  it("stops, not fails, a job an admin asked to stop whose workflow is gone", async () => {
    const asked = launched({ stopRequested: true, maxMinutes: 300, launchedAt: ago(20) });
    const f = fakes({ instances: [asked.inst], jobs: [asked.row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [asked.inst.id]);
    assert.deepEqual(f.finished(asked.row.id), [
      { status: "stopped", reason: "The sweep terminated the instance: Someone asked to stop the job.", terminatedAt: NOW },
    ]);
    assert.deepEqual(result.stoppedJobs, [{ jobId: asked.row.id, reason: "Someone asked to stop the job." }]);
    assert.deepEqual(result.failedJobs, []);
  });

  it("stops, not fails, a stuck job an admin asked to stop", async () => {
    const queued = job({ status: "queued", stopRequested: true, launchedAt: null, createdAt: ago(16) });
    const f = fakes({ instances: [], jobs: [queued] });
    const result = await sweepTraining(f.deps, NOW);
    assert.equal(f.finished(queued.id)[0]?.status, "stopped");
    assert.deepEqual(result.stoppedJobs.map((j) => j.jobId), [queued.id]);
  });

  it("terminates the instance of a runner that died, well before the job's time limit", async () => {
    const dead = launched({ maxMinutes: 300, maxUsd: 40, launchedAt: ago(30), firstHeartbeatAt: ago(25), lastHeartbeatAt: ago(12) });
    const f = fakes({ instances: [dead.inst], jobs: [dead.row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [dead.inst.id]);
    assert.equal(f.finished(dead.row.id)[0]?.status, "failed");
    assert.deepEqual(result.failedJobs, [{ jobId: dead.row.id, reason: "No heartbeat for 10 minutes." }]);
  });

  it("finds a renamed instance by its saved id instead of calling it gone", async () => {
    const ended = launched({ status: "succeeded", finishedAt: ago(5) });
    const renamed = { ...ended.inst, name: "renamed-box" };
    const f = fakes({ instances: [renamed], jobs: [ended.row] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [renamed.id]);
    assert.deepEqual(f.finished(ended.row.id), [
      { status: "succeeded", reason: "The sweep terminated the instance: The job already ended.", terminatedAt: NOW },
    ]);
    assert.equal(result.instances, 0, "only mm-train- instances are counted");
  });

  it("holds an open job's renamed instance to its limits", async () => {
    const late = launched({ maxMinutes: 30, launchedAt: ago(41) });
    const renamed = { ...late.inst, name: "debug-box" };
    const f = fakes({ instances: [renamed], jobs: [late.row] });
    await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [renamed.id]);
    assert.equal(f.finished(late.row.id)[0]?.status, "failed");
  });

  it("finds an instance by its job tag, and never touches an unnamed one no job claims", async () => {
    const ended = job({ status: "failed", finishedAt: ago(5) });
    const tagged = { ...instance({ id: "tagged", name: "renamed-box" }), tags: [{ key: "muse-muse-job", value: ended.id }] } as LambdaInstance;
    const strangers = [
      instance({ id: "mine-not", name: "renamed-too" }),
      { ...instance({ id: "bad-tag", name: "other" }), tags: [{ key: "muse-muse-job", value: "not-a-uuid" }] } as LambdaInstance,
    ];
    const f = fakes({ instances: [tagged, ...strangers], jobs: [ended] });
    await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), ["tagged"]);
    assert.equal(f.finished(ended.id)[0]?.status, "failed");
    assert.deepEqual((f.named("jobsForInstances")[0]!.args[0] as { jobIds: string[] }).jobIds, [ended.id]);
  });

  it("asks Lambda about a saved instance the listing misses before calling it gone", async () => {
    const ended = launched({ status: "failed", finishedAt: ago(5) });
    const f = fakes({ instances: [], jobs: [ended.row] });
    // Listed as nothing, but Lambda still has it live.
    f.deps.getInstance = async (id) => (id === ended.inst.id ? { ...ended.inst, status: "active" } : null);
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), [ended.inst.id]);
    assert.equal(f.finished(ended.row.id)[0]?.terminatedAt, NOW);
    assert.equal(result.terminated.length, 1);
  });

  it("waits for the listing before calling a launch with no saved id gone", async () => {
    // terminateStep ended these without terminatedAt because Lambda didn't list their launch yet.
    const fresh = job({ status: "failed", instanceId: null, launchedAt: ago(9), createdAt: ago(9), finishedAt: ago(UNLISTED_GRACE_MS / MIN - 1) });
    const old = job({ status: "failed", instanceId: null, launchedAt: ago(30), createdAt: ago(30), finishedAt: ago(UNLISTED_GRACE_MS / MIN) });
    const f = fakes({ instances: [], jobs: [fresh, old] });
    await sweepTraining(f.deps, NOW);
    assert.equal(f.finished(fresh.id).length, 0, "still holds its GPU slot");
    assert.deepEqual(f.finished(old.id), [{ status: "failed", reason: "The instance was already gone.", terminatedAt: old.finishedAt }]);
    assert.equal(f.named("getInstance").length, 0);
  });

  it("keeps going when one terminate fails", async () => {
    const a = instance({ id: "a", name: "mm-train-aaaaaaaa-smoke" });
    const b = instance({ id: "b", name: "mm-train-bbbbbbbb-smoke" });
    const f = fakes({ instances: [a, b], terminateFails: ["a"] });
    const result = await sweepTraining(f.deps, NOW);
    assert.deepEqual(f.terminatedIds(), ["a", "b"]);
    assert.deepEqual(
      result.terminated.map((t) => t.instanceId),
      ["b"],
    );
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /mm-train-aaaaaaaa-smoke/);
  });
});
