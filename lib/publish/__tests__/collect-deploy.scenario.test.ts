/**
 * Runs collectDeployFiles with the sandbox faked: the platform's .mcp.json never deploys from a sandbox that has the
 * platform's Muse Code config, and the check that removes it is real bash, run here on a temporary folder.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/publish/__tests__/collect-deploy.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { MUSE_FULL_MARKER } from "@/lib/sandbox/muse-config";
import { PRODUCT_DIR } from "@/lib/sandbox/paths";

let scripts: string[] = [];

const fakeSandbox = {
  writeFiles: async () => {},
  runCommand: async (opts: { args: string[] }) => {
    scripts.push(opts.args[1] ?? "");
    return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
  },
  readFileToBuffer: async ({ path: file }: { path: string }) => (file.endsWith("files.json") ? Buffer.from('{"files":[],"skipped":[]}') : Buffer.alloc(0)),
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let vercel: typeof import("../vercel");

describe("collectDeployFiles", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/sandbox", { namedExports: { Sandbox: { get: async () => fakeSandbox } } });
    vercel = await import("../vercel");
  });

  it("removes .mcp.json before it collects, only in a sandbox that has the platform's config", async () => {
    scripts = [];
    await vercel.collectDeployFiles("sb");
    const script = scripts[0]!;
    assert.ok(script.indexOf(".mcp.json") < script.indexOf("collect-deploy.cjs"), "gone before the walk");

    const dir = mkdtempSync(path.join(tmpdir(), "collect-deploy-"));
    try {
      const marker = path.join(dir, "muse-full");
      const product = path.join(dir, "app");
      const check = script.split("\n")[0]!.replaceAll(MUSE_FULL_MARKER, marker).replaceAll(PRODUCT_DIR, product);
      const mcp = path.join(product, ".mcp.json");
      spawnSync("mkdir", ["-p", product]);
      writeFileSync(mcp, "{}");

      assert.equal(spawnSync("bash", ["-c", check]).status, 0);
      assert.ok(existsSync(mcp), "a product's own .mcp.json stays with MUSE_FULL off");

      writeFileSync(marker, "now\n");
      assert.equal(spawnSync("bash", ["-c", check]).status, 0);
      assert.ok(!existsSync(mcp), "the platform's goes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
