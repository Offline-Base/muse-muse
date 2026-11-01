/**
 * Next's bundler reads new URL("<literal>", import.meta.url) as importing that file, so pointing it at a folder fails the
 * build, and neither tsc nor these tests would notice. lib/drive/plan.ts did this once.
 *
 *   npx tsx --test lib/__tests__/bundler-paths.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const PATTERN = /new URL\(\s*["'`]([^"'`$]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("paths Next's bundler has to resolve", () => {
  it("no app code points new URL(literal, import.meta.url) at a folder or a missing file", () => {
    const bad: string[] = [];
    for (const top of ["lib", "app", "components"]) {
      for (const file of sources(path.join(ROOT, top))) {
        for (const m of readFileSync(file, "utf8").matchAll(PATTERN)) {
          const target = path.resolve(path.dirname(file), m[1]);
          let isFile = false;
          try {
            isFile = statSync(target).isFile();
          } catch {}
          if (!isFile) bad.push(`${path.relative(ROOT, file)}: ${m[1]}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
});
