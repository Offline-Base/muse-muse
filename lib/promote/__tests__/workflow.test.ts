/**
 * Runs publishImportedProduct as a plain function with every step faked and sleep() instant, to check the
 * orchestration: the build workflow's own deploy steps with the product's ids and sandbox, the link saved only once the
 * deployment is READY, a deploy event in the build room, the reason there when Vercel fails or the deploy runs past its
 * cap, and the sandbox put back to sleep either way.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/promote/__tests__/workflow.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

type Call = { step: string; arg: unknown };

let calls: Call[] = [];
let polls: Array<{ state: string; errorMessage?: string }> = [];
let deployThrows: Error | null = null;
/** The emitStep call (1-based) that throws, or 0 for none. */
let emitFailsAt = 0;

const record = (step: string, arg?: unknown) => void calls.push({ step, arg });
const named = (step: string) => calls.filter((c) => c.step === step);
const LIVE = "https://musemuse-bird-count.vercel.app";
const INPUT = { productId: "prod-1", buildId: "build-1", sandboxName: "product-bird-count-0a1b2c3d" };

const pipelineSteps = {
  emitStep: async (buildId: string, body: unknown) => {
    if (named("emitStep").length + 1 === emitFailsAt) throw new Error("the database didn't answer");
    record("emitStep", { buildId, body });
  },
  startDeployStep: async (input: unknown) => {
    record("startDeployStep", input);
    if (deployThrows) throw deployThrows;
    return { projectId: "prj_1", deploymentId: "dpl_1", liveTokenId: "tok-live" };
  },
  pollDeployStep: async (id: string) => {
    record("pollDeployStep", id);
    const next = polls.length > 1 ? polls.shift()! : (polls[0] ?? { state: "BUILDING" });
    return { url: LIVE, ...next };
  },
};

const importSteps = {
  importLiveStep: async (input: unknown) => record("importLiveStep", input),
  importFailedStep: async (input: unknown) => record("importFailedStep", input),
  hibernateIdleStep: async (input: unknown) => record("hibernateIdleStep", input),
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let wf: typeof import("../workflow");

describe("publishing an imported product", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../../pipeline/build-steps.ts", import.meta.url).href, { namedExports: pipelineSteps });
    mock.module(new URL("../steps.ts", import.meta.url).href, { namedExports: importSteps });
    mock.module("workflow", { namedExports: { sleep: async () => undefined } });
    wf = await import("../workflow");
  });

  beforeEach(() => {
    calls = [];
    polls = [];
    deployThrows = null;
    emitFailsAt = 0;
  });

  it("deploys with the build workflow's own steps, saves the link once READY and says so in the build room", async () => {
    polls = [{ state: "QUEUED" }, { state: "BUILDING" }, { state: "READY" }];
    assert.deepEqual(await wf.publishImportedProduct(INPUT), { liveUrl: LIVE });
    assert.deepEqual(
      calls.map((c) => c.step),
      ["emitStep", "startDeployStep", "pollDeployStep", "pollDeployStep", "pollDeployStep", "importLiveStep", "emitStep", "hibernateIdleStep"],
    );
    assert.deepEqual(named("startDeployStep")[0]!.arg, INPUT);
    assert.deepEqual(named("pollDeployStep").map((c) => c.arg), ["dpl_1", "dpl_1", "dpl_1"]);
    assert.deepEqual(named("importLiveStep")[0]!.arg, { productId: "prod-1", liveUrl: LIVE, projectId: "prj_1", liveTokenId: "tok-live" });
    const [note, deploy] = named("emitStep").map((c) => c.arg as { buildId: string; body: { type: string; url?: string; text?: string } });
    assert.equal(note!.body.type, "log");
    assert.match(note!.body.text!, /Imported from a local run/);
    assert.deepEqual(deploy, { buildId: "build-1", body: { type: "deploy", url: LIVE } });
    assert.deepEqual(named("hibernateIdleStep")[0]!.arg, { productId: "prod-1", sandboxName: INPUT.sandboxName });
    assert.equal(named("importFailedStep").length, 0);
  });

  it("leaves the product without a link, and the reason in its build room, when Vercel can't deploy it", async () => {
    polls = [{ state: "BUILDING" }, { state: "ERROR", errorMessage: "Build failed: next build exited 1" }];
    assert.deepEqual(await wf.publishImportedProduct(INPUT), { liveUrl: null });
    assert.equal(named("importLiveStep").length, 0);
    assert.equal(named("emitStep").length, 1, "no deploy event");
    const failed = named("importFailedStep")[0]!.arg as { buildId: string; productId: string; message: string };
    assert.equal(failed.buildId, "build-1");
    assert.equal(failed.productId, "prod-1");
    assert.equal(failed.message, "Vercel could not deploy the product (error). Build failed: next build exited 1");
    assert.equal(named("hibernateIdleStep").length, 1);
  });

  it("stops waiting at the deploy step's cap", async () => {
    polls = [{ state: "BUILDING" }];
    assert.deepEqual(await wf.publishImportedProduct(INPUT), { liveUrl: null });
    // 6 minutes at one poll every 10 s, so the poll count ends it even when the workflow clock lags.
    assert.equal(named("pollDeployStep").length, 36);
    assert.equal((named("importFailedStep")[0]!.arg as { message: string }).message, "The deployment did not finish within 6 minutes.");
    assert.equal(named("hibernateIdleStep").length, 1);
  });

  it("says which step failed when the deploy can't start, and still puts the sandbox back to sleep", async () => {
    deployThrows = new Error('Step "startDeployStep" failed after 2 retries: Sandbox product-bird-count-0a1b2c3d was not found');
    assert.deepEqual(await wf.publishImportedProduct(INPUT), { liveUrl: null });
    assert.equal(named("pollDeployStep").length, 0);
    assert.equal(
      (named("importFailedStep")[0]!.arg as { message: string }).message,
      "The deploy step failed: Sandbox product-bird-count-0a1b2c3d was not found",
    );
    assert.equal(named("hibernateIdleStep").length, 1);
  });

  it("keeps the saved link when only the deploy event fails to go out", async () => {
    polls = [{ state: "READY" }];
    emitFailsAt = 2;
    assert.deepEqual(await wf.publishImportedProduct(INPUT), { liveUrl: LIVE });
    assert.equal(named("importLiveStep").length, 1);
    assert.equal(named("importFailedStep").length, 0, "the product is live, so nothing is revoked");
    assert.equal(named("hibernateIdleStep").length, 1);
  });
});
