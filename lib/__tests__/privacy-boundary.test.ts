/**
 * Muse Privacy lives in privacy/ and Muse Muse never touches its code: private documents and tag maps stay on the
 * person's device, so the platform must have no way to reach them. Neither side imports the other, in either direction.
 *
 *   npx tsx --test lib/__tests__/privacy-boundary.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => m[1]!);
}

function reachesPrivacy(spec: string): boolean {
  return /^(@\/|\.{1,2}\/(\.\.\/)*)?privacy(\/|$)/.test(spec);
}

function leavesPrivacy(file: string, spec: string): boolean {
  if (spec.startsWith("@/")) return true;
  if (!spec.startsWith(".")) return false;
  let at = file.split("/").length - 1; // how many folders down from the repo's root
  for (const part of spec.split("/")) {
    if (part === "..") at -= 1;
    else if (part !== ".") at += 1;
    if (at < 1) return true;
  }
  return false;
}

describe("the line between Muse Muse and Muse Privacy", () => {
  it("is what the checks read", () => {
    assert.ok(tracked.includes("privacy/pyproject.toml"), "privacy/ is in the repo");
    assert.ok(reachesPrivacy("@/privacy/base/x"));
    assert.ok(reachesPrivacy("../../privacy/relay/src/index"));
    assert.ok(!reachesPrivacy("@/lib/privacy/x"));
    assert.ok(!reachesPrivacy("./privacy-note"));
    assert.ok(leavesPrivacy("privacy/relay/src/a.ts", "../../../lib/x"));
    assert.ok(!leavesPrivacy("privacy/relay/src/a.ts", "../test/helpers"));
    assert.deepEqual(importsOf(`import a from "@/privacy/a"; const b = await import("../privacy/b");`), ["@/privacy/a", "../privacy/b"]);
  });

  it("Muse Muse's code never imports privacy/", () => {
    const crossing = tracked
      .filter((file) => SOURCE.test(file) && !file.startsWith("privacy/") && file !== "lib/__tests__/privacy-boundary.test.ts")
      .flatMap((file) => importsOf(readFileSync(file, "utf8")).filter(reachesPrivacy).map((spec) => `${file}: ${spec}`));
    assert.deepEqual(crossing, []);
  });

  it("Muse Privacy's code never imports Muse Muse", () => {
    const crossing = tracked
      .filter((file) => SOURCE.test(file) && file.startsWith("privacy/"))
      .flatMap((file) => importsOf(readFileSync(file, "utf8")).filter((spec) => leavesPrivacy(file, spec)).map((spec) => `${file}: ${spec}`));
    assert.deepEqual(crossing, []);
  });

  it("Muse Privacy's Python stays inside its own folder", () => {
    const python = tracked.filter((file) => file.startsWith("privacy/") && file.endsWith(".py"));
    const crossing = python.filter((file) => /^\s*(from|import)\s+(lib|app|components)\b/m.test(readFileSync(file, "utf8")));
    assert.deepEqual(crossing, []);
  });

  it("the site's typecheck and deploys leave it out", () => {
    const config = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { exclude: string[] };
    assert.ok(config.exclude.includes("privacy"));
    assert.ok(readFileSync(".vercelignore", "utf8").split("\n").includes("/privacy"));
  });

  it("adds no migrations", () => {
    assert.deepEqual(tracked.filter((file) => file.startsWith("privacy/") && file.endsWith(".sql")).filter((file) => file.includes("drizzle")), []);
  });
});
