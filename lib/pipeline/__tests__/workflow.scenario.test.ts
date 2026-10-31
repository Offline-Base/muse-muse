/**
 * Runs buildProduct and refineProduct as plain functions with every step faked and sleep() instant, to check the
 * orchestration: status order, fix rounds, outcomes, timeouts, the owner's Stop, cleanup and failure messages.
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
  judgeBlocking?: boolean;
  judgeThrows?: boolean;
  /** The poll (1-based, per run) that reads run.usage. */
  usageAtPoll?: number;
  previewThrows?: boolean;
  refineRefusal?: string;
  demoThrows?: boolean;
  /** The demo task never finishes, so it hits the record step's cap. */
  demoTimeout?: boolean;
  /** What finishDemoStep returns. Defaults to a video with a poster. */
  demo?: { videoUrl: string | null; posterUrl: string | null };
  deployState?: "READY" | "ERROR";
  /** False makes publishOffStep give a reason. Defaults to true. */
  publish?: boolean;
  provisionThrows?: Error;
  /** The poll, counted across the whole build (1-based), from which every poll reports the owner's Stop. */
  stopAtPoll?: number;
  /** The owner's Stop shows up only when a run's round is taken off the build row, as it can just before the cap. */
  stopOnRoundClear?: boolean;
}

let scenario: Scenario = {};
let calls: Call[] = [];
let verifyRuns = 0;
let musePolled = 0;
let polledTotal = 0;

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
  museRoundStep: async (buildId: string, round: number | null) => {
    record("museRoundStep", buildId, round);
    return round === null && scenario.stopOnRoundClear === true;
  },
  pollMuseStep: async (input: { usageRecorded?: boolean; announced?: string[] }) => {
    record("pollMuseStep", input);
    musePolled += 1;
    polledTotal += 1;
    const done = musePolled >= (scenario.musePolls ?? 2);
    const usageRecorded = Boolean(input.usageRecorded) || musePolled === scenario.usageAtPoll;
    const announced = [...(input.announced ?? []), `reminder:${musePolled}`];
    // Only the first poll reads run.usage here; the later ones say nothing.
    const childrenIncluded = musePolled === 1 ? false : null;
    const stopRequested = scenario.stopAtPoll !== undefined && polledTotal >= scenario.stopAtPoll;
    return {
      done,
      exitCode: done ? (scenario.museExit ?? 0) : null,
      offset: musePolled * 100,
      usageRecorded,
      announced,
      childrenIncluded,
      stopRequested,
    };
  },
  killStep: async (...args: unknown[]) => record("killStep", ...args),
  previewStep: async (...args: unknown[]) => {
    record("previewStep", ...args);
    if (scenario.previewThrows) throw new Error("Preview did not answer 200 on port 3000 (last status 500).");
    return "https://sb-1.vercel.run";
  },
  startTaskStep: async (sandboxName: string, task: string, env?: Record<string, string>) => {
    record("startTaskStep", sandboxName, task, env);
    if (task === "demo" && scenario.demoThrows) throw new Error("ffmpeg missing");
    if (task === "verify") verifyRuns += 1;
    return `${task}-cmd-${verifyRuns}`;
  },
  startTaskWithEnvStep: (sandboxName: string, task: string, env: Record<string, string>) => fakeSteps.startTaskStep(sandboxName, task, env),
  pollTaskStep: async (sandboxName: string, cmdId: string) => {
    record("pollTaskStep", sandboxName, cmdId);
    const v = currentVerify();
    if (cmdId.startsWith("verify") && v.timeout) return { done: false, exitCode: null, outputTail: "" };
    if (cmdId.startsWith("demo") && scenario.demoTimeout) return { done: false, exitCode: null, outputTail: "" };
    return { done: true, exitCode: 0, outputTail: "tail" };
  },
  collectVerifyStep: async (input: { round: number }) => {
    record("collectVerifyStep", input);
    const v = currentVerify();
    const all = Object.fromEntries(["typecheck", "build", "start", "console", "smoke", "manifest"].map((n) => [n, v.passed]));
    const steps = Object.entries(v.steps ?? all).map(([name, ok]) => ({ name, ok }));
    return { passed: v.passed, steps, screenshots: [{ url: "https://x/s.png", caption: "home" }] };
  },
  verifyTimedOutStep: async (input: unknown) => {
    record("verifyTimedOutStep", input);
    return { passed: false, steps: [], screenshots: [] };
  },
  judgeStep: async (input: unknown) => {
    record("judgeStep", input);
    if (scenario.judgeThrows) throw new Error('Step "judgeStep" failed after 1 retry: judge_verdict: no valid reply');
    const pass = scenario.judgePass ?? true;
    return { pass, blocking: pass ? false : (scenario.judgeBlocking ?? true) };
  },
  writeFixPromptStep: async (input: { fix: number }) => {
    record("writeFixPromptStep", input);
    return { promptFile: `fix-${input.fix}.md`, images: [`.muse-fix/round-${input.fix}-1.png`] };
  },
  demoSpecStep: async (input: unknown) => record("demoSpecStep", input),
  finishDemoStep: async (input: unknown) => {
    record("finishDemoStep", input);
    return scenario.demo ?? { videoUrl: "https://x/demo.mp4", posterUrl: "https://x/poster.jpg" };
  },
  publishOffStep: async () => {
    record("publishOffStep");
    return scenario.publish === false ? "VERCEL_TOKEN isn't set" : null;
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
  refineCheckStep: async (buildId: string) => {
    record("refineCheckStep", buildId);
    return { refusal: scenario.refineRefusal ?? null };
  },
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
  polledTotal = 0;
}

describe("build workflow orchestration", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../build-steps.ts", import.meta.url).href, { namedExports: fakeSteps });
    mock.module("workflow", { namedExports: { sleep: async () => undefined } });
    wf = await import("../workflow");
  });

  it("registers without deploying when publishing is off, as on a local run", async () => {
    reset({ publish: false });
    assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
    assert.equal(named("startDeployStep").length, 0);
    assert.equal(named("pollDeployStep").length, 0);
    const reg = named("registerStep")[0]!.args[0] as { liveUrl: unknown; projectId: unknown; liveTokenId: unknown; demoVideoUrl: string; demoPosterUrl: string };
    assert.deepEqual([reg.liveUrl, reg.projectId, reg.liveTokenId], [null, null, null]);
    assert.equal(reg.demoVideoUrl, "https://x/demo.mp4");
    assert.equal(reg.demoPosterUrl, "https://x/poster.jpg");
    assert.equal(named("cleanupStep").length, 1);
    assert.equal(statuses().at(-1), "live");
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
    // Poll offsets, the helper agents already announced and run.usage's children_included carry forward between polls.
    assert.deepEqual(
      named("pollMuseStep").map((c) => (c.args[0] as { offset: number }).offset),
      [0, 100],
    );
    assert.deepEqual(
      named("pollMuseStep").map((c) => (c.args[0] as { announced: string[] }).announced),
      [[], ["reminder:1"]],
    );
    assert.deepEqual(
      named("pollMuseStep").map((c) => (c.args[0] as { childrenIncluded: boolean | null }).childrenIncluded),
      [null, false],
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
    // Each fix run attaches the screenshots its fix prompt step copied in, and the first run keeps the inspo.
    assert.deepEqual(
      named("startMuseStep").map((c) => (c.args[0] as { images: string[] }).images),
      [["inspo/a.png"], [".muse-fix/round-1-1.png"], [".muse-fix/round-2-1.png"]],
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

  it("fixes when the judge fails even though verify passed, and never ships a blocking failure", async () => {
    reset({ verifies: [{ passed: true }], judgePass: false, judgeBlocking: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b4" }), { status: "failed" });
    assert.equal(named("judgeStep").length, 4);
    assert.equal(named("startMuseStep").length, 4);
    // Every verify step passed, but the judge said it copies the inspo or shows no result.
    assert.equal(named("startDeployStep").length, 0);
  });

  it("ships as partial when every test passed and the judge failed it only on minor things", async () => {
    reset({ verifies: [{ passed: true }], judgePass: false, judgeBlocking: false });
    assert.deepEqual(await wf.buildProduct({ buildId: "b5" }), { status: "partial" });
    assert.equal(named("collectVerifyStep").length, 4);
    // Only the last round's verify runs the screen checks in warn mode, so the judge has the last word.
    assert.deepEqual(
      named("startTaskStep").filter((c) => c.args[1] === "verify").map((c) => c.args[2]),
      [undefined, undefined, undefined, { MUSEMUSE_SCREEN_CHECK: "warn" }],
    );
    assert.equal((named("registerStep")[0]!.args[0] as { status: string }).status, "partial");
    assert.equal(statuses().at(-1), "partial");
  });

  it("fails when the smoke test still fails after the last round, even though the app builds and starts", async () => {
    reset({ verifies: [{ passed: false, steps: { typecheck: true, build: true, start: true, console: true, smoke: false } }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b5b" }), { status: "failed" });
    assert.equal(named("collectVerifyStep").length, 4);
    assert.equal(named("judgeStep").length, 0);
    assert.equal(named("startDeployStep").length, 0);
  });

  it("fails without deploying when the app doesn't build after the last round", async () => {
    reset({ verifies: [{ passed: false, steps: { typecheck: true, build: false } }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b6" }), { status: "failed" });
    assert.equal(named("startDeployStep").length, 0);
    assert.deepEqual(named("failStep")[0]!.args[0], {
      buildId: "b6",
      productId: "prod-1",
      message: "The product did not pass its checks after 3 fix rounds, so it was not deployed.",
    });
    assert.equal(named("cleanupStep").length, 1);
  });

  it("kills Muse Code at the 25-minute cap and fails the build", async () => {
    reset({ musePolls: Infinity });
    assert.deepEqual(await wf.buildProduct({ buildId: "b7" }), { status: "failed" });
    // 100 polls, then one more after the kill to read (and charge) what the run wrote on its way out.
    assert.equal(named("pollMuseStep").length, 101);
    assert.equal((named("pollMuseStep")[100]!.args[0] as { offset: number }).offset, 10000);
    assert.ok(calls.findIndex((c) => c.step === "killStep") < calls.findLastIndex((c) => c.step === "pollMuseStep"));
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-0"]);
    assert.equal(
      (named("failStep")[0]!.args[0] as { message: string }).message,
      "Muse Code ran past its 25-minute limit and was stopped.",
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
    const reg = named("registerStep")[0]!.args[0] as { demoVideoUrl: string | null; demoPosterUrl: string | null };
    assert.deepEqual([reg.demoVideoUrl, reg.demoPosterUrl], [null, null]);
  });

  it("writes Demo Studio's spec before the demo starts, and registers the poster with the video", async () => {
    reset({});
    assert.deepEqual(await wf.buildProduct({ buildId: "b19" }), { status: "live" });
    assert.deepEqual(named("demoSpecStep")[0]!.args[0], {
      buildId: "b19",
      productId: "prod-1",
      sandboxName: "product-shelf-scout",
      title: "Shelf Scout",
      tagline: "Find the book you saw",
    });
    const order = calls.map((c) => (c.step === "startTaskStep" ? `startTaskStep:${String(c.args[1])}` : c.step));
    assert.ok(order.indexOf("demoSpecStep") < order.indexOf("startTaskStep:demo"));
    assert.ok(order.indexOf("startTaskStep:demo") < order.indexOf("finishDemoStep"));
    const reg = named("registerStep")[0]!.args[0] as { demoVideoUrl: string; demoPosterUrl: string };
    assert.deepEqual([reg.demoVideoUrl, reg.demoPosterUrl], ["https://x/demo.mp4", "https://x/poster.jpg"]);

    // A run that didn't pass gives no video, says so, and still ships.
    reset({ demo: { videoUrl: null, posterUrl: null } });
    assert.deepEqual(await wf.buildProduct({ buildId: "b20" }), { status: "live" });
    assert.ok(named("emitStep").some((c) => (c.args[1] as { text?: string }).text === "The demo run did not pass, so no video was published."));
    assert.equal((named("registerStep")[0]!.args[0] as { demoVideoUrl: string | null }).demoVideoUrl, null);
  });

  it("stops a demo recording at the record step's 9-minute cap and ships without a video", async () => {
    reset({ demoTimeout: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b21" }), { status: "live" });
    assert.equal(named("pollTaskStep").filter((c) => String(c.args[1]).startsWith("demo")).length, 54);
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "demo-cmd-1"]);
    assert.equal(named("finishDemoStep").length, 0);
    assert.ok(named("emitStep").some((c) => (c.args[1] as { text?: string }).text === "The demo recording ran too long and was skipped."));
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
    // A refinement's screen checks stay strict on its last round too.
    assert.ok(named("startTaskStep").every((c) => c.args[2] === undefined));
  });

  it("keeps the live version when a change builds but doesn't fully pass, instead of shipping it as partial", async () => {
    const refine = { kind: "refine" as const, status: "queued", productId: "prod-1" };
    // Builds and starts, but the smoke test fails every round.
    reset({ head: refine, verifies: [{ passed: false, steps: { typecheck: true, build: true, start: true, console: true, smoke: false } }] });
    assert.deepEqual(await wf.refineProduct({ buildId: "r3" }), { status: "failed" });
    assert.equal(named("startDeployStep").length, 0);
    assert.equal(named("registerStep").length, 0);
    assert.equal(
      (named("failStep")[0]!.args[0] as { message: string }).message,
      "The change did not pass its checks, so it was not deployed. The live version was kept.",
    );

    // Every test passes, but the judge fails it on something minor every round.
    reset({ head: refine, verifies: [{ passed: true }], judgePass: false, judgeBlocking: false });
    assert.deepEqual(await wf.refineProduct({ buildId: "r4" }), { status: "failed" });
    assert.equal(named("judgeStep").length, 4);
    assert.equal(named("startDeployStep").length, 0);
    assert.equal((named("failStep")[0]!.args[0] as { productId: string | null }).productId, null);
  });

  it("checks a change request against the policy first and refuses it without resuming anything", async () => {
    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, refineRefusal: "Muse Muse won't copy a bank's sign-in page." });
    assert.deepEqual(await wf.refineProduct({ buildId: "r5" }), { status: "refused" });
    assert.deepEqual(statuses(), ["briefing", "refused"]);
    assert.deepEqual(named("setStatusStep")[1]!.args[2], {
      message: "Muse Muse won't copy a bank's sign-in page. The live version was kept.",
      error: "Muse Muse won't copy a bank's sign-in page. The live version was kept.",
    });
    for (const step of ["loadRefineStep", "reopenStep", "startMuseStep", "cleanupStep", "failStep"]) {
      assert.equal(named(step).length, 0, step);
    }

    // An allowed change runs the check before it resumes the sandbox.
    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" } });
    assert.deepEqual(await wf.refineProduct({ buildId: "r6" }), { status: "live" });
    const order = calls.map((c) => c.step);
    assert.ok(order.indexOf("refineCheckStep") < order.indexOf("loadRefineStep"));
    assert.ok(order.indexOf("refineCheckStep") < order.indexOf("reopenStep"));
  });

  it("goes on to the checks when the preview doesn't start", async () => {
    reset({ previewThrows: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b14" }), { status: "live" });
    assert.ok(
      named("emitStep").some((c) => String((c.args[1] as { text?: string }).text).startsWith("The preview did not start")),
    );
    assert.equal(named("collectVerifyStep").length, 1);
    assert.equal(named("failStep").length, 0);

    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, previewThrows: true });
    assert.deepEqual(await wf.refineProduct({ buildId: "r7" }), { status: "live" });
    assert.equal(named("collectVerifyStep").length, 1);
  });

  it("treats a judge that can't run as a failed, non-blocking check and runs the fix rounds", async () => {
    reset({ judgeThrows: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b15" }), { status: "partial" });
    assert.equal(named("judgeStep").length, 4);
    assert.equal(named("writeFixPromptStep").length, 3);
    const judged = named("emitStep").filter((c) => (c.args[1] as { type: string }).type === "judge");
    assert.equal(judged.length, 4);
    const first = judged[0]!.args[1] as { round: number; verdict: { pass: boolean; blocking: boolean; reasons: string[] } };
    assert.equal(first.round, 0);
    assert.equal(first.verdict.pass, false);
    assert.equal(first.verdict.blocking, false);
    assert.match(first.verdict.reasons.join(" "), /judge step failed: judge_verdict: no valid reply/);
  });

  it("writes the final status only after cleanup, so a refinement can't start while the sandbox is still held", async () => {
    reset({});
    assert.deepEqual(await wf.buildProduct({ buildId: "b16" }), { status: "live" });
    const order = calls.map((c) => c.step);
    const liveAt = calls.findIndex((c) => c.step === "setStatusStep" && c.args[1] === "live");
    assert.ok(order.indexOf("cleanupStep") >= 0 && order.indexOf("cleanupStep") < liveAt);
    assert.equal(liveAt, calls.length - 1);

    reset({ verifies: [{ passed: false, steps: { typecheck: false } }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b17" }), { status: "failed" });
    assert.ok(calls.findIndex((c) => c.step === "cleanupStep") < calls.findIndex((c) => c.step === "failStep"));
    assert.equal(calls.at(-1)!.step, "failStep");

    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" } });
    assert.deepEqual(await wf.refineProduct({ buildId: "r8" }), { status: "live" });
    assert.equal(calls.at(-1)!.step, "setStatusStep");
    assert.ok(calls.findIndex((c) => c.step === "cleanupStep") < calls.length - 1);
  });

  it("charges a Muse Code run once: the poll that read its usage tells the next ones", async () => {
    reset({ musePolls: 3, usageAtPoll: 1 });
    assert.deepEqual(await wf.buildProduct({ buildId: "b18" }), { status: "live" });
    assert.deepEqual(
      named("pollMuseStep")
        .slice(0, 3)
        .map((c) => (c.args[0] as { usageRecorded?: boolean }).usageRecorded),
      [false, true, true],
    );
  });

  it("names the running round on the build row for the owner's controls, and takes it off a run stopped at its cap", async () => {
    reset({ verifies: [{ passed: false }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b22" }), { status: "live" });
    // Right after each start, numbered as the run's log and mailbox are. The poll that sees a run end takes it off.
    assert.deepEqual(
      named("museRoundStep").map((c) => c.args),
      [
        ["b22", 0],
        ["b22", 1],
      ],
    );
    const order = calls.map((c) => c.step);
    assert.equal(order.indexOf("museRoundStep"), order.indexOf("startMuseStep") + 1);

    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" } });
    assert.deepEqual(await wf.refineProduct({ buildId: "r9" }), { status: "live" });
    assert.deepEqual(named("museRoundStep").map((c) => c.args), [["r9", 10]]);

    reset({ musePolls: Infinity });
    assert.deepEqual(await wf.buildProduct({ buildId: "b23" }), { status: "failed" });
    assert.deepEqual(
      named("museRoundStep").map((c) => c.args),
      [
        ["b23", 0],
        ["b23", null],
      ],
    );
    assert.ok(calls.findLastIndex((c) => c.step === "pollMuseStep") < calls.findLastIndex((c) => c.step === "museRoundStep"));
    assert.equal((named("failStep")[0]!.args[0] as { message: string }).message, "Muse Code ran past its 25-minute limit and was stopped.");
  });

  it("ends the build when its owner presses Stop: the run is killed, nothing is checked or fixed after it, and the sandbox still hibernates", async () => {
    reset({ musePolls: 5, stopAtPoll: 2 });
    assert.deepEqual(await wf.buildProduct({ buildId: "b24" }), { status: "failed" });
    // Two polls, then one last read after the kill, so whatever the run wrote on its way out is shown and charged.
    assert.equal(named("pollMuseStep").length, 3);
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-0"]);
    assert.ok(calls.findIndex((c) => c.step === "killStep") < calls.findLastIndex((c) => c.step === "pollMuseStep"));
    assert.deepEqual(
      named("museRoundStep").map((c) => c.args),
      [
        ["b24", 0],
        ["b24", null],
      ],
    );
    for (const step of ["previewStep", "startTaskStep", "collectVerifyStep", "judgeStep", "writeFixPromptStep", "startDeployStep", "registerStep"]) {
      assert.equal(named(step).length, 0, step);
    }
    assert.deepEqual(statuses(), ["briefing", "provisioning", "building"]);
    assert.deepEqual(named("cleanupStep")[0]!.args[0], { buildId: "b24", productId: "prod-1", sandboxName: "product-shelf-scout" });
    assert.deepEqual(named("failStep")[0]!.args[0], { buildId: "b24", productId: "prod-1", message: "Stopped by you." });
    // The final status is still written last, after the sandbox hibernates.
    assert.ok(calls.findIndex((c) => c.step === "cleanupStep") < calls.findIndex((c) => c.step === "failStep"));
    assert.equal(calls.at(-1)!.step, "failStep");
  });

  it("stops in a fix round without another check or fix round", async () => {
    // The build run ends at its second poll and fails its check, and the owner stops the first fix run at its first poll.
    reset({ verifies: [{ passed: false }], stopAtPoll: 3 });
    assert.deepEqual(await wf.buildProduct({ buildId: "b25" }), { status: "failed" });
    assert.deepEqual(
      named("startMuseStep").map((c) => (c.args[0] as { round: number }).round),
      [0, 1],
    );
    assert.equal(named("collectVerifyStep").length, 1);
    assert.equal(named("writeFixPromptStep").length, 1);
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-1"]);
    assert.equal(statuses().at(-1), "fixing");
    assert.equal((named("failStep")[0]!.args[0] as { message: string }).message, "Stopped by you.");
    assert.equal(named("cleanupStep").length, 1);
  });

  it("still ends the build when the poll that sees the Stop also sees the run end, with nothing left to kill", async () => {
    reset({ stopAtPoll: 2 });
    assert.deepEqual(await wf.buildProduct({ buildId: "b26" }), { status: "failed" });
    assert.equal(named("pollMuseStep").length, 2);
    assert.equal(named("killStep").length, 0);
    // That poll took the round off the build row itself.
    assert.deepEqual(named("museRoundStep").map((c) => c.args), [["b26", 0]]);
    assert.equal(named("previewStep").length, 0);
    assert.equal((named("failStep")[0]!.args[0] as { message: string }).message, "Stopped by you.");
  });

  it("counts a Stop that lands just as a run hits its cap", async () => {
    // Only the update that takes the round off the row sees it, after the last poll.
    reset({ musePolls: Infinity, stopOnRoundClear: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b27" }), { status: "failed" });
    assert.equal((named("failStep")[0]!.args[0] as { message: string }).message, "Stopped by you.");
  });

  it("keeps the live version when the owner stops a change", async () => {
    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, stopAtPoll: 1 });
    assert.deepEqual(await wf.refineProduct({ buildId: "r10" }), { status: "failed" });
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-10"]);
    assert.equal(named("previewStep").length, 0);
    assert.equal(named("cleanupStep").length, 1);
    assert.deepEqual(named("failStep")[0]!.args[0], { buildId: "r10", productId: null, message: "Stopped by you. The live version was kept." });
  });
});
