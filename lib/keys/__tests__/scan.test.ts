/**
 * The shared-keys check that runs in a build sandbox (lib/keys/scan.ts): the real script on a temporary product folder,
 * then the step it adds to verify's summary. The values are made up.
 *
 *   npx tsx --test lib/keys/__tests__/scan.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { KEYS_STEP, parseScanOutput, SHARED_SCAN_SCRIPT, withSharedKeyScan } from "@/lib/keys/scan";
import { sharedLeakLines, valueEncodings } from "@/lib/keys/shared";
import type { VerifySummary } from "@/lib/types";

const HF = "hf_fakeScanToken0123456789abcdefgh";
const AWS = "fakeAwsScan/secret+0123456789abcdefGH";

let dir = "";
let script = "";

function put(root: string, file: string, content: string | Buffer): void {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function scan(root: string, env: Record<string, string>, names = Object.keys(env)) {
  const res = spawnSync("node", [script, root, ...names], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes(HF) && !res.stdout.includes(AWS), "the script never prints a value");
  return parseScanOutput(res.stdout);
}

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "shared-scan-"));
  script = path.join(dir, "shared-scan.cjs");
  writeFileSync(script, SHARED_SCAN_SCRIPT);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("finds values in source, public/, .next/static and prerendered pages, and skips what never ships", () => {
  const root = path.join(dir, "product");
  put(root, "package.json", "{}");
  put(root, "app/page.tsx", "export default function Page() { return null; }");
  put(root, "app/api/x/route.ts", `const key = "${HF}";`);
  put(root, "public/data.txt", Buffer.from(`user:${AWS}`).toString("base64"));
  put(root, ".next/static/chunks/main.js", `var k="${encodeURIComponent(AWS)}"`);
  put(root, ".next/server/app/index.html", `<p>${HF}</p>`);
  // Server code isn't served, and a build's own cache isn't either.
  put(root, ".next/server/app/page.js", `process.env.HF_TOKEN||"${HF}"`);
  put(root, ".next/cache/x.json", HF);
  put(root, "node_modules/pkg/index.js", HF);
  put(root, ".env.local", `HF_TOKEN=${HF}\n`);
  put(root, "inspo/notes.txt", HF);
  put(root, "test-results/judge/out.txt", HF);
  const out = scan(root, { HF_TOKEN: HF, AWS_SECRET_ACCESS_KEY: AWS });
  assert.ok(out);
  assert.deepEqual(
    out.leaks.map((l) => `${l.file} ${l.name}`).sort(),
    [".next/server/app/index.html HF_TOKEN", ".next/static/chunks/main.js AWS_SECRET_ACCESS_KEY", "app/api/x/route.ts HF_TOKEN", "public/data.txt AWS_SECRET_ACCESS_KEY"],
  );
  assert.ok(out.scanned >= 5);
});

test("every encoding the platform redacts is one the script finds", () => {
  const root = path.join(dir, "encodings");
  valueEncodings(AWS).forEach((form, i) => put(root, `lib/f${i}.txt`, `before ${form} after`));
  const out = scan(root, { AWS_SECRET_ACCESS_KEY: AWS });
  assert.equal(out?.leaks.length, valueEncodings(AWS).length);
});

test("a clean product, or no values to look for, finds nothing", () => {
  const root = path.join(dir, "clean");
  put(root, "app/api/x/route.ts", "const key = process.env.HF_TOKEN;");
  assert.deepEqual(scan(root, { HF_TOKEN: HF })?.leaks, []);
  assert.deepEqual(scan(root, {}, ["HF_TOKEN"])?.leaks, []);
});

test("its output is parsed, and anything else is null", () => {
  assert.equal(parseScanOutput("no json here"), null);
  assert.equal(parseScanOutput('{"musemuse_keys":1,"hits":"x"}'), null);
  assert.deepEqual(parseScanOutput('noise\n{"musemuse_keys":1,"scanned":2,"hits":[{"file":"a.ts","name":"HF_TOKEN"}]}\n'), { scanned: 2, leaks: [{ file: "a.ts", name: "HF_TOKEN", why: "value" }] });
});

test("verify's summary gets a keys step: passed when clean, failed with files and names when not, nothing when it couldn't run", () => {
  const base: VerifySummary = { passed: true, steps: [{ name: "smoke", ok: true }], failureOutput: "" };
  assert.equal(withSharedKeyScan(base, null, []), base);
  const clean = withSharedKeyScan(base, [], []);
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.steps.at(-1), { name: KEYS_STEP, ok: true, detail: "no shared key in the product's files" });
  const leaks = [{ file: "app/api/x/route.ts", name: "HF_TOKEN", why: "value" as const }];
  const failed = withSharedKeyScan(base, leaks, sharedLeakLines(leaks));
  assert.equal(failed.passed, false);
  assert.equal(failed.steps.at(-1)?.ok, false);
  assert.match(failed.failureOutput, /app\/api\/x\/route\.ts holds the value of HF_TOKEN/);
  assert.ok(!failed.failureOutput.includes("\u2014"));
});
