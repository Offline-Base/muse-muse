#!/usr/bin/env node
/**
 * Simulated outage drills for a running product that uses lib/meta/edge.ts. It starts a blackhole gateway
 * (scripts/edge-blackhole.mjs) and a fake edge server (scripts/edge-fake.mjs) on loopback, asks the product one question
 * per drill, and checks what came back. No real model and no Meta call is involved.
 *
 *   1. cloud refused   the gateway drops connections, the fake edge answers: a 2xx reply with "Answered on", after
 *                      the product tried the gateway
 *   2. cloud hung      the gateway never answers: the product tried it, and the edge answer arrives within
 *                      EDGE_DRILL_HANG_MAX_MS (about 12 s is expected: the 10 s cloud deadline plus the edge)
 *   3. both down       gateway and edge both drop: the product shows the plain both-down message, and (with --start)
 *                      its server printed no error
 *   4. tampered reply  the gateway drops, the edge sends JSON with wrong types marked TAMPERED: none of it reaches
 *                      the reply, which carries the both-down message instead
 *
 * Those four are the default set, the one builds run. --all adds six more scenarios (--only picks from all ten):
 *
 *   5. cloud slow      the gateway answers at about 8 s, inside the 10 s limit: the product waits for it, shows the
 *                      cloud label and never asks the edge
 *   6. cloud flapping  three asks while the gateway answers 503, then OK, then 503: each reply is labeled with whoever
 *                      answered it (edge, cloud, edge), and none takes longer than EDGE_DRILL_HANG_MAX_MS
 *   7. edge too slow   the gateway hangs and the edge answers only after its own limit: the product shows the plain
 *                      both-down message within both limits plus 3 s, never the late answer
 *   8. truncated reply the gateway drops, the edge sends JSON cut off part way, marked TRUNCATED: none of it reaches
 *                      the reply, which carries the both-down message instead
 *   9. injected text   the gateway drops, the edge sends schema-valid JSON whose free text says to ignore the rules,
 *                      claim the cloud answered and fetch a URL: the reply still says the edge answered, carries the
 *                      text only as data (inside a JSON string, or escaped in HTML), and nothing fetched the URL
 *  10. no DNS          the gateway's host name can't be resolved: the product answers from the edge with its label.
 *                      With --start the runner restarts the product for this drill (it runs last) with GATEWAY_URL at
 *                      a .invalid host and a preload that fails every .invalid lookup in the product, so no DNS query
 *                      leaves the machine. Without --start, set EDGE_DRILL_DNS_BASE_URL to a second copy of the
 *                      product started that way, or the drill fails and says why.
 *
 * With --all and --start, the product gets EDGE_TIMEOUT_MS and EDGE_CLOUD_TIMEOUT_MS from the two limits below, so
 * drill 7 knows how long the product may take.
 *
 * CLI:
 *   MUSEMUSE_BASE_URL=http://127.0.0.1:3101 node scripts/edge-drill.mjs [--start "npm start -- -p 3101"] [--only 1,3] [--all]
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
 *   EDGE_DRILL_CLOUD_LIMIT_MS  the product's cloud limit, default 10000 (drills 5 and 7)
 *   EDGE_DRILL_EDGE_LIMIT_MS   the product's edge limit, default 5000 (drill 7)
 *   EDGE_DRILL_SLOW_MS      how long the slow cloud takes in drill 5, default 8000. Keep it under the cloud limit.
 *   EDGE_DRILL_DNS_BASE_URL a product started with GATEWAY_URL at a host that can't be resolved (drill 10, no --start)
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
import { DEFAULT_FAKE_PORT, INJECT_MARK, startEdgeFake, TAMPER_MARK, TRUNCATE_MARK } from "./edge-fake.mjs";

/** The start of lib/meta/edge.ts's BOTH_DOWN_MESSAGE. */
export const BOTH_DOWN_PHRASE = "Neither the cloud model nor the backup model answered";
export const EDGE_LABEL_PHRASE = "Answered on";
/** The start of lib/meta/edge.ts's cloudLabel(). */
export const CLOUD_LABEL_PHRASE = "Answered in the cloud";
/** The default set, the one builds run. --all adds the rest. */
export const DEFAULT_DRILL_IDS = [1, 2, 3, 4];
/** Drill 10's gateway: a host under .invalid, a name reserved never to resolve (RFC 6761). */
export const DNS_DRILL_HOST = "muse-gateway.drill.invalid";

/**
 * Makes every lookup of a .invalid host fail with ENOTFOUND, the error a real resolver gives, without asking one.
 * Self-contained, so it can run as a preload in the product (noDnsImport). Returns a function that undoes it.
 */
export function blockInvalidHosts(dns) {
  const blocked = (host) => typeof host === "string" && /\.invalid\.?$/i.test(host);
  const notFound = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo", hostname: host });
  const lookup = dns.lookup;
  const promised = dns.promises.lookup;
  dns.lookup = function (host, options, callback) {
    if (!blocked(host)) return lookup.apply(this, arguments);
    process.nextTick(typeof options === "function" ? options : callback, notFound(host));
    return {};
  };
  dns.promises.lookup = function (host) {
    return blocked(host) ? Promise.reject(notFound(host)) : promised.apply(this, arguments);
  };
  return () => {
    dns.lookup = lookup;
    dns.promises.lookup = promised;
  };
}

/** A NODE_OPTIONS entry that runs blockInvalidHosts in a product's server before its own code. */
export function noDnsImport() {
  const source = `import dns from "node:dns";\n(${blockInvalidHosts.toString()})(dns);\n`;
  return `--import=data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
/** Drills 1 and 2 test the fallback, so an edge answer that never tried the cloud (edge only, or EDGE_FIRST) fails them. */
const NO_CLOUD_TRY = "the product never tried the cloud first (the blackhole gateway got no connection)";
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
    return { status: res.status, text: await res.text(), ms: Date.now() - started, type: res.headers.get("content-type") ?? "" };
  } catch (err) {
    return { status: 0, text: "", ms: Date.now() - started, error: err?.name === "TimeoutError" ? "no reply in time" : String(err?.message ?? err) };
  }
}

/**
 * Runs the drills. `product.errors()` (optional) returns the error lines the product's server printed so far.
 * Returns [{ id, name, pass, ms, status, why }].
 */
export async function runDrills({
  baseUrl,
  target,
  fake,
  hole,
  product = null,
  hangMaxMs = 15_000,
  only = null,
  all = false,
  cloudLimitMs = 10_000,
  edgeLimitMs = 5_000,
  slowMs = 8_000,
  dnsBase = null,
  log = () => {},
}) {
  const drills = [
    {
      id: 1,
      name: "cloud refused",
      hole: "refuse",
      edge: "ok",
      check: (r, ctx) =>
        r.status >= 200 && r.status < 300
          ? r.text.includes(EDGE_LABEL_PHRASE)
            ? !ctx.edgeAsked
              ? "the reply has the label but the fake edge got no request"
              : !ctx.cloudAsked
                ? NO_CLOUD_TRY
                : null
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
              : !ctx.cloudAsked
                ? NO_CLOUD_TRY
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
    ...moreDrills({ hangMaxMs, cloudLimitMs, edgeLimitMs, slowMs }),
  ].filter((d) => (only ? only.includes(d.id) : all || DEFAULT_DRILL_IDS.includes(d.id)));

  const results = [];
  for (const d of drills) {
    hole.setMode(d.hole, d.holeOptions);
    fake.setMode(d.edge, d.edgeOptions);
    let url = baseUrl;
    if (d.dns) {
      try {
        url = dnsBase ? await dnsBase() : null;
      } catch (err) {
        url = null;
        d.setupWhy = `couldn't start the product with a gateway host that can't be resolved: ${err?.message ?? err}`;
      }
      if (!url) {
        const why = d.setupWhy ?? "needs a product whose GATEWAY_URL names a host that can't be resolved: run with --start, or set EDGE_DRILL_DNS_BASE_URL";
        results.push({ id: d.id, name: d.name, about: d.about, pass: false, ms: 0, status: 0, why });
        log(`FAIL ${d.id}. ${d.name} (0.0 s): ${why}`);
        continue;
      }
    }
    const rounds = [];
    for (let i = 0; i < (d.asks ?? 1); i++) {
      const asked = fake.requests.length;
      const holeBefore = hole.connections;
      const holeRequests = hole.requests ?? 0;
      const holeAnswered = hole.answered ?? 0;
      const hits = fake.injectedHits ?? 0;
      const errorsBefore = product?.errors().length ?? 0;
      const r = await ask(url, target, d.timeoutMs ?? 40_000);
      // Give the server a moment to print anything it prints after replying.
      await new Promise((res) => setTimeout(res, 200));
      const ctx = {
        edgeAsked: fake.requests.length > asked,
        cloudAsked: hole.connections > holeBefore,
        cloudRequested: (hole.requests ?? 0) > holeRequests,
        cloudAnswered: (hole.answered ?? 0) > holeAnswered,
        injectedHits: (fake.injectedHits ?? 0) - hits,
        errors: product ? product.errors().slice(errorsBefore) : [],
      };
      rounds.push({ r, ctx });
    }
    const why = d.asks ? d.checkAll(rounds) : d.check(rounds[0].r, rounds[0].ctx);
    const ms = rounds.reduce((sum, x) => sum + x.r.ms, 0);
    const last = rounds[rounds.length - 1].r;
    const result = { id: d.id, name: d.name, ...(d.about ? { about: d.about } : {}), pass: !why, ms, status: last.status, why: why ?? null };
    results.push(result);
    log(`${result.pass ? "PASS" : "FAIL"} ${d.id}. ${d.name} (${(ms / 1000).toFixed(1)} s)${why ? `: ${why}` : ""}`);
  }
  return results;
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const bad = (r) => (r.status === 0 ? `no reply (${r.error})` : `status ${r.status}${r.error ? ` (${r.error})` : ""}`);
const ok2xx = (r) => r.status >= 200 && r.status < 300;

/** Every string in a parsed JSON reply, keys apart. */
function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** Why the injected text wasn't kept as data, or null when it was. */
function injectedAsData(r) {
  if (/json/i.test(r.type)) {
    let parsed;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      return "the reply says it is JSON but doesn't parse";
    }
    if (!stringsIn(parsed).some((s) => s.includes(INJECT_MARK))) return "the injected text sits outside a JSON string value";
    return null;
  }
  if (/<script>\s*INJECTED/i.test(r.text)) return "the injected <script> tag reached the page unescaped";
  return null;
}

/** The six scenarios --all adds. Each has a name, a one-line plain description and a pass rule. */
function moreDrills({ hangMaxMs, cloudLimitMs, edgeLimitMs, slowMs }) {
  const bothLimitMs = cloudLimitMs + edgeLimitMs + 3_000;
  return [
    {
      id: 5,
      name: "cloud slow, inside the limit",
      about: `Simulated: the gateway answers after ${secs(slowMs)}, inside the ${secs(cloudLimitMs)} cloud limit.`,
      hole: "slow",
      holeOptions: { delayMs: slowMs },
      edge: "ok",
      timeoutMs: cloudLimitMs + 5_000,
      check: (r, ctx) =>
        !ok2xx(r)
          ? bad(r)
          : ctx.edgeAsked || r.text.includes(EDGE_LABEL_PHRASE)
            ? "the product fell back to the edge although the cloud answered inside its limit"
            : !r.text.includes(CLOUD_LABEL_PHRASE)
              ? `the reply has no "${CLOUD_LABEL_PHRASE}" label`
              : !ctx.cloudAnswered
                ? "the reply says the cloud answered, but the gateway sent no answer"
                : null,
    },
    {
      id: 6,
      name: "cloud flapping",
      about: "Simulated: three asks while the gateway answers 503, then OK, then 503.",
      hole: "flap",
      edge: "ok",
      asks: 3,
      timeoutMs: hangMaxMs + 5_000,
      checkAll: (rounds) => {
        for (const [i, { r, ctx }] of rounds.entries()) {
          const n = `answer ${i + 1} of ${rounds.length}`;
          if (!ok2xx(r)) return `${n}: ${bad(r)}`;
          if (r.ms > hangMaxMs) return `${n} took ${secs(r.ms)}, over ${secs(hangMaxMs)}`;
          const edgeSaid = r.text.includes(EDGE_LABEL_PHRASE);
          const cloudSaid = r.text.includes(CLOUD_LABEL_PHRASE);
          if (ctx.edgeAsked && (!edgeSaid || cloudSaid)) return `${n} came from the edge but its label doesn't say so`;
          if (!ctx.edgeAsked && ctx.cloudAnswered && (!cloudSaid || edgeSaid)) return `${n} came from the cloud but its label doesn't say so`;
          if (!ctx.edgeAsked && !ctx.cloudAnswered) return `${n}: neither the cloud nor the edge answered, but the reply is a success`;
        }
        if (!rounds.some((x) => !x.ctx.edgeAsked && x.ctx.cloudAnswered)) return "the cloud never answered: the product didn't try the gateway again after a 503";
        if (!rounds.some((x) => x.ctx.edgeAsked)) return "the edge never answered, though the gateway sent 503";
        return null;
      },
    },
    {
      id: 7,
      name: "edge too slow as well",
      about: `Simulated: the gateway hangs and the edge answers only after ${secs(edgeLimitMs + 3_000)}, past its ${secs(edgeLimitMs)} limit.`,
      hole: "hang",
      edge: "slow",
      edgeOptions: { delayMs: edgeLimitMs + 3_000 },
      timeoutMs: bothLimitMs + 5_000,
      check: (r, ctx) =>
        r.status === 0
          ? `no reply (${r.error})`
          : r.text.includes(EDGE_LABEL_PHRASE)
            ? "the product waited past its edge limit and showed the late answer"
            : !r.text.includes(BOTH_DOWN_PHRASE)
              ? "the reply has no plain both-down message"
              : !ctx.cloudAsked || !ctx.edgeAsked
                ? `the product didn't try ${!ctx.cloudAsked ? "the cloud" : "the edge"}`
                : r.ms > bothLimitMs
                  ? `the both-down message took ${secs(r.ms)}, over ${secs(bothLimitMs)} (both limits plus 3 s)`
                  : ctx.errors.length
                    ? `the server printed an error: ${ctx.errors[0].slice(0, 160)}`
                    : null,
    },
    {
      id: 8,
      name: "truncated reply rejected",
      about: "Simulated: the gateway drops and the edge reply is cut off part way through its JSON.",
      hole: "refuse",
      edge: "truncate",
      check: (r, ctx) =>
        r.status === 0
          ? `no reply (${r.error})`
          : r.text.includes(TRUNCATE_MARK)
            ? "part of the truncated reply reached the page"
            : !ctx.edgeAsked
              ? "the fake edge got no request"
              : r.text.includes(EDGE_LABEL_PHRASE)
                ? "the reply claims an edge answer, but the only edge reply was cut off"
                : !r.text.includes(BOTH_DOWN_PHRASE)
                  ? "the reply has no plain both-down message"
                  : null,
    },
    {
      id: 9,
      name: "injected text shown as data",
      about: "Simulated: the gateway drops and the edge reply's free text tells the product to ignore its rules.",
      hole: "refuse",
      edge: "inject",
      check: (r, ctx) =>
        !ok2xx(r)
          ? bad(r)
          : !ctx.edgeAsked
            ? "the fake edge got no request"
            : ctx.injectedHits > 0
              ? "the product fetched the URL the injected text asked for"
              : !r.text.includes(EDGE_LABEL_PHRASE) || r.text.includes(CLOUD_LABEL_PHRASE)
                ? "the label no longer says the edge answered"
                : !r.text.includes(INJECT_MARK)
                  ? "the injected text never reached the reply, so this drill can't tell how it is shown"
                  : injectedAsData(r),
    },
    {
      id: 10,
      name: "gateway host not found",
      about: `Simulated: the gateway's host name (${DNS_DRILL_HOST}) can't be resolved.`,
      dns: true,
      hole: "refuse",
      edge: "ok",
      check: (r, ctx) =>
        !ok2xx(r)
          ? bad(r)
          : !r.text.includes(EDGE_LABEL_PHRASE)
            ? `the reply has no "${EDGE_LABEL_PHRASE}" label`
            : !ctx.edgeAsked
              ? "the reply has the label but the fake edge got no request"
              : ctx.cloudAsked
                ? "the gateway was reached, so the host name did resolve: this product isn't the one started for the DNS drill"
                : null,
    },
  ];
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
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    child,
    errors: () => errors,
    stop: () => child.kill("SIGTERM"),
    /** Stops it and waits for it to exit, with SIGKILL after 10 s. */
    async stopAndWait() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** True once nothing answers at baseUrl, so a restarted product can't be confused with the old one. */
async function waitDown(baseUrl, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
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
    if (argv[i] === "--all") {
      out.all = true;
      continue;
    }
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
  const limits = {
    cloudLimitMs: Number(process.env.EDGE_DRILL_CLOUD_LIMIT_MS || 10_000),
    edgeLimitMs: Number(process.env.EDGE_DRILL_EDGE_LIMIT_MS || 5_000),
    slowMs: Number(process.env.EDGE_DRILL_SLOW_MS || 8_000),
  };
  // Only a run past the default set changes the product's env, so the default set runs exactly as it always has.
  const beyondDefault = flags.only ? flags.only.some((id) => !DEFAULT_DRILL_IDS.includes(id)) : !!flags.all;
  const productEnv = {
    GATEWAY_URL: hole.url,
    EDGE_URL: fake.url,
    PRODUCT_TOKEN: process.env.PRODUCT_TOKEN || "drill",
    ...(beyondDefault ? { EDGE_TIMEOUT_MS: String(limits.edgeLimitMs), EDGE_CLOUD_TIMEOUT_MS: String(limits.cloudLimitMs) } : {}),
  };
  /** Drill 10's product: the same one, restarted with a gateway host that can't be resolved. It runs last. */
  const dnsBase = flags.start
    ? async () => {
        await product.stopAndWait();
        if (!(await waitDown(baseUrl, 15_000))) throw new Error(`the product kept answering at ${baseUrl} after it was stopped`);
        const nodeOptions = [process.env.NODE_OPTIONS, noDnsImport()].filter(Boolean).join(" ");
        const next = startProduct(flags.start, baseUrl, { ...productEnv, GATEWAY_URL: `http://${DNS_DRILL_HOST}:${hole.port}`, NODE_OPTIONS: nodeOptions });
        const before = product.errors();
        product = { ...next, errors: () => [...before, ...next.errors()] };
        if (!(await waitUp(baseUrl, 60_000))) throw new Error(`the product never answered at ${baseUrl} after the restart`);
        return baseUrl;
      }
    : process.env.EDGE_DRILL_DNS_BASE_URL?.trim()
      ? async () => process.env.EDGE_DRILL_DNS_BASE_URL.trim()
      : null;
  try {
    if (flags.start) {
      product = startProduct(flags.start, baseUrl, productEnv);
      if (!(await waitUp(baseUrl, 60_000))) throw new SetupError(`The product never answered at ${baseUrl}.`);
    }
    console.log(`Simulated outage drills against ${baseUrl}${target.path}. GATEWAY_URL=${hole.url} EDGE_URL=${fake.url}`);
    const results = await runDrills({
      baseUrl,
      target,
      fake,
      hole,
      // A view that follows the product across drill 10's restart.
      product: product ? { errors: () => product.errors() } : null,
      hangMaxMs: Number(process.env.EDGE_DRILL_HANG_MAX_MS || 15_000),
      only: flags.only ?? null,
      all: !!flags.all,
      ...limits,
      dnsBase,
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
