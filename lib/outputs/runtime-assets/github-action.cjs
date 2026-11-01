// A GitHub Action for one Muse Muse product, generated from its musemuse.json: it runs one of the product's actions
// with the JSON input it is given and puts the reply in the step's `result` output and its summary.
// No dependencies, Node 20 or newer. Built with Muse Muse, a hackathon concept. Not an official Meta product.
"use strict";

const { appendFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const PRODUCT = require("./product.json");

/** An input the way the runner passes it: INPUT_ and the name in capitals, spaces as underscores. */
function input(name) {
  return String(process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "").trim();
}

/** A workflow command's message, escaped the way GitHub reads them. */
function escape(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function fail(message) {
  process.stdout.write(`::error::${escape(message)}\n`);
  process.exitCode = 1;
}

/** Writes a step output that may span lines, with a delimiter no reply can contain by chance. */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    process.stdout.write(`${name}=${value}\n`);
    return;
  }
  let delimiter = `MUSEMUSE_${randomBytes(12).toString("hex")}`;
  while (value.includes(delimiter)) delimiter = `MUSEMUSE_${randomBytes(12).toString("hex")}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

/** A Markdown code block that the text can't close early. */
function fenced(text, lang) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

async function main() {
  const name = input("action") || (PRODUCT.actions[0] && PRODUCT.actions[0].name) || "";
  const action = PRODUCT.actions.find((a) => a.name === name);
  if (!action) return fail(`${PRODUCT.name} has no action called "${name.slice(0, 60)}". It has: ${PRODUCT.actions.map((a) => a.name).join(", ")}.`);
  let body;
  try {
    body = JSON.parse(input("input") || "{}");
  } catch {
    return fail("The input isn't JSON. Pass the action's input as a JSON object, like '{\"text\": \"...\"}'.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("The input must be a JSON object.");
  const base = (input("base-url") || PRODUCT.liveUrl).replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) return fail("base-url must be an https:// address.");
  const seconds = Number(input("timeout-seconds") || 120);
  const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : 120000;
  const url = `${base}/api/actions/${encodeURIComponent(action.name)}`;
  process.stdout.write(`Running ${action.name} on ${base}\n`);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return fail(`${url} couldn't be reached (${err && err.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} seconds` : "network error"}).`);
  }
  const text = await res.text();
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    return fail(`${action.name} answered HTTP ${res.status} with something that isn't JSON.`);
  }
  const json = JSON.stringify(reply);
  setOutput("result", json);
  setOutput("ok", res.ok ? "true" : "false");
  summary([`### ${PRODUCT.name}: ${action.name}`, "", fenced(JSON.stringify(reply, null, 2), "json")]);
  if (!res.ok) return fail(`${action.name} failed: ${reply && typeof reply.error === "string" ? reply.error.slice(0, 300) : `HTTP ${res.status}`}`);
  process.stdout.write(`${json.length > 2000 ? `${json.slice(0, 2000)}...` : json}\n`);
}

main().catch((err) => fail(`It stopped: ${err && err.message ? err.message : err}`));
