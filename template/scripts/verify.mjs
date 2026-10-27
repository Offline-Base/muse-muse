// Definition of done for a Muse Muse product. See .agents/skills/verify/SKILL.md. Don't edit this file.
//
// Steps: typecheck (next typegen + tsc --noEmit), build (next build), start (next start, GET / must be 200),
// console (Chromium loads / with no console or page errors), smoke (playwright, smoke project, every spec in tests/),
// manifest (musemuse.json valid against musemuse.schema.json, action routes and fixtures exist).
// Exits 0 only when every step passes. The LAST line of stdout is always one JSON summary for the platform:
// {"musemuse_verify":1,"passed":bool,"steps":[{"name","ok","ms","detail"}],"failure":"..."}
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = (name) => path.join(ROOT, "node_modules", ".bin", name);
const FAILURE_MAX = 6000;
const STEP_NAMES = ["typecheck", "build", "start", "console", "smoke", "manifest"];

const steps = [];
const failures = [];
const children = new Set();
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
  return { musemuse_verify: 1, passed, steps, failure };
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

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    failures.push({ name: "verify", output: `verify was stopped by ${signal}` });
    void finish();
  });
}
process.on("uncaughtException", (err) => {
  failures.push({ name: "verify", output: String(err?.stack ?? err) });
  void finish();
});

async function main() {
  rmSync(path.join(ROOT, "test-results", "judge"), { recursive: true, force: true });
  mkdirSync(path.join(ROOT, "test-results", "judge"), { recursive: true });

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
      const res = await run(BIN("playwright"), ["test", "--project=smoke"], {
        timeoutMs: 900_000,
        env: { MUSEMUSE_PORT: String(port), CI: "1" },
      });
      const counts = ["passed", "failed", "flaky", "skipped"]
        .map((k) => res.out.match(new RegExp(`(\\d+) ${k}`))?.[0])
        .filter(Boolean)
        .join(", ");
      if (res.code === 0) return { ok: true, detail: counts || "tests passed" };
      const srvLog = stripAnsi(serverLog).trim();
      return {
        ok: false,
        detail: counts || "playwright failed",
        output: `${res.out}${srvLog ? `\n\nServer log (last lines):\n${tail(srvLog, 1500)}` : ""}`,
      };
    });
  } else {
    skip("console");
    skip("smoke");
  }
  await stopServer();

  await step("manifest", checkManifest);
  await finish();
}

async function checkConsole(url) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
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
  return problems.length
    ? { ok: false, detail: `${problems.length} problem(s): ${problems[0]}`, output: problems.join("\n") }
    : { ok: true, detail: `valid, ${manifest.actions.length} action(s), ${manifest.fixtures.length} fixture(s)` };
}

main().catch((err) => {
  failures.push({ name: "verify", output: String(err?.stack ?? err) });
  void finish();
});
