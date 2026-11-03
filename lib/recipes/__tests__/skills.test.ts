import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RECIPES } from "@/lib/recipes/registry";

const ROOT = join(import.meta.dirname, "..", "skills");
const skills = readdirSync(ROOT);

describe("recipe skills", () => {
  it("every registered recipe's folder holds the rules a build relies on", () => {
    for (const id of skills) {
      assert.ok(RECIPES.some((r) => r.id === id), `${id} is not in the registry`);
      const text = readFileSync(join(ROOT, id, "SKILL.md"), "utf8");
      assert.ok(!text.includes("\u2014"), `${id} has an em dash`);
      assert.doesNotMatch(text, /muse-spark-1\.3-contributor/, `${id} names a model a token refuses`);
      assert.doesNotMatch(text, /\b(record_fact|flag_privileged|check_signatures|request_evidence|submit_memo|set_checklist|analyze_document)\b/, `${id} uses the unlicensed workshop's tool names`);
      assert.ok(text.split("\n").length <= 150, `${id} is too long`);
      if (text.includes("github.com/meta-models")) assert.match(text, /never fetch or clone/, id);
    }
  });

  it("the verified agent carries nothing from a legal product or the workshop", () => {
    const dir = join(ROOT, "recipe-verified-agent");
    const texts = ["SKILL.md", ...readdirSync(join(dir, "helpers")).map((f) => `helpers/${f}`)].map((f) => readFileSync(join(dir, f), "utf8"));
    for (const text of texts) {
      assert.ok(!text.includes("\u2014"));
      assert.doesNotMatch(text, /\b(legal|attorney|lawyer|plaintiff|defendant|privileged|court|memo|dispute|lawsuit)\b|legal-agent-workshop|northbridge|caldera|meta-models/i);
    }
  });

  it("the case agent's wrap up turn doesn't force a tool, which Meta refuses with a 400", () => {
    const text = readFileSync(join(ROOT, "recipe-case-agent", "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /`tool_choice` forcing/);
    assert.match(text, /Don't send `tool_choice`/);
  });

  it("keeps the Nov 3 audit's fixes: levels that end, real samples, PNG screens, real agent turns, full-size final steps", () => {
    const read = (id: string) => readFileSync(join(ROOT, id, "SKILL.md"), "utf8");
    const games = read("recipe-games");
    assert.match(games, /Every level ends on its own/);
    assert.match(games, /Idle until the level ends/);
    assert.match(games, /laid over the canvas/);
    const sam = read("recipe-sam-media");
    assert.match(sam, /Never ship a placeholder/);
    assert.match(sam, /zoompan/);
    assert.match(sam, /SAM checks the sample in the smoke test/);
    const loops = read("recipe-simulated-loops");
    assert.match(loops, /svgToPng/);
    assert.match(loops, /No scripted stand-in/);
    assert.match(loops, /makes its own model call/);
    assert.match(loops, /plausibly remove/);
    assert.doesNotMatch(loops, /record in localStorage/);
    const legal = read("recipe-case-agent");
    assert.match(legal, /sample-before-memo/);
    assert.match(legal, /only the pages it needs/);
  });

  it("helpers import nothing, so they work when copied into a product", () => {
    for (const id of skills) {
      const dir = join(ROOT, id, "helpers");
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        const text = readFileSync(join(dir, file), "utf8");
        assert.doesNotMatch(text, /^\s*(import\s|export .* from\s)/m, `${id}/${file}`);
      }
    }
  });
});
