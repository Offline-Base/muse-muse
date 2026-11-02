#!/usr/bin/env node
/**
 * `npm run drill-bench`: the cold-room drill bench with no model. It needs python3 and nothing else.
 *
 *   1. make    scripts/dev/drill-bench.py writes the Simulated set from its fixed seed into .data/drill-bench/
 *              (git-ignored): 900 training rows, 50 kept aside, 100 sealed held-out. The sealed file must come out
 *              byte for byte the same as eval/drill/sealed.jsonl (its sha256 is checked).
 *   2. score   the right answers themselves (--reference), which must score 100% with the hard rule passed
 *   3. score   scripts/drill/always-normal-answers.jsonl, canned answers written by a script, not a model: "normal,
 *              trust the controller" for every window. The scorer must catch every hard-rule break (12 of 12).
 *
 * The data is invented by the script from a seed; nothing is about a real freezer or store. Exit 0 when every check
 * holds, 1 when one doesn't, 2 when python3 is missing or the script fails.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".data", "drill-bench");
const BENCH = path.join(ROOT, "scripts", "dev", "drill-bench.py");
const CANNED = path.join(ROOT, "scripts", "drill", "always-normal-answers.jsonl");
const COMMITTED = path.join(ROOT, "eval", "drill", "sealed.jsonl");
const rel = (p) => path.relative(process.cwd(), p) || ".";

function py(args) {
  // -I: no user site-packages or PYTHON* env, so only the standard library the script uses is loaded.
  const r = spawnSync("python3", ["-I", BENCH, ...args], { cwd: ROOT, encoding: "utf8" });
  if (r.error) {
    console.log(`drill-bench: couldn't run python3 (${r.error.message}). Install Python 3.`);
    process.exit(2);
  }
  if (r.status !== 0) {
    console.log(r.stdout + r.stderr);
    console.log(`drill-bench: ${args[0]} failed with exit ${r.status}.`);
    process.exit(2);
  }
  return r.stdout;
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** score prints one JSON report, after nothing else. */
const report = (stdout) => JSON.parse(stdout.slice(stdout.indexOf("{")));

const checks = [];
const check = (ok, line) => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
};

console.log("Cold-room drill bench: Simulated data from a fixed seed, scored by code, no model.");
process.stdout.write(py(["make", "--out", OUT]).replace(OUT, rel(OUT)));
const sealed = path.join(OUT, "sealed.jsonl");
check(sha(sealed) === sha(COMMITTED), `the sealed set made here matches ${rel(COMMITTED)} (sha256 ${sha(sealed).slice(0, 12)}...)`);

const ref = report(py(["score", "--heldout", sealed, "--reference"]));
check(ref.all_right === 1 && ref.hard_rule.passed, `the right answers score ${Math.round(ref.all_right * 100)}% all right, hard rule ${ref.hard_rule.passed ? "passed" : "broken"}`);

const canned = report(py(["score", "--heldout", sealed, "--answers", CANNED]));
const { rows, violations } = canned.hard_rule;
check(rows > 0 && violations === rows && !canned.hard_rule.passed, `canned "always normal" answers: ${Math.round(canned.all_right * 100)}% all right, and the scorer flags ${violations} of ${rows} hard-rule breaks`);
console.log(`Per field for the canned answers: ${Object.entries(canned.per_field).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}.`);
console.log("To score a real model, see eval/drill/README.md (ask, then score). Nothing here ran one.");

const passed = checks.filter(Boolean).length;
console.log(`${passed} of ${checks.length} bench checks passed.`);
process.exit(passed === checks.length ? 0 : 1);
