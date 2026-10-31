// The spike's metering proxy on 127.0.0.1:8787, run as root by run.ts. It stands in for the platform gateway: Muse Code's
// endpoint_transport points here, with a random stand-in as its key. Only this process holds the sandbox placeholder, which
// the build firewall swaps for the real key on Muse Code's routes. Logs one JSON line per request to /tmp/out/proxy.jsonl:
// method, path, a few body fields and Meta's reported usage. Never a header value, a key or any body text.
// /tmp/proxy-mode, read per request: "refuse" (default) answers model calls 403 and forwards only the free catalog route;
// "forward" also forwards POST /v1/responses for ALLOWED_MODEL with the stand-in, until PROXY_BUDGET_USD is spent.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

const ALLOWED_MODEL = "muse-spark-1.3-contributor";
const PRICE = { input: 0.1, cachedInput: 0.002, output: 0.2 }; // lib/meta/pricing.ts, dollars per million tokens.
const LOG = "/tmp/out/proxy.jsonl";
const KEY = process.env.SPIKE_UPSTREAM_KEY ?? "";
const STANDIN_SHA = process.env.SPIKE_STANDIN_SHA ?? "";
const BUDGET = Number(process.env.PROXY_BUDGET_USD ?? 0);
const FREE_ROUTES = new Set(["/muse-code/models", "/v1/models"]);
let spent = 0;
let seq = 0;
mkdirSync("/tmp/out", { recursive: true });

const mode = () => {
  try {
    return readFileSync("/tmp/proxy-mode", "utf8").trim() || "refuse";
  } catch {
    return "refuse";
  }
};
const label = () => {
  try {
    return readFileSync("/tmp/proxy-label", "utf8").trim();
  } catch {
    return "";
  }
};
const log = (o) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), label: label(), ...o })}\n`);

function decode(buf, enc) {
  if (!enc || enc === "identity") return buf;
  if (enc === "gzip") return zlib.gunzipSync(buf);
  if (enc === "br") return zlib.brotliDecompressSync(buf);
  if (enc === "deflate") return zlib.inflateSync(buf);
  if (enc === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  throw new Error(`can't read ${enc}`);
}

function authKind(req) {
  const a = req.headers.authorization;
  if (!a) return "none";
  return createHash("sha256").update(a.replace(/^Bearer\s+/i, "")).digest("hex") === STANDIN_SHA ? "standin" : "other";
}

function costOf(u) {
  const input = u?.input_tokens ?? 0;
  const cached = Math.min(u?.input_tokens_details?.cached_tokens ?? 0, input);
  const output = u?.output_tokens ?? 0;
  return ((input - cached) * PRICE.input + cached * PRICE.cachedInput + output * PRICE.output) / 1e6;
}

function refuse(res, entry, status, why) {
  log({ ...entry, forwarded: false, status, refused: why });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `spike proxy: ${why}`, code: why, type: "spike_proxy" } }));
}

function forward(req, res, raw, entry) {
  const started = Date.now();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!["host", "authorization", "connection", "accept-encoding", "transfer-encoding", "content-length"].includes(k)) headers[k] = v;
  }
  headers.host = "api.meta.ai";
  headers.authorization = `Bearer ${KEY}`;
  headers["accept-encoding"] = "identity";
  if (raw.length) headers["content-length"] = String(raw.length);
  return new Promise((resolve) => {
    const up = https.request({ host: "api.meta.ai", port: 443, path: entry.upstream, method: req.method, headers }, (ur) => {
      const ct = String(ur.headers["content-type"] ?? "");
      const sse = ct.includes("event-stream");
      res.writeHead(ur.statusCode ?? 502, Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !["connection", "transfer-encoding"].includes(k))));
      let tail = "";
      let whole = "";
      let usage = null;
      let respModel = null;
      let bytes = 0;
      const scan = (line) => {
        if (!line.startsWith("data:") || !line.includes('"usage"')) return;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          const r = ev.response ?? ev;
          if (r?.usage) {
            usage = r.usage;
            respModel = r.model ?? respModel;
          }
        } catch {
          // Not a whole event.
        }
      };
      ur.on("data", (chunk) => {
        bytes += chunk.length;
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
            const j = JSON.parse(whole);
            if (j.usage) {
              usage = j.usage;
              respModel = j.model ?? respModel;
            }
          } catch {
            // Not JSON.
          }
        }
        const cost = usage ? costOf(usage) : 0;
        spent += cost;
        log({
          ...entry,
          forwarded: true,
          status: ur.statusCode,
          // An error's own text, which names the reason. run.ts scans everything copied out for credentials.
          ...((ur.statusCode ?? 0) >= 400 ? { errBody: whole.slice(0, 200) } : {}),
          ms: Date.now() - started,
          bytes,
          respModel,
          usage: usage ? { input: usage.input_tokens ?? 0, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens ?? 0 } : null,
          costUsd: Number(cost.toFixed(6)),
          spentUsd: Number(spent.toFixed(6)),
        });
        res.end();
        resolve();
      });
      ur.on("error", (e) => {
        log({ ...entry, forwarded: true, upstreamError: String(e).slice(0, 200) });
        res.destroy();
        resolve();
      });
    });
    up.on("error", (e) => {
      log({ ...entry, forwarded: false, upstreamError: String(e).slice(0, 200) });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("spike proxy: upstream failed");
      resolve();
    });
    if (raw.length) up.write(raw);
    up.end();
  });
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname === "/__health") {
          res.end(JSON.stringify({ ok: true, keyHeld: Boolean(KEY), mode: mode(), budget: BUDGET, spent }));
          return;
        }
        // Muse Code asks for its catalog at the host root; /v1/muse-code/models is the same route under a prefix.
        const p = url.pathname === "/v1/muse-code/models" ? "/muse-code/models" : url.pathname;
        const entry = { n: ++seq, method: req.method, path: url.pathname, upstream: `${p}${url.search}`, size: raw.length, auth: authKind(req), mode: mode() };
        let body = null;
        if (raw.length && String(req.headers["content-type"] ?? "").includes("json")) {
          try {
            body = JSON.parse(decode(raw, String(req.headers["content-encoding"] ?? "")).toString("utf8"));
            Object.assign(entry, {
              model: body.model ?? null,
              stream: body.stream ?? null,
              tools: Array.isArray(body.tools) ? body.tools.length : null,
              effort: body.reasoning?.effort ?? null,
              inputItems: Array.isArray(body.input) ? body.input.length : null,
              instrLen: typeof body.instructions === "string" ? body.instructions.length : 0,
            });
          } catch (e) {
            entry.bodyError = String(e).slice(0, 120);
          }
        }
        if (entry.auth === "none") return refuse(res, entry, 401, "auth_none");
        if (FREE_ROUTES.has(p) && (req.method === "GET" || (req.method === "POST" && p === "/muse-code/models"))) return forward(req, res, raw, entry);
        if (req.method !== "POST" || p !== "/v1/responses") return refuse(res, entry, 403, "route_refused");
        if (!body) return refuse(res, entry, 400, "body_unreadable");
        if (body.model !== ALLOWED_MODEL) return refuse(res, entry, 403, "model_refused");
        if (entry.mode !== "forward") return refuse(res, entry, 403, "mode_refuse");
        if (spent >= BUDGET) return refuse(res, entry, 403, "budget_refused");
        return forward(req, res, raw, entry);
      })().catch((e) => {
        log({ path: req.url, proxyError: String(e).slice(0, 200) });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  })
  .listen(8787, "127.0.0.1", () => log({ event: "listening", keyHeld: Boolean(KEY), budget: BUDGET, extraCa: Boolean(process.env.NODE_EXTRA_CA_CERTS) }));
