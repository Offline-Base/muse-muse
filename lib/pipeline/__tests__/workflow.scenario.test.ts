/**
 * Runs buildProduct and refineProduct as plain functions with every step faked and sleep() instant, to check the
 * orchestration: status order, fix rounds, outcomes, timeouts, cleanup and failure messages.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/*.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";

type Call = { step: string; args: unknown[] };

interface Scenario {
  head?: { kind: "build" | "refine"; status: string; productId: string | null };
  paused?: boolean;
  verdict?: "yes" | "partly" | "no";
  /** Polls until Muse Code finishes, per run. Infinity never finishes. */
  musePolls?: number;
  museExit?: number;
  /** One entry per verify run: did it pass, and which steps were ok. Last entry repeats. */
  verifies?: Array<{ passed: boolean; steps?: Record<string, boolean>; timeout?: boolean }>;
  judgePass?: boolean;
  buildNotes?: boolean;
  demoThrows?: boolean;
  deployState?: "READY" | "ERROR";
  provisionThrows?: Error;
}

let scenario: Scenario = {};
let calls: Call[] = [];
let verifyRuns = 0;
let musePolled = 0;

function record(step: string, ...args: unknown[]) {
  calls.push({ step, args });
}

function named(step: string) {
  return calls.filter((c) => c.step === step);
}

function statuses(): string[] {
  return named("setStatusStep").map((c) => c.args[1] as string);
}

const fakeSteps = {
  loadBuildStep: async (buildId: string) => {
    record("loadBuildStep", buildId);
    return scenario.head ?? { kind: "build", status: "queued", productId: null };
  },
  setStatusStep: async (...args: unknown[]) => record("setStatusStep", ...args),
  emitStep: async (...args: unknown[]) => record("emitStep", ...args),
  spendPausedStep: async () => {
    record("spendPausedStep");
    return scenario.paused ?? false;
  },
  failStep: async (input: unknown) => record("failStep", input),
  cleanupStep: async (input: unknown) => record("cleanupStep", input),
  briefStep: async (buildId: string) => {
    record("briefStep", buildId);
    return {
      verdict: scenario.verdict ?? "yes",
      refusal: scenario.verdict === "no" ? "We don't clone real brands." : null,
      name: "Shelf Scout",
      tagline: "Find the book you saw",
      model: "muse-spark-1.3",
    };
  },
  createProductStep: async (buildId: string) => {
    record("createProductStep", buildId);
    return { productId: "prod-1", slug: "shelf-scout" };
  },
  fixturesStep: async (buildId: string) => {
    record("fixturesStep", buildId);
    return [{ fileName: "fixture.png", url: "https://x/fixture.png", description: "a shelf" }];
  },
  provisionStep: async (input: unknown) => {
    record("provisionStep", input);
    if (scenario.provisionThrows) throw scenario.provisionThrows;
    return { sandboxName: "product-shelf-scout", sessionId: "sess-1", images: ["inspo/a.png"] };
  },
  startMuseStep: async (input: { round: number }) => {
    record("startMuseStep", input);
    musePolled = 0;
    return { cmdId: `cmd-${input.round}`, logPath: `/log/${input.round}` };
  },
  pollMuseStep: async (input: unknown) => {
    record("pollMuseStep", input);
    musePolled += 1;
    const done = musePolled >= (scenario.musePolls ?? 2);
    return { done, exitCode: done ? (scenario.museExit ?? 0) : null, offset: musePolled * 100 };
  },
  killStep: async (...args: unknown[]) => record("killStep", ...args),
  previewStep: async (...args: unknown[]) => {
    record("previewStep", ...args);
    return "https://sb-1.vercel.run";
  },
  startTaskStep: async (sandboxName: string, task: string) => {
    record("startTaskStep", sandboxName, task);
    if (task === "demo" && scenario.demoThrows) throw new Error("ffmpeg missing");
    if (task === "verify") verifyRuns += 1;
    return `${task}-cmd-${verifyRuns}`;
  },
  pollTaskStep: async (sandboxName: string, cmdId: string) => {
    record("pollTaskStep", sandboxName, cmdId);
    const v = currentVerify();
    if (cmdId.startsWith("verify") && v.timeout) return { done: false, exitCode: null, outputTail: "" };
    return { done: true, exitCode: 0, outputTail: "tail" };
  },
  collectVerifyStep: async (input: { round: number }) => {
    record("collectVerifyStep", input);
    const v = currentVerify();
    const steps = Object.entries(v.steps ?? { typecheck: v.passed, build: v.passed, start: v.passed }).map(
      ([name, ok]) => ({ name, ok }),
    );
    return { passed: v.passed, steps, screenshots: [{ url: "https://x/s.png", caption: "home" }] };
  },
  verifyTimedOutStep: async (input: unknown) => {
    record("verifyTimedOutStep", input);
    return { passed: false, steps: [], screenshots: [] };
  },
  judgeStep: async (input: unknown) => {
    record("judgeStep", input);
    return { pass: scenario.judgePass ?? true };
  },
  writeFixPromptStep: async (input: { fix: number }) => {
    record("writeFixPromptStep", input);
    return `fix-${input.fix}.md`;
  },
  buildNotesStep: async (sandboxName: string) => {
    record("buildNotesStep", sandboxName);
    return scenario.buildNotes ?? false;
  },
  finishDemoStep: async (input: unknown) => {
    record("finishDemoStep", input);
    return "https://x/demo.mp4";
  },
  startDeployStep: async (input: unknown) => {
    record("startDeployStep", input);
    return { projectId: "prj_1", deploymentId: "dpl_1", liveTokenId: "tok-live" };
  },
  pollDeployStep: async (id: string) => {
    record("pollDeployStep", id);
    const state = scenario.deployState ?? "READY";
    return { state, url: "https://musemuse-shelf-scout.vercel.app", errorMessage: state === "ERROR" ? "Build failed" : undefined };
  },
  registerStep: async (input: unknown) => record("registerStep", input),
  loadRefineStep: async (buildId: string) => {
    record("loadRefineStep", buildId);
    return {
      productId: "prod-1",
      name: "Shelf Scout",
      tagline: "Find the book you saw",
      sandboxName: "product-shelf-scout",
      sessionId: "sess-1",
      model: "muse-spark-1.3",
      refineIndex: 1,
    };
  },
  reopenStep: async (input: unknown) => {
    record("reopenStep", input);
    return { promptFile: "refine-1.md", images: [] };
  },
};

function currentVerify() {
  const list = scenario.verifies ?? [{ passed: true }];
  return list[Math.min(Math.max(verifyRuns - 1, 0), list.length - 1)]!;
}

const canMock = typeof (mock as { module?: unknown }).module === "function";
let wf: typeof import("../workflow");

function reset(next: Scenario) {
  scenario = next;
  calls = [];
  verifyRuns = 0;
  musePolled = 0;
}

describe("build workflow orchestration", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../build-steps.ts", import.meta.url).href, { namedExports: fakeSteps });
    mock.module("workflow", { namedExports: { sleep: async () => undefined } });
    wf = await import("../workflow");
  });

  it("ships a build that passes on the first check", async () => {
    reset({});
    assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
    assert.deepEqual(statuses(), [
      "briefing",
      "provisioning",
      "building",
      "previewing",
      "verifying",
      "recording",
      "deploying",
      "deploying",
      "live",
    ]);
    assert.deepEqual(named("startMuseStep")[0]!.args[0], {
      sandboxName: "product-shelf-scout",
      sessionId: "sess-1",
      promptFile: "brief.md",
      images: ["inspo/a.png"],
      model: "muse-spark-1.3",
      round: 0,
    });
    assert.equal(named("judgeStep").length, 1);
    assert.equal((named("registerStep")[0]!.args[0] as { status: string }).status, "live");
    assert.equal((named("registerStep")[0]!.args[0] as { demoVideoUrl: string }).demoVideoUrl, "https://x/demo.mp4");
    assert.deepEqual(named("cleanupStep")[0]!.args[0], {
      buildId: "b1",
      productId: "prod-1",
      sandboxName: "product-shelf-scout",
    });
    assert.equal(named("failStep").length, 0);
    // Poll offsets carry forward between polls.
    assert.deepEqual(
      named("pollMuseStep").map((c) => (c.args[0] as { offset: number }).offset),
      [0, 100],
    );
  });

  it("stops at a refusal without making a product or a sandbox", async () => {
    reset({ verdict: "no" });
    assert.deepEqual(await wf.buildProduct({ buildId: "b2" }), { status: "refused" });
    assert.deepEqual(statuses(), ["briefing", "refused"]);
    assert.deepEqual(named("setStatusStep")[1]!.args[2], {
      message: "We don't clone real brands.",
      error: "We don't clone real brands.",
    });
    assert.equal(named("createProductStep").length, 0);
    assert.equal(named("cleanupStep").length, 0);
  });

  it("runs fix rounds in the same session until the checks pass", async () => {
    reset({ verifies: [{ passed: false }, { passed: false }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b3" }), { status: "live" });
    assert.deepEqual(
      named("startMuseStep").map((c) => (c.args[0] as { round: number; promptFile: string; sessionId: string }).round),
      [0, 1, 2],
    );
    assert.deepEqual(
      named("startMuseStep").map((c) => (c.args[0] as { promptFile: string }).promptFile),
      ["brief.md", "fix-1.md", "fix-2.md"],
    );
    assert.ok(named("startMuseStep").every((c) => (c.args[0] as { sessionId: string }).sessionId === "sess-1"));
    assert.deepEqual(
      named("collectVerifyStep").map((c) => (c.args[0] as { round: number }).round),
      [0, 1, 2],
    );
    assert.deepEqual(
      named("writeFixPromptStep").map((c) => c.args[0]),
      [
        { buildId: "b3", sandboxName: "product-shelf-scout", fix: 1, verifiedRound: 0 },
        { buildId: "b3", sandboxName: "product-shelf-scout", fix: 2, verifiedRound: 1 },
      ],
    );
    const fixing = named("setStatusStep").filter((c) => c.args[1] === "fixing");
    assert.deepEqual(
      fixing.map((c) => (c.args[2] as { fixRounds: number }).fixRounds),
      [1, 2],
    );
    // The judge only runs once verify passes.
    assert.equal(named("judgeStep").length, 1);
  });

  it("fixes when the judge fails even though verify passed", async () => {
    reset({ verifies: [{ passed: true }], judgePass: false, buildNotes: false });
    assert.deepEqual(await wf.buildProduct({ buildId: "b4" }), { status: "failed" });
    assert.equal(named("judgeStep").length, 4);
    assert.equal(named("startMuseStep").length, 4);
    // Verify passed, so typecheck/build/start were ok, but without build notes it can't ship as partial.
    assert.equal(named("startDeployStep").length, 0);
  });

  it("ships as partial when the app builds and runs and the build notes exist", async () => {
    reset({
      verifies: [{ passed: false, steps: { typecheck: true, build: true, start: true, smoke: false } }],
      buildNotes: true,
    });
    assert.deepEqual(await wf.buildProduct({ buildId: "b5" }), { status: "partial" });
    assert.equal(named("collectVerifyStep").length, 4);
    assert.equal((named("registerStep")[0]!.args[0] as { status: string }).status, "partial");
    assert.equal(statuses().at(-1), "partial");
  });

  it("fails without deploying when the app doesn't build after the last round", async () => {
    reset({ verifies: [{ passed: false, steps: { typecheck: true, build: false } }], buildNotes: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b6" }), { status: "failed" });
    assert.equal(named("startDeployStep").length, 0);
    assert.deepEqual(named("failStep")[0]!.args[0], {
      buildId: "b6",
      productId: "prod-1",
      message: "The product did not pass its checks after 3 fix rounds, so it was not deployed.",
    });
    assert.equal(named("cleanupStep").length, 1);
  });

  it("kills Muse Code at the 20-minute cap and fails the build", async () => {
    reset({ musePolls: Infinity });
    assert.deepEqual(await wf.buildProduct({ buildId: "b7" }), { status: "failed" });
    assert.equal(named("pollMuseStep").length, 80);
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-0"]);
    assert.equal(
      (named("failStep")[0]!.args[0] as { message: string }).message,
      "Muse Code ran past its 20-minute limit and was stopped.",
    );
    assert.equal(named("cleanupStep").length, 1);
  });

  it("treats a verify run that hangs as a failed check", async () => {
    reset({ verifies: [{ passed: false, timeout: true }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b8" }), { status: "live" });
    assert.equal(named("verifyTimedOutStep").length, 1);
    assert.equal(named("killStep").length, 1);
    assert.equal(named("pollTaskStep").filter((c) => String(c.args[1]).startsWith("verify-cmd-1")).length, 48);
  });

  it("reports a step that ran out of retries in plain words and still cleans up", async () => {
    const err = Object.assign(new Error('Step "step//./lib/pipeline/build-steps//provisionStep" failed after 2 retries: boom'), {
      name: "FatalError",
    });
    reset({ provisionThrows: err });
    assert.deepEqual(await wf.buildProduct({ buildId: "b9" }), { status: "failed" });
    assert.deepEqual(named("failStep")[0]!.args[0], {
      buildId: "b9",
      productId: "prod-1",
      message: "The sandbox setup step failed: boom",
    });
    assert.deepEqual(named("cleanupStep")[0]!.args[0], { buildId: "b9", productId: "prod-1", sandboxName: null });
  });

  it("stops before spending when the daily cap is reached", async () => {
    reset({ paused: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b10" }), { status: "failed" });
    assert.equal(named("briefStep").length, 0);
    assert.match((named("failStep")[0]!.args[0] as { message: string }).message, /spending cap/);
    assert.equal(named("cleanupStep").length, 0);
  });

  it("keeps going when the demo recording fails", async () => {
    reset({ demoThrows: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b11" }), { status: "live" });
    assert.ok(named("emitStep").some((c) => String((c.args[1] as { text?: string }).text).includes("demo recording was skipped")));
    assert.equal((named("registerStep")[0]!.args[0] as { demoVideoUrl: string | null }).demoVideoUrl, null);
  });

  it("fails when Vercel can't deploy", async () => {
    reset({ deployState: "ERROR" });
    assert.deepEqual(await wf.buildProduct({ buildId: "b12" }), { status: "failed" });
    assert.match((named("failStep")[0]!.args[0] as { message: string }).message, /Vercel could not deploy/);
    assert.equal(named("registerStep").length, 0);
  });

  it("does nothing for a build that already finished", async () => {
    reset({ head: { kind: "build", status: "live", productId: "prod-1" } });
    assert.deepEqual(await wf.buildProduct({ buildId: "b13" }), { status: "live" });
    assert.deepEqual(
      calls.map((c) => c.step),
      ["loadBuildStep"],
    );
  });

  it("refines in the product's session with its own log rounds, and keeps the product on failure", async () => {
    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" } });
    assert.deepEqual(await wf.refineProduct({ buildId: "r1" }), { status: "live" });
    assert.deepEqual(named("startMuseStep")[0]!.args[0], {
      sandboxName: "product-shelf-scout",
      sessionId: "sess-1",
      promptFile: "refine-1.md",
      images: [],
      model: "muse-spark-1.3",
      round: 10,
    });
    assert.equal(named("createProductStep").length, 0);
    assert.equal(named("cleanupStep").length, 1);

    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, verifies: [{ passed: false }] });
    assert.deepEqual(await wf.refineProduct({ buildId: "r2" }), { status: "failed" });
    assert.deepEqual(
      named("startMuseStep").map((c) => (c.args[0] as { round: number }).round),
      [10, 11, 12, 13],
    );
    const fail = named("failStep")[0]!.args[0] as { productId: string | null; message: string };
    assert.equal(fail.productId, null);
    assert.match(fail.message, /live version was kept/);
  });
});
