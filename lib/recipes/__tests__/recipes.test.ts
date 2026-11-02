import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, it } from "node:test";
import { NewBriefSchema, newBriefSchemaFor } from "@/lib/brief/schema";
import { renderBuildPrompt } from "@/lib/brief/render";
import { allowedModelsFor, liveDailyBudgetFor } from "@/lib/pipeline/logic";
import { RUN_LIMITS, runLimitsFor } from "@/lib/gateway/runs";
import { CASE_AGENT_SAMPLE_NOTE, availableRecipes, pickedRecipes, recipeExtraFiles, recipeNotes, recipesWriterRules } from "@/lib/recipes/registry";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

beforeEach(() => {
  delete process.env.RECIPES_ENABLED;
  delete process.env.AGENT_LONG_RUNS;
  delete process.env.AGENT_LONG_DAILY_USD;
});

describe("recipes", () => {
  it("generated.json matches the skills", () => {
    const run = spawnSync(process.execPath, ["scripts/recipes-gen.mjs", "--check"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  });

  it("flag off: none offered, the writer's schema is the same object, and a stored pick gets nothing", () => {
    const brief = { ...BRIEF, recipes: ["recipe-case-agent"] };
    assert.deepEqual(availableRecipes(), []);
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [], recipes: availableRecipes().map((r) => r.id) }), NewBriefSchema);
    assert.equal(recipesWriterRules([]), "");
    assert.deepEqual(pickedRecipes(brief), []);
    assert.deepEqual(recipeExtraFiles(brief), []);
    assert.deepEqual(recipeNotes(brief), []);
    const plain = renderBuildPrompt(BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 200 });
    assert.equal(renderBuildPrompt(brief, { inspoFiles: [], fixtures: [], maxModelSteps: 200, recipes: recipeNotes(brief) }), plain);
  });

  it("flag on: the writer may pick the case agent, and only known ids", () => {
    process.env.RECIPES_ENABLED = "1";
    process.env.AGENT_LONG_RUNS = "1";
    assert.ok(CASE_AGENT_SAMPLE_NOTE.includes("legal-agent-workshop"));
    const ids = availableRecipes().map((r) => r.id);
    assert.ok(ids.includes("recipe-case-agent"));
    const schema = newBriefSchemaFor({ gadgets: true, targets: [], recipes: ids });
    assert.equal(schema.safeParse(BRIEF).success, false, "recipes is required");
    assert.deepEqual((schema.parse({ ...BRIEF, recipes: ["recipe-case-agent"] }) as { recipes: string[] }).recipes, ["recipe-case-agent"]);
    assert.equal(schema.safeParse({ ...BRIEF, recipes: null }).success, true);
    assert.equal(schema.safeParse({ ...BRIEF, recipes: ["recipe-made-up"] }).success, false);
  });

  it("writes the skill into the product and ignores an unknown id", () => {
    process.env.RECIPES_ENABLED = "1";
    process.env.AGENT_LONG_RUNS = "1";
    const files = recipeExtraFiles({ recipes: ["recipe-gone", "recipe-case-agent"] });
    assert.deepEqual(files.map((f) => f.path), [".agents/skills/recipe-case-agent/SKILL.md", ".agents/skills/recipe-case-agent/helpers/loop.ts"]);
    assert.ok(!/\u2014/.test(files[0].content), "no em dashes");
  });

  it("long runs: marker, limits and budget need both flags and a long recipe", () => {
    const brief = { ...BRIEF, recipes: ["recipe-case-agent"], estimatedCostPerRunUsd: 8 };
    const marker = () => allowedModelsFor(brief).includes("agent-long");
    assert.equal(marker(), false, "both flags off");
    assert.equal(liveDailyBudgetFor(brief), 10, "the normal ceiling");
    process.env.RECIPES_ENABLED = "1";
    assert.equal(marker(), false, "AGENT_LONG_RUNS off");
    process.env.AGENT_LONG_RUNS = "1";
    assert.equal(marker(), true);
    assert.equal(allowedModelsFor(BRIEF).includes("agent-long"), false, "no recipe");
    assert.equal(allowedModelsFor({ ...BRIEF, recipes: null }).includes("agent-long"), false);
    assert.ok(allowedModelsFor(brief).includes("sam-3.1"), "the recipe's own models are allowed");
    assert.ok(!allowedModelsFor(brief).includes("agent"), "no catalog tools");
    assert.equal(liveDailyBudgetFor(brief), 25);
    process.env.AGENT_LONG_DAILY_USD = "40";
    assert.equal(liveDailyBudgetFor(brief), 40);
    assert.equal(liveDailyBudgetFor(BRIEF), liveDailyBudgetFor({ ...BRIEF, recipes: null }));
  });

  it("run limits: a build token gets its own long limits only with the long marker, and long comes before agent", () => {
    const limits = (scope: string, allowedModels: string[]) => runLimitsFor({ scope, allowedModels });
    assert.equal(limits("build", ["agent-long", "agent"]), RUN_LIMITS.buildLong);
    assert.equal(limits("build", ["agent"]), RUN_LIMITS.build);
    assert.equal(limits("build", ["muse-wonder-1.0"]), RUN_LIMITS.build);
    assert.ok(RUN_LIMITS.buildLong.usd < RUN_LIMITS.longAgent.usd && RUN_LIMITS.buildLong.turns < RUN_LIMITS.longAgent.turns);
    assert.equal(limits("live", ["agent-long", "agent"]), RUN_LIMITS.longAgent);
    assert.equal(limits("live", ["agent-long"]), RUN_LIMITS.longAgent);
    assert.equal(limits("live", ["agent"]), RUN_LIMITS.liveAgent);
    assert.equal(limits("live", ["muse-wonder-1.0"]), null);
  });
});
