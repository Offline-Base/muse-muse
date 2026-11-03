/**
 * demo-batch's note sets, mainly --set=cookbook (docs/COOKBOOK.md): one note per app-build recipe in Meta's cookbook.
 *   npx tsx --test scripts/__tests__/demo-batch.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RECIPES } from "@/lib/recipes/registry";
import { noteSet } from "../demo-batch";

const COOKBOOK_DIR = join(import.meta.dirname, "..", "..", "content", "meta-docs", "pages", "cookbook");
// Section index pages link recipes and have none of their own. contained-execution (04/04) is a docs demo only.
const NOT_BUILT = ["agent-patterns", "api-fundamentals", "contained-execution", "muse-code", "muse-image", "muse-voice-transcribe", "post-training", "run-locally", "sam", "use-cases"];

describe("demo-batch note sets", () => {
  const cookbook = noteSet("cookbook");

  it("cookbook: one note per recipe page, ids are slugs, recipes are in the registry", () => {
    const ids = cookbook.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, "no repeated ids");
    for (const n of cookbook) {
      assert.ok(existsSync(join(COOKBOOK_DIR, `${n.id}.md`)), `${n.id} is a cookbook page`);
      assert.ok(RECIPES.some((r) => r.id === n.recipe), `${n.id}: ${n.recipe} is in the registry`);
      assert.ok(n.note.startsWith("Build "), `${n.id} is a build note`);
      assert.ok(!n.note.includes("\u2014"), `${n.id} has no em dash`);
    }
    const pages = readdirSync(COOKBOOK_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    const missing = pages.filter((p) => !ids.includes(p) && !NOT_BUILT.includes(p));
    assert.deepEqual(missing, [], "every recipe page has a note or a reason in docs/COOKBOOK.md");
    assert.equal(cookbook.length, 50);
  });

  it("reused DEMO_NOTES notes keep their text under the slug", () => {
    const demo = noteSet(undefined);
    for (const [slug, demoId] of [["alert-fatigue-copilot", "alerts"], ["perception-grounding", "fridge"], ["video-to-sticker-pack", "stickers"]] as const) {
      assert.equal(cookbook.find((n) => n.id === slug)?.note, demo.find((n) => n.id === demoId)?.note);
    }
  });

  it("the glasses recipe keeps its target, and an unknown set still stops", () => {
    assert.deepEqual(cookbook.find((n) => n.id === "rayban-openclaw")?.targets, ["glasses"]);
    assert.throws(() => noteSet("nope"), /cookbook/);
  });
});
