// Definition of done for a Muse Muse product. See .agents/skills/verify/SKILL.md. Don't edit this file.
//
// Steps: typecheck (next typegen + tsc --noEmit), build (next build), start (next start, GET / must be 200),
// console (Chromium loads / with no console or page errors), smoke (playwright, smoke project, every spec in tests/,
// with no test.only and no skipped tests, and a last judge screenshot with no error or empty state, its result near the
// top and a page that isn't too long, for a glasses product a photo taken through the fake glasses, and for a VR product
// a screenshot from inside VR that isn't blank; see scripts/smoke-report.mjs), manifest (musemuse.json valid against
// musemuse.schema.json, action routes and fixtures exist, and no model package in package.json or requirements.txt: every
// model the product calls is a Meta model through the gateway, see modelPackageProblems; no media saved in localStorage
// and no client component that reaches the model client, see storageMediaProblems and clientModelImportProblems; samples
// load from public/samples/, never /fixtures/, and the smoke test presses the product's own "Try the sample" control, see
// fixtureUrlProblems, sampleFileProblems and sampleClickProblems). The smoke
// step also fails an action that answered the built-in sample with a fallback (actionFallbackProblems in smoke-report.mjs). A product with platform services (musemuse.caps.json) also
// gets a caps step after smoke: the platform's caps check runs each cap's fixed checks against what the smoke test
// recorded and what the gateway saw.
// Exits 0 only when every step passes. The LAST line of stdout is always one JSON summary for the platform:
// {"musemuse_verify":1,"passed":bool,"steps":[{"name","ok","ms","detail"}],"failure":"..."}, plus "caps":[...] with caps.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_LOG, actionFallbackProblems, browserLaunchOptions, finalShotProblems, glassesGateProblems, judgeShotNotes, judgeShotProblems, missingFileProblems, onlyRequirementTestsFailed, readCapsFile, productTargets, readRequirementsFile, requirementResults, smokeReportProblems, storedMediaProblems, verifyStepNames, xrGateProblems } from "./smoke-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = (name) => path.join(ROOT, "node_modules", ".bin", name);
const FAILURE_MAX = 6000;
const readRootText = (file) => (existsSync(path.join(ROOT, file)) ? readFileSync(path.join(ROOT, file), "utf8") : null);
// null for a product without platform services, which verifies exactly as before they existed.
const CAPS = readCapsFile(readRootText);
// null for a product without a requirements list, which verifies as before (FULL_BUILDS, docs/FULL_BUILDS.md).
const REQUIREMENTS = readRequirementsFile(readRootText);
const STEP_NAMES = verifyStepNames(CAPS !== null, REQUIREMENTS !== null);
let capsResult = null;
let requirementsResult = null;
// When this verify started, so the caps step counts only what the gateway saw during it, not an earlier round's work.
const STARTED_AT = new Date().toISOString();
// The platform's read-only copy of the caps check in a build sandbox. A product's own copy runs only outside one.
const PLATFORM_CAPS_CHECK = "/vercel/musemuse/caps/core/files/scripts/caps-check.mjs";

// Set only by the template's own tests, which import this file for modelPackageProblems: no step runs and no handler is set.
const IMPORT_ONLY = process.env.MUSEMUSE_VERIFY_IMPORT_ONLY === "1";

const steps = [];
const failures = [];
const children = new Set();
/** The text of a file under the product, or null when it isn't there. */
const readText = (file) => {
  const full = path.join(ROOT, file);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};
let server = null;
let serverLog = "";

let finished = false;
const log = (line) => {
  if (!finished) process.stdout.write(`verify: ${line}\n`);
};
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const tail = (s, n) => (s.length > n ? `...\n${s.slice(-n)}` : s);
const oneLine = (s, n = 300) => stripAnsi(s).replace(/\s+/g, " ").trim().slice(0, n);

/** Runs a command, collecting combined output. Resolves with { code, out } and never throws. */
function run(cmd, args, { timeoutMs, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    children.add(child);
    const collect = (chunk) => {
      out += chunk.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = timeoutMs
      ? setTimeout(() => {
          out += `\n[verify] timed out after ${Math.round(timeoutMs / 1000)} s`;
          killGroup(child);
        }, timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      children.delete(child);
      resolve({ code: 127, out: `${out}\n${err.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      children.delete(child);
      resolve({ code: code ?? 1, out: stripAnsi(out) });
    });
  });
}

function killGroup(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function step(name, fn) {
  if (finished) return false;
  log(`${name} ...`);
  const t0 = Date.now();
  let result;
  try {
    result = await fn();
  } catch (err) {
    result = { ok: false, detail: oneLine(String(err?.message ?? err)), output: String(err?.stack ?? err) };
  }
  const ms = Date.now() - t0;
  if (finished) return false;
  steps.push({ name, ok: result.ok, ms, detail: oneLine(result.detail ?? "") });
  log(`${name} ${result.ok ? "ok" : "FAILED"} (${(ms / 1000).toFixed(1)} s) ${oneLine(result.detail ?? "", 200)}`);
  if (!result.ok) {
    const output = stripAnsi(result.output ?? result.detail ?? "").trim();
    failures.push({ name, output });
    if (output) process.stdout.write(`\n----- ${name} output -----\n${tail(output, 4000)}\n----- end ${name} -----\n\n`);
  }
  return result.ok;
}

function skip(name) {
  steps.push({ name, ok: false, ms: 0, detail: "skipped because an earlier step failed" });
  log(`${name} skipped`);
}

async function portFree(port) {
  const bindable = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port }, () => srv.close(() => resolve(true)));
  });
  if (!bindable) return false;
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function pickPort() {
  for (let port = 3100; port < 3200; port++) if (await portFree(port)) return port;
  throw new Error("No free port between 3100 and 3199.");
}

async function waitFor200(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) return { ok: false, last: `server exited with code ${server.exitCode}` };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      if (res.status === 200) return { ok: true, last: "200" };
      last = `HTTP ${res.status}`;
      if (res.status >= 400) return { ok: false, last };
    } catch (err) {
      last = String(err?.cause?.code ?? err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, last: `timed out, last: ${last}` };
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 7000))]);
  clearTimeout(timer);
}

function summarize() {
  const passed = steps.length === STEP_NAMES.length && steps.every((s) => s.ok);
  const share = failures.length ? Math.floor(FAILURE_MAX / failures.length) : 0;
  let failure = failures.map((f) => `## ${f.name}\n${tail(f.output, Math.max(200, share - f.name.length - 8))}`).join("\n\n");
  if (failure.length > FAILURE_MAX) failure = failure.slice(-FAILURE_MAX);
  return { musemuse_verify: 1, passed, steps, failure, ...(capsResult ? { caps: capsResult } : {}), ...(requirementsResult ? { requirements: requirementsResult } : {}) };
}

async function finish() {
  if (finished) return;
  log(steps.length === STEP_NAMES.length && steps.every((s) => s.ok) ? "all steps passed" : `failed: ${steps.filter((s) => !s.ok).map((s) => s.name).join(", ") || "stopped"}`);
  finished = true;
  for (const child of children) killGroup(child, "SIGKILL");
  await stopServer();
  const summary = summarize();
  process.stdout.write(`${JSON.stringify(summary)}\n`, () => process.exit(summary.passed ? 0 : 1));
}

for (const signal of IMPORT_ONLY ? [] : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    failures.push({ name: "verify", output: `verify was stopped by ${signal}` });
    void finish();
  });
}
if (!IMPORT_ONLY) {
  process.on("uncaughtException", (err) => {
    failures.push({ name: "verify", output: String(err?.stack ?? err) });
    void finish();
  });
}

async function main() {
  rmSync(path.join(ROOT, "test-results", "judge"), { recursive: true, force: true });
  mkdirSync(path.join(ROOT, "test-results", "judge"), { recursive: true });
  if (CAPS) rmSync(path.join(ROOT, "test-results", "caps"), { recursive: true, force: true });
  rmSync(path.join(ROOT, path.dirname(ACTION_LOG)), { recursive: true, force: true });

  const typecheckOk = await step("typecheck", async () => {
    const gen = await run(BIN("next"), ["typegen"], { timeoutMs: 120_000 });
    if (gen.code !== 0) return { ok: false, detail: "next typegen failed", output: gen.out };
    const tsc = await run(BIN("tsc"), ["--noEmit", "-p", "."], { timeoutMs: 300_000 });
    const errors = (tsc.out.match(/error TS\d+/g) ?? []).length;
    return tsc.code === 0
      ? { ok: true, detail: "no type errors" }
      : { ok: false, detail: `${errors || "some"} type errors`, output: tsc.out };
  });

  let port = 3100;
  let ready = false;
  if (typecheckOk && (await step("build", async () => {
    const res = await run(BIN("next"), ["build"], { timeoutMs: 600_000 });
    return res.code === 0 ? { ok: true, detail: "next build succeeded" } : { ok: false, detail: "next build failed", output: res.out };
  }))) {
    ready = await step("start", async () => {
      port = await pickPort();
      server = spawn(BIN("next"), ["start", "-p", String(port)], {
        cwd: ROOT,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0", PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const collect = (chunk) => {
        serverLog += chunk.toString();
        if (serverLog.length > 200_000) serverLog = serverLog.slice(-100_000);
      };
      server.stdout.on("data", collect);
      server.stderr.on("data", collect);
      const t0 = Date.now();
      const res = await waitFor200(`http://localhost:${port}/`, 60_000);
      return res.ok
        ? { ok: true, detail: `GET / returned 200 on port ${port} after ${((Date.now() - t0) / 1000).toFixed(1)} s` }
        : { ok: false, detail: `GET / did not return 200 (${res.last})`, output: stripAnsi(serverLog) };
    });
  } else {
    if (!typecheckOk) skip("build");
    skip("start");
  }

  if (ready) {
    await step("console", () => checkConsole(`http://localhost:${port}/`));
    await step("smoke", async () => {
      const reportPath = path.join(ROOT, "test-results", "report.json");
      rmSync(reportPath, { force: true });
      const smokeStarted = Date.now();
      const res = await run(BIN("playwright"), ["test", "--project=smoke", "--forbid-only"], {
        // One test per requirement can run longer than the usual few.
        timeoutMs: REQUIREMENTS ? Number(process.env.MUSEMUSE_REQUIREMENTS_MS) || 1_500_000 : 900_000,
        env: { MUSEMUSE_PORT: String(port), CI: "1" },
      });
      const counts = ["passed", "failed", "flaky", "skipped"]
        .map((k) => res.out.match(new RegExp(`(\\d+) ${k}`))?.[0])
        .filter(Boolean)
        .join(", ");
      // On the last round (MUSEMUSE_SCREEN_CHECK=warn) a failed requirement's test is the requirements step's to report,
      // so the judge still runs and the checklist can name it.
      const onlyTheirs = REQUIREMENTS && res.code !== 0 && lastRoundOnlyRequirements(reportPath);
      if (res.code === 0 || onlyTheirs) {
        let report;
        try {
          report = JSON.parse(readFileSync(reportPath, "utf8"));
        } catch {
          return { ok: false, detail: "Playwright wrote no test-results/report.json. Keep playwright.config.ts as it is.", output: res.out };
        }
        const judgeDir = path.join(ROOT, "test-results", "judge");
        const shots = readdirSync(judgeDir);
        const read = (f) => readFileSync(path.join(judgeDir, f), "utf8");
        const problems = [
          ...smokeReportProblems(report, { requireActions: hasActions() }),
          ...judgeShotProblems(shots),
          ...glassesGateProblems(readText, { since: smokeStarted }),
          ...xrGateProblems(readText, shots, read),
          // A sample that 404s isn't a matter of layout, so it fails even on the platform's last round.
          ...missingFileProblems(shots, read),
        ];
        // An action that answered the sample with a fallback hid a model call that failed. Never only a warning.
        const fallbacks = actionFallbackProblems(readText(ACTION_LOG), { since: smokeStarted });
        if (fallbacks.length) {
          problems.push(...fallbacks);
          const modelLines = stripAnsi(serverLog).split("\n").filter((l) => l.includes("[model]") || /\b(?:APIError|BadRequestError|RateLimitError)\b/.test(l));
          if (modelLines.length) problems.push(`Server log, model lines:\n${modelLines.slice(-8).join("\n")}`);
        }
        const finalScreen = [...finalShotProblems(shots, read), ...storedMediaProblems(shots, read)];
        // MUSEMUSE_SCREEN_CHECK=warn (set by the platform, never by the product) logs them instead, as judgeShot does.
        if (process.env.MUSEMUSE_SCREEN_CHECK === "warn") for (const p of finalScreen) log(`musemuse screen check: ${p}`);
        else problems.push(...finalScreen);
        for (const note of judgeShotNotes(shots, read)) log(`note: ${note}`);
        if (!problems.length) return { ok: true, detail: counts || "tests passed" };
        return { ok: false, detail: problems[0], output: `${problems.join("\n")}\n\n${res.out}` };
      }
      const srvLog = stripAnsi(serverLog).trim();
      const focused = /focused with '\.only'/.test(res.out);
      return {
        ok: false,
        detail: focused ? "test.only is not allowed. Remove it so every test runs." : counts || "playwright failed",
        output: `${res.out}${srvLog ? `\n\nServer log (last lines):\n${tail(srvLog, 1500)}` : ""}`,
      };
    });
    if (CAPS) await step("caps", checkCaps);
    if (REQUIREMENTS) await step("requirements", checkRequirements);
  } else {
    skip("console");
    skip("smoke");
    if (CAPS) skip("caps");
    if (REQUIREMENTS) skip("requirements");
  }
  await stopServer();

  await step("manifest", checkManifest);
  await finish();
}

/**
 * The caps step: the core overlay's caps check runs each active cap's checks against what the smoke test recorded in
 * test-results/caps/ and what the gateway saw for this build since this verify started. In a build sandbox it is the
 * platform's read-only copy, with its own checkers and gateway record, so nothing in the product folder decides it. Its
 * last line is one JSON result.
 */
async function checkCaps() {
  const script = existsSync(PLATFORM_CAPS_CHECK) ? PLATFORM_CAPS_CHECK : path.join(ROOT, "scripts", "caps-check.mjs");
  if (!existsSync(script)) return { ok: false, detail: "scripts/caps-check.mjs is missing, so the platform services can't be checked" };
  const res = await run(process.execPath, [script, "--root", ROOT, "--since", STARTED_AT], { timeoutMs: 120_000 });
  const line = res.out.trim().split("\n").reverse().find((l) => l.startsWith("{") && l.includes("musemuse_caps"));
  let parsed = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.caps)) return { ok: false, detail: "the caps check printed no result", output: res.out };
  capsResult = parsed.caps;
  const failed = parsed.caps.flatMap((c) => (c.checks ?? []).filter((k) => !k.ok).map((k) => `${c.cap}, ${k.id}: ${k.detail ?? "failed"}`));
  const total = parsed.caps.reduce((n, c) => n + (c.checks?.length ?? 0), 0);
  if (res.code === 0 && parsed.ok === true && !failed.length) return { ok: true, detail: `${total} fixed check(s) passed for ${parsed.caps.map((c) => c.cap).join(", ")}` };
  return { ok: false, detail: failed[0] ?? "the caps check failed", output: failed.join("\n") || res.out };
}

/** On the platform's last round, the last smoke run failed only on requirement tests. */
function lastRoundOnlyRequirements(reportPath) {
  if (process.env.MUSEMUSE_SCREEN_CHECK !== "warn") return false;
  try {
    return onlyRequirementTestsFailed(JSON.parse(readFileSync(reportPath, "utf8")), REQUIREMENTS);
  } catch {
    return false;
  }
}

/**
 * The requirements step: every requirement has a passing test of its own, read from the smoke run's report. Warn mode
 * (the platform's last round) records the results without failing, and the judge's verdict counts them either way.
 */
function checkRequirements() {
  let report = null;
  try {
    report = JSON.parse(readFileSync(path.join(ROOT, "test-results", "report.json"), "utf8"));
  } catch {
    // No report: every requirement counts as having no test.
  }
  requirementsResult = requirementResults(report, REQUIREMENTS, (file) => readText(path.join("tests", file)));
  const bad = requirementsResult.filter((r) => !r.ok);
  if (!bad.length) return { ok: true, detail: `${requirementsResult.length} of ${requirementsResult.length} requirements passed` };
  const detail = `${bad.length} of ${requirementsResult.length} not passing: ${bad.map((r) => r.id).join(", ")}`;
  if (process.env.MUSEMUSE_SCREEN_CHECK === "warn") return { ok: true, detail };
  return { ok: false, detail, output: bad.map((r) => `${r.id}: ${r.detail}`).join("\n") };
}

/** True when the product has actions, so tests/actions.spec.ts must run too. */
function hasActions() {
  if (existsSync(path.join(ROOT, "tests", "actions.spec.ts"))) return true;
  try {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "musemuse.json"), "utf8"));
    return Array.isArray(manifest.actions) && manifest.actions.length > 0;
  } catch {
    return false;
  }
}

async function checkConsole(url) {
  const { chromium } = await import("@playwright/test");
  // A VR product's 3D preview needs software WebGL, or the page logs that it couldn't create a context.
  const browser = await chromium.launch(browserLaunchOptions(readText));
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1000);
    if (!res || res.status() !== 200) problems.unshift(`GET / returned ${res?.status() ?? "nothing"} in the browser`);
  } finally {
    await browser.close();
  }
  return problems.length
    ? { ok: false, detail: `${problems.length} problem(s): ${problems[0]}`, output: problems.join("\n") }
    : { ok: true, detail: "no console or page errors" };
}

async function checkManifest() {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
  let manifest;
  try {
    manifest = read("musemuse.json");
  } catch (err) {
    return { ok: false, detail: "musemuse.json is missing or not valid JSON", output: String(err?.message ?? err) };
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(read("musemuse.schema.json"));
  const problems = validate(manifest)
    ? []
    : (validate.errors ?? []).map((e) => `musemuse.json${e.instancePath || ""} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`);
  for (const action of Array.isArray(manifest.actions) ? manifest.actions : []) {
    const route = path.join("app", "api", "actions", String(action?.name), "route.ts");
    if (action?.name && !existsSync(path.join(ROOT, route))) problems.push(`action "${action.name}" has no ${route}`);
  }
  for (const fixture of Array.isArray(manifest.fixtures) ? manifest.fixtures : []) {
    if (fixture?.path && !existsSync(path.join(ROOT, fixture.path))) problems.push(`fixture ${fixture.path} does not exist`);
  }
  problems.push(...modelPackageProblems(readRootText));
  const sources = readSources();
  problems.push(...storageMediaProblems(sources), ...clientModelImportProblems(sources));
  problems.push(...fixtureUrlProblems(sources), ...sampleFileProblems(sources, (p) => existsSync(path.join(ROOT, "public", p))));
  problems.push(...sampleClickProblems(sources, readText("tests/smoke.spec.ts"), productTargets(readText)));
  return problems.length
    ? { ok: false, detail: `${problems.length} problem(s): ${problems[0]}`, output: problems.join("\n") }
    : { ok: true, detail: `valid, ${manifest.actions.length} action(s), ${manifest.fixtures.length} fixture(s)` };
}

/**
 * npm packages that run a model in the product itself, or reach a model that isn't Meta's. The organizers ruled on Nov 2
 * that every model a project calls must be a Meta model, so a product reaches models only through the Muse Muse gateway
 * (lib/meta helpers). Each entry is an exact name, or a scope or prefix ending in "/" or "*".
 */
export const MODEL_NPM_PACKAGES = [
  "@xenova/", "@huggingface/transformers", "@huggingface/inference", "transformers.js", "onnxruntime*", "tesseract.js*",
  "@tensorflow/", "@tensorflow-models/", "@mediapipe/", "face-api.js", "@vladmandic/", "ml5", "@mlc-ai/", "node-llama-cpp",
  "llama-node", "@llama-node/", "ollama", "@anthropic-ai/", "@google/generative-ai", "@google/genai", "@mistralai/",
  "cohere-ai", "groq-sdk", "replicate", "@ai-sdk/",
];
/** Any npm name with whisper in it is a speech model port (whisper-node, nodejs-whisper, smart-whisper and the like). */
const WHISPER_RE = /whisper/i;
/** PyPI packages that run a model (the runtime cap's requirements.txt). Names compare lowercased, with _ and . as -. */
export const MODEL_PYPI_PACKAGES = [
  "transformers", "torch", "torchvision", "torchaudio", "tensorflow*", "tf-keras", "keras", "onnxruntime*", "onnx", "mediapipe",
  "sentence-transformers", "pytesseract", "easyocr", "ultralytics", "llama-cpp-python", "tflite-runtime", "openai-whisper",
  "faster-whisper", "whisper*", "diffusers", "accelerate", "vllm", "ollama", "anthropic", "google-generativeai", "google-genai",
];

const matchesList = (name, list) => list.some((p) => (p.endsWith("/") || p.endsWith("*") ? name.startsWith(p.replace(/\*$/, "")) : name === p));

/**
 * Why the product's packages aren't allowed: one plain line per model package in package.json (any dependency list) or
 * requirements.txt, or none. `readText(file)` gives a file's text under the product, or null when it isn't there.
 */
export function modelPackageProblems(readText) {
  const out = [];
  const reason = "runs or reaches a model that isn't Meta's. Every model the product calls must be a Meta model through the Muse Muse gateway (the lib/meta helpers), so remove it";
  const pkgText = readText("package.json");
  if (pkgText !== null) {
    let pkg = null;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      out.push("package.json isn't valid JSON, so its packages can't be checked");
    }
    const names = new Set();
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = pkg?.[field];
      if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        names.add(name.toLowerCase());
        // An alias ("my-ocr": "npm:tesseract.js@5") pulls in the package it names, so that name is checked too.
        const alias = typeof spec === "string" ? /^npm:((?:@[^/@\s]+\/)?[^@\s]+)/i.exec(spec.trim())?.[1] : undefined;
        if (alias) names.add(alias.toLowerCase());
      }
    }
    for (const name of [...names].sort()) {
      if (matchesList(name, MODEL_NPM_PACKAGES) || WHISPER_RE.test(name)) out.push(`package.json pulls in ${name}, which ${reason}`);
    }
  }
  const reqText = readText("requirements.txt");
  if (reqText !== null) {
    for (const raw of reqText.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      if (!line || line.startsWith("-")) continue;
      const name = (/^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(line)?.[0] ?? "").toLowerCase().replace(/[_.]/g, "-");
      if (name && matchesList(name, MODEL_PYPI_PACKAGES)) out.push(`requirements.txt pulls in ${name}, which ${reason}`);
    }
  }
  return out;
}

// ---------- Source checks: cheap, static and narrow, run with the manifest ----------

/** Folders under the product that are never its own app code. */
const NOT_SOURCE = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report", "tests", "scripts", "targets", "caps", "inspo", "fixtures", "public", ".agents"]);
const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs)$/;

/** The product's own source files, as [{ path, text }] with paths relative to the product and "/" between parts. */
function readSources() {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!NOT_SOURCE.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), relPath);
      } else if (SOURCE_EXT.test(e.name) && !e.name.endsWith(".d.ts") && !/\.config\.[cm]?[jt]s$/.test(e.name)) {
        try {
          const text = readFileSync(path.join(dir, e.name), "utf8");
          if (text.length < 1_000_000) out.push({ path: relPath, text });
        } catch {
          // unreadable: nothing to check
        }
      }
    }
  };
  walk(ROOT, "");
  return out;
}

/** The text between a call's parentheses, from just after "(" at `open`, or what is there within 2,000 characters. */
function callArgs(text, open) {
  let depth = 1;
  for (let i = open; i < Math.min(text.length, open + 2000); i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open, open + 2000);
}

/** Words in a setItem call's arguments that mean the value is a photo, audio or video as text. */
const MEDIA_VALUE = /data:(?:image|audio|video)\/|toDataURL\s*\(|readAsDataURL|blobToDataUrl|toDataUrl\s*\(|\bb64_json\b|base64|data_?url/i;

/**
 * localStorage or sessionStorage setItem calls whose value reads as a data URL or base64 media. Both hold about 5 MB per
 * site, so a few photos fill them and the next save throws. One line per file, or none. `sources` is [{ path, text }].
 */
export function storageMediaProblems(sources) {
  const out = [];
  for (const { path: file, text } of sources) {
    const hits = [];
    for (const m of text.matchAll(/\b(localStorage|sessionStorage)\s*\.\s*setItem\s*\(/g)) {
      const args = callArgs(text, m.index + m[0].length);
      if (MEDIA_VALUE.test(args)) hits.push(`${m[1]}.setItem(${oneLine(args, 60)})`);
    }
    if (hits.length) {
      out.push(
        `${file} saves media in browser storage: ${hits.slice(0, 2).join("; ")}. localStorage and sessionStorage hold about ` +
          "5 MB per site, so a few photos or recordings fill them and the next save throws. Keep media in IndexedDB (or in " +
          "memory), and save only text and ids in localStorage, inside a try/catch.",
      );
    }
  }
  return out;
}

/** A file's code with its comments taken out. A "//" just after a colon or a quote is a web address, so it stays. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Folders whose files are the product's screens and their parts. */
const isScreenCode = (file) => /^(?:app|components)\//.test(file);

/**
 * Code that asks the browser for a file under fixtures/: a string that starts with "/fixtures/" anywhere in app/ or
 * components/ (or in a "use client" file), or one that starts with "fixtures/" in a "use client" file. next start and
 * production serve only public/, so that sample works in tests that use setInputFiles and for no visitor (the Nov 3
 * aisle build's "Try the sample shelf photo" got a 404). A server route that reads fixtures/ from disk is left alone:
 * its path never starts with a slash. One line per file, or none. `sources` is [{ path, text }].
 */
export function fixtureUrlProblems(sources) {
  const out = [];
  for (const { path: file, text } of sources) {
    const client = USE_CLIENT.test(text);
    if (!isScreenCode(file) && !client) continue;
    // A route handler, or a server file that reads the disk, asks for no file in the browser: process.cwd() + "/fixtures/a.jpg" is a path on disk.
    if (!client && (/(?:^|\/)route\.[jt]sx?$/.test(file) || /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs/.test(text))) continue;
    const code = withoutComments(text);
    const hits = new Set();
    for (const m of code.matchAll(/["'`](\.?\/?fixtures\/[^"'`\s]*)/g)) {
      if (m[1].startsWith("/fixtures/") || client) hits.add(m[1]);
    }
    if (hits.size) {
      out.push(
        `${file} loads ${[...hits].slice(0, 2).map((h) => `"${h}"`).join(" and ")} in the browser, but fixtures/ is never served: ` +
          "a visitor gets a 404. Copy the sample to public/samples/ and load it from \"/samples/<name>\". Keep fixtures/ for the tests (AGENTS.md, The product).",
      );
    }
  }
  return out;
}

/**
 * Sample files the code names under /samples/ that public/samples/ doesn't have, so the page would get a 404. Only whole
 * names with an extension count, not ones built from a variable. `exists(p)` says whether public/<p> is there. One line
 * per file, or none.
 */
export function sampleFileProblems(sources, exists) {
  const out = [];
  for (const { path: file, text } of sources) {
    if (!isScreenCode(file) && !USE_CLIENT.test(text) && !file.startsWith("lib/")) continue;
    const missing = new Set();
    for (const m of withoutComments(text).matchAll(/["'`](\/samples\/[\w\-./]+\.[A-Za-z0-9]{2,5})["'`]/g)) {
      if (!m[1].includes("..") && !exists(m[1].slice(1))) missing.add(m[1]);
    }
    if (missing.size) out.push(`${file} loads ${[...missing].slice(0, 3).map((m) => `"${m}"`).join(", ")}, but public${[...missing][0]} isn't there, so a visitor gets a 404. Copy the sample from fixtures/ to public/samples/.`);
  }
  return out;
}

/**
 * A button or link that offers the built-in sample: "Try the sample", "Use a sample photo", "Load the sample". The words
 * start a label (JSX text after ">", or a string), so a sentence like "you can use a sample to see how it works" isn't one.
 */
const SAMPLE_CONTROL = /(?:>|["'`])\s*((?:try|use|load)\s+(?:the\s+|a\s+|our\s+|this\s+)?(?:built-in\s+)?sample)\b/i;

/**
 * When the product's screens offer a "Try the sample" control, tests/smoke.spec.ts must press it (a click on a locator
 * that names a sample), not only hand the file to the input with setInputFiles: only the button shows the sample loads
 * for a visitor. Glasses and VR products are left out, since their smoke tests take a set path through the headset or
 * the glasses. `smokeText` is the spec's text or null. One line, or none.
 */
export function sampleClickProblems(sources, smokeText, targets = []) {
  if (smokeText === null || targets.includes("glasses") || targets.includes("vr")) return [];
  const offer = sources.find((s) => isScreenCode(s.path) && /\.[jt]sx$/.test(s.path) && SAMPLE_CONTROL.test(withoutComments(s.text)));
  if (!offer) return [];
  if (smokeClicksSample(smokeText)) return [];
  const label = SAMPLE_CONTROL.exec(withoutComments(offer.text))?.[1] ?? "Try the sample";
  return [
    `${offer.path} offers "${label}", but tests/smoke.spec.ts never presses it. Press it in the smoke test the way a visitor ` +
      `does, like await page.getByRole("button", { name: /${label.replace(/\s+/g, " ").toLowerCase()}/i }).click(), and wait for the ` +
      "sample to show. setInputFiles skips the button, so a sample that only loads in tests goes unnoticed (verify skill, Smoke test).",
  ];
}

/** True when a spec clicks a locator that names a sample, directly or through a variable it set up. */
export function smokeClicksSample(specText) {
  const code = withoutComments(String(specText ?? ""));
  for (const m of code.matchAll(/\.(?:click|tap|dblclick)\s*\(/g)) {
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    // The statement the click ends: from its own await, or from the end of the one before it.
    const awaited = before.lastIndexOf("await ");
    const ended = before.lastIndexOf(";");
    const statement = awaited > ended ? before.slice(awaited + 6) : before.slice(ended + 1);
    if (/sample/i.test(statement)) return true;
    const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(statement)?.[1];
    if (!name) continue;
    const set = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=([^;]*)`).exec(code);
    if (set && /sample/i.test(set[1])) return true;
  }
  return false;
}

/** Imports in a file: { spec, typeOnly }, side-effect and dynamic imports included. Comments are left out. */
export function importsOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?([\w$*{}\s,]*?)\s*from\s*["']([^"'\n]+)["']/g)) {
    const clause = m[2].trim();
    const braces = /^\{([^}]*)\}$/.exec(clause)?.[1];
    const names = braces?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
    out.push({ spec: m[3], typeOnly: Boolean(m[1]) || (names.length > 0 && names.every((x) => /^type\s/.test(x))) });
  }
  for (const m of code.matchAll(/\bimport\s*["']([^"'\n]+)["']/g)) out.push({ spec: m[1], typeOnly: false });
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false });
  return out;
}

/** A local import's file among `paths`, or null for a package. "@/x" is the product's root (tsconfig paths). */
function resolveImport(from, spec, paths) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null;
  const tries = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((x) => base + x), ...["ts", "tsx", "js", "jsx"].map((x) => `${base}/index.${x}`)];
  return tries.find((t) => paths.has(t)) ?? null;
}

const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const isPackage = (spec, name) => spec === name || spec.startsWith(`${name}/`);

/**
 * Client components that reach the template's server-only model modules: a "use client" file, or a file it imports,
 * that imports a lib/meta module which calls the model (it imports openai, reads process.env, or imports such a module),
 * or the openai package itself. That puts the SDK in the browser bundle and code that needs the server's env in the page.
 * Type-only imports are fine. One line per client file, or none. `sources` is [{ path, text }].
 */
export function clientModelImportProblems(sources) {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const paths = new Set(byPath.keys());
  const imports = new Map(sources.map((s) => [s.path, importsOf(s.text).filter((i) => !i.typeOnly)]));
  // lib/meta modules that call the model, directly or through another one.
  const serverOnly = new Set();
  const meta = sources.filter((s) => s.path.startsWith("lib/meta/"));
  for (const s of meta) {
    if (/\bprocess\.env\b/.test(s.text) || imports.get(s.path).some((i) => isPackage(i.spec, "openai") || i.spec.startsWith("node:"))) serverOnly.add(s.path);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of meta) {
      if (serverOnly.has(s.path)) continue;
      if (imports.get(s.path).some((i) => serverOnly.has(resolveImport(s.path, i.spec, paths)))) {
        serverOnly.add(s.path);
        grew = true;
      }
    }
  }
  const out = [];
  for (const entry of sources.filter((s) => USE_CLIENT.test(s.text))) {
    // Breadth first, so the path named is the shortest.
    const via = new Map([[entry.path, null]]);
    const queue = [entry.path];
    let found = null;
    while (queue.length && !found) {
      const file = queue.shift();
      for (const i of imports.get(file) ?? []) {
        if (isPackage(i.spec, "openai")) {
          found = { file, target: "the openai package" };
          break;
        }
        const target = resolveImport(file, i.spec, paths);
        if (!target || via.has(target)) continue;
        via.set(target, file);
        if (serverOnly.has(target)) {
          found = { file: target, target };
          break;
        }
        queue.push(target);
      }
    }
    if (!found) continue;
    const chain = [];
    for (let f = found.target === "the openai package" ? found.file : via.get(found.target); f && f !== entry.path; f = via.get(f)) chain.unshift(f);
    out.push(
      `${entry.path} is a client component ("use client") and imports ${found.target}${chain.length ? ` (through ${chain.join(", ")})` : ""}. ` +
        "That ships the model client to the browser, where the gateway's env doesn't exist. Call the model only in a route " +
        "under app/api/ or a server action, and fetch it from the page. Keep zod schemas the page shares in a file that " +
        "imports only zod.",
    );
  }
  return out;
}

if (!IMPORT_ONLY) {
  main().catch((err) => {
    failures.push({ name: "verify", output: String(err?.stack ?? err) });
    void finish();
  });
}
