/**
 * demo-batch's note sets, mainly --set=cookbook (docs/COOKBOOK.md): one note per app-build recipe in Meta's cookbook.
 *   npx tsx --test scripts/__tests__/demo-batch.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RECIPES } from "@/lib/recipes/registry";
import { noteSet, SETS, USAGE } from "../demo-batch";

const ROOT = join(import.meta.dirname, "..", "..");
const COOKBOOK_DIR = join(ROOT, "content", "meta-docs", "pages", "cookbook");
// Where a skill a build can get lives: the recipes, the web template's skills and the phone and desktop template's.
const SKILL_DIRS = [join(ROOT, "lib", "recipes", "skills"), join(ROOT, "template", ".agents", "skills"), join(ROOT, "template-native", ".agents", "skills")];
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

  it("skills: one note per skill, ids skill-<skill>, each skill exists, plain notes with no em dash", () => {
    const skills = noteSet("skills");
    const ids = skills.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, "no repeated ids");
    for (const n of skills) {
      assert.equal(n.id, `skill-${n.recipe}`, `${n.id} names its skill`);
      assert.ok(SKILL_DIRS.some((d) => existsSync(join(d, n.recipe, "SKILL.md"))), `${n.recipe} is a skill on disk`);
      if (n.recipe.startsWith("recipe-")) assert.ok(RECIPES.some((r) => r.id === n.recipe), `${n.recipe} is in the registry`);
      assert.ok(n.note.trim().length > 0, `${n.id} has a note`);
      assert.ok(n.note.startsWith("Build "), `${n.id} is a build note`);
      assert.ok(!n.note.includes("\u2014"), `${n.id} has no em dash`);
      assert.match(n.note, /made-up/, `${n.id} says its data is made up`);
    }
    // Every recipe gets a build, and the template skills the owner listed. jetson-fleet is left out on purpose (no fleet env).
    for (const r of RECIPES) assert.ok(ids.includes(`skill-${r.id}`), `${r.id} has a build`);
    for (const t of ["meta-reasoning", "meta-glimmer", "muse-edge", "muse-gadget", "muse-native"]) assert.ok(ids.includes(`skill-${t}`), `${t} has a build`);
    assert.ok(!ids.includes("skill-jetson-fleet"));
    assert.deepEqual(skills.find((n) => n.id === "skill-muse-edge")?.targets, ["edge"]);
    assert.deepEqual(skills.find((n) => n.id === "skill-muse-native")?.targets, ["phone"]);
    // New products: no note repeats one from another set.
    const others = new Set([undefined, "targets", "showcase", "cookbook"].flatMap((s) => noteSet(s).map((n) => n.note)));
    for (const n of skills) assert.ok(!others.has(n.note), `${n.id} is a new note`);
  });

  it("--help lists every set, and every set loads", () => {
    assert.match(USAGE, /--set=skills/);
    for (const s of SETS) {
      assert.ok(USAGE.includes(`--set=${s}`), `--help lists ${s}`);
      assert.ok(noteSet(s).length > 0, `${s} has notes`);
    }
    assert.throws(() => noteSet("nope"), /skills/);
  });
});
