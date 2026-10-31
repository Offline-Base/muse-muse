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

/** Manifests and replies come from elsewhere: nothing a terminal would act on gets printed, only tabs and new lines. */
function safe(text) {
  return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function out(text) {
  process.stdout.write(`${safe(text)}\n`);
}

function err(text) {
  process.stderr.write(`${safe(text)}\n`);
}

/** JSON as text. JSON.stringify leaves DEL and C1 characters raw, so they are escaped: the value stays exact and safe() has nothing to cut. */
function jsonText(value, indent) {
  return JSON.stringify(value, null, indent).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The tool's own options. Each short form gives way to a field of the same name, and each --cli- form always means the tool. */
const TOOL_OPTIONS = ["help", "json", "input", "input-file", "timeout"];

/** True while errors should come out as JSON, so a failure before the arguments are read still follows --json. */
let jsonMode = false;

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
  const choices = Array.isArray(field.schema.enum) ? ` (${field.schema.enum.join(", ").replace(/\s+/g, " ")})` : "";
  const about = field.schema.description ? `  ${String(field.schema.description).replace(/\s+/g, " ")}` : "";
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
    "An action's field with one of these names takes that flag. --cli-help, --cli-json, --cli-input <json>,",
    "--cli-input-file <path> and --cli-timeout <seconds> always mean the options above.",
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
  const taken = TOOL_OPTIONS.filter((o) => fields.some((f) => flagKey(f.name) === flagKey(o)));
  if (taken.length) lines.push("", `A field has the flag ${taken.map((o) => `--${o}`).join(", ")} here. For the tool's own option, use ${taken.map((o) => `--cli-${o}`).join(", ")}.`);
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
    const forTool = name.startsWith("cli-") && TOOL_OPTIONS.includes(name.slice(4));
    const field = forTool ? undefined : byKey.get(flagKey(name));
    if (field) {
      const bare = typeOf(field.schema) === "boolean" && inline === undefined && (i + 1 >= args.length || args[i + 1].startsWith("--"));
      named[field.name] = bare ? true : coerce(field, value());
      continue;
    }
    const negated = !forTool && name.startsWith("no-") ? byKey.get(flagKey(name.slice(3))) : undefined;
    if (negated && typeOf(negated.schema) === "boolean") {
      named[negated.name] = false;
      continue;
    }
    const option = forTool ? name.slice(4) : name;
    if (option === "json") opts.json = true;
    else if (option === "help") opts.help = true;
    else if (option === "input") {
      const text = value();
      input = parseInput(text === "-" ? readStdin() : text, `--${name}`);
    } else if (option === "input-file") {
      const file = value();
      let text;
      try {
        text = require("node:fs").readFileSync(file, "utf8");
      } catch {
        throw new UsageError(`Can't read ${file}.`);
      }
      input = parseInput(text, file);
    } else if (option === "timeout") {
      opts.timeoutS = Number(value());
      if (!(opts.timeoutS > 0)) throw new UsageError(`--${name} must be a number of seconds.`);
    } else {
      const known = fields.length ? ` It takes ${fields.map((f) => `--${f.name}`).join(", ")}.` : " It takes no fields.";
      throw new UsageError(`${action.name} has no field --${name}.${known}`);
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

/** Whether these arguments ask for JSON, by the same rule parseArgs goes by. A value that happens to read --json counts too, for errors only. */
function wantsJson(args, action) {
  if (args.includes("--cli-json")) return true;
  if (!args.includes("--json")) return false;
  return !(action && fieldsOf(action).some((f) => flagKey(f.name) === "json"));
}

async function main(argv) {
  const isJsonFlag = (a) => a === "--json" || a === "--cli-json";
  const first = argv.find((a) => !isJsonFlag(a));
  // An action's name comes first, so one called list or help runs. Those words only mean help when no action has them.
  const action = first !== undefined && !first.startsWith("-") ? findAction(first) : undefined;
  const at = first === undefined ? argv.length : argv.indexOf(first);
  const leadingJson = at > 0;
  const rest = argv.slice(at + 1);
  jsonMode = leadingJson || wantsJson(rest, action);
  if (first === undefined || first === "--help" || first === "--cli-help" || first === "-h" || (!action && (first === "help" || first === "list"))) {
    if (jsonMode) out(jsonText({ name: PRODUCT.name, tagline: PRODUCT.tagline, url: PRODUCT.liveUrl, mcp: PRODUCT.mcpUrl, actions: PRODUCT.actions.map((a) => ({ name: a.name, description: a.description, input: a.input })) }));
    else out(mainHelp());
    return first === undefined && !jsonMode ? USAGE_ERROR : 0;
  }
  if (first === "--version") {
    out(VERSION);
    return 0;
  }
  if (!action) throw new UsageError(`${PRODUCT.slug} has no action called ${first}. Run it with --help to see them.`);
  const { body, opts } = parseArgs(action, rest);
  const json = leadingJson || opts.json;
  if (opts.help) {
    if (json) out(jsonText({ name: action.name, description: action.description, input: action.input }));
    else out(actionHelp(action));
    return 0;
  }
  const result = await callAction(action, body, opts.timeoutS);
  if (!result.ok) {
    if (json) out(jsonText({ error: { message: result.message, status: result.status } }));
    else err(result.message);
    return CALL_ERROR;
  }
  out(json ? jsonText(result.reply) : jsonText(result.reply, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (cause) => {
    const usage = cause instanceof UsageError;
    if (jsonMode) out(jsonText({ error: { message: cause.message, status: null } }));
    else err(usage ? `${cause.message}\nRun ${PRODUCT.slug} --help to see what it takes.` : String(cause.message || cause));
    process.exitCode = usage ? USAGE_ERROR : CALL_ERROR;
  },
);
