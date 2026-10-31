/**
 * scripts/drive-export.ts, the owner's S3 export, names the site it talks to: no --origin means it stops before signing
 * anything, so a test on a preview (decision 6) never lands on production by leaving the flag out. It runs with an empty
 * PATH, so the aws CLI can't be found even if the script got that far, and with a made-up session.
 *
 *   npx tsx --test lib/drive/__tests__/drive-export-script.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("scripts/drive-export.ts", () => {
  it("stops before signing anything when --origin is left out", async () => {
    const cli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const failed = await run(process.execPath, [cli, path.join(ROOT, "scripts", "drive-export.ts"), "--s3", "s3://example-bucket/model.gguf", "--drive", "sda"], {
      cwd: ROOT,
      env: { PATH: "", HOME: process.env.HOME ?? "", MUSE_SESSION: "made-up-session-for-a-test" },
      timeout: 60_000,
    }).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err,
    );
    assert.ok(failed, "it exits with an error");
    assert.equal(failed.code, 1);
    assert.match(failed.stderr ?? "", /Pass --origin/);
  });
});
