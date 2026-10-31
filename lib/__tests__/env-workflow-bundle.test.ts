/**
 * Workflows import lib/env.ts, so everything it imports ends up in the workflow bundle, where Workflow's build warns about
 * any text that looks like a Node import, even inside a string. A false warning hides a real one, which would fail at
 * runtime. `npx wf build` prints the real check: "Serde warning".
 *
 *   npx tsx --test lib/__tests__/env-workflow-bundle.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/** A Node import inside a string. A real one, as in lib/sandbox/policy.ts, is shaken out of the bundle when unused. */
const NODE_IMPORT_IN_A_STRING = /['"`]\s*import\b[^\n]*from\s+["']node:/;
const VALUE_IMPORT = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(@\/[^"]+|\.[^"]+)"/gm;

function fileOf(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? path.join(process.cwd(), specifier.slice(2)) : path.join(path.dirname(from), specifier);
  return [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base].find((file) => existsSync(file) && file.match(/\.tsx?$/)) ?? null;
}

/** Each module lib/env.ts reaches by a value import, itself included. */
function graph(start: string, seen = new Set<string>()): Set<string> {
  if (seen.has(start)) return seen;
  seen.add(start);
  for (const [, specifier] of readFileSync(start, "utf8").matchAll(VALUE_IMPORT)) {
    const file = fileOf(start, specifier!);
    if (file) graph(file, seen);
  }
  return seen;
}

describe("lib/env.ts in the workflow bundle", () => {
  it("reaches no module with text that holds a Node import in a string", () => {
    const modules = [...graph(path.join(process.cwd(), "lib/env.ts"))];
    assert.ok(modules.length > 3, "the walk found lib/env.ts's imports");
    assert.deepEqual(
      modules.filter((file) => NODE_IMPORT_IN_A_STRING.test(readFileSync(file, "utf8"))).map((file) => path.relative(process.cwd(), file)),
      [],
    );
  });
});
