/**
 * The QDC submitter's and carrier's own unit tests (devices/qdc/tests/test_submit.py and test_carrier.py), run with this
 * Mac's Python 3.12 in isolated mode against the fake SDK, the fake Appium client and the fake adb in devices/qdc/tests,
 * and test_submit_real_sdk.py against the real SDK wheel in the submitter's venv (MM_QDC_VENV_PYTHON, or the one
 * scripts/devices/qdc.ts made in the cache), with the network faked under httpx and requests. Nothing reaches QDC, a
 * phone or the network. Each part is skipped when its Python isn't there.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/qdc-python.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PYTHON = ["/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12", "/usr/bin/python3.12"].find(existsSync);
const CACHE = process.env.MM_DEVICES_CACHE?.trim() || path.join(os.homedir(), ".cache", "muse-muse-devices");
const VENV_PYTHON = [process.env.MM_QDC_VENV_PYTHON, path.join(CACHE, "qdc", "venv-0.2.3", "bin", "python")].find((p) => p && existsSync(p));

function runSuite(file: string, python = PYTHON as string) {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", PYTHONDONTWRITEBYTECODE: "1" };
  return spawnSync(python, ["-I", "-B", path.join(ROOT, "devices", "qdc", "tests", file)], { encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 600_000 });
}

describe("the QDC Python code", { skip: PYTHON ? false : "Python 3.12 isn't installed" }, () => {
  for (const file of ["test_submit.py", "test_carrier.py"]) {
    it(`passes ${file}`, () => {
      const run = runSuite(file);
      assert.equal(run.status, 0, `${file} failed:\n${run.stderr}\n${run.stdout}`);
      assert.match(run.stderr, /^OK/m);
      assert.match(run.stderr, /Ran \d+ tests/);
    });
  }
});

describe("the submitter against the real SDK wheel", { skip: VENV_PYTHON ? false : "no submitter venv (scripts/devices/qdc.ts makes one)" }, () => {
  it("passes test_submit_real_sdk.py", () => {
    const run = runSuite("test_submit_real_sdk.py", VENV_PYTHON as string);
    assert.equal(run.status, 0, `test_submit_real_sdk.py failed:\n${run.stderr}\n${run.stdout}`);
    assert.match(run.stderr, /^OK$/m, "every test ran (none skipped)");
  });
});
