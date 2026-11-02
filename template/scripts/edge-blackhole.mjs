#!/usr/bin/env node
/**
 * A blackhole that stands in for the Muse Muse gateway during an outage drill: point a product's GATEWAY_URL at it and
 * every cloud call fails the way a cut network does. In refuse and hang modes it never answers a request. In slow and
 * flap modes it answers like the gateway with Simulated JSON built from the request's own schema. It never calls
 * anything.
 *
 * CLI:
 *   node scripts/edge-blackhole.mjs [--port 18436] [--host 127.0.0.1] [--mode refuse|hang|slow|flap] [--log <file>]
 *
 * Env (a flag wins over its env):
 *   EDGE_BLACKHOLE_PORT  default 18436
 *   EDGE_BLACKHOLE_HOST  default 127.0.0.1. Keep it on loopback.
 *   EDGE_BLACKHOLE_MODE  default refuse
 *   EDGE_BLACKHOLE_LOG   default test-results/caps/blackhole.json, relative to the working directory
 *
 * Modes:
 *   refuse  accepts each connection and drops it at once (the SDK sees a connection error)
 *   hang    accepts each connection and never sends a byte (the caller's own timeout must end it)
 *   slow    answers each request with schema-valid Simulated JSON, after delayMs (default 8000)
 *   flap    answers 503, then schema-valid Simulated JSON, then 503, and so on, starting again at 503 on each setMode
 *
 * Answers carry "connection: close", and every held or kept-alive connection ends when the mode changes, so each
 * drill starts clean.
 *
 * The log is { mode, connections, requests, answered }, rewritten on every connection and request, so a drill can show
 * the product tried the cloud and whether the cloud answered.
 *
 * Exit codes: 0 on SIGINT or SIGTERM, 2 on a bad flag or a port it can't bind.
 *
 * As a module: startBlackhole({ port, host, mode, log }) resolves to { url, port, setMode(mode, { delayMs }), mode,
 * connections, requests, answered, close }. port 0 picks a free port. url has no /v1, ready for GATEWAY_URL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chatReply, responsesReply, sampleFromSchema } from "./edge-fake.mjs";

export const BLACKHOLE_MODES = ["refuse", "hang", "slow", "flap"];
export const DEFAULT_BLACKHOLE_PORT = 18436;
/** How long slow mode waits before it answers, unless setMode says otherwise: inside the 10 s cloud deadline. */
export const DEFAULT_CLOUD_SLOW_MS = 8_000;

/** The schema a gateway request asks for, from either API. */
function schemaOf(route, body) {
  const f = route.endsWith("/chat/completions") ? body?.response_format : body?.text?.format;
  if (f?.type !== "json_schema") return null;
  return (route.endsWith("/chat/completions") ? f.json_schema?.schema : f.schema) ?? null;
}

export function startBlackhole(options = {}) {
  let mode = options.mode ?? "refuse";
  if (!BLACKHOLE_MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use one of ${BLACKHOLE_MODES.join(", ")}.`);
  const logFile = options.log === null ? null : path.resolve(options.log ?? "test-results/caps/blackhole.json");
  const sockets = new Set();
  const timers = new Set();
  let connections = 0;
  let requests = 0;
  let answered = 0;
  let delayMs = DEFAULT_CLOUD_SLOW_MS;
  /** Requests seen in flap mode since the last setMode. */
  let flapCount = 0;

  const writeLog = () => {
    if (!logFile) return;
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      writeFileSync(logFile, JSON.stringify({ mode, connections, requests, answered }) + "\n");
    } catch {
      // A log that can't be written never stops a drill.
    }
  };

  const server = createServer((req, res) => {
    requests++;
    writeLog();
    // A connection kept alive from an answer mode still gets the current mode.
    if (mode === "refuse") return req.socket.destroy();
    // hang: read and ignore everything.
    if (mode === "hang") return req.resume();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const route = (req.url ?? "/").split("?")[0];
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      } catch {
        body = null;
      }
      const send = (status, json) => {
        if (req.socket.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify(json));
      };
      if (mode === "flap" && flapCount++ % 2 === 0) {
        return send(503, { error: { message: "Simulated outage: the gateway is overloaded." } });
      }
      const answer = () => {
        if (req.socket.destroyed) return;
        const schema = schemaOf(route, body);
        const text = schema ? JSON.stringify(sampleFromSchema(schema)) : "Simulated cloud reply.";
        const model = body?.model ?? "muse-wonder-1.0";
        if (route.endsWith("/v1/responses")) send(200, responsesReply(model, text));
        else if (route.endsWith("/v1/chat/completions")) send(200, chatReply(model, text));
        else return send(404, { error: { message: `No route ${req.method} ${route}` } });
        answered++;
        writeLog();
      };
      if (mode === "flap") return answer();
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, delayMs);
      timers.add(timer);
    });
  });
  server.on("connection", (socket) => {
    connections++;
    writeLog();
    socket.on("error", () => {});
    if (mode === "refuse") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const endAll = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const s of sockets) s.destroy();
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_BLACKHOLE_PORT, options.host ?? "127.0.0.1", () => {
      const { port, address } = server.address();
      resolve({
        url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
        port,
        get mode() {
          return mode;
        },
        get connections() {
          return connections;
        },
        get requests() {
          return requests;
        },
        get answered() {
          return answered;
        },
        setMode(next, opts = {}) {
          if (!BLACKHOLE_MODES.includes(next)) throw new Error(`Unknown mode "${next}".`);
          mode = next;
          delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : DEFAULT_CLOUD_SLOW_MS;
          flapCount = 0;
          // Connections held by a hang end when the mode changes, so the next drill starts clean.
          endAll();
        },
        close() {
          endAll();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=", 2);
    const value = inline ?? argv[++i];
    if (key === "--port") out.port = Number(value);
    else if (key === "--host") out.host = value;
    else if (key === "--mode") out.mode = value;
    else if (key === "--log") out.log = value;
    else throw new Error(`Unknown flag ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const flags = parseFlags(process.argv.slice(2));
    const hole = await startBlackhole({
      port: flags.port ?? Number(process.env.EDGE_BLACKHOLE_PORT || DEFAULT_BLACKHOLE_PORT),
      host: flags.host ?? (process.env.EDGE_BLACKHOLE_HOST || "127.0.0.1"),
      mode: flags.mode ?? (process.env.EDGE_BLACKHOLE_MODE || "refuse"),
      log: flags.log ?? (process.env.EDGE_BLACKHOLE_LOG || "test-results/caps/blackhole.json"),
    });
    console.log(`Blackhole gateway at ${hole.url}, mode ${hole.mode}. Set GATEWAY_URL=${hole.url}`);
    const stop = () => hole.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (err) {
    console.log(`edge-blackhole: ${err.message}`);
    process.exit(2);
  }
}
