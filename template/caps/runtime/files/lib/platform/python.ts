// Platform file (Muse Muse platform services). Don't edit: call it from your action routes.
//
// Runs one of the product's Python functions (api/py/<name>.py) and returns its JSON reply. Server code only.
//
// - On Vercel it calls the deployment's own /api/py/<name>, which Vercel serves from the Python file.
// - With MUSEMUSE_PYTHON_URL set it calls that address instead (for example scripts/py-local.mjs serve).
// - Anywhere else, and in every build (MUSEMUSE_PYTHON=local), it runs the file on this machine with
//   scripts/py-local.mjs. In a build each call is also noted in test-results/caps/runtime-calls.jsonl, so verify's
//   checks can run the same function again on the same input.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface HeaderReader {
  get(name: string): string | null;
}

/** A route handler's `request`, or `await headers()` from next/headers in a server action. */
export type PythonRequest = Request | { headers: HeaderReader } | HeaderReader;

/** What every platform helper throws: a code, an HTTP status the action can answer with, and a plain message. */
export class CapError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "CapError";
    this.code = code;
    this.status = status;
  }
}

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);
/** A little over the function's own 10 seconds (vercel.json), so its answer, not ours, says when it ran out. */
const TIMEOUT_MS = 12_000;
const CALL_LOG = path.join("test-results", "caps", "runtime-calls.jsonl");
/** The checks run a logged call again, so only inputs this small are noted in full. */
const LOG_MAX_INPUT_BYTES = 64 * 1024;

function headerReader(from: PythonRequest): HeaderReader {
  return "get" in from && typeof from.get === "function" ? (from as HeaderReader) : (from as { headers: HeaderReader }).headers;
}

/** This deployment's own address, from the incoming request, else Vercel's VERCEL_URL. */
function ownOrigin(from: PythonRequest): string {
  const url = (from as { url?: unknown }).url;
  if (typeof url === "string" && /^https?:\/\//.test(url)) return new URL(url).origin;
  const host = headerReader(from).get("x-forwarded-host") ?? headerReader(from).get("host");
  if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) return `https://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  throw new CapError("python_unreachable", 502, "This server doesn't know its own address, so it can't reach its Python functions.");
}

function where(): { kind: "local" } | { kind: "http"; base: string | null } {
  if (process.env.MUSEMUSE_PYTHON === "local") return { kind: "local" };
  const url = process.env.MUSEMUSE_PYTHON_URL?.trim();
  if (url) return { kind: "http", base: url.replace(/\/+$/, "") };
  return process.env.VERCEL ? { kind: "http", base: null } : { kind: "local" };
}

function parseReply<T>(name: string, status: number, text: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CapError("python_failed", 502, status >= 400 ? `The ${name} function failed (HTTP ${status}).` : `The ${name} function didn't answer with JSON.`);
  }
  if (status >= 400) {
    const said = (json as { error?: unknown } | null)?.error;
    throw new CapError("python_failed", status >= 500 ? 502 : status, typeof said === "string" && said ? said.slice(0, 300) : `The ${name} function failed (HTTP ${status}).`);
  }
  return json as T;
}

function runLocal(name: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "py-local.mjs");
    const child = spawn(process.execPath, [script, "call", name, "--json-result"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CapError("python_timeout", 504, `The ${name} function took longer than ${TIMEOUT_MS / 1000} seconds.`));
    }, TIMEOUT_MS + 3_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new CapError("python_unreachable", 502, "Python functions can't run on this machine."));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = Buffer.concat(out).toString("utf8").trim().split("\n").at(-1) ?? "";
      let r: { status?: number; body?: string; error?: string };
      try {
        r = JSON.parse(line);
      } catch {
        return reject(new CapError("python_failed", 502, `The ${name} function stopped without an answer.`));
      }
      if (r.error) return reject(new CapError(r.status === 404 ? "unknown_function" : r.status === 504 ? "python_timeout" : "python_failed", r.status === 404 ? 500 : (r.status ?? 502), `The ${name} function failed: ${r.error.slice(0, 300)}`));
      resolve({ status: r.status ?? 500, text: Buffer.from(r.body ?? "", "base64").toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
}

function noteCall(name: string, input: string, output: unknown): void {
  if (process.env.MUSEMUSE_PYTHON !== "local" || Buffer.byteLength(input) > LOG_MAX_INPUT_BYTES) return;
  try {
    mkdirSync(path.dirname(CALL_LOG), { recursive: true });
    appendFileSync(CALL_LOG, `${JSON.stringify({ name, input: JSON.parse(input), output, at: new Date().toISOString() })}\n`);
  } catch {
    // A note the checks can't read only fails the checks, never the call.
  }
}

/**
 * Calls the product's Python function `name` with `input` as its JSON body and returns its JSON reply. Pass the incoming
 * request, as you do for metaClient(request). Throws CapError with a plain message the action can show.
 */
export async function callPython<T = unknown>(request: PythonRequest, name: string, input: unknown): Promise<T> {
  if (!NAME.test(name)) throw new CapError("unknown_function", 500, `"${String(name).slice(0, 40)}" isn't a Python function name.`);
  const body = JSON.stringify(input ?? null);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new CapError("too_large", 413, "That's too much to send in one go: the limit is 4.5 MB.");
  const at = where();
  if (at.kind === "local") {
    const { status, text } = await runLocal(name, body);
    const reply = parseReply<T>(name, status, text);
    noteCall(name, body, reply);
    return reply;
  }
  const base = at.base ?? ownOrigin(request);
  let res: Response;
  try {
    res = await fetch(`${base}/api/py/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === "TimeoutError";
    throw new CapError(timedOut ? "python_timeout" : "python_unreachable", timedOut ? 504 : 502, timedOut ? `The ${name} function took longer than ${TIMEOUT_MS / 1000} seconds.` : `The ${name} function couldn't be reached.`);
  }
  return parseReply<T>(name, res.status, await res.text());
}
