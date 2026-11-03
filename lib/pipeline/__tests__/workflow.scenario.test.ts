/**
 * Runs buildProduct and refineProduct as plain functions with every step faked and sleep() instant, to check the
 * orchestration: status order, fix rounds, outcomes, timeouts, the owner's Stop, cleanup and failure messages.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/*.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

type Call = { step: string; args: unknown[] };

interface Scenario {
  head?: { kind: "build" | "refine"; status: string; productId: string | null };
  paused?: boolean;
  verdict?: "yes" | "partly" | "no";
  /** Polls until Muse Code finishes, per run. Infinity never finishes. */
  musePolls?: number;
  /** Polls per run, by the run's order in the build (first run first). Falls back to musePolls. */
  musePollsByRun?: number[];
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
  /** Steering on (MUSE_ENGINE=serve), so the workflow names each running round on the build row. Off by default. */
  steering?: boolean;
  /** The poll, counted across the whole build (1-based), from which every poll reports the owner's Stop. */
  stopAtPoll?: number;
  /** The owner's Stop shows up only when a run's round is taken off the build row, as it can just before the cap. */
  stopOnRoundClear?: boolean;
  /** Every run is on the session bridge, so each poll returns the bridge condenser's state. */
  bridge?: boolean;
  provePlanThrows?: boolean;
  proveStartThrows?: boolean;
  /** What liveCheckStep answers (ENGINE_LIVE_SMOKE). Defaults to a pass. */
  liveCheck?: { ok: boolean; reason?: string };
  /** Wave 3, unit 14: an enabled cap has a step after deploy (capsShipping in lib/caps/ship.ts). Off by default. */
  capsShipping?: boolean;
  /** The engine's round plan briefStep and loadRefineStep return. */
  plan?: { buildMs: number; fixMs: number; verifyMs: number; wallMs: number | null; milestones: Array<{ title: string }>; full?: boolean; chain?: Record<string, number> };
  /** CHAINED_BUILDS: what each chainReadStep answers, in order, then $1 and no Stop. */
  chainReads?: Array<{ costUsd?: number; stopRequested?: boolean }>;
  /** FULL_BUILDS: what judgeStep says is still not met. */
  judgeUnmet?: string[];
  /** How far each named step moves the fake clock (Date.now), for the build's wall. Unset, time stands still. */
  advance?: Partial<Record<"previewStep" | "collectVerifyStep" | "judgeStep", number>>;
  /** PLAN_ART's step: settles once the build registers ("late"), never ("hangs"), throws, or answers at once (the default). */
  art?: "late" | "hangs" | "throws";
  /** EDGE_ENABLED: briefStep and loadRefineStep say this is an edge build. */
  edge?: boolean;
  /** The edge drill's exit code, or "hang" for a drill that never finishes. Defaults to 0. */
  drill?: number | "hang";
}

/** The fake clock the workflow reads with Date.now while a scenario sets `advance`. */
let clock = 0;
function tick(step: "previewStep" | "collectVerifyStep" | "judgeStep") {
  clock += scenario.advance?.[step] ?? 0;
}

let scenario: Scenario = {};
let calls: Call[] = [];
/** Lets a "late" plan picture finish, from registerStep. */
let releaseArt: (() => void) | null = null;
/** Every sleep() the workflow asked for, in order. */
let slept: unknown[] = [];
let verifyRuns = 0;
let musePolled = 0;
let polledTotal = 0;
let museRuns = 0;
let feedThrows = false;

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
      ...(scenario.plan ? { plan: scenario.plan } : {}),
      ...(scenario.edge ? { edge: true } : {}),
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
    museRuns += 1;
    return { cmdId: `cmd-${input.round}`, logPath: `/log/${input.round}`, ...(scenario.bridge ? { engine: "serve" as const } : {}) };
  },
  museRoundStep: async (buildId: string, round: number | null) => {
    record("museRoundStep", buildId, round);
    return round === null && scenario.stopOnRoundClear === true;
  },
  pollMuseStep: async (input: { usageRecorded?: boolean; announced?: string[] }) => {
    record("pollMuseStep", input);
    musePolled += 1;
    polledTotal += 1;
    const done = musePolled >= (scenario.musePollsByRun?.[museRuns - 1] ?? scenario.musePolls ?? 2);
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
      ...(scenario.bridge ? { bridgeState: { shown: { [`item-${musePolled}`]: `line ${musePolled}` }, announced: [`hook:${musePolled}`] } } : {}),
    };
  },
  killStep: async (...args: unknown[]) => record("killStep", ...args),
  previewStep: async (...args: unknown[]) => {
    record("previewStep", ...args);
    tick("previewStep");
    if (scenario.previewThrows) throw new Error("Preview did not answer 200 on port 3000 (last status 500).");
    return "https://sb-1.vercel.run";
  },
  startTaskStep: async (sandboxName: string, task: string, env?: Record<string, string>) => {
    record("startTaskStep", sandboxName, task, env);
    if (task === "demo" && scenario.demoThrows) throw new Error("ffmpeg missing");
    if (task === "verify") verifyRuns += 1;
    return `${task}-cmd-${verifyRuns}`;
  },
  startEdgeDrillStep: async (sandboxName: string) => {
    record("startEdgeDrillStep", sandboxName);
    return `edge-drill-cmd-${verifyRuns}`;
  },
  startTaskWithEnvStep: (sandboxName: string, task: string, env: Record<string, string>) => fakeSteps.startTaskStep(sandboxName, task, env),
  pollTaskStep: async (sandboxName: string, cmdId: string) => {
    record("pollTaskStep", sandboxName, cmdId);
    const v = currentVerify();
    if (cmdId.startsWith("verify") && v.timeout) return { done: false, exitCode: null, outputTail: "" };
    if (cmdId.startsWith("demo") && scenario.demoTimeout) return { done: false, exitCode: null, outputTail: "" };
    if (cmdId.startsWith("edge-drill")) return scenario.drill === "hang" ? { done: false, exitCode: null, outputTail: "" } : { done: true, exitCode: scenario.drill ?? 0, outputTail: "drill tail" };
    return { done: true, exitCode: 0, outputTail: "tail" };
  },
  collectVerifyStep: async (input: { round: number }) => {
    record("collectVerifyStep", input);
    tick("collectVerifyStep");
    const v = currentVerify();
    const all = Object.fromEntries(["typecheck", "build", "start", "console", "smoke", "manifest"].map((n) => [n, v.passed]));
    const steps = Object.entries(v.steps ?? all).map(([name, ok]) => ({ name, ok }));
    return { passed: v.passed, steps, screenshots: [{ url: "https://x/s.png", caption: "home" }] };
  },
  warmSandboxStep: async () => {},
  dropWarmSandboxStep: async () => {},
  recheckFailedStep: async () => ({ passed: false, steps: [], screenshots: [] }),
  verifyTimedOutStep: async (input: unknown) => {
    record("verifyTimedOutStep", input);
    return { passed: false, steps: [], screenshots: [] };
  },
  judgeStep: async (input: unknown) => {
    record("judgeStep", input);
    tick("judgeStep");
    if (scenario.judgeThrows) throw new Error('Step "judgeStep" failed after 1 retry: judge_verdict: no valid reply');
    const pass = scenario.judgePass ?? true;
    return { pass, blocking: pass ? false : (scenario.judgeBlocking ?? true), ...(scenario.judgeUnmet ? { unmet: scenario.judgeUnmet } : {}) };
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
  saveUnpublishedVersionStep: async (input: unknown) => {
    record("saveUnpublishedVersionStep", input);
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
  registerStep: async (input: unknown) => {
    record("registerStep", input);
    releaseArt?.();
  },
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
      ...(scenario.plan ? { plan: { ...scenario.plan, milestones: [] } } : {}),
      ...(scenario.edge ? { edge: true } : {}),
    };
  },
  reopenStep: async (input: unknown) => {
    record("reopenStep", input);
    return { promptFile: "refine-1.md", images: [] };
  },
  // Wave 3, unit 2: milestones and the live check.
  writeMilestonePromptStep: async (input: { index: number }) => {
    record("writeMilestonePromptStep", input);
    return { promptFile: `milestone-${input.index}.md` };
  },
  milestoneStep: async (...args: unknown[]) => record("milestoneStep", ...args),
  chainReadStep: async (...args: unknown[]) => {
    record("chainReadStep", ...args);
    const read = scenario.chainReads?.shift();
    return { costUsd: read?.costUsd ?? 1, stopRequested: read?.stopRequested ?? false };
  },
  chainSaveStep: async (...args: unknown[]) => record("chainSaveStep", ...args),
  chainReopenStep: async (input: { session: number }) => {
    record("chainReopenStep", input);
    return { sessionId: `session-${input.session}` };
  },
  liveCheckStep: async (input: unknown) => {
    record("liveCheckStep", input);
    return scenario.liveCheck ?? { ok: true };
  },
  // Wave 3, unit 14: what a cap makes from the live link.
  capsShipStep: async (input: unknown) => record("capsShipStep", input),
};

function currentVerify() {
  const list = scenario.verifies ?? [{ passed: true }];
  return list[Math.min(Math.max(verifyRuns - 1, 0), list.length - 1)]!;
}

const canMock = typeof (mock as { module?: unknown }).module === "function";
let wf: typeof import("../workflow");

const savedEnv = { MUSE_ENGINE: process.env.MUSE_ENGINE, MUSE_FULL: process.env.MUSE_FULL, PLAN_ART: process.env.PLAN_ART };

function reset(next: Scenario) {
  scenario = next;
  calls = [];
  verifyRuns = 0;
  musePolled = 0;
  polledTotal = 0;
  museRuns = 0;
  releaseArt = null;
  slept = [];
  if (next.steering) process.env.MUSE_ENGINE = "serve";
  else delete process.env.MUSE_ENGINE;
  delete process.env.MUSE_FULL;
  // These scenarios walk the fix loop with 3 fix rounds, set here since the default is 2 (Nov 2).
  process.env.MAX_FIX_ROUNDS = "3";
}

describe("build workflow orchestration", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../build-steps.ts", import.meta.url).href, { namedExports: fakeSteps });
    mock.module(new URL("../prove-steps.ts", import.meta.url).href, {
      namedExports: {
        provePlanStep: async (buildId: string) => {
          record("provePlanStep", buildId);
          if (scenario.provePlanThrows) throw new Error("no database");
          return "run-1";
        },
      },
    });
    mock.module(new URL("../package-step.ts", import.meta.url).href, { namedExports: { packageProductStep: async () => {} } });
    mock.module(new URL("../prove-start.ts", import.meta.url).href, {
      namedExports: {
        startProveStep: async (input: unknown) => {
          record("startProveStep", input);
          if (scenario.proveStartThrows) throw new Error("no queue");
        },
      },
    });
    mock.module(new URL("../steps-feed-step.ts", import.meta.url).href, {
      namedExports: {
        stepsFeedStep: async (buildId: string, last?: boolean) => {
          record("stepsFeedStep", { buildId, last });
          if (feedThrows) throw new Error("Contributor is down");
          return "written";
        },
      },
    });
    mock.module(new URL("../plan-art-step.ts", import.meta.url).href, {
      namedExports: {
        planArtStep: async (buildId: string) => {
          record("planArtStep", buildId);
          if (scenario.art === "throws") throw new Error("Muse Image is down");
          if (scenario.art === "late") await new Promise<void>((resolve) => (releaseArt = resolve));
          if (scenario.art === "hangs") await new Promise<void>(() => undefined);
          record("planArtStep:done", buildId);
          return "https://blob.example/fixtures/b1/plan-art.jpg";
        },
      },
    });
    // Wave 3, unit 14: whether an enabled cap has a step after deploy, by scenario.
    mock.module(new URL("../../caps/ship.ts", import.meta.url).href, { namedExports: { CAPS_SHIPPING: ["extension"], capsShipping: () => scenario.capsShipping ?? false } });
    mock.module("workflow", {
      namedExports: {
        FatalError: class FatalError extends Error {},
        sleep: async (d: unknown) => {
          slept.push(d);
        },
      },
    });
    wf = await import("../workflow");
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it("registers without deploying when publishing is off, as on a local run", async () => {
    reset({ publish: false });
    assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
    assert.equal(named("startDeployStep").length, 0);
    assert.equal(named("pollDeployStep").length, 0);
    assert.equal(named("saveUnpublishedVersionStep").length, 1, "the Code page still gets this version's files");
    const reg = named("registerStep")[0]!.args[0] as { liveUrl: unknown; projectId: unknown; liveTokenId: unknown; demoVideoUrl: string; demoPosterUrl: string };
    assert.deepEqual([reg.liveUrl, reg.projectId, reg.liveTokenId], [null, null, null]);
    assert.equal(reg.demoVideoUrl, "https://x/demo.mp4");
    assert.equal(reg.demoPosterUrl, "https://x/poster.jpg");
    assert.equal(named("cleanupStep").length, 1);
    assert.equal(statuses().at(-1), "live");
  });

  describe("Prove it", () => {
    const withProve = async (fn: () => Promise<void>) => {
      process.env.PRODUCT_OUTPUTS = "1";
      process.env.PROVE_IT = "1";
      try {
        await fn();
      } finally {
        delete process.env.PRODUCT_OUTPUTS;
        delete process.env.PROVE_IT;
      }
    };
    /** Each step's name, in order, around the final status. */
    const order = () => calls.map((c) => (c.step === "setStatusStep" ? `status:${c.args[1] as string}` : c.step)).filter((s) => /^status:(live|partial|failed)$|^prove|^startProve|^cleanup/.test(s));

    it("takes no step with its flags off", async () => {
      reset({});
      await wf.buildProduct({ buildId: "b1" });
      assert.deepEqual(order(), ["cleanupStep", "status:live"]);
    });

    it("says a run is coming before the final status, and starts it after", () =>
      withProve(async () => {
        reset({});
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
        assert.deepEqual(order(), ["cleanupStep", "provePlanStep", "status:live", "startProveStep"]);
        assert.deepEqual(named("startProveStep")[0]!.args[0], { buildId: "b1", runId: "run-1" });
      }));

    it("still goes live when it can't plan or start, with no second try", () =>
      withProve(async () => {
        reset({ provePlanThrows: true });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
        assert.deepEqual(order(), ["cleanupStep", "provePlanStep", "status:live"]);
        reset({ proveStartThrows: true });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
        assert.equal(statuses().at(-1), "live");
      }));

    it("doesn't run for a build that failed", () =>
      withProve(async () => {
        reset({ provisionThrows: new Error("no sandbox") });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "failed" });
        assert.equal(named("provePlanStep").length, 0);
        assert.equal(named("startProveStep").length, 0);
      }));

    it("runs again after a refinement ships", () =>
      withProve(async () => {
        reset({ head: { kind: "refine", status: "queued", productId: "p1" } });
        assert.deepEqual(await wf.refineProduct({ buildId: "r1" }), { status: "live" });
        assert.deepEqual(order().slice(-3), ["provePlanStep", "status:live", "startProveStep"]);
      }));
  });

  describe("the feed's words (BUILD_ROOM_STEPS)", () => {
    it("makes no call with the flag off", async () => {
      delete process.env.BUILD_ROOM_STEPS;
      reset({});
      await wf.buildProduct({ buildId: "b1" });
      assert.equal(named("stepsFeedStep").length, 0);
    });
    it("asks for the last words before cleanup, and a step that throws changes nothing", async () => {
      for (const throws of [false, true]) {
        process.env.BUILD_ROOM_STEPS = "1";
        feedThrows = throws;
        try {
          reset({});
          assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
          const order = calls.map((c) => c.step);
          assert.deepEqual(named("stepsFeedStep").at(-1)?.args, [{ buildId: "b1", last: true }]);
          assert.ok(order.lastIndexOf("stepsFeedStep") < order.indexOf("cleanupStep"));
          // After the checks too: Muse Code's polling has stopped by then, and nothing else would start a batch.
          assert.ok(named("stepsFeedStep").some((c) => (c.args[0] as { last?: boolean }).last === undefined));
        } finally {
          delete process.env.BUILD_ROOM_STEPS;
          feedThrows = false;
        }
      }
    });
  });

  describe("the plan card's picture (PLAN_ART)", () => {
    const withArt = async (fn: () => Promise<void>) => {
      process.env.PLAN_ART = "1";
      try {
        await fn();
      } finally {
        delete process.env.PLAN_ART;
      }
    };
    const steps = () => calls.map((c) => (c.step === "setStatusStep" ? `status:${c.args[1] as string}` : c.step));

    it("takes no step with the flag off", async () => {
      delete process.env.PLAN_ART;
      reset({});
      assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
      assert.equal(named("planArtStep").length, 0);
    });

    it("starts once the brief says yes, and the build goes on beside it without waiting", () =>
      withArt(async () => {
        reset({ art: "late" });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
        const order = steps();
        assert.deepEqual(named("planArtStep").map((c) => c.args), [["b1"]]);
        assert.ok(order.indexOf("briefStep") < order.indexOf("planArtStep"));
        assert.ok(order.indexOf("planArtStep") < order.indexOf("createProductStep"));
        // Still out while the product, sandbox, Muse Code, checks, demo and deploy all ran.
        for (const s of ["createProductStep", "provisionStep", "startMuseStep", "collectVerifyStep", "finishDemoStep", "registerStep"]) {
          assert.ok(order.indexOf(s) < order.indexOf("planArtStep:done"), s);
        }
        // In before the final status, while the room's stream is still open.
        assert.ok(order.indexOf("planArtStep:done") < order.indexOf("cleanupStep"));
        assert.ok(order.indexOf("planArtStep:done") < order.indexOf("status:live"));
      }));

    it("never fails the build when it throws", () =>
      withArt(async () => {
        reset({ art: "throws" });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
        assert.equal(named("planArtStep").length, 1);
        assert.equal(named("failStep").length, 0);
        assert.equal(statuses().at(-1), "live");
      }));

    it("holds a shipped build's end for at most 15 s when the picture never comes back", () =>
      withArt(async () => {
        reset({ art: "hangs" });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "live" });
        assert.equal(named("planArtStep").length, 1);
        assert.equal(named("planArtStep:done").length, 0);
        assert.equal(slept.at(-1), 15_000);
        assert.equal(statuses().at(-1), "live");
        assert.equal(named("cleanupStep").length, 1);
      }));

    it("doesn't hold a failed build's end at all", () =>
      withArt(async () => {
        reset({ art: "hangs", provisionThrows: new Error("no sandbox") });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "failed" });
        assert.equal(named("planArtStep:done").length, 0);
        assert.ok(!slept.includes(15_000));
        assert.equal(named("failStep").length, 1);
      }));

    it("makes no picture for a declined brief or a change", () =>
      withArt(async () => {
        reset({ verdict: "no" });
        assert.deepEqual(await wf.buildProduct({ buildId: "b1" }), { status: "refused" });
        assert.equal(named("planArtStep").length, 0);
        reset({ head: { kind: "refine", status: "queued", productId: "prod-1" } });
        await wf.refineProduct({ buildId: "r1" });
        assert.equal(named("planArtStep").length, 0);
      }));
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
      buildId: "b1",
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

  it("kills Muse Code at the 60-minute cap and fails the build", async () => {
    reset({ musePolls: Infinity });
    assert.deepEqual(await wf.buildProduct({ buildId: "b7" }), { status: "failed" });
    // 100 polls, then one more after the kill to read (and charge) what the run wrote on its way out.
    assert.equal(named("pollMuseStep").length, 241);
    assert.equal((named("pollMuseStep")[240]!.args[0] as { offset: number }).offset, 24000);
    assert.ok(calls.findIndex((c) => c.step === "killStep") < calls.findLastIndex((c) => c.step === "pollMuseStep"));
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-0"]);
    assert.equal(
      (named("failStep")[0]!.args[0] as { message: string }).message,
      "Muse Code ran past its 60-minute limit and was stopped.",
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
      buildId: "r1",
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

  it("hands each poll the session bridge's condenser state from the one before, and names the build at every start", async () => {
    reset({ musePolls: 3, bridge: true, steering: true, verifies: [{ passed: false }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "b29" }), { status: "live" });
    // A new run starts from nothing: the fix round's first poll carries no state from the build round's last.
    assert.deepEqual(
      named("pollMuseStep").map((c) => (c.args[0] as { bridgeState?: unknown }).bridgeState),
      [
        undefined,
        { shown: { "item-1": "line 1" }, announced: ["hook:1"] },
        { shown: { "item-2": "line 2" }, announced: ["hook:2"] },
        undefined,
        { shown: { "item-1": "line 1" }, announced: ["hook:1"] },
        { shown: { "item-2": "line 2" }, announced: ["hook:2"] },
      ],
    );
    assert.deepEqual(
      named("startMuseStep").map((c) => (c.args[0] as { buildId?: string }).buildId),
      ["b29", "b29"],
    );

    // An exec round's polls never carry one.
    reset({ musePolls: 3 });
    assert.deepEqual(await wf.buildProduct({ buildId: "b30" }), { status: "live" });
    assert.ok(named("pollMuseStep").every((c) => !("bridgeState" in (c.args[0] as object))));
  });

  it("names the running round on the build row for the owner's controls, and takes it off a run stopped at its cap", async () => {
    reset({ verifies: [{ passed: false }, { passed: true }], steering: true });
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

    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, steering: true });
    assert.deepEqual(await wf.refineProduct({ buildId: "r9" }), { status: "live" });
    assert.deepEqual(named("museRoundStep").map((c) => c.args), [["r9", 10]]);

    reset({ musePolls: Infinity, steering: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b23" }), { status: "failed" });
    assert.deepEqual(
      named("museRoundStep").map((c) => c.args),
      [
        ["b23", 0],
        ["b23", null],
      ],
    );
    assert.ok(calls.findLastIndex((c) => c.step === "pollMuseStep") < calls.findLastIndex((c) => c.step === "museRoundStep"));
    assert.equal((named("failStep")[0]!.args[0] as { message: string }).message, "Muse Code ran past its 60-minute limit and was stopped.");
  });

  it("takes exactly today's steps while steering is off", async () => {
    for (const next of [{ verifies: [{ passed: false }, { passed: true }] }, { musePolls: Infinity }]) {
      reset(next);
      await wf.buildProduct({ buildId: "b28" });
      assert.equal(named("museRoundStep").length, 0, JSON.stringify(next));
    }
  });

  it("ends the build when its owner presses Stop: the run is killed, nothing is checked or fixed after it, and the sandbox still hibernates", async () => {
    reset({ musePolls: 5, stopAtPoll: 2, steering: true });
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
    reset({ verifies: [{ passed: false }], stopAtPoll: 3, steering: true });
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
    reset({ stopAtPoll: 2, steering: true });
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
    reset({ musePolls: Infinity, stopOnRoundClear: true, steering: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "b27" }), { status: "failed" });
    assert.equal((named("failStep")[0]!.args[0] as { message: string }).message, "Stopped by you.");
  });

  it("keeps the live version when the owner stops a change", async () => {
    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, stopAtPoll: 1, steering: true });
    assert.deepEqual(await wf.refineProduct({ buildId: "r10" }), { status: "failed" });
    assert.deepEqual(named("killStep")[0]!.args, ["product-shelf-scout", "cmd-10"]);
    assert.equal(named("previewStep").length, 0);
    assert.equal(named("cleanupStep").length, 1);
    assert.deepEqual(named("failStep")[0]!.args[0], { buildId: "r10", productId: null, message: "Stopped by you. The live version was kept." });
  });
});

describe("engine (docs/CAPABILITIES.md, section 8)", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  const ENGINE = ["ENGINE_CHECK_ON_TIMEOUT", "ENGINE_ROUND_SCALING", "ENGINE_MILESTONES", "ENGINE_LIVE_SMOKE"] as const;
  const saved = Object.fromEntries(ENGINE.map((k) => [k, process.env[k]]));
  const flags = (on: Partial<Record<(typeof ENGINE)[number], string>>) => {
    for (const k of ENGINE) delete process.env[k];
    Object.assign(process.env, on);
  };
  const MIN = 60_000;
  const plan = (over: Partial<NonNullable<Scenario["plan"]>> = {}) => ({ buildMs: 35 * MIN, fixMs: 15 * MIN, verifyMs: 8 * MIN, wallMs: 90 * MIN, milestones: [], ...over });
  const logs = () => named("emitStep").map((c) => (c.args[1] as { type: string; text?: string })).filter((b) => b.type === "log").map((b) => b.text);
  const starts = () => named("startMuseStep").map((c) => c.args[0] as { round: number; promptFile: string; capMs?: number; images: string[] });

  before(async () => {
    wf ??= await import("../workflow");
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it("FULL_BUILDS: shares the wall among milestones, checks a capped round with no engine flag, and names what's unmet", async () => {
    flags({});
    reset({
      plan: plan({ full: true, buildMs: 60 * MIN, wallMs: 120 * MIN, verifyMs: 12 * MIN, milestones: [{ title: "R1 to R4" }, { title: "R5 to R8" }] }),
      musePollsByRun: [Infinity, 2, 2, 2, 2],
      verifies: [{ passed: true }],
      judgePass: false,
      judgeBlocking: false,
      judgeUnmet: ["R5 is not met: Edit a trip."],
    });
    assert.deepEqual(await wf.buildProduct({ buildId: "t1" }), { status: "partial" });
    const caps = starts().map((r) => r.capMs!);
    assert.ok(caps[0]! < 60 * MIN, "the first round leaves time for the second");
    assert.ok(starts().some((r) => r.promptFile === "milestone-2.md"));
    assert.ok(named("setStatusStep").some((c) => String((c.args[2] as { message?: string })?.message).includes("Not met: R5 is not met: Edit a trip.")));
  });

  describe("CHAINED_BUILDS", () => {
    const chain = { sessionMs: 85 * MIN, sessionUsd: 15, totalUsd: 60, maxSessions: 12, maxMs: 1440 * MIN };
    const list = [{ title: "R1 to R4" }, { title: "R5 to R8" }, { title: "R9 to R12" }];
    const chained = (over: Partial<Scenario> = {}): Scenario => ({
      plan: plan({ full: true, buildMs: 60 * MIN, wallMs: 85 * MIN, verifyMs: 25 * MIN, milestones: list, chain } as never),
      verifies: [{ passed: true }],
      ...over,
    });
    it("runs every milestone in one session while it fits, with no rotation", async () => {
      flags({});
      reset(chained());
      assert.deepEqual(await wf.buildProduct({ buildId: "c1" }), { status: "live" });
      assert.equal(named("chainReopenStep").length, 0);
      assert.deepEqual(starts().map((r) => r.promptFile), ["brief.md", "milestone-2.md", "milestone-3.md"]);
    });

    it("saves and starts a new session past the wall, and the next round uses its id and a fresh prompt", async () => {
      flags({});
      const real = Date.now;
      clock = real();
      Date.now = () => clock;
      try {
        reset(chained({ advance: { collectVerifyStep: 50 * MIN } }));
        assert.deepEqual(await wf.buildProduct({ buildId: "c2" }), { status: "live" });
      } finally {
        Date.now = real;
      }
      const order = calls.map((c) => c.step).filter((s) => s === "chainSaveStep" || s === "chainReopenStep");
      assert.deepEqual(order.slice(0, 2), ["chainSaveStep", "chainReopenStep"]);
      const second = starts().find((r) => r.promptFile === "milestone-2.md") as unknown as { sessionId: string };
      assert.equal(second.sessionId, "session-2");
      assert.equal((named("writeMilestonePromptStep")[0]!.args[0] as { newSession?: number }).newSession, 2);
      assert.equal((named("writeMilestonePromptStep")[1]!.args[0] as { newSession?: number }).newSession, 3);
    });

    it("ends at the spending cap, skips what's left and checks what was built", async () => {
      flags({});
      reset(chained({ chainReads: [{ costUsd: 58 }, { costUsd: 58 }] }));
      await wf.buildProduct({ buildId: "c3" });
      assert.equal(starts().filter((r) => r.promptFile.startsWith("milestone")).length, 0);
      assert.ok(logs().some((t) => t?.includes("$60 spending cap")));
      const states = named("milestoneStep").map((c) => { const m = c.args[1] as { index: number; state: string }; return `${m.index}:${m.state}`; });
      assert.ok(states.includes("2:skipped") && states.includes("3:skipped"));
      assert.equal(named("chainReopenStep").length, 0);
    });

    it("stops for the owner between rounds, and cleans up", async () => {
      flags({});
      reset(chained({ chainReads: [{ stopRequested: true }] }));
      assert.deepEqual(await wf.buildProduct({ buildId: "c4" }), { status: "failed" });
      assert.match((named("failStep")[0]!.args[0] as { message: string }).message, /Stopped by you/);
      assert.equal(named("cleanupStep").length, 1);
    });
  });

  it("checks a first round that hit its cap and ships it after a fix round (ENGINE_CHECK_ON_TIMEOUT)", async () => {
    flags({ ENGINE_CHECK_ON_TIMEOUT: "1" });
    reset({ musePollsByRun: [Infinity, 2], verifies: [{ passed: false }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "t1" }), { status: "live" });
    assert.equal(named("killStep").length, 1, "the capped run was killed");
    assert.ok(logs().includes("Muse Code was stopped after 60 minutes."));
    assert.ok(logs().includes("Muse Code was stopped at its time limit. Checking what it built."));
    assert.ok(!logs().some((t) => t?.startsWith("Muse Code ended with an error")), "a capped run isn't reported as an error");
    assert.deepEqual(starts().map((r) => [r.round, r.promptFile]), [[0, "brief.md"], [1, "fix-1.md"]]);
    assert.equal(named("previewStep").length, 1);
    assert.equal(named("failStep").length, 0);
    // No plan: the rounds keep today's caps and ask for no session time of their own.
    assert.ok(starts().every((r) => !("capMs" in r)));
  });

  it("still fails a first round at its cap with the flag off, naming the scaled cap", async () => {
    flags({ ENGINE_ROUND_SCALING: "1" });
    reset({ musePolls: Infinity, plan: plan() });
    assert.deepEqual(await wf.buildProduct({ buildId: "t2" }), { status: "failed" });
    assert.match((named("failStep")[0]!.args[0] as { message: string }).message, /past its 35-minute limit/);
    assert.equal(named("collectVerifyStep").length, 0);
    assert.equal(starts()[0]!.capMs, 35 * MIN, "a scaled round asks for its session time");
  });

  it("keeps the live version when a change hits its cap, even with ENGINE_CHECK_ON_TIMEOUT", async () => {
    // The judge sees the product's brief, not the change, so a half-made change could pass and replace what is live.
    flags({ ENGINE_CHECK_ON_TIMEOUT: "1" });
    reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, musePollsByRun: [Infinity], verifies: [{ passed: true }] });
    assert.deepEqual(await wf.refineProduct({ buildId: "t3" }), { status: "failed" });
    assert.match((named("failStep")[0]!.args[0] as { message: string }).message, /past its 60-minute limit and was stopped\. The live version was kept\./);
    assert.equal(named("collectVerifyStep").length, 0);
    assert.equal(named("judgeStep").length, 0);
    assert.equal(named("registerStep").length, 0, "nothing shipped");
    assert.ok(!logs().includes("Muse Code was stopped at its time limit. Checking what it built."));
  });

  it("builds milestones in chained rounds with strict checks between, then numbers fix rounds after them", async () => {
    flags({ ENGINE_MILESTONES: "1" });
    const milestones = [{ title: "Play one level" }, { title: "Level maker" }, { title: "Solver hints" }];
    reset({ plan: plan({ milestones }), verifies: [{ passed: false }, { passed: true }, { passed: false }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "t4" }), { status: "live" });
    assert.deepEqual(starts().map((r) => [r.round, r.promptFile]), [[0, "brief.md"], [1, "milestone-2.md"], [2, "milestone-3.md"], [3, "fix-1.md"]]);
    assert.deepEqual(named("writeMilestonePromptStep").map((c) => (c.args[0] as { index: number; verifiedRound: number; of: number })).map((m) => [m.index, m.of, m.verifiedRound]), [[2, 3, 0], [3, 3, 1]]);
    // Milestone checks are strict and never judged; the judge sees only the checks after the last milestone.
    const verifyEnvs = named("startTaskStep").filter((c) => c.args[1] === "verify").map((c) => c.args[2]);
    assert.deepEqual(verifyEnvs.slice(0, 2), [undefined, undefined]);
    assert.deepEqual(named("collectVerifyStep").map((c) => (c.args[0] as { round: number }).round), [0, 1, 2, 3]);
    assert.deepEqual(named("judgeStep").map((c) => (c.args[0] as { round: number }).round), [3]);
    assert.deepEqual(named("writeFixPromptStep").map((c) => c.args[0]), [{ buildId: "t4", sandboxName: "product-shelf-scout", fix: 1, verifiedRound: 2 }]);
    const states = named("milestoneStep").map((c) => { const m = c.args[1] as { index: number; state: string }; return `${m.index}:${m.state}`; });
    assert.deepEqual(states, ["1:building", "1:failed", "2:building", "2:passed", "3:building", "3:passed"]);
    assert.ok(statuses().includes("verifying"));
  });

  it("keeps milestones plus fix rounds under the refinement stride", async () => {
    flags({ ENGINE_MILESTONES: "1" });
    try {
      const milestones = [{ title: "One" }, { title: "Two" }, { title: "Three" }];
      reset({ plan: plan({ milestones, wallMs: 10_000 * MIN }), verifies: [{ passed: true }, { passed: true }, { passed: false }] });
      process.env.MAX_FIX_ROUNDS = "9";
      assert.deepEqual(await wf.buildProduct({ buildId: "t5" }), { status: "failed" });
      const rounds = starts().map((r) => r.round);
      assert.equal(Math.max(...rounds), 9, "the last fix round is round 9, under REFINE_ROUND_STRIDE (10)");
      assert.equal(named("writeFixPromptStep").length, 7);
    } finally {
      delete process.env.MAX_FIX_ROUNDS;
    }
  });

  it("skips milestones and fix rounds that wouldn't fit before the build's wall, and checks what was built", async () => {
    flags({ ENGINE_MILESTONES: "1" });
    const milestones = [{ title: "One" }, { title: "Two" }];
    reset({ plan: plan({ milestones, wallMs: 10 * MIN }), verifies: [{ passed: false }, { passed: false }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "t6" }), { status: "failed" });
    assert.deepEqual(starts().map((r) => r.promptFile), ["brief.md"], "no milestone or fix round started");
    assert.ok(logs().some((t) => t?.startsWith("The build is near its time limit, so milestone 2 of 2")));
    assert.ok(logs().includes("The build is near its time limit, so no more fix rounds run."));
    // With no fix round to follow, the last check ran in warn mode, as a build's last round does.
    const verifyEnvs = named("startTaskStep").filter((c) => c.args[1] === "verify").map((c) => c.args[2]);
    assert.deepEqual(verifyEnvs, [undefined, { MUSEMUSE_SCREEN_CHECK: "warn" }]);
    const states = named("milestoneStep").map((c) => { const m = c.args[1] as { index: number; state: string }; return `${m.index}:${m.state}`; });
    assert.deepEqual(states, ["1:building", "1:failed", "2:skipped", "1:failed"]);
  });

  it("never starts a fix round that no longer fits once the verify and the judge have run, so the wall holds", async () => {
    flags({ ENGINE_ROUND_SCALING: "1" });
    // The review's case: a 15-minute fix and an 8-minute verify, the room check near minute 66, and a verify plus a slow
    // judge that take 12 minutes. A full fix round and its verify would end past minute 90.
    const real = Date.now;
    clock = real();
    Date.now = () => clock;
    try {
      // The verify passes and the judge, which takes 4 minutes, fails it, so a fix round would come next.
      reset({ plan: plan(), verifies: [{ passed: true }, { passed: true }], judgePass: false, judgeBlocking: true, advance: { previewStep: 66 * MIN, collectVerifyStep: 8 * MIN, judgeStep: 4 * MIN } });
      assert.deepEqual(await wf.buildProduct({ buildId: "t8" }), { status: "failed" });
      assert.deepEqual(starts().map((r) => r.promptFile), ["brief.md"], "no fix round started past the wall");
      assert.ok(logs().includes("The build is near its time limit, so no more fix rounds run."));
      assert.equal(named("collectVerifyStep").length, 1);
    } finally {
      Date.now = real;
    }
  });

  it("starts a fix round that fits, cut to what's left before the wall after its verify", async () => {
    flags({ ENGINE_ROUND_SCALING: "1" });
    const real = Date.now;
    clock = real();
    Date.now = () => clock;
    try {
      reset({ plan: plan(), verifies: [{ passed: false }, { passed: true }], advance: { previewStep: 50 * MIN, collectVerifyStep: 8 * MIN } });
      assert.deepEqual(await wf.buildProduct({ buildId: "t9" }), { status: "live" });
      const fix = starts().find((r) => r.promptFile === "fix-1.md");
      // At minute 58: 90 - 58 - 8 (its verify) - 3 (its judge) leaves 21, so the 15-minute cap holds.
      assert.equal(fix?.capMs, 15 * MIN);
    } finally {
      Date.now = real;
    }
  });

  it("ships as partial, saying so, when the live link fails its check (ENGINE_LIVE_SMOKE)", async () => {
    flags({ ENGINE_LIVE_SMOKE: "1" });
    reset({ liveCheck: { ok: false, reason: "the page answered HTTP 500" } });
    assert.deepEqual(await wf.buildProduct({ buildId: "t7" }), { status: "partial" });
    assert.deepEqual(named("liveCheckStep").map((c) => c.args[0]), [{ buildId: "t7", sandboxName: "product-shelf-scout", url: "https://musemuse-shelf-scout.vercel.app" }]);
    assert.equal((named("registerStep")[0]!.args[0] as { status: string }).status, "partial");
    const end = named("setStatusStep").at(-1)!.args[2] as { message: string };
    assert.equal(end.message, "Shipped as partial at https://musemuse-shelf-scout.vercel.app. It passed on the build machine, but failed on its live link: the page answered HTTP 500");
    // The check runs after the deploy and before register.
    const order = calls.map((c) => c.step);
    assert.ok(order.indexOf("pollDeployStep") < order.indexOf("liveCheckStep") && order.indexOf("liveCheckStep") < order.indexOf("registerStep"));
  });

  it("ships as live when the live link passes, and skips the check when publishing is off", async () => {
    flags({ ENGINE_LIVE_SMOKE: "1" });
    reset({});
    assert.deepEqual(await wf.buildProduct({ buildId: "t8" }), { status: "live" });
    assert.equal(named("liveCheckStep").length, 1);
    reset({ publish: false });
    assert.deepEqual(await wf.buildProduct({ buildId: "t9" }), { status: "live" });
    assert.equal(named("liveCheckStep").length, 0);
  });

  it("takes exactly today's steps with every engine flag off", async () => {
    flags({});
    reset({ verifies: [{ passed: false }, { passed: true }] });
    assert.deepEqual(await wf.buildProduct({ buildId: "t10" }), { status: "live" });
    assert.equal(named("liveCheckStep").length + named("milestoneStep").length + named("writeMilestonePromptStep").length + named("capsShipStep").length, 0);
    assert.ok(starts().every((r) => !("capMs" in r)));
  });

  describe("the edge drill after verify (EDGE_ENABLED)", () => {
    const collected = () => named("collectVerifyStep").map((c) => c.args[0] as { edgeDrill?: { exitCode: number | null; timedOut: boolean; outputTail: string } });

    it("isn't a step at all for a build that isn't an edge build", async () => {
      reset({});
      assert.deepEqual(await wf.buildProduct({ buildId: "e0" }), { status: "live" });
      assert.equal(named("startEdgeDrillStep").length, 0);
      assert.ok(collected().every((c) => !("edgeDrill" in c)));
    });

    it("runs after a passing verify, on the build's sandbox, and hands its run to collectVerifyStep", async () => {
      reset({ edge: true });
      assert.deepEqual(await wf.buildProduct({ buildId: "e1" }), { status: "live" });
      assert.deepEqual(named("startEdgeDrillStep").map((c) => c.args[0]), ["product-shelf-scout"]);
      const order = calls.map((c) => c.step).filter((s) => ["startTaskStep", "startEdgeDrillStep", "collectVerifyStep", "judgeStep"].includes(s));
      assert.deepEqual(order.slice(0, 4), ["startTaskStep", "startEdgeDrillStep", "collectVerifyStep", "judgeStep"]);
      assert.deepEqual(collected()[0]!.edgeDrill, { exitCode: 0, timedOut: false, outputTail: "drill tail" });
      assert.ok(named("emitStep").some((c) => /simulated outage drills/.test(JSON.stringify(c.args[1]))));
    });

    it("hands a failed drill on, so collectVerifyStep fails the round, and drills again on the next verify", async () => {
      reset({ edge: true, drill: 1, verifies: [{ passed: false }, { passed: true }] });
      await wf.buildProduct({ buildId: "e2" });
      assert.equal(named("startEdgeDrillStep").length, 2);
      assert.deepEqual(collected().map((c) => c.edgeDrill?.exitCode), [1, 1]);
    });

    it("stops a drill that hangs at its cap and says it timed out", async () => {
      reset({ edge: true, drill: "hang" });
      await wf.buildProduct({ buildId: "e3" });
      assert.ok(named("killStep").some((c) => String(c.args[1]).startsWith("edge-drill")));
      assert.equal(collected()[0]!.edgeDrill?.timedOut, true);
    });

    it("drills a refinement of an edge product too", async () => {
      reset({ head: { kind: "refine", status: "queued", productId: "prod-1" }, edge: true });
      await wf.refineProduct({ buildId: "e4" });
      assert.equal(named("startEdgeDrillStep").length, 1);
    });
  });
});

describe("a cap's step after deploy (docs/CAPABILITIES.md, section 20)", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    wf ??= await import("../workflow");
  });

  it("runs after the deploy and the live check and before register, with the live link, when an enabled cap ships", async () => {
    reset({ capsShipping: true });
    assert.deepEqual(await wf.buildProduct({ buildId: "u1" }), { status: "live" });
    assert.deepEqual(named("capsShipStep").map((c) => c.args[0]), [
      { buildId: "u1", productId: "prod-1", sandboxName: "product-shelf-scout", liveUrl: "https://musemuse-shelf-scout.vercel.app" },
    ]);
    const order = calls.map((c) => c.step);
    assert.ok(order.indexOf("pollDeployStep") < order.indexOf("capsShipStep") && order.indexOf("capsShipStep") < order.indexOf("registerStep"));
  });

  it("isn't a step at all when no enabled cap ships, or when publishing is off", async () => {
    reset({});
    await wf.buildProduct({ buildId: "u2" });
    assert.equal(named("capsShipStep").length, 0);
    reset({ capsShipping: true, publish: false });
    await wf.buildProduct({ buildId: "u3" });
    assert.equal(named("capsShipStep").length, 0);
  });

  it("packages a refinement again from its live link", async () => {
    reset({ capsShipping: true, head: { kind: "refine", status: "queued", productId: "prod-1" } });
    assert.deepEqual(await wf.refineProduct({ buildId: "r1" }), { status: "live" });
    assert.equal(named("capsShipStep").length, 1);
  });
});
