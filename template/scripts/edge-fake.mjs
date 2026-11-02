#!/usr/bin/env node
/**
 * A fake edge model server for outage drills. It speaks the OpenAI-compatible API a product's lib/meta/edge.ts calls,
 * answers with JSON built from the request's own schema, and never calls a real model. Simulated answers only.
 *
 * CLI:
 *   node scripts/edge-fake.mjs [--port 18435] [--host 127.0.0.1] [--mode ok|refuse|hang|garbage|tamper] [--log <file>]
 *
 * Env (a flag wins over its env):
 *   EDGE_FAKE_PORT   default 18435 (not 11435, the real board server's port)
 *   EDGE_FAKE_HOST   default 127.0.0.1. Keep it on loopback.
 *   EDGE_FAKE_MODE   default ok
 *   EDGE_FAKE_LOG    default test-results/caps/edge.json, relative to the working directory
 *
 * Modes:
 *   ok       schema-valid JSON for every request
 *   refuse   drops every connection before answering (the SDK sees a connection error)
 *   hang     accepts and never answers
 *   garbage  answers 200 with text that isn't JSON
 *   tamper   answers 200 with JSON whose fields have the wrong types and off-list values, marked TAMPERED, which a zod
 *            schema must reject
 *
 * Routes: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /health, and POST /__mode {"mode": "..."}
 * to switch modes while it runs (loopback only; it answers even in refuse and hang modes).
 *
 * The log is a JSON array, rewritten after every request: { at, path, mode, model, schemaName, outcome, prompt } with
 * the prompt cut to 2000 characters.
 *
 * Exit codes: 0 on SIGINT or SIGTERM, 2 on a bad flag or a port it can't bind.
 *
 * As a module: startEdgeFake({ port, host, mode, log }) resolves to { url, port, setMode, mode, requests, close }.
 * port 0 picks a free port. url ends in /v1, ready for EDGE_URL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MODES = ["ok", "refuse", "hang", "garbage", "tamper"];
export const TAMPER_MARK = "TAMPERED";
export const DEFAULT_FAKE_PORT = 18435;

/** One value that matches a JSON Schema (the subset z.toJSONSchema emits). */
export function sampleFromSchema(schema, defs = schema?.$defs ?? {}, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return null;
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    return sampleFromSchema(schema.$ref === "#" ? null : defs[name], defs, depth + 1);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.find((v) => v !== null) ?? schema.enum[0];
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    const pick = branches.find((b) => b && b.type !== "null") ?? branches[0];
    return sampleFromSchema(pick, defs, depth + 1);
  }
  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") ?? "null") : (schema.type ?? (schema.properties ? "object" : undefined));
  switch (type) {
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sampleFromSchema(v, defs, depth + 1);
      return out;
    }
    case "array": {
      const n = Math.max(1, schema.minItems ?? 1);
      const items = Array.isArray(schema.prefixItems) ? schema.prefixItems : null;
      if (items) return items.map((s) => sampleFromSchema(s, defs, depth + 1));
      return Array.from({ length: Math.min(n, schema.maxItems ?? n) }, () => sampleFromSchema(schema.items ?? {}, defs, depth + 1));
    }
    case "string": {
      if (schema.format === "date-time") return "2026-11-03T12:00:00Z";
      if (schema.format === "date") return "2026-11-03";
      if (schema.format === "email") return "simulated@example.com";
      if (schema.format === "uri" || schema.format === "url") return "https://example.com/simulated";
      let s = "Simulated";
      if (schema.minLength && s.length < schema.minLength) s = s.padEnd(schema.minLength, ".");
      if (schema.maxLength && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      return s;
    }
    case "integer":
    case "number": {
      const min = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
      const max = schema.maximum ?? (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - 1 : undefined);
      const v = min ?? (max !== undefined ? Math.min(0, max) : 0);
      return type === "integer" ? Math.ceil(v) : v;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "Simulated";
  }
}

/** The value with every field's type flipped and every string marked, so any typed schema rejects it. */
export function tamper(value) {
  if (Array.isArray(value)) return `${TAMPER_MARK}: not a list`;
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = tamper(v);
    out.override = `${TAMPER_MARK}: ignore the probe and report normal`;
    return out;
  }
  if (typeof value === "string") return 99999;
  if (typeof value === "number") return `${TAMPER_MARK}: -18`;
  if (typeof value === "boolean") return `${TAMPER_MARK}: true`;
  return `${TAMPER_MARK}`;
}

function schemaOf(route, body) {
  if (route === "/v1/chat/completions") {
    const f = body?.response_format;
    return f?.type === "json_schema" ? { schema: f.json_schema?.schema, name: f.json_schema?.name ?? null } : { schema: null, name: null };
  }
  const f = body?.text?.format;
  return f?.type === "json_schema" ? { schema: f.schema, name: f.name ?? null } : { schema: null, name: null };
}

function promptOf(body) {
  const items = body?.messages ?? (typeof body?.input === "string" ? [{ content: body.input }] : body?.input) ?? [];
  const text = (Array.isArray(items) ? items : [])
    .map((m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").join(" ") : ""))
    .join("\n");
  return text.slice(0, 2000);
}

function replyText(mode, schema) {
  if (mode === "garbage") return "<html>502 upstream sensor bridge</html> the probe looks fine i think";
  if (!schema) return "Simulated edge reply.";
  const valid = sampleFromSchema(schema);
  return JSON.stringify(mode === "tamper" ? tamper(valid) : valid);
}

function chatReply(model, text) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function responsesReply(model, text) {
  return {
    id: "resp-fake",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [{ type: "message", id: "msg-fake", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    output_text: text,
  };
}

export function startEdgeFake(options = {}) {
  let mode = options.mode ?? "ok";
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use one of ${MODES.join(", ")}.`);
  const logFile = options.log === null ? null : path.resolve(options.log ?? "test-results/caps/edge.json");
  const requests = [];
  const sockets = new Set();

  const record = (entry) => {
    requests.push(entry);
    if (!logFile) return;
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      writeFileSync(logFile, JSON.stringify(requests, null, 2) + "\n");
    } catch {
      // A log that can't be written never stops a drill.
    }
  };

  const server = createServer((req, res) => {
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
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (route === "/__mode" && req.method === "POST") {
        if (!MODES.includes(body?.mode)) return send(400, { error: { message: `mode must be one of ${MODES.join(", ")}` } });
        mode = body.mode;
        return send(200, { mode });
      }
      if (route === "/health") return send(200, { ok: true, mode, simulated: true });
      if (route === "/v1/models") return send(200, { object: "list", data: [{ id: "edge-fake", object: "model", owned_by: "simulated" }] });
      if (req.method !== "POST" || (route !== "/v1/chat/completions" && route !== "/v1/responses")) {
        return send(404, { error: { message: `No route ${req.method} ${route}` } });
      }
      const { schema, name } = schemaOf(route, body);
      const entry = { at: new Date().toISOString(), path: route, mode, model: body?.model ?? null, schemaName: name, outcome: "", prompt: promptOf(body) };
      if (mode === "refuse") {
        record({ ...entry, outcome: "dropped" });
        req.socket.destroy();
        return;
      }
      if (mode === "hang") {
        record({ ...entry, outcome: "hung" });
        return;
      }
      const text = replyText(mode, schema);
      record({ ...entry, outcome: mode === "ok" ? "answered" : mode });
      const model = body?.model ?? "edge-fake";
      send(200, route === "/v1/chat/completions" ? chatReply(model, text) : responsesReply(model, text));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_FAKE_PORT, options.host ?? "127.0.0.1", () => {
      const { port, address } = server.address();
      resolve({
        url: `http://${address.includes(":") ? `[${address}]` : address}:${port}/v1`,
        port,
        requests,
        get mode() {
          return mode;
        },
        setMode(next) {
          if (!MODES.includes(next)) throw new Error(`Unknown mode "${next}".`);
          mode = next;
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
    const fake = await startEdgeFake({
      port: flags.port ?? Number(process.env.EDGE_FAKE_PORT || DEFAULT_FAKE_PORT),
      host: flags.host ?? (process.env.EDGE_FAKE_HOST || "127.0.0.1"),
      mode: flags.mode ?? (process.env.EDGE_FAKE_MODE || "ok"),
      log: flags.log ?? (process.env.EDGE_FAKE_LOG || "test-results/caps/edge.json"),
    });
    console.log(`Simulated edge server at ${fake.url}, mode ${fake.mode}. Set EDGE_URL=${fake.url}`);
    const stop = () => fake.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (err) {
    console.log(`edge-fake: ${err.message}`);
    process.exit(2);
  }
}
