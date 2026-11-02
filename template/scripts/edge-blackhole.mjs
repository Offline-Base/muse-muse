#!/usr/bin/env node
/**
 * A blackhole that stands in for the Muse Muse gateway during an outage drill: point a product's GATEWAY_URL at it and
 * every cloud call fails the way a cut network does. It never answers a request and never calls anything.
 *
 * CLI:
 *   node scripts/edge-blackhole.mjs [--port 18436] [--host 127.0.0.1] [--mode refuse|hang] [--log <file>]
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
 *
 * The log is { mode, connections }, rewritten on every connection, so a drill can show the product tried the cloud.
 *
 * Exit codes: 0 on SIGINT or SIGTERM, 2 on a bad flag or a port it can't bind.
 *
 * As a module: startBlackhole({ port, host, mode, log }) resolves to { url, port, setMode, mode, connections, close }.
 * port 0 picks a free port. url has no /v1, ready for GATEWAY_URL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BLACKHOLE_MODES = ["refuse", "hang"];
export const DEFAULT_BLACKHOLE_PORT = 18436;

export function startBlackhole(options = {}) {
  let mode = options.mode ?? "refuse";
  if (!BLACKHOLE_MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use refuse or hang.`);
  const logFile = options.log === null ? null : path.resolve(options.log ?? "test-results/caps/blackhole.json");
  const sockets = new Set();
  let connections = 0;

  const server = createServer((socket) => {
    connections++;
    if (logFile) {
      try {
        mkdirSync(path.dirname(logFile), { recursive: true });
        writeFileSync(logFile, JSON.stringify({ mode, connections }) + "\n");
      } catch {
        // A log that can't be written never stops a drill.
      }
    }
    socket.on("error", () => {});
    if (mode === "refuse") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // hang: read and ignore everything.
    socket.resume();
  });

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
        setMode(next) {
          if (!BLACKHOLE_MODES.includes(next)) throw new Error(`Unknown mode "${next}".`);
          mode = next;
          // Connections held by a hang end when the mode changes, so the next drill starts clean.
          for (const s of sockets) s.destroy();
        },
        close() {
          for (const s of sockets) s.destroy();
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
