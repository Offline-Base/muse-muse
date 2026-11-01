/**
 * Writes lib/recipes/generated.json from lib/recipes/skills/<id>/, so a recipe's SKILL.md and helpers bundle into the
 * platform's functions with no file tracing. template/ isn't deployed with the platform, and a template skill would need
 * a new builder snapshot, which is why these live here (docs/RECIPES.md). Run it after every edit to a skill:
 *
 *   node scripts/recipes-gen.mjs
 *
 * With --check it writes nothing and exits 1 while the two differ. lib/recipes/__tests__/recipes.test.ts runs that.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SKILLS = path.join(ROOT, "lib/recipes/skills");
const OUT = path.join(ROOT, "lib/recipes/generated.json");

function walk(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== ".DS_Store")
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

const skills = {};
for (const entry of existsSync(SKILLS) ? readdirSync(SKILLS, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)) : []) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(SKILLS, entry.name);
  const files = walk(dir).map((file) => ({ path: file, content: readFileSync(path.join(dir, file), "utf8") }));
  const main = files.find((f) => f.path === "SKILL.md");
  if (!main) throw new Error(`${entry.name} has no SKILL.md`);
  const head = /^---\nname: (\S+)\ndescription: .+\n---\n/.exec(main.content);
  if (head?.[1] !== entry.name) throw new Error(`${entry.name}/SKILL.md needs frontmatter with name: ${entry.name} and a description`);
  skills[entry.name] = { files };
}

const text = `${JSON.stringify({ skills }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== text) {
    console.error("lib/recipes/generated.json is out of date. Run: node scripts/recipes-gen.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`Wrote lib/recipes/generated.json (${Object.keys(skills).length} recipes).`);
}
