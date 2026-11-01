import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, it } from "node:test";
import { NewBriefSchema, newBriefSchemaFor } from "@/lib/brief/schema";
import { renderBuildPrompt } from "@/lib/brief/render";
import { availableRecipes, pickedRecipes, recipeExtraFiles, recipeNotes, recipesWriterRules } from "@/lib/recipes/registry";
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
});
