/**
 * .vercelignore against the same `ignore` package the Vercel CLI filters a deployment with. Everything under lib/native is
 * runtime code: lib/env.ts imports it, so a deployment without it can't build at all, flags off included.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

// Loaded by name so the deployment's own typecheck doesn't depend on a package only the tools bring in.
const ignore = createRequire(import.meta.url)("ignore") as () => { add(rules: string): { ignores(file: string): boolean } };
const rules = ignore().add(readFileSync(path.join(process.cwd(), ".vercelignore"), "utf8"));

describe(".vercelignore", () => {
  it("keeps everything in lib/native", () => {
    const files = readdirSync(path.join(process.cwd(), "lib/native"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    assert.ok(files.includes("targets.ts"));
    for (const f of files) assert.equal(rules.ignores(`lib/native/${f}`), false, `lib/native/${f} is dropped`);
  });

  it("drops the shells, the lab and the bridge at the repo's root", () => {
    for (const f of ["native/lab/agent.ts", "native/shell-mobile/App.tsx", "native/bridge/protocol.ts"]) assert.equal(rules.ignores(f), true, f);
  });

  it("keeps the file a kept test imports, since a deployment's typecheck reads tests too", () => {
    assert.equal(rules.ignores("lib/native/__tests__/template-bridge.test.ts"), false);
    assert.equal(rules.ignores("template-native/lib/native/bridge.ts"), false);
    assert.equal(rules.ignores("template-native/lib/native/protocol.ts"), false);
  });
});
