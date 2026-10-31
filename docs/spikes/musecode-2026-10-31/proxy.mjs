// The spike's recording proxy, on 127.0.0.1:8787, as root. It logs one JSON line per request: method, path, selected body fields
// and the usage Meta reported. Never a header value, a key or a body. It stands in for the platform gateway.
// The mode in /tmp/proxy-mode, read per request:
//   refuse   answer everything 403 and forward nothing (the default)
//   catalog  forward the catalog routes only
//   forward  also forward model calls, only for ALLOWED_MODEL, until PROXY_BUDGET_USD has been spent
//   nocatalog  as forward, but the catalog routes are answered 403
//   hang     hold model calls open and never answer, for the stop test. Free.
// Upstream calls skip /etc/hosts (the sink owns api.meta.ai there), and carry SPIKE_UPSTREAM_KEY, which the firewall swaps.
import { createHash } from "node:crypto";
import { promises as dnsp } from "node:dns";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

const ALLOWED_MODEL = "muse-spark-1.3-contributor";
const PRICE = { input: 0.1, cachedInput: 0.002, output: 0.2 }; // lib/meta/pricing.ts, per million tokens.
const LOG = "/tmp/out/proxy.jsonl";
const KEY = process.env.SPIKE_UPSTREAM_KEY ?? "";
const STANDIN_SHA = process.env.SPIKE_STANDIN_SHA ?? "";
const BUDGET = Number(process.env.PROXY_BUDGET_USD ?? 0);
const CATALOG = new Set(["/muse-code/models", "/v1/models", "/v1/muse-code/models"]);
let spent = 0;
let seq = 0;
mkdirSync("/tmp/out", { recursive: true });

const readFile = (f, d) => {
  try {
    return readFileSync(f, "utf8").trim() || d;
  } catch {
    return d;
  }
};
const log = (o) => {
  try {
    appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), label: readFile("/tmp/proxy-label", ""), ...o })}\n`);
  } catch {
    // Nothing to tell.
  }
};
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

function decode(buf, encoding) {
  if (!encoding || encoding === "identity") return buf;
  if (encoding === "gzip") return zlib.gunzipSync(buf);
  if (encoding === "br") return zlib.brotliDecompressSync(buf);
  if (encoding === "deflate") return zlib.inflateSync(buf);
  if (encoding === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  throw new Error(`can't read ${encoding}`);
}

/** The selected fields only: nothing of the text, and only a hash of the instructions so calls of one kind can be grouped. */
function fieldsOf(body) {
  const input = body.input;
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  const keys = Object.keys(body).sort();
  return {
    model: body.model ?? null,
    stream: body.stream ?? null,
    background: body.background ?? null,
    tools: Array.isArray(body.tools) ? body.tools.length : null,
    toolKinds: Array.isArray(body.tools) ? [...new Set(body.tools.map((t) => `${t.type ?? "?"}${t.name ? `:${t.name}` : ""}${Array.isArray(t.tools) ? `[${t.tools.length}]` : ""}`))].slice(0, 12) : null,
    effort: body.reasoning?.effort ?? null,
    inputItems: Array.isArray(input) ? input.length : typeof input === "string" ? 1 : null,
    prevResp: Boolean(body.previous_response_id),
    instrLen: instructions.length,
    instrSha: instructions ? hash(instructions) : null,
    maxOutput: body.max_output_tokens ?? null,
    store: body.store ?? null,
    safetyId: Boolean(body.safety_identifier),
    bodyKeys: keys,
  };
}

function authKind(req) {
  const a = req.headers.authorization;
  if (!a) return "none";
  const token = a.replace(/^Bearer\s+/i, "");
  return createHash("sha256").update(token).digest("hex") === STANDIN_SHA ? "standin" : "other";
}

async function upstreamAddress() {
  const [ip] = await dnsp.resolve4("api.meta.ai");
  return ip;
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

async function forward(req, res, raw, entry, upstreamPath) {
  const started = Date.now();
  const ip = await upstreamAddress();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "authorization", "connection", "accept-encoding", "transfer-encoding", "content-length"].includes(k)) continue;
    headers[k] = v;
  }
  headers.host = "api.meta.ai";
  headers.authorization = `Bearer ${KEY}`;
  headers["accept-encoding"] = "identity";
  if (raw.length) headers["content-length"] = String(raw.length);
  await new Promise((resolve) => {
    const up = https.request({ host: ip, servername: "api.meta.ai", port: 443, path: upstreamPath, method: req.method, headers }, (ur) => {
      const ct = String(ur.headers["content-type"] ?? "");
      const sse = ct.includes("event-stream");
      res.writeHead(ur.statusCode ?? 502, Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !["connection", "transfer-encoding"].includes(k))));
      let tail = "";
      let usage = null;
      let respModel = null;
      let firstByte = null;
      let bytes = 0;
      let whole = "";
      const scan = (line) => {
        if (!line.startsWith("data:") || !line.includes('"usage"')) return;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          const r = ev.response ?? ev;
          if (r?.usage && (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed" || !ev.type)) {
            usage = r.usage;
            respModel = r.model ?? respModel;
          }
        } catch {
          // Not a whole event.
        }
      };
      ur.on("data", (chunk) => {
        firstByte ??= Date.now();
        bytes += chunk.length;
        res.write(chunk);
        const text = chunk.toString("utf8");
        if (sse) {
          tail += text;
          const lines = tail.split("\n");
          tail = lines.pop() ?? "";
          for (const l of lines) scan(l);
        } else if (whole.length < 2_000_000) {
          whole += text;
        }
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
            if (j.background !== undefined) entry.respBackground = j.background;
            if (typeof j.status === "string") entry.respStatus = j.status;
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
          contentTypeOut: ct.split(";")[0],
          ms: Date.now() - started,
          ttfbMs: firstByte ? firstByte - started : null,
          bytes,
          respModel,
          usage: usage
            ? { input: usage.input_tokens ?? 0, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens ?? 0, reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0 }
            : null,
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

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      if (path === "/__health") {
        res.end(JSON.stringify({ ok: true, keyHeld: Boolean(KEY), mode: readFile("/tmp/proxy-mode", "refuse"), spent }));
        return;
      }
      const mode = readFile("/tmp/proxy-mode", "refuse");
      const ct = String(req.headers["content-type"] ?? "");
      const encoding = String(req.headers["content-encoding"] ?? "");
      const entry = { n: ++seq, method: req.method, path, query: url.search ? [...url.searchParams.keys()] : undefined, contentType: ct.split(";")[0] || null, encoded: encoding || undefined, size: raw.length, auth: authKind(req), mode };
      let body = null;
      if (raw.length && ct.includes("json")) {
        try {
          body = JSON.parse(decode(raw, encoding).toString("utf8"));
          Object.assign(entry, fieldsOf(body));
        } catch (e) {
          entry.bodyError = String(e).slice(0, 120);
        }
      }
      const upstreamPath = path === "/v1/muse-code/models" ? `/muse-code/models${url.search}` : `${path}${url.search}`;
      if (CATALOG.has(path) && req.method !== "PUT" && req.method !== "DELETE") {
        if (mode === "refuse" || mode === "nocatalog") return refuse(res, entry, 403, "mode_refuse");
        return forward(req, res, raw, entry, upstreamPath);
      }
      if (mode === "hang" && req.method === "POST") {
        log({ ...entry, forwarded: false, held: true });
        return;
      }
      if (mode !== "forward" && mode !== "nocatalog") return refuse(res, entry, 403, "mode_refuse");
      if (req.method === "POST" && body) {
        if (body.model !== ALLOWED_MODEL) return refuse(res, entry, 403, "model_refused");
        if (spent >= BUDGET) return refuse(res, entry, 403, "budget_refused");
        return forward(req, res, raw, entry, upstreamPath);
      }
      return refuse(res, entry, 403, "route_refused");
    })().catch((e) => {
      log({ path: req.url, proxyError: String(e).slice(0, 200) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
});
server.listen(8787, "127.0.0.1", () => log({ event: "listening", keyHeld: Boolean(KEY), budget: BUDGET, extraCa: Boolean(process.env.NODE_EXTRA_CA_CERTS) }));
