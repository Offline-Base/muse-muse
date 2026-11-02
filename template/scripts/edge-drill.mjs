#!/usr/bin/env node
/**
 * Simulated outage drills for a running product that uses lib/meta/edge.ts. It starts a blackhole gateway
 * (scripts/edge-blackhole.mjs) and a fake edge server (scripts/edge-fake.mjs) on loopback, asks the product one question
 * per drill, and checks what came back. No real model and no Meta call is involved.
 *
 *   1. cloud refused   the gateway drops connections, the fake edge answers: a 2xx reply with "Answered on"
 *   2. cloud hung      the gateway never answers: the edge answer arrives within EDGE_DRILL_HANG_MAX_MS (about 12 s
 *                      is expected: the 10 s cloud deadline plus the edge)
 *   3. both down       gateway and edge both drop: the product shows the plain both-down message, and (with --start)
 *                      its server printed no error
 *   4. tampered reply  the gateway drops, the edge sends JSON with wrong types marked TAMPERED: none of it reaches
 *                      the reply, which carries the both-down message instead
 *
 * CLI:
 *   MUSEMUSE_BASE_URL=http://127.0.0.1:3101 node scripts/edge-drill.mjs [--start "npm start -- -p 3101"] [--only 1,3]
 *
 * --start runs the product itself with GATEWAY_URL, EDGE_URL and PORT set for the drill and watches its output for
 * errors. Without it, start the product first with
 *   GATEWAY_URL=http://127.0.0.1:18436 EDGE_URL=http://127.0.0.1:18435/v1 PRODUCT_TOKEN=drill
 * (the default ports below), since a product reads its env when it starts.
 *
 * Env:
 *   MUSEMUSE_BASE_URL       the product, required (playwright.config.ts reads the same name)
 *   EDGE_DRILL_PATH         the route to ask, for example /api/actions/status. Else edge-drill.json's "path".
 *   EDGE_DRILL_BODY         the JSON body to send. Else edge-drill.json's "body", else {}.
 *   EDGE_DRILL_METHOD       default POST, or edge-drill.json's "method"
 *   EDGE_DRILL_HANG_MAX_MS  default 15000
 *   EDGE_FAKE_PORT          default 18435
 *   EDGE_BLACKHOLE_PORT     default 18436
 *   EDGE_DRILL_OUT          default test-results/caps/edge-drill.json. The fake's own log goes to
 *                           test-results/caps/edge.json and the blackhole's to test-results/caps/blackhole.json.
 *
 * edge-drill.json, at the product's root, is written by Muse Code (the muse-edge skill):
 *   { "path": "/api/actions/status", "method": "POST", "body": { ...simulated input } }
 *
 * Exit codes: 0 every drill passed, 1 a drill failed, 2 setup failed (no MUSEMUSE_BASE_URL or route, a port in use,
 * or the product never came up).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BLACKHOLE_PORT, startBlackhole } from "./edge-blackhole.mjs";
import { DEFAULT_FAKE_PORT, startEdgeFake, TAMPER_MARK } from "./edge-fake.mjs";

/** The start of lib/meta/edge.ts's BOTH_DOWN_MESSAGE. */
export const BOTH_DOWN_PHRASE = "Neither the cloud model nor the backup model answered";
export const EDGE_LABEL_PHRASE = "Answered on";
const ERROR_LINE = /\berror\b|⨯|unhandled|uncaught/i;

export class SetupError extends Error {}

/** The route to ask: env first, then edge-drill.json in `dir`. */
export function drillTarget(env = process.env, dir = process.cwd()) {
  const file = path.join(dir, "edge-drill.json");
  const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const route = env.EDGE_DRILL_PATH?.trim() || json.path;
  if (!route) throw new SetupError("No route to ask: set EDGE_DRILL_PATH or write edge-drill.json with a \"path\".");
  const body = env.EDGE_DRILL_BODY ? JSON.parse(env.EDGE_DRILL_BODY) : (json.body ?? {});
  return { path: route, method: (env.EDGE_DRILL_METHOD || json.method || "POST").toUpperCase(), body };
}

async function ask(baseUrl, target, timeoutMs) {
  const started = Date.now();
  const url = new URL(target.path, baseUrl).href;
  try {
    const res = await fetch(url, {
      method: target.method,
      headers: target.method === "GET" ? {} : { "content-type": "application/json" },
      ...(target.method === "GET" ? {} : { body: JSON.stringify(target.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text(), ms: Date.now() - started };
  } catch (err) {
    return { status: 0, text: "", ms: Date.now() - started, error: err?.name === "TimeoutError" ? "no reply in time" : String(err?.message ?? err) };
  }
}

/**
 * Runs the drills. `product.errors()` (optional) returns the error lines the product's server printed so far.
 * Returns [{ id, name, pass, ms, status, why }].
 */
export async function runDrills({ baseUrl, target, fake, hole, product = null, hangMaxMs = 15_000, only = null, log = () => {} }) {
  const drills = [
    {
      id: 1,
      name: "cloud refused",
      hole: "refuse",
      edge: "ok",
      check: (r, ctx) =>
        r.status >= 200 && r.status < 300
          ? r.text.includes(EDGE_LABEL_PHRASE)
            ? ctx.edgeAsked
              ? null
              : "the reply has the label but the fake edge got no request"
            : `the reply has no "${EDGE_LABEL_PHRASE}" label`
          : `status ${r.status}${r.error ? ` (${r.error})` : ""}`,
    },
    {
      id: 2,
      name: "cloud hung",
      hole: "hang",
      edge: "ok",
      timeoutMs: hangMaxMs + 5_000,
      check: (r, ctx) =>
        r.status < 200 || r.status >= 300
          ? `status ${r.status}${r.error ? ` (${r.error})` : ""}`
          : !r.text.includes(EDGE_LABEL_PHRASE)
            ? `the reply has no "${EDGE_LABEL_PHRASE}" label`
            : !ctx.edgeAsked
              ? "the fake edge got no request"
              : r.ms > hangMaxMs
                ? `the edge answer took ${(r.ms / 1000).toFixed(1)} s, over ${(hangMaxMs / 1000).toFixed(0)} s`
                : null,
    },
    {
      id: 3,
      name: "both down",
      hole: "refuse",
      edge: "refuse",
      check: (r, ctx) =>
        r.status === 0
          ? `no reply (${r.error})`
          : !r.text.includes(BOTH_DOWN_PHRASE)
            ? "the reply has no plain both-down message"
            : ctx.errors.length
              ? `the server printed an error: ${ctx.errors[0].slice(0, 160)}`
              : null,
    },
    {
      id: 4,
      name: "tampered reply rejected",
      hole: "refuse",
      edge: "tamper",
      check: (r, ctx) =>
        r.status === 0
          ? `no reply (${r.error})`
          : r.text.includes(TAMPER_MARK)
            ? "part of the tampered reply reached the page"
            : !ctx.edgeAsked
              ? "the fake edge got no request"
              : !r.text.includes(BOTH_DOWN_PHRASE)
                ? "the reply has no plain both-down message"
                : null,
    },
  ].filter((d) => !only || only.includes(d.id));

  const results = [];
  for (const d of drills) {
    hole.setMode(d.hole);
    fake.setMode(d.edge);
    const asked = fake.requests.length;
    const errorsBefore = product?.errors().length ?? 0;
    const r = await ask(baseUrl, target, d.timeoutMs ?? 40_000);
    // Give the server a moment to print anything it prints after replying.
    await new Promise((res) => setTimeout(res, 200));
    const ctx = { edgeAsked: fake.requests.length > asked, errors: product ? product.errors().slice(errorsBefore) : [] };
    const why = d.check(r, ctx);
    const result = { id: d.id, name: d.name, pass: !why, ms: r.ms, status: r.status, why: why ?? null };
    results.push(result);
    log(`${result.pass ? "PASS" : "FAIL"} ${d.id}. ${d.name} (${(r.ms / 1000).toFixed(1)} s)${why ? `: ${why}` : ""}`);
  }
  return results;
}

/** Starts the product with the drill's env and collects the error lines it prints. */
function startProduct(command, baseUrl, env) {
  const port = new URL(baseUrl).port || "3000";
  const child = spawn(command, { shell: true, env: { ...process.env, ...env, PORT: port }, stdio: ["ignore", "pipe", "pipe"] });
  const errors = [];
  const watch = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (ERROR_LINE.test(line)) errors.push(line.trim());
    });
  };
  watch(child.stdout);
  watch(child.stderr);
  return { child, errors: () => errors, stop: () => child.kill("SIGTERM") };
}

async function waitUp(baseUrl, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) });
      if (res.status < 500) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=", 2);
    const value = inline ?? argv[++i];
    if (key === "--start") out.start = value;
    else if (key === "--only") out.only = value.split(",").map(Number);
    else throw new SetupError(`Unknown flag ${argv[i]}`);
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const baseUrl = process.env.MUSEMUSE_BASE_URL?.trim();
  if (!baseUrl) throw new SetupError("Set MUSEMUSE_BASE_URL to the running product, for example http://127.0.0.1:3101.");
  const target = drillTarget();
  const outFile = path.resolve(process.env.EDGE_DRILL_OUT || "test-results/caps/edge-drill.json");
  let fake;
  let hole;
  try {
    fake = await startEdgeFake({ port: Number(process.env.EDGE_FAKE_PORT || DEFAULT_FAKE_PORT) });
    hole = await startBlackhole({ port: Number(process.env.EDGE_BLACKHOLE_PORT || DEFAULT_BLACKHOLE_PORT) });
  } catch (err) {
    await fake?.close();
    throw new SetupError(`Couldn't start the drill servers: ${err.message}`);
  }
  let product = null;
  try {
    if (flags.start) {
      product = startProduct(flags.start, baseUrl, { GATEWAY_URL: hole.url, EDGE_URL: fake.url, PRODUCT_TOKEN: process.env.PRODUCT_TOKEN || "drill" });
      if (!(await waitUp(baseUrl, 60_000))) throw new SetupError(`The product never answered at ${baseUrl}.`);
    }
    console.log(`Simulated outage drills against ${baseUrl}${target.path}. GATEWAY_URL=${hole.url} EDGE_URL=${fake.url}`);
    const results = await runDrills({
      baseUrl,
      target,
      fake,
      hole,
      product,
      hangMaxMs: Number(process.env.EDGE_DRILL_HANG_MAX_MS || 15_000),
      only: flags.only ?? null,
      log: (line) => console.log(line),
    });
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify({ simulated: true, at: new Date().toISOString(), baseUrl, path: target.path, results }, null, 2) + "\n");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed} of ${results.length} simulated drills passed. Results in ${path.relative(process.cwd(), outFile)}.`);
    return passed === results.length ? 0 : 1;
  } finally {
    product?.stop();
    await fake.close();
    await hole.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(`edge-drill: ${err.message}`);
      process.exit(err instanceof SetupError || err instanceof SyntaxError ? 2 : 1);
    },
  );
}
