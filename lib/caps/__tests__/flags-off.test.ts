/**
 * With every wave 3 flag off, a build with no caps gets no wave 3 behavior (docs/CAPABILITIES.md, section 1): no cap is
 * enabled, every registry and hook is empty, and round caps are today's. The real sandbox, deploy and judge surfaces are
 * checked byte for byte against goldens written from d8ffec4 (wave 2) alone, in flags-off-surface.test.ts.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { NewBriefSchema, NewBriefSchemaNoGadget, newBriefSchemaFor } from "@/lib/brief/schema";
import { renderBuildPrompt } from "@/lib/brief/render";
import { CAP_BRIEF_FIELDS, briefCaps, capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks, howProductsRun } from "@/lib/caps/catalog";
import { CAP_CLEANUPS, sweepCaps } from "@/lib/caps/cleanup";
import { CAP_FLAG, CAP_IDS, CAP_READY } from "@/lib/caps/ids";
import { capsJudgeNotes, capsProofText } from "@/lib/caps/judge";
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { engineBudgetLines, engineWriterRules, milestoneBuildLines } from "@/lib/engine/prompts";
import { env } from "@/lib/env";
import { roundCapMs, roundPlanFor, stepTimeoutMs, STEPS } from "@/lib/pipeline/steps";
import { JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const FLAGS = [
  // Wave 3, one line per unit, in plan order.
  "TRUST_SIGNED_IN_CAPS", "TRUST_BUILDER_DAILY_USD", "TRUST_AGE_GATE", "TRUST_LEGAL_PAGES", "TRUST_GEO_BLOCK", "TRUST_GEO_COUNTRIES", "TRUST_REPORTS", "TRUST_SPARK_TO_WONDER",
  "ENGINE_CHECK_ON_TIMEOUT", "ENGINE_ROUND_SCALING", "ENGINE_ROUND_MAX_MINUTES", "ENGINE_MILESTONES", "ENGINE_LIVE_SMOKE", "ENGINE_EXACT_LOGIC", "ENGINE_FIT_OUTPUT",
  "DATA_SIGN_IN", "DATA_PRODUCT_ROWS", "DATA_PRODUCT_MB", "DATA_DAILY_WRITES",
  "FILES_SEARCH", "FILES_DATASETS", "FILES_PRODUCT_MB", "FILES_MAX_FILE_MB", "FILES_BLOB_STORE_ID",
  "CONNECT_MORE_TOOLS", "CONNECT_VAULT", "CONNECT_VAULT_KEY", "CONNECT_SENDS", "CONNECT_SENDS_PRODUCTION",
  "JOBS_WEBHOOKS", "JOBS_DAILY_RUNS", "JOBS_DAILY_USD", "JOBS_PRODUCT_DAILY_RUNS", "JOBS_PRODUCT_DAILY_USD", "JOBS_RUN_USD", "JOBS_PAUSE_DAYS",
  ...CAP_IDS.map((id) => CAP_FLAG[id]),
  "LIVE_UPDATES", "LIVE_CAPTION_MINUTES",
  "CODE_EXEC", "CODE_EXEC_VISITORS", "CODE_EXEC_DAILY_USD", "CODE_EXEC_SNAPSHOT_ID", "CODE_BROWSE", "CODE_BROWSE_DAILY_USD", "MUSE_CODE_ENABLED", "MUSE_CODE_VISITORS",
  "RUNTIME_OUTPUTS",
  "GPU_GLIMMER_SHARED", "GPU_GLIMMER_DAILY_USD", "GPU_GLIMMER_ALL_PRODUCTS", "GPU_TRAIN_ON_DATA",
  "HARDWARE_BOARD_TOOLS", "HARDWARE_BOARD_REGISTRY", "HARDWARE_BOARD_KEY", "HARDWARE_GADGET_OWNER_CHECK",
];

beforeEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

describe("with every wave 3 flag off", () => {
  it("no cap is enabled, and every cap's flag alone enables nothing until its unit says it's ready", () => {
    assert.deepEqual(env.enabledCaps, []);
    for (const id of CAP_IDS) {
      process.env[CAP_FLAG[id]] = "1";
      assert.deepEqual(env.enabledCaps, CAP_READY[id] ? [id] : [], id);
      delete process.env[CAP_FLAG[id]];
    }
  });

  it("the writer's schema is the same object as before, and the brief adds nothing", () => {
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [], caps: env.enabledCaps, milestones: env.engineMilestones }), NewBriefSchema);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps, milestones: env.engineMilestones }), NewBriefSchemaNoGadget);
    assert.deepEqual(briefCaps(BRIEF), []);
    assert.equal(capsWriterRules(env.enabledCaps), "");
    assert.equal(engineWriterRules({ milestones: env.engineMilestones, exactLogic: env.engineExactLogic }), "");
  });

  it("every prompt hook adds nothing", () => {
    assert.deepEqual(capsBuildLines(BRIEF), []);
    assert.deepEqual(capsRefineLines(BRIEF), []);
    assert.deepEqual(capsMarkdown(BRIEF), []);
    assert.deepEqual(milestoneBuildLines(BRIEF), []);
    assert.deepEqual(engineBudgetLines(false), []);
    assert.equal(howProductsRun(env.enabledCaps, { gadgets: false }), null);
    assert.deepEqual(capsCatalogBlocks(env.enabledCaps), []);
    assert.equal(capsJudgeNotes(BRIEF), "");
    assert.equal(judgeInstructions(BRIEF), JUDGE_INSTRUCTIONS);
    assert.equal(capsProofText({}), null);
    assert.equal(capsProofText(null), null);
    const render = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
    assert.equal(renderBuildPrompt(BRIEF, { ...render, verifyBudget: false }), renderBuildPrompt(BRIEF, render));
  });

  it("round caps are today's, with no wall", () => {
    const size = { complexity: "complex" as const, caps: 0, screens: 5, actions: 3 };
    const opts = { scaling: env.engineRoundScaling, maxMinutes: env.engineRoundMaxMinutes };
    for (const kind of ["build", "fix", "verify"] as const) assert.equal(roundCapMs(size, kind, opts), stepTimeoutMs(kind));
    assert.deepEqual(roundPlanFor(size, [], opts).wallMs, null);
    assert.deepEqual(STEPS.map((s) => [s.name, s.timeoutMs / 60_000]).filter(([n]) => ["build", "fix", "verify"].includes(n as string)), [["build", 60], ["verify", 8], ["fix", 12]]);
  });

  it("no cap stores anything, so cleanup and the cron's sweep do nothing", async () => {
    // A cap that stores something has its entry (unit 3's data), and with its flag off the entry has nothing to run.
    for (const c of CAP_CLEANUPS) assert.ok(!c.buildEnded && !c.productOff && !c.sweep, c.cap);
    assert.equal(await sweepCaps(), null);
    // A registered brief block (unit 10's runtime) is an optional field of the stored brief only: a brief without it has
    // no caps, so nothing above changes for it.
    assert.deepEqual(briefCaps(BRIEF), []);
    for (const key of Object.keys(CAP_BRIEF_FIELDS)) assert.ok(!(key in BRIEF), key);
  });
});
