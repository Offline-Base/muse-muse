/**
 * The strings a deployed function uses must match the files they are generated from.
 *   npx tsx --test lib/outputs/__tests__/assets-source.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLI_SOURCE, PROVE_CHECK_PLUGIN_SOURCE, PROVE_RUNNER_SOURCE, PROVE_SCENE_SOURCE } from "@/lib/outputs/assets-source";

const read = (file: string) => readFileSync(path.join(process.cwd(), "lib/outputs/assets", file), "utf8");

describe("the generated asset strings", () => {
  it("match lib/outputs/assets (run scripts/gen-outputs-source.ts after an edit)", () => {
    assert.equal(CLI_SOURCE, read("cli.cjs"));
    assert.equal(PROVE_RUNNER_SOURCE, read("prove-runner.mjs"));
    assert.equal(PROVE_CHECK_PLUGIN_SOURCE, read("prove-check-plugin.mjs"));
    assert.equal(PROVE_SCENE_SOURCE, read("prove-scene.html"));
  });
});
