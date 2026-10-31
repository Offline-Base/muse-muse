#!/usr/bin/env node
// A command line tool for one Muse Muse product, generated from its musemuse.json. One file, no dependencies, Node 18+.
// Built with Muse Muse, a hackathon concept. Not an official Meta product.
"use strict";

const PRODUCT = /*__MUSE_PRODUCT__*/ { slug: "example", name: "Example", tagline: "", liveUrl: "http://localhost", mcpUrl: "", actions: [] };
const VERSION = "1.0.0";
const DEFAULT_TIMEOUT_S = 120;
const USAGE_ERROR = 2;
const CALL_ERROR = 1;

class UsageError extends Error {}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function err(text) {
  process.stderr.write(`${text}\n`);
}

/** recipeText and recipe-text both name the field recipeText. */
function flagKey(name) {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function findAction(name) {
  return PRODUCT.actions.find((a) => a.name === name || a.name === name.replace(/-/g, "_"));
}

function fieldsOf(action) {
  const props = action.input && typeof action.input.properties === "object" && action.input.properties ? action.input.properties : {};
  const required = Array.isArray(action.input && action.input.required) ? action.input.required : [];
  return Object.keys(props).map((name) => ({ name, schema: props[name] || {}, required: required.includes(name) }));
}

function typeOf(schema) {
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.type) return typeof schema.enum[0];
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") || "string" : schema.type || "string";
}

function fieldHint(field) {
  const type = typeOf(field.schema);
  const choices = Array.isArray(field.schema.enum) ? ` (${field.schema.enum.join(", ")})` : "";
  const about = field.schema.description ? `  ${field.schema.description}` : "";
  return `  --${field.name} <${type}>${choices}${field.required ? " required" : ""}${about}`;
}

function mainHelp() {
  const lines = [
    `${PRODUCT.name}${PRODUCT.tagline ? `: ${PRODUCT.tagline}` : ""}`,
    "",
    `Usage: ${PRODUCT.slug} <action> [--field value ...] [--json]`,
    "",
    "Actions:",
    ...PRODUCT.actions.map((a) => `  ${a.name}  ${a.description}`),
    "",
    "Options:",
    "  --help, -h          Show this help, or an action's fields after its name",
    "  --json              Print only JSON. With --help, the actions and their input schemas",
    "  --input <json>      The action's whole input as JSON. '-' reads it from stdin",
    "  --input-file <path> Read the action's input from a JSON file",
    `  --timeout <seconds> How long to wait for a reply (default ${DEFAULT_TIMEOUT_S})`,
    "  --version           Show the version",
    "",
    `It calls the live product at ${PRODUCT.liveUrl}`,
    "Built with Muse Muse. Not an official Meta product.",
  ];
  return lines.join("\n");
}

function actionHelp(action) {
  const fields = fieldsOf(action);
  const lines = [`${action.name}: ${action.description}`, "", `Usage: ${PRODUCT.slug} ${action.name}${fields.length ? " [--field value ...]" : ""} [--json]`];
  if (fields.length) lines.push("", "Fields:", ...fields.map(fieldHint));
  return lines.join("\n");
}

function coerce(field, raw) {
  const type = typeOf(field.schema);
  if (type === "number" || type === "integer") {
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) throw new UsageError(`--${field.name} must be ${type === "integer" ? "a whole number" : "a number"}.`);
    return value;
  }
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new UsageError(`--${field.name} must be true or false.`);
  }
  if (type === "array" || type === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`--${field.name} must be JSON.`);
    }
  }
  return raw;
}

function readStdin() {
  return require("node:fs").readFileSync(0, "utf8");
}

function parseInput(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${source} isn't valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${source} must be a JSON object.`);
  return value;
}

/** Splits the arguments after the action into the input and the tool's own options. */
function parseArgs(action, args) {
  const opts = { json: false, help: false, timeoutS: DEFAULT_TIMEOUT_S };
  const fields = fieldsOf(action);
  const byKey = new Map(fields.map((f) => [flagKey(f.name), f]));
  let input = {};
  const named = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      if (arg === "-h") {
        opts.help = true;
        continue;
      }
      throw new UsageError(`Unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= args.length) throw new UsageError(`--${name} needs a value.`);
      return args[++i];
    };
    if (name === "json") opts.json = true;
    else if (name === "help") opts.help = true;
    else if (name === "input") {
      const text = value();
      input = parseInput(text === "-" ? readStdin() : text, "--input");
    } else if (name === "input-file") {
      const file = value();
      let text;
      try {
        text = require("node:fs").readFileSync(file, "utf8");
      } catch {
        throw new UsageError(`Can't read ${file}.`);
      }
      input = parseInput(text, file);
    } else if (name === "timeout") {
      opts.timeoutS = Number(value());
      if (!(opts.timeoutS > 0)) throw new UsageError("--timeout must be a number of seconds.");
    } else {
      const negated = name.startsWith("no-") ? byKey.get(flagKey(name.slice(3))) : undefined;
      if (negated && typeOf(negated.schema) === "boolean") {
        named[negated.name] = false;
        continue;
      }
      const field = byKey.get(flagKey(name));
      if (!field) {
        const known = fields.length ? ` It takes ${fields.map((f) => `--${f.name}`).join(", ")}.` : " It takes no fields.";
        throw new UsageError(`${action.name} has no field --${name}.${known}`);
      }
      const bare = typeOf(field.schema) === "boolean" && inline === undefined && (i + 1 >= args.length || args[i + 1].startsWith("--"));
      named[field.name] = bare ? true : coerce(field, value());
    }
  }
  const body = { ...input, ...named };
  if (!opts.help) {
    const missing = fields.filter((f) => f.required && body[f.name] === undefined).map((f) => `--${f.name}`);
    if (missing.length) throw new UsageError(`${action.name} needs ${missing.join(", ")}.`);
  }
  return { body, opts };
}

async function callAction(action, body, timeoutS) {
  if (typeof fetch !== "function") throw new Error("This tool needs Node 18 or newer.");
  const url = `${PRODUCT.liveUrl.replace(/\/+$/, "")}/api/actions/${encodeURIComponent(action.name)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `MuseMuse-CLI/${VERSION}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
  } catch (cause) {
    const timedOut = cause && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return { ok: false, status: null, message: timedOut ? `${action.name} took longer than ${timeoutS} s and was stopped.` : `Couldn't reach ${PRODUCT.name} to run ${action.name}.` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, message: `${action.name} failed with HTTP ${res.status}: ${text.slice(0, 2000) || "(empty body)"}` };
  try {
    return { ok: true, reply: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, message: `${action.name} returned a reply that isn't JSON: ${text.slice(0, 2000)}` };
  }
}

async function main(argv) {
  const json = argv.includes("--json");
  const first = argv.find((a) => a !== "--json");
  if (first === undefined || first === "--help" || first === "-h" || first === "help" || first === "list") {
    if (json) out(JSON.stringify({ name: PRODUCT.name, tagline: PRODUCT.tagline, url: PRODUCT.liveUrl, mcp: PRODUCT.mcpUrl, actions: PRODUCT.actions.map((a) => ({ name: a.name, description: a.description, input: a.input })) }));
    else out(mainHelp());
    return first === undefined && !json ? USAGE_ERROR : 0;
  }
  if (first === "--version") {
    out(VERSION);
    return 0;
  }
  const action = findAction(first);
  if (!action) throw new UsageError(`${PRODUCT.slug} has no action called ${first}. Run it with --help to see them.`);
  const rest = argv.slice(argv.indexOf(first) + 1);
  const { body, opts } = parseArgs(action, argv.slice(0, argv.indexOf(first)).concat(rest));
  if (opts.help) {
    if (opts.json) out(JSON.stringify({ name: action.name, description: action.description, input: action.input }));
    else out(actionHelp(action));
    return 0;
  }
  const result = await callAction(action, body, opts.timeoutS);
  if (!result.ok) {
    if (opts.json) out(JSON.stringify({ error: { message: result.message, status: result.status } }));
    else err(result.message);
    return CALL_ERROR;
  }
  out(opts.json ? JSON.stringify(result.reply) : JSON.stringify(result.reply, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (cause) => {
    const usage = cause instanceof UsageError;
    if (process.argv.includes("--json")) out(JSON.stringify({ error: { message: cause.message, status: null } }));
    else err(usage ? `${cause.message}\nRun ${PRODUCT.slug} --help to see what it takes.` : String(cause.message || cause));
    process.exitCode = usage ? USAGE_ERROR : CALL_ERROR;
  },
);
