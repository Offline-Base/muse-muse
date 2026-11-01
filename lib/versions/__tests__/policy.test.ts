import assert from "node:assert/strict";
import { test } from "node:test";
import { canReadCode, findFile, holdsSecret, isHiddenPath, restorePlan, visibleFiles, type VersionFile } from "@/lib/versions/policy";

const file = (path: string, sha = "a", extra: Partial<VersionFile> = {}): VersionFile => ({ path, sha, size: 1, url: "u", ...extra });

test("env files, keys and build files are hidden, source isn't", () => {
  for (const p of [".env", ".env.local", "app/.env.production", ".mcp.json", ".npmrc", "certs/server.pem", "id_rsa", "credentials.json", "service-account-prod.json", "brief.md", "refine-3.md", ".muse/x", ".git/config", "inspo/a.png", "fixtures/a.txt"]) {
    assert.equal(isHiddenPath(p), true, p);
  }
  for (const p of ["app/page.tsx", "package.json", "lib/env.ts", "app/brief.md", "public/key.svg", "tests/a.spec.ts"]) assert.equal(isHiddenPath(p), false, p);
});

test("a path can't climb out or reach a hidden file", () => {
  for (const p of ["../secret", "a/../../b", "/etc/passwd", "a//b", "a\\b", "./a", "a/.", ""]) assert.equal(isHiddenPath(p), true, JSON.stringify(p));
  const files = [file("app/page.tsx"), file(".env.local")];
  assert.equal(findFile(files, "app/page.tsx")?.path, "app/page.tsx");
  assert.equal(findFile(files, "app/../app/page.tsx"), null);
  assert.equal(findFile(files, ".env.local"), null);
  assert.equal(findFile(files, "nope"), null);
  assert.deepEqual(visibleFiles(files).map((f) => f.path), ["app/page.tsx"]);
});

test("content shaped like a secret is caught, ordinary code isn't", () => {
  const secrets = [`mm_live_${"a".repeat(24)}`, `ghp_${"a".repeat(36)}`, "-----BEGIN RSA PRIVATE KEY-----", `AKIA${"A".repeat(16)}`, `sk-ant-${"a".repeat(40)}`, `sk_live_${"a".repeat(24)}`];
  for (const s of secrets) assert.equal(holdsSecret(Buffer.from(`const k = "${s}";`)), true, s);
  assert.equal(holdsSecret(Buffer.from("const key = process.env.PRODUCT_TOKEN; // task-list-item")), false);
  assert.equal(holdsSecret(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0])), true);
});

test("code follows the product's visibility", () => {
  const open = { status: "live", takenDownAt: null };
  assert.equal(canReadCode(open, false), true);
  assert.equal(canReadCode({ status: "disabled", takenDownAt: null }, false), false);
  assert.equal(canReadCode({ status: "disabled", takenDownAt: null }, true), true);
  assert.equal(canReadCode({ status: "disabled", takenDownAt: new Date() }, true), false);
});

test("a restore never touches hidden or held files", () => {
  const plan = restorePlan(
    [{ path: "a.ts", sha: "new" }, { path: "later.ts", sha: "x" }, { path: ".env.local", sha: "e" }, { path: "brief.md", sha: "b" }, { path: "held.ts", sha: "h" }, { path: "same.ts", sha: "s" }],
    [file("a.ts", "old"), file("gone.ts", "g"), file("same.ts", "s"), { path: "held.ts", sha: "h2", size: 1, held: true }],
  );
  assert.deepEqual(plan.write.map((f) => f.path), ["a.ts", "gone.ts"]);
  assert.deepEqual(plan.remove, ["later.ts"]);
});
