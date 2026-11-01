/**
 * What the build's steps bundle (wave 3, unit 11). @workflow/builders bundles lib/pipeline/build-steps.ts with esbuild and no
 * splitting, so a dynamic import comes along like any other. This does the same, without running anything, and checks that
 * the lab's launch path isn't in it. Importing it from lib/caps/cleanup.ts, even lazily, is what this catches.
 *
 *   npx tsx --test lib/caps/__tests__/build-steps-bundle.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";

const ROOT = new URL("../../..", import.meta.url).pathname;

describe("lib/pipeline/build-steps.ts's bundle", () => {
  it("has none of the lab's launch path, by any kind of import", async () => {
    const out = await build({
      entryPoints: ["lib/pipeline/build-steps.ts"],
      bundle: true,
      write: false,
      metafile: true,
      packages: "external",
      platform: "node",
      format: "esm",
      jsx: "automatic",
      absWorkingDir: ROOT,
      logLevel: "silent",
      loader: { ".json": "json" },
    });
    const inputs = Object.keys(out.metafile.inputs);
    assert.ok(inputs.includes("lib/caps/cleanup.ts"), "the graph reaches the cleanup registry");
    assert.ok(inputs.includes("lib/caps/gpu/forget.ts"), "and the takedown hook, which is meant to be light");
    assert.deepEqual(
      inputs.filter((f) => /^lib\/train\/(launch|workflow|store)\.ts$|^lib\/caps\/gpu\/(deps|sweep|store|train|train-deps)\.ts$/.test(f)),
      [],
    );
  });
});
