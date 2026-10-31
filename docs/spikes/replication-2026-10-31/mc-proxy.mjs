// The Muse Code phase's metering proxy on 127.0.0.1:8787, run as root. It stands in for the platform gateway: Muse Code holds a
// stand-in key, and only this process holds the sandbox's placeholder, which the firewall swaps for the real key on api.meta.ai.
// It forwards two things only: the catalog (GET or POST /muse-code/models) and POST /v1/responses for muse-spark-1.3-contributor,
// until PROXY_BUDGET_USD of Meta's reported usage is spent. Everything else gets a 403. It logs one JSON line per request to
// /tmp/out/proxy.jsonl: method, path, model, status, usage and cost. Never a header, a key or a body.
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const MODEL = "muse-spark-1.3-contributor";
const PRICE = { input: 0.1, cachedInput: 0.002, output: 0.2 }; // lib/meta/pricing.ts, dollars per million tokens
const UPSTREAM_KEY = process.env.REP_UPSTREAM_KEY ?? "";
const STANDIN_SHA = Buffer.from(process.env.REP_STANDIN_SHA ?? "", "hex");
const BUDGET = Number(process.env.PROXY_BUDGET_USD ?? 0);
const LOG = "/tmp/out/proxy.jsonl";
let spent = 0;
let seq = 0;
mkdirSync("/tmp/out", { recursive: true });
const log = (o) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...o })}\n`);

function holdsStandIn(req) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const got = createHash("sha256").update(token).digest();
  return STANDIN_SHA.length === got.length && timingSafeEqual(got, STANDIN_SHA);
}

function costOf(u) {
  const input = u?.input_tokens ?? 0;
  const cached = Math.min(u?.input_tokens_details?.cached_tokens ?? 0, input);
  const output = u?.output_tokens ?? 0;
  return ((input - cached) * PRICE.input + cached * PRICE.cachedInput + output * PRICE.output) / 1e6;
}

function refuse(res, entry, why) {
  log({ ...entry, forwarded: false, refused: why });
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `replication spike proxy: ${why}`, code: why } }));
}

function forward(req, res, raw, entry) {
  const started = Date.now();
  const headers = { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*", "accept-encoding": "identity", authorization: `Bearer ${UPSTREAM_KEY}` };
  for (const k of Object.keys(req.headers)) if (k.startsWith("x-") || k.startsWith("openai-")) headers[k] = req.headers[k];
  if (raw.length) headers["content-length"] = String(raw.length);
  const up = https.request({ host: "api.meta.ai", port: 443, path: entry.path, method: req.method, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, { "content-type": ur.headers["content-type"] ?? "application/octet-stream" });
    const sse = String(ur.headers["content-type"] ?? "").includes("event-stream");
    let tail = "";
    let whole = "";
    let usage = null;
    const scan = (line) => {
      if (!line.startsWith("data:") || !line.includes('"usage"')) return;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        const r = ev.response ?? ev;
        if (r?.usage) usage = r.usage;
      } catch {
        // Not a whole event.
      }
    };
    ur.on("data", (chunk) => {
      res.write(chunk);
      const text = chunk.toString("utf8");
      if (sse) {
        tail += text;
        const lines = tail.split("\n");
        tail = lines.pop() ?? "";
        for (const l of lines) scan(l);
      } else if (whole.length < 4_000_000) whole += text;
    });
    ur.on("end", () => {
      if (tail) scan(tail);
      if (!sse && whole) {
        try {
          usage = JSON.parse(whole).usage ?? usage;
        } catch {
          // Not JSON.
        }
      }
      const cost = usage ? costOf(usage) : 0;
      spent += cost;
      log({ ...entry, forwarded: true, status: ur.statusCode, ms: Date.now() - started, usage: usage ? { input: usage.input_tokens ?? 0, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens ?? 0 } : null, costUsd: Number(cost.toFixed(6)), spentUsd: Number(spent.toFixed(6)) });
      res.end();
    });
  });
  up.on("error", (e) => {
    log({ ...entry, forwarded: false, upstreamError: String(e).slice(0, 160) });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  if (raw.length) up.write(raw);
  up.end();
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const entry = { n: ++seq, method: req.method, path: url.pathname + url.search, size: raw.length };
      if (url.pathname === "/__health") return res.end(JSON.stringify({ ok: true, budget: BUDGET, spent }));
      if (!holdsStandIn(req)) return refuse(res, entry, "no_standin");
      if (url.pathname === "/muse-code/models" && (req.method === "GET" || req.method === "POST")) return forward(req, res, raw, entry);
      if (url.pathname !== "/v1/responses" || req.method !== "POST") return refuse(res, entry, "route_refused");
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return refuse(res, entry, "not_json");
      }
      entry.model = body.model ?? null;
      entry.stream = body.stream ?? null;
      entry.effort = body.reasoning?.effort ?? null;
      if (body.model !== MODEL) return refuse(res, entry, "model_refused");
      if (spent >= BUDGET) return refuse(res, entry, "budget_refused");
      return forward(req, res, raw, entry);
    });
  })
  .listen(8787, "127.0.0.1", () => log({ event: "listening", budget: BUDGET, keyHeld: Boolean(UPSTREAM_KEY) }));
