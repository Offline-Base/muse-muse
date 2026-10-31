/** The lab's routes and token script have to reach a deployment too, alongside the lib/native that vercelignore.test.ts holds. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

const ignore = createRequire(import.meta.url)("ignore") as () => { add(rules: string): { ignores(file: string): boolean } };
const rules = ignore().add(readFileSync(path.join(process.cwd(), ".vercelignore"), "utf8"));

describe(".vercelignore and the lab", () => {
  it("keeps the lab's routes and its token script", () => {
    for (const f of ["app/api/native/selftest/route.ts", "app/api/native/agent/claim/route.ts", "scripts/native/lab.ts"]) assert.equal(rules.ignores(f), false, f);
  });
});
