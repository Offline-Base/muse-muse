/**
 * Runs the real step functions in build-steps.ts with the database, sandbox, judge, policy check and usage faked:
 * the judge on a refinement, Muse Code usage charging, the admin kill switch at register, the brief copied onto
 * refine rows, and the refinement policy check.
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
let revoked: unknown[][] = [];
let judgeInputs: Array<{ brief: unknown; references: Array<{ fileName: string }> }> = [];
let judgeImpl: () => Promise<unknown> = async () => ({ verdict: {}, usage: [] });
let checkInputs: unknown[] = [];
let checkImpl: () => Promise<unknown> = async () => ({ refusal: null, usage: [] });
let pollImpl: () => Promise<unknown> = async () => ({});

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
        addBuildCost: async () => undefined,
        setBuildStatus: async () => undefined,
      },
    });
    mock.module(at("../../usage.ts"), {
      namedExports: {
        recordUsage: async (_ctx: unknown, items: ModelUsage[]) => void recorded.push(items),
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
      namedExports: { pollDeploy: async () => ({}), startDeployFromSandbox: async () => ({}) },
    });
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        pollMuse: async () => pollImpl(),
        readManifest: async () => null,
        exportTranscript: async () => ({ url: "https://x/transcript.json", highlights: [] }),
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
    revoked = [];
    judgeInputs = [];
    checkInputs = [];
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
