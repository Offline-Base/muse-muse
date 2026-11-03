/**
 * Runs the real step functions in build-steps.ts with the database, sandbox, judge, policy check and usage faked:
 * the judge on a refinement, Muse Code usage charging on both engines (child agents included, never twice), the engine
 * and goal a round starts with, the judge's screenshots on fix rounds, the admin kill switch at register, the brief and
 * the build model copied onto refine rows, the refinement policy check, the running round and the owner's Stop on the
 * build row, and what the fix and change prompts say about the session while the flags are on or off.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/*.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realSchema from "@/lib/db/schema";
import { goalObjective, renderRefinePrompt } from "@/lib/brief/render";
import { StructuredOutputError } from "@/lib/brief/structured";
import type { Brief, ModelUsage } from "@/lib/types";
import { z } from "zod";
import { CAP_BRIEF_FIELDS } from "@/lib/caps/brief-fields";
import { CAP_ENV } from "@/lib/caps/env";
import { CAP_BUILD_HOSTS } from "@/lib/caps/hosts";
import { CAP_READY } from "@/lib/caps/ids";
import { BRIEF as FULL_BRIEF } from "@/lib/promote/__tests__/fixtures";

type Rows = Record<string, unknown>[];

/** Select results per table, served in the order the step queries them. */
let selects: Record<string, Rows[]> = {};
/** update(...).returning() results per table. */
let returns: Record<string, Rows[]> = {};
let writes: Array<{ table: string; values: Record<string, unknown> }> = [];
/** Each select's where clause, in order. */
let wheres: Array<{ table: string; where: SQL | undefined }> = [];
let emitted: Array<{ buildId: string; body: Record<string, unknown> }> = [];
let recorded: ModelUsage[][] = [];
let recordedEndpoints: string[] = [];
let costs: string[] = [];
let fixShots: Array<{ fix: number; urls: string[] }> = [];
let fixShotsError: Error | null = null;
let productFiles: Array<{ path: string; content: string }> = [];
let revoked: unknown[][] = [];
let judgeInputs: Array<{ brief: unknown; references: Array<{ fileName: string }>; samples?: unknown[] }> = [];
/** What collectJudgeSamples finds in the sandbox, or the error it throws. */
let judgeSamples: unknown[] | Error = [];
let judgeImpl: () => Promise<unknown> = async () => ({ verdict: {}, usage: [] });
let checkInputs: unknown[] = [];
let checkImpl: () => Promise<unknown> = async () => ({ refusal: null, usage: [] });
let pollImpl: () => Promise<unknown> = async () => ({});
let pollInputs: Array<Record<string, unknown>> = [];
let startImpl: () => Promise<unknown> = async () => ({ cmdId: "cmd", logPath: "/log", engine: "exec" });
let startInputs: Array<Record<string, unknown>> = [];
let demoSpecs: Array<{ sandboxName: string; spec: Record<string, unknown> }> = [];
let demoVideo: { videoUrl: string | null; posterUrl: string | null } = { videoUrl: null, posterUrl: null };
let liveCheckImpl: (input: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true, url: "https://x", at: "t", checks: [] });
let liveCheckInputs: Array<Record<string, unknown>> = [];
let minted: Array<Record<string, unknown>> = [];
let reopened: Array<Record<string, unknown>> = [];
let provisioned: Array<Record<string, unknown>> = [];
let manifestReads = 0;
let manifestImpl: unknown = null;
let deployImpl: () => Promise<unknown> = async () => ({});
/** EDGE_ENABLED: what the drill wrote, and the drills started. */
let drillJson: string | null = null;
let drillStarts: string[] = [];
/** The model-credits check: verify's own summary, and the UI files the credit scan sends back. */
let verifySummary: { passed: boolean; steps: Array<{ name: string; ok: boolean }>; failureOutput: string } | null = null;
let creditFiles: Array<{ file: string; text: string }> | null = null;
/** The live action check: the product's fixtures by path, and the transcript's raw highlights. */
let sandboxFiles: Record<string, Buffer> = {};
let transcriptHighlights: string[] = [];

function thenable<T extends object>(q: T, result: () => unknown): T {
  return Object.assign(q, {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(result).then(resolve, reject),
  });
}

const fakeDb = () => ({
  batch: async () => [],
  select: () => {
    let table = "";
    const q: Record<string, unknown> = {};
    for (const m of ["orderBy", "limit"]) q[m] = () => q;
    q.from = (t: never) => {
      table = getTableName(t);
      return q;
    };
    q.where = (where: SQL | undefined) => {
      wheres.push({ table, where });
      return q;
    };
    return thenable(q, () => selects[table]?.shift() ?? []);
  },
  // The model-credits check's read of the gateway's record: usage joined to the build's tokens, served from selects.usage.
  selectDistinct: () => {
    let table = "";
    const q: Record<string, unknown> = {};
    q.innerJoin = () => q;
    q.from = (t: never) => {
      table = getTableName(t);
      return q;
    };
    q.where = (where: SQL | undefined) => {
      wheres.push({ table, where });
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
        mintToken: async (opts: Record<string, unknown>) => {
          minted.push(opts);
          return { id: "tok-1", token: "secret" };
        },
        revokeTokens: async (...args: unknown[]) => void revoked.push(args),
        revokeLiveTokensExcept: async (...args: unknown[]) => void revoked.push(["live except", ...args]),
      },
    });
    mock.module(at("../../judge.ts"), {
      namedExports: {
        judgeBuild: async (input: { brief: unknown; references: Array<{ fileName: string }> }) => {
          judgeInputs.push(input);
          return judgeImpl();
        },
        MAX_CHAIN_SCREENSHOTS: 48,
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
        collectDeployFiles: async () => ({ files: [] }),
        pollDeploy: async () => ({}),
        startDeployFromSandbox: async () => deployImpl(),
        projectNameFor: (slug: string) => `musemuse-${slug}`,
      },
    });
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        startMuse: async (input: Record<string, unknown>) => {
          startInputs.push(input);
          return startImpl();
        },
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
        reopenSandbox: async (input: Record<string, unknown>) => void reopened.push(input),
        provisionSandbox: async (input: Record<string, unknown>) => {
          provisioned.push(input);
          return { sandboxName: "sb" };
        },
        readManifest: async () => {
          manifestReads += 1;
          return manifestImpl;
        },
        exportTranscript: async () => ({ url: "https://x/transcript.json", highlights: transcriptHighlights }),
        readSandboxFile: async (_name: string, file: string) => sandboxFiles[file] ?? null,
        writeDemoSpec: async (sandboxName: string, spec: Record<string, unknown>) => void demoSpecs.push({ sandboxName, spec }),
        finishDemo: async () => demoVideo,
        collectVerifyResult: async () => ({ summary: verifySummary ?? { passed: true, steps: [{ name: "build", ok: true }], failureOutput: "" }, screenshots: [] }),
        scanModelCredits: async () => creditFiles,
        collectJudgeSamples: async () => {
          if (judgeSamples instanceof Error) throw judgeSamples;
          return judgeSamples;
        },
        readSandboxText: async (_name: string, file: string) => (file.endsWith("test-results/caps/edge-drill.json") ? drillJson : null),
      },
    });
    mock.module(at("../edge-drill-sandbox.ts"), {
      namedExports: {
        EDGE_DRILL_RESULTS: "/vercel/app/test-results/caps/edge-drill.json",
        startEdgeDrill: async (name: string) => {
          drillStarts.push(name);
          return { cmdId: "drill-1" };
        },
      },
    });
    mock.module(at("../../engine/live-check.ts"), {
      namedExports: {
        liveCheck: async (input: Record<string, unknown>) => {
          liveCheckInputs.push(input);
          return liveCheckImpl(input);
        },
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
    wheres = [];
    emitted = [];
    recorded = [];
    recordedEndpoints = [];
    costs = [];
    fixShots = [];
    fixShotsError = null;
    pollInputs = [];
    startInputs = [];
    startImpl = async () => ({ cmdId: "cmd", logPath: "/log", engine: "exec" });
    productFiles = [];
    revoked = [];
    judgeInputs = [];
    checkInputs = [];
    demoSpecs = [];
    demoVideo = { videoUrl: null, posterUrl: null };
    liveCheckInputs = [];
    liveCheckImpl = async () => ({ ok: true, url: "https://x", at: "t", checks: [] });
    minted = [];
    reopened = [];
    provisioned = [];
    manifestReads = 0;
    manifestImpl = null;
    verifySummary = null;
    creditFiles = null;
    sandboxFiles = {};
    transcriptHighlights = [];
  });

  describe("collectVerifyStep's model-credits check", () => {
    const SMOKED = { passed: true, steps: [{ name: "smoke", ok: true }], failureOutput: "" };
    const FRIDGE = [{ file: "app/page.tsx", text: `<div className="card-head"><h2>Your fridge</h2><ModelChip model="sam-3.1" verb="Outlined" /></div>` }];
    const build = { id: "b1", kind: "build", productId: "prod-1", brief: FULL_BRIEF, inspirationId: "i", startedAt: new Date("2026-11-03T05:00:00Z") };
    const collect = (extra: Record<string, unknown> = {}) =>
      steps.collectVerifyStep({ buildId: "b1", sandboxName: "sb", round: 0, exitCode: 0, outputTail: "", verifyStartedAt: Date.parse("2026-11-03T06:00:00Z"), ...extra });
    const verified = () => emitted.filter((e) => e.body.type === "verify").map((e) => e.body.summary as { passed: boolean; steps: Array<{ name: string; ok: boolean; detail?: string }>; failureOutput: string })[0]!;
    let saved: string | undefined;
    before(() => {
      saved = process.env.PLATFORM_URL;
      process.env.PLATFORM_URL = "https://platform.example";
    });
    after(() => (saved === undefined ? delete process.env.PLATFORM_URL : (process.env.PLATFORM_URL = saved)));

    it("fails the audit's fridge: a SAM 3.1 chip when this verify only called the vision model", async () => {
      verifySummary = SMOKED;
      creditFiles = FRIDGE;
      selects = { builds: [[build]], usage: [[{ model: "muse-spark-1.3-contributor" }]] };
      const out = await collect();
      assert.equal(out.passed, false);
      assert.deepEqual(out.steps.at(-1), { name: "model credits", ok: false });
      assert.match(verified().failureOutput, /app\/page\.tsx \(<ModelChip model="sam-3\.1">\) credits sam-3\.1, but this check's smoke run never called sam-3\.1/);
      const read = wheres.find((w) => w.table === "usage");
      const sql = new PgDialect().sqlToQuery(read!.where!);
      assert.match(sql.sql, /"usage"\."source" = \$1/);
      assert.match(sql.sql, /"gateway_tokens"\."scope" = \$3/);
      assert.ok(sql.params.includes("build") && sql.params.includes("prod-1"));
      assert.ok(sql.params.some((p) => String(p).startsWith("2026-11-03T05:59:00")), "reads only this verify's calls, with a minute of slack");
    });

    it("passes when the gateway saw the credited model, and only warns on a new build's last round", async () => {
      verifySummary = SMOKED;
      creditFiles = FRIDGE;
      selects = { builds: [[build]], usage: [[{ model: "sam-3.1" }, { model: "muse-spark-1.3-contributor" }]] };
      assert.equal((await collect()).passed, true);
      emitted = [];
      selects = { builds: [[build]], usage: [[{ model: "muse-spark-1.3-contributor" }]] };
      const last = await collect({ lastRound: true });
      assert.equal(last.passed, true);
      assert.match(verified().steps.at(-1)?.detail ?? "", /^warning: /);
      assert.ok(emitted.some((e) => e.body.type === "log" && String(e.body.text).startsWith("Model credits: app/page.tsx")));
    });

    it("adds nothing when smoke didn't pass, nothing is credited, or the product calls Meta directly", async () => {
      creditFiles = FRIDGE;
      verifySummary = { passed: false, steps: [{ name: "smoke", ok: false }], failureOutput: "smoke failed" };
      assert.deepEqual((await collect()).steps, [{ name: "smoke", ok: false }]);
      verifySummary = SMOKED;
      creditFiles = [{ file: "app/page.tsx", text: "<p>No credit here.</p>" }];
      assert.deepEqual((await collect()).steps, [{ name: "smoke", ok: true }]);
      creditFiles = FRIDGE;
      process.env.PLATFORM_URL = "http://localhost:3000";
      try {
        assert.deepEqual((await collect()).steps, [{ name: "smoke", ok: true }]);
      } finally {
        process.env.PLATFORM_URL = "https://platform.example";
      }
    });
  });

  describe("judgeStep on a refinement", () => {
    const refineRow = { id: "r1", kind: "refine", brief: null, inspirationId: "insp-refine", productId: "prod-1" };

    it("POLISH_ENABLED: on a polish with known failures it tells the judge and returns the model's own call and each requirement's state", async () => {
      const req = (n: number) => ({ id: `R${n}`, text: `Thing ${n}`, kind: "asked", words: "", savesData: false, canDo: true, cantDoWhy: null });
      const REQ_BRIEF = { ...BRIEF, requirements: [req(1), req(2)] };
      const requirements = [
        { id: "R1", text: "Thing 1", state: "met" },
        { id: "R2", text: "Thing 2", state: "unmet", detail: "Its test failed." },
      ];
      const old = process.env.FULL_BUILDS;
      process.env.FULL_BUILDS = "1";
      try {
        for (const knownFailing of [["R2"], undefined]) {
          judgeInputs = [];
          selects = {
            builds: [[{ ...refineRow, brief: REQ_BRIEF }], [{ brief: REQ_BRIEF }]],
            inspirations: [[{ references: [] }], [{ references: [] }]],
            products: [[{ id: "prod-1", inspirationId: "insp-original" }]],
            build_events: [[{ payload: { type: "verify", round: 0, summary: { passed: true, steps: [], failureOutput: "", requirements: [{ id: "R1", ok: true }, { id: "R2", ok: false }] }, screenshots: [] } }]],
          };
          judgeImpl = async () => ({ verdict: { pass: false, blocking: false, reasons: ["Fine otherwise."], mismatches: ["R2 is not met: Thing 2. Its test failed."], requirements }, usage: [], ownPass: true });
          const out = await steps.judgeStep({ buildId: "r1", productId: "prod-1", round: 0, screenshots: [], ...(knownFailing ? { knownFailing } : {}) });
          const sent = judgeInputs[0] as { knownFailing?: string[] };
          if (knownFailing) {
            assert.deepEqual(sent.knownFailing, ["R2"]);
            assert.equal(out.ownPass, true);
            assert.deepEqual(out.requirements, [{ id: "R1", state: "met" }, { id: "R2", state: "unmet" }]);
          } else {
            // Every other judge call is as it was.
            assert.equal(sent.knownFailing, undefined);
            assert.deepEqual(Object.keys(out).sort(), ["blocking", "pass", "unmet"]);
          }
        }
      } finally {
        if (old === undefined) delete process.env.FULL_BUILDS;
        else process.env.FULL_BUILDS = old;
      }
    });

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

    it("shows the judge the product's own samples from its sandbox, and judges without them when they can't be read", async () => {
      const sample = { url: "https://blob/screens/b1/r0/sample-1.jpg", fileName: "public/samples/puppy.mp4", kind: "video" };
      judgeImpl = async () => ({ verdict: { pass: true, blocking: false, reasons: ["Fine."], mismatches: [] }, usage: [] });
      for (const [found, expected] of [[[sample], [sample]], [new Error("sandbox gone"), undefined]] as const) {
        judgeInputs = [];
        judgeSamples = found as unknown[] | Error;
        selects = { builds: [[{ ...refineRow, kind: "build", brief: BRIEF, sandboxName: "sb" }]], inspirations: [[{ references: [] }]] };
        await steps.judgeStep({ buildId: "b1", productId: "prod-1", round: 0, screenshots: [] });
        assert.deepEqual(judgeInputs[0]!.samples, expected);
      }
      judgeSamples = [];
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

    it("charges usage read before the process exited, and each run's run.usage as a poll reads it", async () => {
      pollImpl = async () => ({ done: false, exitCode: null, offset: 500, lines: [], usage: [USAGE], finalText: null });
      const first = await steps.pollMuseStep(input);
      assert.equal(first.usageRecorded, true);
      assert.equal(first.done, false);
      assert.deepEqual(recorded, [[USAGE]]);

      // Polls read new bytes only, so a later run.usage is another run's: a workflow's completion comes as a second run.
      const SECOND: ModelUsage = { ...USAGE, inputTokens: 57381, cachedInputTokens: 28273, outputTokens: 251 };
      pollImpl = async () => ({ done: false, exitCode: null, offset: 900, lines: [], usage: [SECOND], finalText: null });
      const again = await steps.pollMuseStep({ ...input, offset: 500, usageRecorded: true });
      assert.equal(again.usageRecorded, true);
      assert.deepEqual(recorded, [[USAGE], [SECOND]]);
    });

    it("charges nothing until usage appears", async () => {
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 10, lines: [], usage: [], finalText: null });
      const out = await steps.pollMuseStep(input);
      assert.equal(out.usageRecorded, false);
      assert.equal(recorded.length, 0);
    });

    const CHILDREN: ModelUsage = { model: "muse-spark-1.3", inputTokens: 33775, cachedInputTokens: 0, outputTokens: 1800, costUsd: 0.0499 };
    /** The session log at done for a run whose run.usage was in the stream: nothing is left unreported. */
    const session = {
      main: { calls: 2, usage: [USAGE] },
      unreported: { calls: 0, usage: [] },
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
      pollImpl = async () => ({ done: true, exitCode: 143, offset: 10, lines: [], usage: [], finalText: null, session: { ...session, unreported: session.main } });
      const out = await steps.pollMuseStep(input);
      assert.deepEqual(recorded, [[USAGE], [CHILDREN]]);
      assert.deepEqual(recordedEndpoints, ["muse exec", "muse exec children"]);
      assert.equal(out.usageRecorded, true);
    });

    it("charges a session bridge round from its session log, under the serve endpoints, and carries the bridge's state", async () => {
      const bridgeState = { shown: { m1: "Reading the brief" }, announced: ["reminder:goal"] };
      pollImpl = async () => ({ done: false, exitCode: null, offset: 300, lines: [{ kind: "say", text: "Reading" }], usage: [], finalText: null, bridgeState });
      const serveRun = { ...input, run: { cmdId: "cmd", logPath: "/vercel/musemuse/logs/muse-r0.msp.jsonl", engine: "serve" as const } };
      const first = await steps.pollMuseStep(serveRun);
      assert.equal(pollInputs[0]!.engine, "serve");
      assert.deepEqual(first.bridgeState, bridgeState);
      assert.equal(recorded.length, 0);
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 400, lines: [], usage: [], finalText: "Done.", session: { ...session, unreported: session.main }, childrenIncluded: null });
      const last = await steps.pollMuseStep({ ...serveRun, offset: 300, bridgeState: first.bridgeState });
      assert.deepEqual(pollInputs[1]!.bridgeState, bridgeState, "the last poll's state reaches pollMuse");
      assert.deepEqual(recordedEndpoints, ["muse serve", "muse serve children"]);
      assert.deepEqual(recorded, [[USAGE], [CHILDREN]]);
      assert.equal(last.done, true);
      assert.equal(last.bridgeState, undefined);
    });

    it("charges what a session bridge round's host reported once, when its session log couldn't say", async () => {
      const serveRun = { ...input, run: { cmdId: "cmd", logPath: "/vercel/musemuse/logs/muse-r0.msp.jsonl", engine: "serve" as const } };
      pollImpl = async () => ({ done: true, exitCode: 0, offset: 400, lines: [], usage: [USAGE], finalText: null, childrenIncluded: null });
      const out = await steps.pollMuseStep(serveRun);
      assert.deepEqual(recordedEndpoints, ["muse serve"]);
      assert.deepEqual(recorded, [[USAGE]]);
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

  describe("startMuseStep", () => {
    const input = { sandboxName: "sb", sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e", promptFile: "brief.md", images: ["inspo/a.png"], model: "muse-wonder-1.0" as const, round: 0 };
    const GOAL_BRIEF = { ...BRIEF, slug: "bird-count" } as unknown as Brief;
    const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
      const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      try {
        return await fn();
      } finally {
        for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      }
    };

    it("starts today's exec round without looking the build up or adding to the build room", async () => {
      selects = { builds: [[{ id: "b9", brief: GOAL_BRIEF, productId: "prod-1" }]] };
      const out = await withEnv({ MUSE_ENGINE: undefined, MUSE_FULL: undefined }, () => steps.startMuseStep(input));
      assert.deepEqual(out, { cmdId: "cmd", logPath: "/log", engine: "exec" });
      assert.deepEqual(startInputs, [{ ...input, maxModelSteps: 200, engine: "exec", goal: null }]);
      assert.equal(selects.builds!.length, 1, "no query");
      assert.equal(emitted.length, 0);
    });

    it("gives a serve round the brief's goal and its build, and says how it runs", async () => {
      selects = { builds: [[{ id: "b9", brief: GOAL_BRIEF, productId: "prod-1" }]] };
      startImpl = async () => ({ cmdId: "cmd-2", logPath: "/vercel/musemuse/logs/muse-r0.msp.jsonl", engine: "serve", buildMcp: false });
      const out = await withEnv({ MUSE_ENGINE: "serve", MUSE_FULL: undefined }, () => steps.startMuseStep(input));
      assert.deepEqual(out, { cmdId: "cmd-2", logPath: "/vercel/musemuse/logs/muse-r0.msp.jsonl", engine: "serve" });
      assert.equal(startInputs[0]!.engine, "serve");
      assert.equal(startInputs[0]!.goal, goalObjective(GOAL_BRIEF));
      assert.equal(startInputs[0]!.buildId, "b9");
      assert.deepEqual(emitted, [{ buildId: "b9", body: { type: "log", text: "Muse Code runs this round on its session host, so its owner can steer it." } }]);
    });

    it("looks up the build the workflow names, so a change's round gets the goal its prompt names", async () => {
      // loadRefineStep copied the product's brief onto the refine row.
      selects = { builds: [[{ id: "r1", brief: GOAL_BRIEF, productId: "prod-1" }]] };
      startImpl = async () => ({ cmdId: "cmd-4", logPath: "/vercel/musemuse/logs/muse-r10.msp.jsonl", engine: "serve" });
      const change = { ...input, promptFile: "refine-1.md", images: [], round: 10, buildId: "r1" };
      await withEnv({ MUSE_ENGINE: "serve", MUSE_FULL: undefined }, () => steps.startMuseStep(change));
      assert.equal(startInputs[0]!.goal, goalObjective(GOAL_BRIEF));
      assert.equal(startInputs[0]!.buildId, "r1");
      assert.equal(wheres.length, 1);
      const lookup = new PgDialect().sqlToQuery(wheres[0]!.where!);
      assert.equal(lookup.sql, '"builds"."id" = $1');
      assert.deepEqual(lookup.params, ["r1"]);
    });

    it("says so when the bridge couldn't start, and goes on without a goal when the build isn't found", async () => {
      selects = { builds: [[]] };
      startImpl = async () => ({ cmdId: "cmd-3", logPath: "/log", engine: "exec", notice: "The session bridge couldn't install its SDK, so this round runs on muse exec." });
      const out = await withEnv({ MUSE_ENGINE: "serve", MUSE_FULL: undefined }, () => steps.startMuseStep({ ...input, buildId: "b7" }));
      assert.equal(out.engine, "exec");
      assert.equal(startInputs[0]!.goal, null);
      assert.equal(startInputs[0]!.buildId, "b7");
      assert.deepEqual(emitted.map((e) => [e.buildId, e.body.text]), [["b7", "The session bridge couldn't install its SDK, so this round runs on muse exec."]]);
    });

    it("words the build room's line for each engine and setting", () => {
      assert.equal(steps.museRunLine({ engine: "exec" }, false, 6), null);
      assert.equal(steps.museRunLine({ engine: "exec" }, true, 6), "Muse Code runs this round with muse exec. It has 6 agent slots, every reminder and the platform's hooks.");
      assert.equal(
        steps.museRunLine({ engine: "serve", buildMcp: true }, true, 1),
        "Muse Code runs this round on its session host, so its owner can steer it. It has 1 agent slot, every reminder and the platform's hooks and build tools.",
      );
      assert.equal(steps.museRunLine({ engine: "exec", notice: "The bridge didn't start." }, false, 6), "The bridge didn't start.");
      for (const line of [steps.museRunLine({ engine: "serve", buildMcp: true }, true, 6)]) assert.ok(!line?.includes("\u2014"));
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
    it("POLISH_ENABLED: a polish's fix round drops what already failed on the live version from the judge's notes and says to leave it", async () => {
      const failed = { ...verdict, mismatches: ["R2 is not met: Thing 2. Its test failed.", "R4 is not met: Thing 4. Its test failed.", "The header is clipped at 360 px."] };
      selects = { build_events: [[{ payload: { type: "judge", round: 0, verdict: failed } }, verifyEvent(true)]] };
      await steps.writeFixPromptStep({ buildId: "b1", sandboxName: "sb", fix: 1, verifiedRound: 0, knownFailing: ["R2"] });
      const text = productFiles[0]!.content;
      assert.doesNotMatch(text, /R2 is not met/);
      assert.match(text, /R4 is not met/);
      assert.match(text, /The header is clipped/);
      assert.match(text, /## Already failing before this pass\n\nR2 already failed on the live version before this UI pass\. Leave it as it is: don't spend steps on it/);
      assert.ok(!text.includes("\u2014"));
      // Without it, the fix round is written as before.
      productFiles = [];
      selects = { build_events: [[{ payload: { type: "judge", round: 0, verdict: failed } }, verifyEvent(true)]] };
      await steps.writeFixPromptStep({ buildId: "b1", sandboxName: "sb", fix: 1, verifiedRound: 0 });
      assert.match(productFiles[0]!.content, /R2 is not met/);
      assert.doesNotMatch(productFiles[0]!.content, /Already failing/);
    });
  });

  // Wave 3, unit 2 (docs/CAPABILITIES.md, section 8).
  describe("engine steps", () => {
    const FULL = (async () => (await import("@/lib/promote/__tests__/fixtures")).BRIEF)();
    const milestones = [
      { title: "Play one level", doneMeans: "A built-in level loads and can be won." },
      { title: "Level maker", doneMeans: "A generated level passes the solver and saves." },
    ];
    afterEach(() => {
      for (const k of ["ENGINE_ROUND_SCALING", "ENGINE_MILESTONES"]) delete process.env[k];
    });

    it("briefStep gives a round plan only when the engine scales or has milestones", async () => {
      const brief = { ...(await FULL), complexity: "complex" as const, milestones };
      selects = { builds: [[{ brief }]] };
      assert.ok(!("plan" in (await steps.briefStep("b1"))), "flags off: today's summary");
      process.env.ENGINE_ROUND_SCALING = "1";
      selects = { builds: [[{ brief }]] };
      const scaled = await steps.briefStep("b1");
      // A first round's floor is the one-hour build step (#10), above the scaled 25 plus 5 for a complex brief.
      assert.equal(scaled.plan?.buildMs, 60 * 60_000);
      assert.deepEqual(scaled.plan?.milestones, [], "milestones need their own flag");
      process.env.ENGINE_MILESTONES = "1";
      selects = { builds: [[{ brief }]] };
      assert.deepEqual((await steps.briefStep("b1")).plan?.milestones, [{ title: "Play one level" }, { title: "Level maker" }]);
    });

    it("BUILDS_ON_CONTRIBUTOR: briefStep refuses a personal product in plain words, and a gadget product goes on", async () => {
      process.env.BUILDS_ON_CONTRIBUTOR = "1";
      try {
        const yes = { ...(await FULL), verdict: "yes" as const, refusal: null };
        selects = { builds: [[{ brief: { ...yes, agent: { connections: "owner", tools: [] } } }]] };
        const personal = await steps.briefStep("b1");
        assert.equal(personal.verdict, "no");
        assert.match(personal.refusal ?? "", /a person's own accounts or personal tools/);
        selects = { builds: [[{ brief: { ...yes, agent: undefined, capabilities: [{ need: "See the room", model: "muse-gadget", why: "made up" }] } }]] };
        const gadget = await steps.briefStep("b1");
        assert.equal(gadget.verdict, "yes");
      } finally {
        delete process.env.BUILDS_ON_CONTRIBUTOR;
      }
    });

    it("writeMilestonePromptStep writes milestone-<n>.md with what the last strict check found", async () => {
      const brief = { ...(await FULL), milestones };
      const failed = { type: "verify", round: 0, summary: { passed: false, steps: [{ name: "smoke", ok: false, detail: "no board" }], failureOutput: "" }, screenshots: [] };
      selects = { builds: [[{ brief }]], build_events: [[{ payload: failed }]] };
      const out = await steps.writeMilestonePromptStep({ buildId: "b1", sandboxName: "sb", index: 2, of: 2, verifiedRound: 0 });
      assert.deepEqual(out, { promptFile: "milestone-2.md" });
      assert.equal(productFiles[0]!.path, "milestone-2.md");
      assert.match(productFiles[0]!.content, /^# Milestone 2 of 2: Level maker/);
      assert.match(productFiles[0]!.content, /FAILED: smoke: no board/);
    });

    it("milestoneStep tells the build room and keeps builds.round_plan in step", async () => {
      selects = { builds: [[{ roundPlan: { capMinutes: 35, milestones: [{ title: "A", state: "planned" }, { title: "B", state: "planned" }] } }]] };
      await steps.milestoneStep("b1", { index: 2, of: 2, title: "B", state: "building" });
      assert.deepEqual(emitted, [{ buildId: "b1", body: { type: "milestone", index: 2, of: 2, title: "B", state: "building" } }]);
      assert.deepEqual(writes, [{ table: "builds", values: { roundPlan: { capMinutes: 35, milestones: [{ title: "A", state: "planned" }, { title: "B", state: "building" }] } } }]);
      writes = [];
      selects = { builds: [[{ roundPlan: null }]] };
      await steps.milestoneStep("b1", { index: 1, of: 2, title: "A", state: "passed" });
      assert.deepEqual(writes, [], "no plan to keep");
    });

    it("liveCheckStep checks the live link with the product's actions, saves what it found and never throws", async () => {
      liveCheckImpl = async () => ({ ok: false, url: "https://musemuse-bird-count.vercel.app", at: "2026-10-31T00:00:00.000Z", reason: "the page answered HTTP 500", checks: [] });
      selects = { builds: [[{ brief: await FULL, productId: "prod-1" }]] };
      const out = await steps.liveCheckStep({ buildId: "b1", sandboxName: "sb", url: "https://musemuse-bird-count.vercel.app" });
      assert.deepEqual(out, { ok: false, reason: "the page answered HTTP 500" });
      assert.deepEqual(liveCheckInputs[0], { url: "https://musemuse-bird-count.vercel.app", actions: [], health: false });
      assert.deepEqual(writes, [{ table: "builds", values: { liveCheck: { ok: false, at: "2026-10-31T00:00:00.000Z", url: "https://musemuse-bird-count.vercel.app", reason: "the page answered HTTP 500" } } }]);
      assert.deepEqual(emitted.map((e) => e.body), [{ type: "live_check", ok: false, url: "https://musemuse-bird-count.vercel.app", reason: "the page answered HTTP 500" }]);

      liveCheckImpl = async () => {
        throw new Error("dns");
      };
      selects = { builds: [[{ brief: await FULL, productId: "prod-1" }]] };
      const broken = await steps.liveCheckStep({ buildId: "b1", sandboxName: "sb", url: "https://x.vercel.app" });
      assert.equal(broken.ok, false);
      assert.match(broken.reason ?? "", /^the check couldn't run \(dns\)$/);
    });
  });

  describe("liveActionStep (LIVE_ACTION_CHECK)", () => {
    let server: import("node:http").Server;
    let base = "";
    let reply: { status: number; body: unknown; wait?: number } = { status: 200, body: { ok: true } };
    let posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const manifest = (over: Record<string, unknown> = {}) => ({
      name: "Sim Desk",
      slug: "sim-desk",
      tagline: "A toy desk agent",
      inspiration: "x",
      models: [{ id: "muse-wonder-1.0", usedFor: "deciding" }],
      actions: [
        { name: "delete_note", description: "Deletes", input: { type: "object" }, output: { type: "object" }, example: { id: 1 }, annotations: { readOnly: false } },
        { name: "decide_next_step", description: "Decides", input: { type: "object" }, output: { type: "object" }, example: { runId: "r1", screenshotDataUrl: "data:image/png;base64,AAA" } },
      ],
      fixtures: [{ path: "fixtures/desk.png", description: "A desk" }, { path: "fixtures/notes.txt", description: "Notes" }],
      limits: [],
      estimatedCostPerRunUsd: 0.05,
      ...over,
    });

    before(async () => {
      const http = await import("node:http");
      server = http.createServer((req, res) => {
        let text = "";
        req.on("data", (c) => (text += c));
        req.on("end", () => {
          posts.push({ path: req.url ?? "", body: JSON.parse(text || "{}") });
          setTimeout(() => {
            res.writeHead(reply.status, { "content-type": "application/json" });
            res.end(JSON.stringify(reply.body));
          }, reply.wait ?? 0);
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    });
    after(() => new Promise<void>((r) => server.close(() => r())));
    beforeEach(() => {
      posts = [];
      reply = { status: 200, body: { ok: true } };
    });

    const run = () => steps.liveActionStep({ buildId: "b1", productId: "prod-1", sandboxName: "sb", url: `${base}/` });

    it("calls the first safe action once with its example, swapping a shortened picture for the product's own sample", async () => {
      manifestImpl = manifest();
      sandboxFiles = { "/vercel/app/fixtures/desk.png": Buffer.from("png-bytes") };
      selects = { build_events: [[]], usage: [[{ total: 0.004 }]] };
      const out = await run();
      assert.deepEqual(out, { ok: true });
      assert.equal(posts.length, 1, "one call");
      assert.equal(posts[0]!.path, "/api/actions/decide_next_step", "never the action marked as changing things");
      assert.equal(posts[0]!.body.screenshotDataUrl, `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
      assert.equal(posts[0]!.body.runId, "r1");
      assert.deepEqual(costs, ["Live check: one call to the live product"]);
      assert.deepEqual(emitted.map((e) => e.body), [{ type: "live_check", ok: true, url: base, action: "decide_next_step" }]);
      assert.equal((writes[0]!.values.liveCheck as { ok: boolean }).ok, true);
    });

    it("fails, as a known issue, on a reply that covers a model failure with a stand-in", async () => {
      manifestImpl = manifest();
      selects = { build_events: [[]], usage: [[{ total: 0 }]] };
      reply = { status: 200, body: { action: "click", model: false, error: "An AI model is unavailable right now. Using the local plan instead." } };
      const out = await run();
      assert.equal(out.ok, false);
      assert.equal(out.reason, "decide_next_step answered without its AI model (model: false): An AI model is unavailable right now. Using the local plan instead.");
      assert.deepEqual(emitted.at(-1)!.body, { type: "live_check", ok: false, url: base, action: "decide_next_step", reason: out.reason });
      assert.deepEqual(costs, [], "nothing spent, nothing charged");
    });

    it("fails on a server error, and neither passes nor fails on a refused sample", async () => {
      manifestImpl = manifest();
      selects = { build_events: [[]], usage: [[{ total: 0 }]] };
      reply = { status: 502, body: { error: "That call failed." } };
      assert.deepEqual(await run(), { ok: false, reason: "decide_next_step answered HTTP 502: That call failed." });
      emitted = [];
      selects = { build_events: [[]], usage: [[{ total: 0 }]] };
      reply = { status: 422, body: { error: "bad screenshot" } };
      assert.deepEqual(await run(), { ok: true });
      assert.deepEqual(emitted.map((e) => e.body.type), ["log"], "a line that says so, never a pass");
      assert.match(String(emitted[0]!.body.text), /neither passed nor failed: decide_next_step refused the sample input \(HTTP 422\)/);
    });

    it("makes no call for a costly run, a product with nothing safe to call, or a call Prove it already made on this deploy", async () => {
      manifestImpl = manifest({ estimatedCostPerRunUsd: 5 });
      assert.deepEqual(await run(), { ok: true });
      manifestImpl = manifest({ actions: [manifest().actions[0]] });
      assert.deepEqual(await run(), { ok: true });
      assert.equal(posts.length, 0);
      assert.ok(emitted.every((e) => e.body.type === "log" && String(e.body.text).startsWith("The live check called no action:")));
      emitted = [];
      manifestImpl = manifest();
      selects = { build_events: [[{ payload: { type: "deploy", url: base } }, { payload: { type: "prove", item: "mcp", checks: [{ ok: false, label: "Call decide_next_step" }] } }]] };
      assert.deepEqual(await run(), { ok: false, reason: "decide_next_step failed when Prove it called it" });
      assert.equal(posts.length, 0);
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
      assert.deepEqual(revoked, [
        ["prod-1", "build"],
        ["live except", "prod-1", "tok-live"],
      ]);
    });

    it("logs how it was built without the build machine's paths, session ids or raw tool output", async () => {
      returns = { products: [[{ status: "live" }]] };
      transcriptHighlights = [
        "266 tool calls, 80 edits touching 80 files",
        "Read text file `/vercel/.local/share/muse/sessions/2026/11/03/01a19fda-2f91-7801-af60-9c4a872edba7/tool-outputs/x/subagent-1-subagent_result.txt`.",
        "{",
        "Read text file `app/page.tsx`.",
        '<read-skill-result name="meta-reasoning" status="ok">',
        "Ran npm test in /vercel/app/tests",
      ];
      await steps.registerStep(input);
      assert.deepEqual(emitted.map((e) => e.body.text), ["How it was built:\n266 tool calls, 80 edits touching 80 files\nRead text file `app/page.tsx`.\nRan npm test in tests"]);
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
          [], // no other row holds the product's session, so it resumes on the first build's model
          [{ brief: BRIEF }],
        ],
        products: [[{ id: "prod-1", name: "Bird Count", tagline: "Count birds", sandboxName: "sb", museSessionId: "sess" }]],
      };
      const out = await steps.loadRefineStep("r1");
      assert.equal(out.refineIndex, 2);
      const update = writes.find((w) => w.table === "builds")!;
      assert.equal(update.values.brief, BRIEF);
      assert.equal(update.values.sandboxName, "sb");
      // With no engine flag the change has no plan, and its room shows the plain build's real time limit.
      assert.deepEqual(update.values.roundPlan, { capMinutes: 60, wallMinutes: 120, milestones: [] });
    });

    it("records a scaled change's wall as its time limit, and none for a restore", async () => {
      const full = (await import("@/lib/promote/__tests__/fixtures")).BRIEF;
      const rows = () => ({
        builds: [
          [{ id: "r1", kind: "refine", productId: "prod-1", brief: full, startedAt: new Date() }],
          [{ n: 1 }],
          [{ buildModel: "muse-wonder-1.0" }],
        ],
        products: [[{ id: "prod-1", name: "Bird Count", tagline: "Count birds", sandboxName: "sb", museSessionId: "sess" }]],
      });
      process.env.ENGINE_ROUND_SCALING = "1";
      try {
        selects = rows();
        await steps.loadRefineStep("r1");
        assert.equal((writes.find((w) => w.table === "builds")!.values.roundPlan as { wallMinutes: number }).wallMinutes, 90);
        writes = [];
        selects = rows();
        await steps.loadRefineStep("r1", { restore: true });
        assert.ok(!("roundPlan" in writes.find((w) => w.table === "builds")!.values));
      } finally {
        delete process.env.ENGINE_ROUND_SCALING;
      }
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

    it("POLISH_ENABLED: a polish row runs on Muse Wonder in a fresh session under the switch, with its bounds, and a look-alike doesn't", async () => {
      const { polishNote } = await import("@/lib/polish/logic");
      const rows = (row: Record<string, unknown>) => ({
        builds: [
          [{ id: "r1", kind: "refine", productId: "prod-1", brief: BRIEF, startedAt: new Date(), ...row }],
          [{ n: 1 }],
          [{ buildModel: "muse-spark-1.3-contributor" }],
          [{ buildModel: "muse-spark-1.3-contributor" }],
        ],
        products: [[{ id: "prod-1", name: "Bird Count", tagline: "Count birds", sandboxName: "sb", museSessionId: "sess" }]],
      });
      const old = process.env.BUILDS_ON_CONTRIBUTOR;
      process.env.BUILDS_ON_CONTRIBUTOR = "1";
      try {
        selects = rows({ message: polishNote(), buildModel: "muse-wonder-1.0" });
        const out = await steps.loadRefineStep("r1");
        assert.equal(out.model, "muse-wonder-1.0");
        assert.equal(out.freshSession, true);
        assert.deepEqual(out.polish, { maxUsd: 4, productUsd: 0.8, roundSteps: 26, fixSteps: 14, fixRounds: 1 });
        assert.equal(writes.find((w) => w.table === "builds")!.values.buildModel, "muse-wonder-1.0");
        // The note without the row's override, or the override on a person's note: an ordinary change on Contributor.
        for (const row of [{ message: polishNote(), buildModel: null }, { message: "Dark mode", buildModel: "muse-wonder-1.0" }]) {
          writes = [];
          selects = rows(row);
          const plain = await steps.loadRefineStep("r1");
          assert.equal(plain.model, "muse-spark-1.3-contributor");
          assert.equal(plain.polish, undefined);
        }
      } finally {
        if (old === undefined) delete process.env.BUILDS_ON_CONTRIBUTOR;
        else process.env.BUILDS_ON_CONTRIBUTOR = old;
      }
    });

    it("POLISH_ENABLED: a polish of a product with requirements reads what the live build's last judge said of each, and unknown when it said nothing", async () => {
      const { polishNote } = await import("@/lib/polish/logic");
      const req = (n: number) => ({ id: `R${n}`, text: `Thing ${n}`, kind: "asked", words: "", savesData: false, canDo: true, cantDoWhy: null });
      const REQ_BRIEF = { ...BRIEF, requirements: [req(1), req(2), req(3)] };
      const rows = (judge: Rows, message = polishNote()) => ({
        builds: [
          [{ id: "r1", kind: "refine", productId: "prod-1", brief: REQ_BRIEF, startedAt: new Date(), message, buildModel: "muse-wonder-1.0" }],
          [{ n: 1 }],
          [{ buildModel: "muse-wonder-1.0" }],
          [{ buildModel: "muse-wonder-1.0" }],
        ],
        products: [[{ id: "prod-1", name: "Bird Count", tagline: "Count birds", sandboxName: "sb", museSessionId: "sess", latestBuildId: "live-1" }]],
        build_events: [judge],
      });
      const verdict = (states: string[]) => ({ type: "judge", round: 2, verdict: { pass: false, reasons: ["x"], mismatches: [], requirements: states.map((state, i) => ({ id: `R${i + 1}`, text: `Thing ${i + 1}`, state })) } });
      const old = process.env.FULL_BUILDS;
      process.env.FULL_BUILDS = "1";
      try {
        selects = rows([{ payload: verdict(["met", "unmet", "unmet"]) }]);
        assert.deepEqual((await steps.loadRefineStep("r1")).polishBaseline, { known: true, failing: ["R2", "R3"], met: ["R1"] });
        // A judge event with no requirement list (the judge couldn't run), or no judge event: unknown, so every requirement must pass.
        selects = rows([{ payload: { type: "judge", round: 0, verdict: { pass: false, reasons: ["x"], mismatches: [] } } }]);
        assert.deepEqual((await steps.loadRefineStep("r1")).polishBaseline, { known: false, failing: [], met: [] });
        selects = rows([]);
        assert.deepEqual((await steps.loadRefineStep("r1")).polishBaseline, { known: false, failing: [], met: [] });
        // An ordinary change never reads it.
        selects = rows([{ payload: verdict(["met", "unmet", "unmet"]) }], "Dark mode");
        assert.equal((await steps.loadRefineStep("r1")).polishBaseline, undefined);
        // With FULL_BUILDS off the judge doesn't decide requirements, so the polish keeps today's gate.
        process.env.FULL_BUILDS = "";
        selects = rows([{ payload: verdict(["met", "unmet", "unmet"]) }]);
        assert.equal((await steps.loadRefineStep("r1")).polishBaseline, undefined);
      } finally {
        if (old === undefined) delete process.env.FULL_BUILDS;
        else process.env.FULL_BUILDS = old;
      }
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

  describe("the running round and the owner's Stop", () => {
    /** Steering on (the session bridge) or off, for one test. Returns the undo. */
    const steering = (on: boolean) => {
      const old = { MUSE_ENGINE: process.env.MUSE_ENGINE, MUSE_FULL: process.env.MUSE_FULL };
      if (on) process.env.MUSE_ENGINE = "serve";
      else delete process.env.MUSE_ENGINE;
      delete process.env.MUSE_FULL;
      return () => {
        for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      };
    };
    const input = { buildId: "b1", productId: "prod-1", sandboxName: "sb", run: { cmdId: "cmd", logPath: "/log" }, offset: 0, round: 1 };

    it("puts the running round on the build row, or takes it off, and reads the Stop in the same update", async () => {
      const restore = steering(true);
      try {
        returns = { builds: [[{ stopRequested: false }], [{ stopRequested: true }]] };
        assert.equal(await steps.museRoundStep("b1", 11), false);
        assert.equal(await steps.museRoundStep("b1", null), true);
      } finally {
        restore();
      }
      assert.deepEqual(writes, [
        { table: "builds", values: { museRound: 11 } },
        { table: "builds", values: { museRound: null } },
      ]);
    });

    it("has every poll read the Stop, and the poll that sees the run end take its round off", async () => {
      const restore = steering(true);
      try {
        pollImpl = async () => ({ done: false, exitCode: null, offset: 500, lines: [], usage: [], finalText: null });
        selects = { builds: [[{ stopRequested: true }]] };
        assert.equal((await steps.pollMuseStep(input)).stopRequested, true);
        assert.equal(writes.length, 0, "a run still going keeps its round");

        pollImpl = async () => ({ done: true, exitCode: 0, offset: 600, lines: [], usage: [], finalText: null });
        returns = { builds: [[{ stopRequested: false }]] };
        assert.equal((await steps.pollMuseStep({ ...input, offset: 500 })).stopRequested, false);
      } finally {
        restore();
      }
      assert.deepEqual(writes, [{ table: "builds", values: { museRound: null } }]);
    });

    it("leaves the build row alone while steering is off", async () => {
      const restore = steering(false);
      try {
        pollImpl = async () => ({ done: true, exitCode: 0, offset: 10, lines: [], usage: [], finalText: null });
        returns = { builds: [[{ stopRequested: true }]] };
        assert.equal(await steps.museRoundStep("b1", 0), false);
        assert.equal((await steps.pollMuseStep(input)).stopRequested, false);
      } finally {
        restore();
      }
      assert.equal(writes.length, 0);
    });
  });

  describe("what a fix round's or a change's prompt says about the session", () => {
    /** The prompt file a step writes with MUSE_ENGINE and MUSE_FULL set as given. */
    const promptWith = async (vars: Record<string, string | undefined>, write: () => Promise<unknown>) => {
      const old = { MUSE_ENGINE: process.env.MUSE_ENGINE, MUSE_FULL: process.env.MUSE_FULL };
      for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      try {
        productFiles = [];
        await write();
        return productFiles[0]!.content;
      } finally {
        for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      }
    };
    const fixPrompt = (vars: Record<string, string | undefined>) =>
      promptWith(vars, () => {
        selects = { build_events: [[{ payload: { type: "verify", round: 0, summary: { passed: false, steps: [], failureOutput: "boom" }, screenshots: [] } }]] };
        return steps.writeFixPromptStep({ buildId: "b1", sandboxName: "sb", fix: 1, verifiedRound: 0 });
      });
    const changePrompt = (vars: Record<string, string | undefined>) =>
      promptWith(vars, () => {
        selects = {
          builds: [[{ id: "r1", kind: "refine", productId: "prod-1", message: "Add a dark mode", inspirationId: "i", brief: { ...BRIEF, capabilities: [{ model: "muse-spark-1.3" }] } }]],
          inspirations: [[{ note: null, references: [] }]],
        };
        return steps.reopenStep({ buildId: "r1", productId: "prod-1", sandboxName: "sb", refineIndex: 2 });
      });

    it("names the goal on the session bridge, the owner's notes and the playbook wherever steering is on, and none of them on plain muse exec", async () => {
      const bridge = await fixPrompt({ MUSE_ENGINE: "serve", MUSE_FULL: undefined });
      assert.match(bridge, /`get_goal`/);
      assert.match(bridge, /The build's owner can send you notes while you fix/);
      assert.match(bridge, /Stay within the agent capacity the run allows/);
      // MUSE_FULL's hook hands the owner's notes to `muse exec`, which has no goal set for it.
      const full = await fixPrompt({ MUSE_ENGINE: undefined, MUSE_FULL: "1" });
      assert.doesNotMatch(full, /get_goal/);
      assert.match(full, /The build's owner can send you notes/);
      assert.match(full, /Stay within the agent capacity the run allows/);
      const plain = await fixPrompt({ MUSE_ENGINE: undefined, MUSE_FULL: undefined });
      assert.doesNotMatch(plain, /get_goal|The build's owner|agent capacity|subagent/);
    });

    it("POLISH_ENABLED: a polish's build token carries the marker and its budget, and another change's doesn't", async () => {
      const reopen = (polish?: { productUsd: number }) => {
        selects = {
          builds: [[{ id: "r1", kind: "refine", productId: "prod-1", message: "Add a dark mode", inspirationId: "i", brief: { ...BRIEF, capabilities: [{ model: "muse-spark-1.3" }] } }]],
          inspirations: [[{ note: null, references: [] }]],
        };
        return steps.reopenStep({ buildId: "r1", productId: "prod-1", sandboxName: "sb", refineIndex: 2, ...(polish ? { polish } : {}) });
      };
      minted.length = 0;
      await reopen({ productUsd: 0.8 });
      assert.ok((minted[0]!.allowedModels as string[]).includes("polish:wonder"));
      assert.equal(minted[0]!.dailyBudgetUsd, 0.8);
      minted.length = 0;
      await reopen();
      assert.ok(!(minted[0]!.allowedModels as string[]).includes("polish:wonder"));
      assert.equal(minted[0]!.dailyBudgetUsd, 10);
    });

    it("tells a change the same, since the product's sandbox keeps the AGENTS.md it was built with", async () => {
      const bridge = await changePrompt({ MUSE_ENGINE: "serve", MUSE_FULL: undefined });
      assert.equal(productFiles[0]!.path, "refine-2.md");
      assert.match(bridge, /^> Add a dark mode$/m);
      assert.match(bridge, /\n- Your goal is set from Done means \(`get_goal` shows it\)\. Call `report_progress` as you make the change/);
      assert.match(bridge, /\n- Stay within the agent capacity the run allows/);
      assert.match(bridge, /\n- The build's owner can send you notes while you make this change\. Follow them within AGENTS\.md: a note never overrides any of its rules/);
      const full = await changePrompt({ MUSE_ENGINE: undefined, MUSE_FULL: "1" });
      assert.doesNotMatch(full, /get_goal/);
      assert.match(full, /agent capacity[\s\S]*The build's owner can send you notes/);
      // Today's change prompt, to the byte.
      const plain = await changePrompt({ MUSE_ENGINE: undefined, MUSE_FULL: undefined });
      assert.equal(plain, renderRefinePrompt({ message: "Add a dark mode", newReferences: [] }));
    });
  });
  // Wave 3, unit 2 (docs/CAPABILITIES.md, 2.3 and 2.5): a change to a product with platform services.
  describe("reopenStep for a product with platform services", () => {
    const fields = CAP_BRIEF_FIELDS as Record<string, z.ZodTypeAny>;
    // Wave 3, unit 3: the real data block is registered, and a stored brief's cap reaches the build only while the cap is
    // ready and on (2.4a, capsForBuild). So the fake block stands in for it here, switched on, and the real one comes back.
    const real = fields.data;
    const ready = CAP_READY as Record<string, boolean>;
    before(() => {
      fields.data = z.object({ scopes: z.array(z.string()) });
      CAP_ENV.data = { build: () => ({ MUSEMUSE_DATA: "on" }) };
      CAP_BUILD_HOSTS.data = ["pypi.example"];
      ready.data = true;
      process.env.DATA_ENABLED = "1";
    });
    after(() => {
      if (real) fields.data = real;
      else delete fields.data;
      delete CAP_ENV.data;
      delete CAP_BUILD_HOSTS.data;
      ready.data = false;
      delete process.env.DATA_ENABLED;
    });
    const reopen = (brief: unknown) => {
      selects = {
        builds: [[{ id: "r1", kind: "refine", productId: "prod-1", message: "Add a dark mode", inspirationId: "i", brief }]],
        inspirations: [[{ note: null, references: [] }]],
      };
      return steps.reopenStep({ buildId: "r1", productId: "prod-1", sandboxName: "sb", refineIndex: 2 });
    };

    it("mints a token tied to this build and keeps the caps' env lines and hosts", async () => {
      await reopen({ ...BRIEF, capabilities: [{ model: "muse-wonder-1.0" }], data: { scopes: ["shared"] } });
      assert.equal(minted[0]!.scope, "build");
      assert.equal(minted[0]!.buildId, "r1", "the change's rows live in the build namespace b:r1, never in live");
      assert.equal(reopened[0]!.capEnv, "MUSEMUSE_DATA=on\n");
      assert.equal(reopened[0]!.caps, true, "the caps check's gateway record gets the change's token");
      assert.deepEqual(reopened[0]!.capHosts, ["pypi.example"]);
    });

    it("says once at provision that a local run can't reach the gateway, and says nothing on a public one", async () => {
      const saved = process.env.PLATFORM_URL;
      const provision = () => {
        selects = {
          builds: [[{ id: "b1", kind: "build", productId: "prod-1", inspirationId: "i", brief: { ...FULL_BRIEF, data: { scopes: ["shared"] } } }]],
          inspirations: [[{ note: null, references: [] }]],
        };
        return steps.provisionStep({ buildId: "b1", productId: "prod-1", slug: "bird-count", fixtures: [] });
      };
      try {
        process.env.PLATFORM_URL = "http://localhost:3000";
        await provision();
        assert.deepEqual(emitted.filter((e) => e.body.type === "log").map((e) => e.body.text), [steps.CAPS_LOCAL_RUN_NOTE]);
        assert.equal(minted[0]!.buildId, "b1");
        emitted = [];
        process.env.PLATFORM_URL = "https://platform.example";
        await provision();
        assert.deepEqual(emitted.filter((e) => e.body.type === "log"), []);
      } finally {
        saved === undefined ? delete process.env.PLATFORM_URL : (process.env.PLATFORM_URL = saved);
      }
    });

    it("a live token's caps are narrowed by the product's musemuse.json at deploy, never widened", async () => {
      const deploy = (brief: unknown) => {
        selects = {
          builds: [[{ id: "b1", kind: "build", productId: "prod-1", inspirationId: "i", brief }]],
          products: [[{ id: "prod-1", slug: "bird-count", name: "Bird Count", vercelProjectId: null }]],
        };
        return steps.startDeployStep({ buildId: "b1", productId: "prod-1", sandboxName: "sb" });
      };
      const withData = { ...FULL_BRIEF, data: { scopes: ["shared"] } };
      manifestImpl = { caps: ["files"] };
      await deploy(withData);
      assert.equal(minted[0]!.scope, "live");
      assert.ok(!(minted[0]!.allowedModels as string[]).includes("cap:data"), "the manifest left data out");
      assert.ok(!(minted[0]!.allowedModels as string[]).includes("cap:files"), "and can't add files");
      minted = [];
      manifestImpl = { caps: ["data"] };
      await deploy(withData);
      assert.ok((minted[0]!.allowedModels as string[]).includes("cap:data"));
      // A product with no caps: the manifest isn't read at deploy, as before.
      minted = [];
      manifestReads = 0;
      await deploy(FULL_BRIEF);
      assert.equal(manifestReads, 0);
    });

    it("leaves a product with no caps as it was: no build id, no extra env, no hosts", async () => {
      await reopen({ ...BRIEF, capabilities: [{ model: "muse-wonder-1.0" }] });
      assert.ok(!("buildId" in minted[0]!));
      assert.ok(!("capEnv" in reopened[0]!));
      assert.ok(!("capHosts" in reopened[0]!));
    });
  });
  // Wave 3, unit 1 (docs/CAPABILITIES.md, section 7).
  describe("startDeployStep and a refused deploy", () => {
    const deploy = () => {
      selects = {
        builds: [[{ id: "b1", kind: "build", productId: "prod-1", inspirationId: "i", brief: FULL_BRIEF }]],
        products: [[{ id: "prod-1", slug: "bird-count", name: "Bird Count", vercelProjectId: null }]],
      };
      return steps.startDeployStep({ buildId: "b1", productId: "prod-1", sandboxName: "sb" });
    };
    const tokenRevokes = () => writes.filter((w) => w.table === "gateway_tokens" && w.values.revokedAt instanceof Date);

    it("revokes the live token it minted when the deploy is refused for good (files too big), and leaves it for a retry otherwise", async () => {
      try {
        deployImpl = async () => {
          throw new FakeFatalError("The product has a file over Vercel's 100.0 MB limit for one file, so it wasn't deployed.");
        };
        await assert.rejects(deploy(), /wasn't deployed/);
        assert.equal(minted.at(-1)!.scope, "live");
        assert.equal(tokenRevokes().length, 1, "the unused token");
        writes = [];
        deployImpl = async () => {
          throw new Error("fetch failed");
        };
        await assert.rejects(deploy(), /fetch failed/);
        assert.equal(tokenRevokes().length, 0, "a retried step mints its own, and this one may be in a deployment");
        deployImpl = async () => ({ projectId: "prj_1", deploymentId: "dpl_1" });
        writes = [];
        await deploy();
        assert.equal(tokenRevokes().length, 0);
      } finally {
        deployImpl = async () => ({});
      }
    });
  });

  // Wave 3, unit 2 (docs/CAPABILITIES.md, section 8).
  // Wave 3, unit 11: the shared Glimmer endpoint has no cap block, so its .env.local line has its own path.
  describe("a no-caps brief that picks muse-glimmer", () => {
    const GLIMMER = { ...FULL_BRIEF, capabilities: [{ need: "x", model: "muse-glimmer", why: "y" }] };
    const LINES = "GLIMMER_SHARED=1\nGLIMMER_MODEL=muse-glimmer\n";
    const reopen = () => {
      selects = { builds: [[{ id: "r1", kind: "refine", productId: "prod-1", message: "Add a dark mode", inspirationId: "i", brief: GLIMMER }]], inspirations: [[{ note: null, references: [] }]] };
      return steps.reopenStep({ buildId: "r1", productId: "prod-1", sandboxName: "sb", refineIndex: 2 });
    };
    const provision = () => {
      selects = { builds: [[{ id: "b1", kind: "build", productId: "prod-1", brief: GLIMMER, inspirationId: "i" }]], inspirations: [[{ note: null, references: [] }]] };
      return steps.provisionStep({ buildId: "b1", productId: "prod-1", slug: "bird-count", fixtures: [] });
    };
    afterEach(() => {
      delete process.env.GPU_GLIMMER_SHARED;
    });

    it("gets its line at provision and on a change, with the flag on", async () => {
      process.env.GPU_GLIMMER_SHARED = "1";
      await provision();
      assert.equal(provisioned[0]!.capEnv, LINES);
      assert.ok(!("caps" in provisioned[0]!));
      await reopen();
      assert.equal(reopened[0]!.capEnv, LINES);
      assert.ok(!("caps" in reopened[0]!));
    });

    it("gets nothing with the flag off", async () => {
      await provision();
      assert.ok(!("capEnv" in provisioned[0]!));
      await reopen();
      assert.ok(!("capEnv" in reopened[0]!));
    });
  });

  describe("edge builds (EDGE_ENABLED)", () => {
    const EDGE_BRIEF = { ...FULL_BRIEF, targets: [{ id: "web", why: "w" }, { id: "edge", why: "Keep answering when the cloud is cut." }] };
    const provision = (brief: unknown) => {
      selects = { builds: [[{ id: "b1", kind: "build", productId: "prod-1", brief, inspirationId: "i" }]], inspirations: [[{ note: null, references: [] }]] };
      return steps.provisionStep({ buildId: "b1", productId: "prod-1", slug: "bird-count", fixtures: [] });
    };
    const on = () => {
      process.env.EDGE_ENABLED = "1";
      process.env.EDGE_BUILDS = "1";
    };
    const results = (pass: boolean[]) =>
      JSON.stringify({ simulated: true, results: pass.map((p, i) => ({ id: i + 1, name: `d${i + 1}`, pass: p, ms: 100, why: p ? null : "the reply has no plain both-down message" })) });
    const verifyEvents = () => emitted.filter((e) => e.body.type === "verify").map((e) => e.body.summary as { passed: boolean; steps: Array<{ name: string; ok: boolean }>; failureOutput: string });
    afterEach(() => {
      delete process.env.EDGE_ENABLED;
      delete process.env.EDGE_BUILDS;
      drillJson = null;
      drillStarts = [];
    });

    it("with the flags off, an edge brief gets no Next config and verify's summary is verify's own", async () => {
      await provision(EDGE_BRIEF);
      assert.ok(!("extraFiles" in provisioned[0]!));
      await steps.collectVerifyStep({ buildId: "b1", sandboxName: "sb", round: 0, exitCode: 0, outputTail: "" });
      assert.deepEqual(verifyEvents()[0], { passed: true, steps: [{ name: "build", ok: true }], failureOutput: "" });
    });

    it("with the flags on, only an edge brief gets the standalone Next config", async () => {
      on();
      await provision(EDGE_BRIEF);
      const files = provisioned[0]!.extraFiles as Array<{ path: string; content: string }>;
      assert.match(files.find((f) => f.path === "next.config.ts")!.content, /output: "standalone"/);
      assert.ok(files.some((f) => f.path === "scripts/edge-drill.mjs"), "the drill kit comes with the edge target");
      assert.ok(files.some((f) => f.path === "lib/meta/edge.ts"), "and the fallback helper");
      provisioned = [];
      await provision(FULL_BRIEF);
      const other = (provisioned[0]!.extraFiles ?? []) as Array<{ path: string }>;
      assert.ok(!other.some((f) => f.path === "next.config.ts"));
      for (const want of ["lib/meta/edge.ts", ".agents/skills/muse-edge/SKILL.md", "scripts/edge-drill.mjs", "scripts/edge-fake.mjs", "scripts/edge-blackhole.mjs"]) {
        assert.ok(!other.some((f) => f.path === want), `a build without the edge target gets no ${want}`);
      }
    });

    it("starts the drill on the build's sandbox", async () => {
      on();
      assert.equal(await steps.startEdgeDrillStep("sb"), "drill-1");
      assert.deepEqual(drillStarts, ["sb"]);
    });

    it("adds a passing drill as four passed steps", async () => {
      on();
      drillJson = results([true, true, true, true]);
      const r = await steps.collectVerifyStep({ buildId: "b1", sandboxName: "sb", round: 0, exitCode: 0, outputTail: "", edgeDrill: { exitCode: 0, timedOut: false, outputTail: "" } });
      assert.equal(r.passed, true);
      assert.equal(r.steps.length, 5);
      assert.ok(r.steps.slice(1).every((x) => x.ok && x.name.startsWith("Simulated outage drill")));
      assert.equal(verifyEvents()[0]!.passed, true);
    });

    it("fails the round on a failed drill, in the build room's verify event and the fix round's output", async () => {
      on();
      drillJson = results([true, true, false, true]);
      const r = await steps.collectVerifyStep({ buildId: "b1", sandboxName: "sb", round: 0, exitCode: 0, outputTail: "", edgeDrill: { exitCode: 1, timedOut: false, outputTail: "" } });
      assert.equal(r.passed, false);
      assert.deepEqual(r.steps.map((x) => x.ok), [true, true, true, false, true]);
      const event = verifyEvents()[0]!;
      assert.equal(event.passed, false);
      assert.match(event.failureOutput, /Simulated outage drill 3: both down: the reply has no plain both-down message/);
    });

    it("fails every drill when the drill wrote nothing", async () => {
      on();
      const r = await steps.collectVerifyStep({ buildId: "b1", sandboxName: "sb", round: 0, exitCode: 0, outputTail: "", edgeDrill: { exitCode: 2, timedOut: false, outputTail: "edge-drill: No route to ask" } });
      assert.equal(r.passed, false);
      assert.deepEqual(r.steps.map((x) => x.ok), [true, false, false, false, false]);
      assert.match(verifyEvents()[0]!.failureOutput, /No route to ask/);
    });
  });

  describe("provisionStep and milestones", () => {
    const milestones = [
      { title: "Play one level", doneMeans: "A level loads and can be won." },
      { title: "Level maker", doneMeans: "A generated level is saved." },
    ];
    const provision = (roundPlan: unknown) => {
      selects = {
        builds: [[{ id: "b1", kind: "build", productId: "prod-1", inspirationId: "i", brief: { ...FULL_BRIEF, milestones }, roundPlan }]],
        inspirations: [[{ note: null, references: [] }]],
      };
      return steps.provisionStep({ buildId: "b1", productId: "prod-1", slug: "bird-count", fixtures: [] });
    };

    it("writes the Milestones section only when the saved round plan chains them", async () => {
      await provision({ capMinutes: 35, milestones: milestones.map((m) => ({ title: m.title, state: "planned" })) });
      assert.match(provisioned[0]!.promptMarkdown as string, /## Milestones[\s\S]*This run builds only milestone 1/);
      provisioned = [];
      await provision(null);
      assert.ok(!(provisioned[0]!.promptMarkdown as string).includes("## Milestones"), "the flag was off when the plan was made");
    });
  });
});
