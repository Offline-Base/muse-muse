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
