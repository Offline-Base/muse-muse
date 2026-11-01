import assert from "node:assert/strict";
import { test } from "node:test";
import { captureVersion, type CaptureDeps, type CaptureFile } from "@/lib/versions/store";
import { sha1, type VersionFile } from "@/lib/versions/policy";

const f = (file: string, text: string): CaptureFile => {
  const content = Buffer.from(text);
  return { file, sha: sha1(content), size: content.length, content };
};

function fake(known: VersionFile[] = []) {
  const puts: string[] = [];
  const rows: Array<{ files: VersionFile[] }> = [];
  const deps: CaptureDeps = {
    knownFiles: async () => known,
    put: async (key) => (puts.push(key), `https://blob/${key}`),
    saveVersion: async (row) => void rows.push(row),
  };
  return { deps, puts, rows };
}

test("secrets and env files never reach storage", async () => {
  const { deps, puts, rows } = fake();
  const secret = f("lib/k.ts", `const k = "mm_live_${"a".repeat(24)}"`);
  assert.equal(await captureVersion({ buildId: "b", productId: "p", files: [f("app/a.ts", "a"), secret, f(".env.local", "X=1"), f("brief.md", "private")] }, deps), true);
  assert.deepEqual(puts.length, 1);
  assert.deepEqual(rows[0]!.files.map((x) => [x.path, x.held ?? false]), [["app/a.ts", false], ["lib/k.ts", true]]);
  assert.equal(rows[0]!.files[1]!.url, undefined);
  assert.equal(puts.includes(`source/p/${secret.sha}`), false);
});

test("a file already stored isn't stored twice", async () => {
  const a = f("a.ts", "same");
  const { deps, puts } = fake([{ path: "old-name.ts", sha: a.sha, size: 4, url: "https://blob/x" }]);
  await captureVersion({ buildId: "b", productId: "p", files: [a] }, deps);
  assert.equal(puts.length, 0);
});

test("a failed save returns false and writes no row", async () => {
  const { deps, rows } = fake();
  deps.put = async () => {
    throw new Error("no store");
  };
  assert.equal(await captureVersion({ buildId: "b", productId: "p", files: [f("a.ts", "a")] }, deps), false);
  assert.equal(rows.length, 0);
});
