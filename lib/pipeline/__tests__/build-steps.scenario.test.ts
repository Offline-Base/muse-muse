/**
 * Runs the real step functions in build-steps.ts with the database, sandbox, judge, policy check and usage faked:
 * the judge on a refinement, Muse Code usage charging (child agents included, never twice), the judge's screenshots on
 * fix rounds, the admin kill switch at register, the brief and the build model copied onto refine rows, and the
 * refinement policy check.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/*.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realSchema from "@/lib/db/schema";
import { StructuredOutputError } from "@/lib/brief/structured";
import type { ModelUsage } from "@/lib/types";

type Rows = Record<string, unknown>[];

/** Select results per table, served in the order the step queries them. */
let selects: Record<string, Rows[]> = {};
/** update(...).returning() results per table. */
let returns: Record<string, Rows[]> = {};
let writes: Array<{ table: string; values: Record<string, unknown> }> = [];
let emitted: Array<{ buildId: string; body: Record<string, unknown> }> = [];
let recorded: ModelUsage[][] = [];
let recordedEndpoints: string[] = [];
let costs: string[] = [];
let fixShots: Array<{ fix: number; urls: string[] }> = [];
let fixShotsError: Error | null = null;
let productFiles: Array<{ path: string; content: string }> = [];
let revoked: unknown[][] = [];
let judgeInputs: Array<{ brief: unknown; references: Array<{ fileName: string }> }> = [];
let judgeImpl: () => Promise<unknown> = async () => ({ verdict: {}, usage: [] });
let checkInputs: unknown[] = [];
let checkImpl: () => Promise<unknown> = async () => ({ refusal: null, usage: [] });
let pollImpl: () => Promise<unknown> = async () => ({});
let pollInputs: Array<Record<string, unknown>> = [];
let demoSpecs: Array<{ sandboxName: string; spec: Record<string, unknown> }> = [];
let demoVideo: { videoUrl: string | null; posterUrl: string | null } = { videoUrl: null, posterUrl: null };

function thenable<T extends object>(q: T, result: () => unknown): T {
  return Object.assign(q, {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(result).then(resolve, reject),
  });
}

const fakeDb = () => ({
  select: () => {
    let table = "";
    const q: Record<string, unknown> = {};
    for (const m of ["where", "orderBy", "limit"]) q[m] = () => q;
    q.from = (t: never) => {
      table = getTableName(t);
      return q;
    };
    return thenable(q, () => selects[table]?.shift() ?? []);
  },
  update: (t: never) => {
    const table = getTableName(t);
    const q: Record<string, unknown> = {};
    q.set = (values: Record<string, unknown>) => {
      writes.push({ table, values });
      return q;
    };
    q.where = () => q;
    q.returning = () => q;
    return thenable(q, () => returns[table]?.shift() ?? []);
  },
});

class FakeFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

const canMock = typeof (mock as { module?: unknown }).module === "function";
let steps: typeof import("../build-steps");

const BRIEF = { name: "Bird Count", inspiration: { references: [{ index: 0, kind: "image", describes: "a feeder" }] } };
const USAGE: ModelUsage = { model: "muse-spark-1.3", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 80, costUsd: 0.002 };

describe("build steps", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module(at("../../db/client.ts"), { namedExports: { db: fakeDb, schema: realSchema } });
    mock.module(at("../../events.ts"), {
      namedExports: {
        emit: async (buildId: string, body: Record<string, unknown>) => void emitted.push({ buildId, body }),
        addBuildCost: async (_buildId: string, _usd: number, what: string) => void costs.push(what),
        setBuildStatus: async () => undefined,
      },
    });
    mock.module(at("../../usage.ts"), {
      namedExports: {
        recordUsage: async (ctx: { endpoint: string }, items: ModelUsage[]) => {
          recorded.push(items);
          recordedEndpoints.push(ctx.endpoint);
        },
        platformSpendToday: async () => 0,
      },
    });
    mock.module(at("../../gateway/tokens.ts"), {
      namedExports: {
        mintToken: async () => ({ id: "tok-1", token: "secret" }),
        revokeTokens: async (...args: unknown[]) => void revoked.push(args),
      },
    });
    mock.module(at("../../judge.ts"), {
      namedExports: {
        judgeBuild: async (input: { brief: unknown; references: Array<{ fileName: string }> }) => {
          judgeInputs.push(input);
          return judgeImpl();
        },
        // The real rule: the first screenshot, then the last three.
        pickScreenshots: <T>(s: T[]) => (s.length <= 4 ? s : [s[0]!, ...s.slice(-3)]),
      },
    });
    mock.module(at("../../brief/policy.ts"), {
      namedExports: {
        checkChange: async (input: unknown) => {
          checkInputs.push(input);
          return checkImpl();
        },
      },
    });
    mock.module(at("../../brief/write.ts"), {
      namedExports: { prepareFixtures: async () => ({ fixtures: [], usage: [] }), writeBrief: async () => ({}) },
    });
    mock.module(at("../../publish/vercel.ts"), {
      namedExports: {
        pollDeploy: async () => ({}),
        startDeployFromSandbox: async () => ({}),
        projectNameFor: (slug: string) => `musemuse-${slug}`,
      },
    });
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        pollMuse: async (input: Record<string, unknown>) => {
          pollInputs.push(input);
          return pollImpl();
        },
        writeFixScreenshots: async (_name: string, fix: number, shots: Array<{ url: string }>) => {
          fixShots.push({ fix, urls: shots.map((x) => x.url) });
          if (fixShotsError) throw fixShotsError;
          return shots.map((_, i) => `.muse-fix/round-${fix}-${i + 1}.png`);
        },
        writeProductFile: async (_name: string, path: string, content: string) => void productFiles.push({ path, content }),
        readManifest: async () => null,
        exportTranscript: async () => ({ url: "https://x/transcript.json", highlights: [] }),
        writeDemoSpec: async (sandboxName: string, spec: Record<string, unknown>) => void demoSpecs.push({ sandboxName, spec }),
        finishDemo: async () => demoVideo,
      },
    });
    mock.module("workflow", {
      namedExports: { FatalError: FakeFatalError, getStepMetadata: () => ({ attempt: 1 }) },
    });
    steps = await import("../build-steps");
  });

  beforeEach(() => {
    selects = {};
    returns = {};
    writes = [];
    emitted = [];
    recorded = [];
    recordedEndpoints = [];
    costs = [];
    fixShots = [];
    fixShotsError = null;
    pollInputs = [];
    productFiles = [];
    revoked = [];
    judgeInputs = [];
    checkInputs = [];
    demoSpecs = [];
    demoVideo = { videoUrl: null, posterUrl: null };
  });

  describe("judgeStep on a refinement", () => {
    const refineRow = { id: "r1", kind: "refine", brief: null, inspirationId: "insp-refine", productId: "prod-1" };

    it("uses the product's brief and its original references, then the change's new files", async () => {
      selects = {
        builds: [[refineRow], [{ brief: BRIEF }]],
        inspirations: [[{ references: [{ fileName: "abcd1234-dark.png", kind: "image" }] }], [{ references: [{ fileName: "feeder.jpg", kind: "image" }] }]],
        products: [[{ id: "prod-1", inspirationId: "insp-original" }]],
      };
      judgeImpl = async () => ({
        verdict: { pass: false, blocking: false, reasons: ["Text is cut off."], mismatches: [] },
        usage: [USAGE],
      });
      const out = await steps.judgeStep({ buildId: "r1", productId: "prod-1", round: 0, screenshots: [] });
      assert.deepEqual(out, { pass: false, blocking: false });
      assert.equal(judgeInputs[0]!.brief, BRIEF);
      assert.deepEqual(
        judgeInputs[0]!.references.map((r) => r.fileName),
        ["feeder.jpg", "abcd1234-dark.png"],
      );
      assert.deepEqual(recorded, [[USAGE]]);
      assert.equal(emitted[0]!.body.type, "judge");
    });

    it("records what a judge call that failed both attempts spent, then rethrows", async () => {
      selects = {
        builds: [[{ ...refineRow, kind: "build", brief: BRIEF }]],
        inspirations: [[{ references: [] }]],
      };
      judgeImpl = async () => {
        throw new StructuredOutputError("judge_verdict: no valid reply after a retry.", [USAGE]);
      };
      await assert.rejects(
        steps.judgeStep({ buildId: "b1", productId: "prod-1", round: 1, screenshots: [] }),
        /no valid reply/,
      );
      assert.deepEqual(recorded, [[USAGE]]);
    });
  });

  describe("pollMuseStep", () => {
    const input = {
      buildId: "b1",
      productId: "prod-1",
      sandboxName: "sb",
      run: { cmdId: "cmd", logPath: "/log" },
      offset: 0,
      round: 0,
    };

    it("charges usage read before the process exited, and only once per run", async () => {
      pollImpl = async () => ({ done: false, exitCode: null, offset: 500, lines: [], usage: [USAGE], finalText: null });
      const first = await steps.pollMuseStep(input);
      assert.equal(first.usageRecorded, true);
      assert.equal(first.done, false);
      assert.deepEqual(recorded, [[USAGE]]);

      // Even if a later poll reported usage again, a run that was charged is not charged twice.
      const again = await steps.pollMuseStep({ ...input, offset: 500, usageRecorded: true });
      assert.equal(again.usageRecorded, true);
      assert.equal(recorded.length, 1);
    });

    it("charges nothing until usage appears", async () => {
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 10, lines: [], usage: [], finalText: null });
      const out = await steps.pollMuseStep(input);
      assert.equal(out.usageRecorded, false);
      assert.equal(recorded.length, 0);
    });

    const CHILDREN: ModelUsage = { model: "muse-spark-1.3", inputTokens: 33775, cachedInputTokens: 0, outputTokens: 1800, costUsd: 0.0499 };
    const session = {
      main: { calls: 2, usage: [USAGE] },
      children: { calls: 4, usage: [CHILDREN], owners: ["reminder_child"] },
    };

    it("charges the reminder agents and subagents that run.usage leaves out, under their own endpoint", async () => {
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 10, lines: [], usage: [], finalText: null, session, announced: ["reminder:verify"] });
      // An earlier poll read run.usage, which said children_included: false.
      const out = await steps.pollMuseStep({ ...input, round: 2, usageRecorded: true, childrenIncluded: false });
      assert.deepEqual(recorded, [[CHILDREN]]);
      assert.deepEqual(recordedEndpoints, ["muse exec children"]);
      assert.deepEqual(costs, ["Muse Code round 2: reminders"]);
      assert.deepEqual(out.announced, ["reminder:verify"]);
    });

    it("charges the main agent from the session log when the run never wrote run.usage", async () => {
      pollImpl = async () => ({ done: true, exitCode: 143, offset: 10, lines: [], usage: [], finalText: null, session });
      const out = await steps.pollMuseStep(input);
      assert.deepEqual(recorded, [[USAGE], [CHILDREN]]);
      assert.deepEqual(recordedEndpoints, ["muse exec", "muse exec children"]);
      assert.equal(out.usageRecorded, true);
    });

    it("never charges the main agent twice when run.usage arrived in the same poll", async () => {
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 10, lines: [], usage: [USAGE], finalText: null, session, childrenIncluded: false });
      await steps.pollMuseStep(input);
      assert.deepEqual(recordedEndpoints, ["muse exec", "muse exec children"]);
      assert.deepEqual(recorded, [[USAGE], [CHILDREN]]);
    });

    it("never charges the child agents when run.usage already counts them, even if it said so polls earlier", async () => {
      pollImpl = async () => ({ done: false, exitCode: null, offset: 500, lines: [], usage: [USAGE], finalText: null, childrenIncluded: true });
      const first = await steps.pollMuseStep(input);
      assert.equal(first.childrenIncluded, true);
      // The poll that reports done reads the session log, but run.usage was in the earlier poll.
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 600, lines: [], usage: [], finalText: null, session, childrenIncluded: null });
      const last = await steps.pollMuseStep({ ...input, offset: 500, usageRecorded: first.usageRecorded, childrenIncluded: first.childrenIncluded });
      assert.equal(pollInputs[1]!.childrenIncluded, true, "the earlier poll's answer reaches pollMuse");
      assert.deepEqual(recordedEndpoints, ["muse exec"]);
      assert.deepEqual(recorded, [[USAGE]]);
      assert.equal(last.childrenIncluded, true);
    });
  });

  describe("writeFixPromptStep", () => {
    const shots = [1, 2, 3, 4, 5].map((n) => ({ url: `https://blob/r0/0${n}.png`, caption: `step ${n}` }));
    const verifyEvent = (passed: boolean) => ({
      payload: { type: "verify", round: 0, summary: { passed, steps: [], failureOutput: "" }, screenshots: shots },
    });
    const verdict = { pass: false, blocking: false, reasons: ["The result is cut off."], mismatches: ["No total."] };

    it("copies in the screenshots the judge saw and names them in fix-<n>.md", async () => {
      selects = { build_events: [[{ payload: { type: "judge", round: 0, verdict } }, verifyEvent(true)]] };
      const out = await steps.writeFixPromptStep({ buildId: "b1", sandboxName: "sb", fix: 1, verifiedRound: 0 });
      assert.deepEqual(fixShots, [{ fix: 1, urls: ["https://blob/r0/01.png", "https://blob/r0/03.png", "https://blob/r0/04.png", "https://blob/r0/05.png"] }]);
      assert.deepEqual(out, {
        promptFile: "fix-1.md",
        images: [".muse-fix/round-1-1.png", ".muse-fix/round-1-2.png", ".muse-fix/round-1-3.png", ".muse-fix/round-1-4.png"],
      });
      assert.equal(productFiles[0]!.path, "fix-1.md");
      assert.match(productFiles[0]!.content, /4 screenshots it judged are attached to this message as images, in order: `\.muse-fix\/round-1-1\.png`/);
      assert.match(productFiles[0]!.content, /Don't move them into the product/);
    });

    it("attaches nothing when verify failed, so the judge never ran", async () => {
      selects = { build_events: [[verifyEvent(false)]] };
      const out = await steps.writeFixPromptStep({ buildId: "b1", sandboxName: "sb", fix: 2, verifiedRound: 0 });
      assert.deepEqual(out, { promptFile: "fix-2.md", images: [] });
      assert.equal(fixShots.length, 0);
      assert.doesNotMatch(productFiles[0]!.content, /attached/);
    });

    it("still writes fix-<n>.md, attaching nothing, when the screenshots can't be copied", async () => {
      fixShotsError = new Error("writeFiles failed");
      selects = { build_events: [[{ payload: { type: "judge", round: 0, verdict } }, verifyEvent(true)]] };
      const out = await steps.writeFixPromptStep({ buildId: "b1", sandboxName: "sb", fix: 3, verifiedRound: 0 });
      assert.equal(fixShots.length, 1);
      assert.deepEqual(out, { promptFile: "fix-3.md", images: [] });
      assert.equal(productFiles[0]!.path, "fix-3.md");
      assert.match(productFiles[0]!.content, /The result is cut off\./);
      assert.doesNotMatch(productFiles[0]!.content, /attached/);
    });
  });

  describe("registerStep", () => {
    const input = {
      buildId: "b1",
      productId: "prod-1",
      sandboxName: "sb",
      sessionId: "sess",
      projectId: "prj",
      liveUrl: "https://musemuse-bird.vercel.app",
      liveTokenId: "tok-live",
      demoVideoUrl: null,
      status: "live" as const,
    };

    it("never overwrites an admin's disabled status, and says so", async () => {
      returns = { products: [[{ status: "disabled" }]] };
      await steps.registerStep(input);
      const update = writes.find((w) => w.table === "products")!;
      const query = new PgDialect().sqlToQuery(update.values.status as SQL);
      assert.match(query.sql, /case when "products"\."status" = 'disabled' then 'disabled' else \$1 end/);
      assert.deepEqual(query.params, ["live"]);
      assert.equal(update.values.latestBuildId, "b1");
      assert.ok(emitted.some((e) => String(e.body.text).includes("turned this product off")));
      assert.deepEqual(revoked, [["prod-1", "build"]]);
    });

    it("sets the outcome when the product is on", async () => {
      returns = { products: [[{ status: "live" }]] };
      await steps.registerStep(input);
      assert.equal(emitted.length, 0);
    });

    it("saves a new video with its poster, null included, and leaves both alone without one", async () => {
      const saved = async (demo: { demoVideoUrl: string | null; demoPosterUrl?: string | null }) => {
        writes = [];
        returns = { products: [[{ status: "live" }]] };
        await steps.registerStep({ ...input, ...demo });
        const values = writes.find((w) => w.table === "products")!.values;
        return [values.demoVideoUrl, values.demoPosterUrl, "demoPosterUrl" in values];
      };
      assert.deepEqual(await saved({ demoVideoUrl: "https://x/demo.mp4", demoPosterUrl: "https://x/poster.jpg" }), ["https://x/demo.mp4", "https://x/poster.jpg", true]);
      // A new video without a poster clears the old one, which belongs to the old video.
      assert.deepEqual(await saved({ demoVideoUrl: "https://x/demo.mp4" }), ["https://x/demo.mp4", null, true]);
      assert.deepEqual(await saved({ demoVideoUrl: null, demoPosterUrl: null }), [undefined, undefined, false]);
    });
  });

  describe("demoSpecStep", () => {
    const BRIEF_MODELS = { ...BRIEF, capabilities: [{ model: "muse-spark-1.3" }, { model: "sam-3.1" }, { model: "muse-spark-1.3" }] };
    const input = { buildId: "b1", productId: "prod-1", sandboxName: "sb", title: "Bird Count", tagline: "Count the birds at your feeder" };
    const env = (vars: Record<string, string | undefined>) => {
      const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      return () => {
        for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      };
    };

    it("names the models for the cards and shows the URL the first deploy will get", async () => {
      const restore = env({ VERCEL_TOKEN: "tok", PLATFORM_URL: "https://muse-muse.vercel.app" });
      try {
        selects = { builds: [[{ id: "b1", brief: BRIEF_MODELS }]], products: [[{ id: "prod-1", slug: "bird-count", liveUrl: null, manifest: null }]] };
        await steps.demoSpecStep(input);
      } finally {
        restore();
      }
      assert.deepEqual(demoSpecs, [
        {
          sandboxName: "sb",
          spec: { title: "Bird Count", tagline: "Count the birds at your feeder", models: ["Muse Spark 1.3", "SAM 3.1"], url: "https://musemuse-bird-count.vercel.app" },
        },
      ]);
    });

    it("keeps a refinement's live URL, and shows none when publishing is off", async () => {
      const restore = env({ VERCEL_TOKEN: undefined });
      try {
        selects = { builds: [[{ id: "b1", brief: BRIEF_MODELS }]], products: [[{ id: "prod-1", slug: "bird-count", liveUrl: "https://bird-count-x.vercel.app", manifest: null }]] };
        await steps.demoSpecStep(input);
        selects = { builds: [[{ id: "b1", brief: BRIEF_MODELS }]], products: [[{ id: "prod-1", slug: "bird-count", liveUrl: null, manifest: null }]] };
        await steps.demoSpecStep(input);
      } finally {
        restore();
      }
      assert.deepEqual(demoSpecs.map((d) => d.spec.url), ["https://bird-count-x.vercel.app", null]);
    });

    it("takes the models from the product's first brief, or its manifest, when the build has no brief", async () => {
      selects = {
        builds: [[{ id: "r1", brief: null }], [{ brief: { ...BRIEF, capabilities: [{ model: "muse-voice-transcribe-1.0" }] } }]],
        products: [[{ id: "prod-1", slug: "bird-count", liveUrl: null, manifest: null }]],
      };
      await steps.demoSpecStep(input);
      selects = {
        builds: [[{ id: "r1", brief: null }], []],
        products: [[{ id: "prod-1", slug: "bird-count", liveUrl: null, manifest: { models: [{ id: "muse-image-1.0", usedFor: "art" }] } }]],
      };
      await steps.demoSpecStep(input);
      assert.deepEqual(demoSpecs.map((d) => d.spec.models), [["Voice Transcribe"], ["Muse Image"]]);
    });
  });

  describe("finishDemoStep", () => {
    const input = { buildId: "b1", sandboxName: "sb", title: "Bird Count", subtitle: "Count birds" };

    it("tells the build room about the video and its poster", async () => {
      demoVideo = { videoUrl: "https://x/demo.mp4", posterUrl: "https://x/poster.jpg" };
      assert.deepEqual(await steps.finishDemoStep(input), demoVideo);
      assert.deepEqual(emitted, [{ buildId: "b1", body: { type: "recording", url: "https://x/demo.mp4", posterUrl: "https://x/poster.jpg" } }]);
    });

    it("says nothing when there is no video", async () => {
      assert.deepEqual(await steps.finishDemoStep(input), { videoUrl: null, posterUrl: null });
      assert.equal(emitted.length, 0);
    });
  });

  describe("loadRefineStep", () => {
    it("copies the product's brief onto the refine row", async () => {
      selects = {
        builds: [
          [{ id: "r1", kind: "refine", productId: "prod-1", brief: null, startedAt: new Date() }],
          [{ n: 2 }],
          [{ buildModel: "muse-spark-1.3" }],
          [{ brief: BRIEF }],
        ],
        products: [[{ id: "prod-1", name: "Bird Count", tagline: "Count birds", sandboxName: "sb", museSessionId: "sess" }]],
      };
      const out = await steps.loadRefineStep("r1");
      assert.equal(out.refineIndex, 2);
      const update = writes.find((w) => w.table === "builds")!;
      assert.equal(update.values.brief, BRIEF);
      assert.equal(update.values.sandboxName, "sb");
    });

    /** Runs loadRefineStep for a product whose first build recorded `buildModel` (no row at all when undefined). */
    const refineOn = async (buildModel: string | null | undefined) => {
      selects = {
        builds: [
          [{ id: "r1", kind: "refine", productId: "prod-1", brief: BRIEF, startedAt: new Date() }],
          [{ n: 1 }],
          buildModel === undefined ? [] : [{ buildModel }],
        ],
        products: [[{ id: "prod-1", name: "Bird Count", tagline: "Count birds", sandboxName: "sb", museSessionId: "sess" }]],
      };
      const out = await steps.loadRefineStep("r1");
      const saved = writes.find((w) => w.table === "builds")!.values.buildModel;
      assert.equal(saved, out.model, "the refine row records the model it resumes on");
      return out.model;
    };

    it("resumes a Spark 1.3 product on Spark 1.3 Contributor, even with every default on Muse Wonder", async () => {
      const keys = ["BUILD_MODEL", "COMPLEX_BUILD_MODEL"] as const;
      const old = keys.map((k) => process.env[k]);
      for (const k of keys) delete process.env[k];
      try {
        assert.equal(await refineOn("muse-spark-1.3"), "muse-spark-1.3-contributor");
      } finally {
        keys.forEach((k, i) => (old[i] === undefined ? delete process.env[k] : (process.env[k] = old[i])));
      }
    });

    it("resumes a Wonder product on Wonder, even when the build default is Spark 1.3 Contributor", async () => {
      const old = process.env.BUILD_MODEL;
      process.env.BUILD_MODEL = "muse-spark-1.3-contributor";
      try {
        assert.equal(await refineOn("muse-wonder-1.0"), "muse-wonder-1.0");
      } finally {
        if (old === undefined) delete process.env.BUILD_MODEL;
        else process.env.BUILD_MODEL = old;
      }
    });

    it("resumes a product with no recorded model on Spark 1.3 Contributor, since it was built on Spark 1.3", async () => {
      assert.equal(await refineOn(null), "muse-spark-1.3-contributor");
      writes = [];
      assert.equal(await refineOn(undefined), "muse-spark-1.3-contributor");
    });
  });

  describe("refineCheckStep", () => {
    it("checks the message and the new files' names, records the cost, and returns the refusal", async () => {
      selects = {
        builds: [[{ id: "r1", kind: "refine", productId: "prod-1", message: "Make it look exactly like Chase's sign-in page", inspirationId: "i" }]],
        inspirations: [[{ note: "ignored", references: [{ fileName: "abcd1234-chase.png", kind: "image" }] }]],
      };
      checkImpl = async () => ({ refusal: "Muse Muse won't copy a bank's sign-in page.", usage: [USAGE] });
      const out = await steps.refineCheckStep("r1");
      assert.deepEqual(out, { refusal: "Muse Muse won't copy a bank's sign-in page." });
      assert.deepEqual(checkInputs[0], {
        message: "Make it look exactly like Chase's sign-in page",
        references: [{ fileName: "abcd1234-chase.png", kind: "image" }],
      });
      assert.deepEqual(recorded, [[USAGE]]);
    });

    it("lets an ordinary change through", async () => {
      selects = {
        builds: [[{ id: "r2", kind: "refine", productId: "prod-1", message: "Add a dark mode", inspirationId: "i" }]],
        inspirations: [[{ note: null, references: [] }]],
      };
      checkImpl = async () => ({ refusal: null, usage: [] });
      assert.deepEqual(await steps.refineCheckStep("r2"), { refusal: null });
    });
  });
});
