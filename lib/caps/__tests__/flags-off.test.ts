/**
 * With every wave 3 flag off, a build with no caps gets the same sandbox and deploy it does today: the same files,
 * .env.local, network policy, token allowlist, round caps, verify steps and deploy env, and the judge the same content
 * (docs/CAPABILITIES.md, section 1). golden/ was written from the code with every flag off, and its policy, steps and
 * allowlist were checked against tg-cap-contract (378f387) before any wave 3 change. A change that isn't behind a flag
 * has to regenerate it on purpose, and the diff shows what changed:
 *
 *   UPDATE_GOLDEN=1 npx tsx --test lib/caps/__tests__/flags-off.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { capsOffSurface } from "./flags-off-surface";

const GOLDEN = join(import.meta.dirname, "golden");
const FLAGS = [
  // Wave 3, one line per unit, in plan order.
  "ENGINE_CHECK_ON_TIMEOUT", "ENGINE_ROUND_SCALING", "ENGINE_ROUND_MAX_MINUTES", "ENGINE_MILESTONES", "ENGINE_LIVE_SMOKE", "ENGINE_EXACT_LOGIC", "ENGINE_FIT_OUTPUT",
  "TRUST_SIGNED_IN_CAPS",
  ...CAP_IDS.map((id) => CAP_FLAG[id]),
];

beforeEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

describe("with every wave 3 flag off", () => {
  it("a build with no caps gets today's sandbox, deploy and judge", () => {
    const surface = capsOffSurface();
    assert.equal(Object.keys(surface).length, 7);
    for (const [name, text] of Object.entries(surface)) {
      if (process.env.UPDATE_GOLDEN) writeFileSync(join(GOLDEN, name), text);
      assert.equal(text, readFileSync(join(GOLDEN, name), "utf8"), `${name} changed`);
    }
  });

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
    assert.deepEqual(STEPS.map((s) => [s.name, s.timeoutMs / 60_000]).filter(([n]) => ["build", "fix", "verify"].includes(n as string)), [["build", 25], ["verify", 8], ["fix", 12]]);
  });

  it("no cap stores anything, so cleanup and the cron's sweep do nothing", async () => {
    assert.equal(CAP_CLEANUPS.length, 0);
    assert.equal(await sweepCaps(), null);
    assert.deepEqual(Object.keys(CAP_BRIEF_FIELDS), []);
  });
});
