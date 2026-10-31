/**
 * The bridge the platform writes into sandboxes (lib/sandbox/bridge-source.ts) must be lib/sandbox/bridge/bridge.mjs as
 * it is now. When this fails, run `npx tsx scripts/gen-bridge-source.ts`.
 *   npx tsx --test lib/sandbox/__tests__/bridge-source.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { BRIDGE_SOURCE } from "@/lib/sandbox/bridge-source";

const BRIDGE = path.join(import.meta.dirname, "../bridge/bridge.mjs");

it("is the bridge as it is now", () => {
  assert.ok(BRIDGE_SOURCE === readFileSync(BRIDGE, "utf8"), "lib/sandbox/bridge-source.ts is stale: run npx tsx scripts/gen-bridge-source.ts");
});

it("imports only node: built-ins up front, and the pinned SDK only when it runs for real", () => {
  const imports = [...BRIDGE_SOURCE.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.match(name!, /^node:/, `${name} isn't a built-in`);
  assert.deepEqual([...BRIDGE_SOURCE.matchAll(/await import\("([^"]+)"\)/g)].map((m) => m[1]), ["@muse-code/sdk"]);
});

it("has no em dashes in what it writes", () => {
  assert.ok(!BRIDGE_SOURCE.includes("\u2014"));
});
