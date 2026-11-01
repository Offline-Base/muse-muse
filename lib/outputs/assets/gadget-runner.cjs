#!/usr/bin/env node
// Runs one action of a Muse Muse product for a Muse gadget's custom command (docs/PRODUCT_OUTPUTS.md). The gadget's
// service starts it with no shell and the command's parameters as a JSON object on stdin. It POSTs them to the live
// product and prints the reply as one JSON object. On a failure it exits 1 with the reason as its last line on stderr,
// which the gadget hands back to Muse. One file, no dependencies, Node 18+. It never starts another program.
// Built with Muse Muse, a hackathon concept. Not an official Meta product.
"use strict";

const PACK = /*__MUSE_GADGET__*/ { liveUrl: "http://localhost", actions: {} };
const VERSION = "1.0.0";
/** What stdin may hold. A gadget's own parameters are small. */
const MAX_INPUT_BYTES = 1024 * 1024;
/** The gadget keeps 96 KiB of a command's output, so a longer reply would come back cut and no longer JSON. */
const MAX_OUTPUT_BYTES = 90 * 1024;
/** Time left for saying why, before the gadget stops the command at its timeout_ms. */
const MARGIN_MS = 1500;

/** One line with nothing a terminal or a log would act on, since replies come from elsewhere. */
function oneLine(text, max = 400) {
  const flat = String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

class Failure extends Error {}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) reject(new Failure(`The input is over ${MAX_INPUT_BYTES / 1024} KiB.`));
      else chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => reject(new Failure("Couldn't read the input.")));
  });
}

function parseInput(text) {
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Failure("The input isn't JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Failure("The input must be a JSON object.");
  return value;
}

/** What an error reply says, in one line. */
function replyReason(text) {
  try {
    const body = JSON.parse(text);
    const said = body && typeof body === "object" ? (typeof body.error === "string" ? body.error : body.error && body.error.message) || body.message : null;
    if (typeof said === "string" && said.trim()) return oneLine(said, 300);
  } catch {
    // Not JSON: say what it was.
  }
  return oneLine(text, 300) || "(empty reply)";
}

async function main() {
  const name = process.argv[2];
  const action = typeof name === "string" && Object.hasOwn(PACK.actions, name) ? PACK.actions[name] : null;
  if (!action) throw new Failure(`This pack has no action called ${oneLine(name || "(none)", 80)}.`);
  if (typeof fetch !== "function") throw new Failure("It needs Node 18 or newer.");
  const input = parseInput(await readStdin());
  const waitMs = Math.max(500, action.timeoutMs - MARGIN_MS);
  const url = `${PACK.liveUrl.replace(/\/+$/, "")}/api/actions/${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `MuseMuse-Gadget/${VERSION}` },
      body: JSON.stringify(input),
      // The address is fixed in this file. A redirect would send the input somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (cause) {
    const timedOut = cause && (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw new Failure(timedOut ? `${name} took longer than ${Math.round(waitMs / 1000)} s and was stopped.` : `Couldn't reach the product to run ${name}.`);
  }
  const text = await res.text();
  if (!res.ok) throw new Failure(`${name} failed with HTTP ${res.status}: ${replyReason(text)}`);
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new Failure(`${name} answered with something that isn't JSON.`);
  }
  // The gadget takes a JSON object as the result, so anything else is wrapped in one.
  const object = reply && typeof reply === "object" && !Array.isArray(reply) ? reply : { result: reply };
  // DEL and C1 characters are escaped too, so the value stays exact and nothing in it reaches a log raw.
  const json = JSON.stringify(object).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (Buffer.byteLength(json) > MAX_OUTPUT_BYTES) throw new Failure(`${name}'s reply is ${Math.ceil(Buffer.byteLength(json) / 1024)} KiB, more than a gadget passes back (${MAX_OUTPUT_BYTES / 1024} KiB).`);
  process.stdout.write(`${json}\n`);
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (cause) => {
    process.stderr.write(`${oneLine(cause instanceof Failure ? cause.message : `Something went wrong: ${cause && cause.message ? cause.message : cause}`)}\n`);
    process.exitCode = 1;
  },
);
