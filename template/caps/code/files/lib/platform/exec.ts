// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Runs a Python or Node program on a Muse Muse sandbox ({GATEWAY_URL}/exec): a fresh machine for each run, with no
// network and no secrets, 15 seconds at most. Code and stdin up to 64 KB each, files up to 1 MB in all, and stdout and
// stderr cut at 64 KB each. Python has its standard library only. Server code only, and always pass the incoming request
// (or `await headers()` in a server action), so the gateway knows who is asking: only the product's owner may run code
// here. Anyone else gets CapError sign_in_required, so show them the browser runtime or say that it's the owner's.
// In a build every run is real, at most 5 in all.
import { gatewayEnv, type RequestLike } from "@/lib/meta/client";
import type { CodeRun } from "@/lib/platform/code-run";
import { identityHeaders } from "@/lib/platform/identity";
import { userHeaders } from "@/lib/platform/user";

/** What every platform helper throws: a code, an HTTP status the route can answer with, and a plain message. */
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

export interface ServerFile {
  /** One plain name: letters, digits, dots, dashes and underscores. The program finds it in its working folder. */
  name: string;
  text?: string;
  /** For bytes that aren't text. */
  base64?: string;
}

export interface ServerProgram {
  language: "python" | "node";
  code: string;
  stdin?: string;
  files?: ServerFile[];
}

function settings(): { base: string; token: string } {
  try {
    const { baseURL, apiKey } = gatewayEnv();
    return { base: baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, ""), token: apiKey };
  } catch {
    throw new CapError("not_configured", 500, "Running code isn't set up on this server. The Muse Muse platform sets it when it deploys the product.");
  }
}

/** Posts to one of the gateway's code routes with the caller's identity, and turns its errors into CapError. */
export async function codeCall<T>(from: RequestLike | null | undefined, path: "/exec" | "/browse", body: unknown, what: string): Promise<T> {
  const { base, token } = settings();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...identityHeaders(from), ...userHeaders(from) },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(110_000),
  }).catch(() => {
    throw new CapError("unreachable", 502, `${what} is unreachable right now. Try again in a minute.`);
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) throw new CapError(reply?.error?.code ?? "cap_failed", res.status, reply?.error?.message ?? `${what} didn't work this time. Try again.`);
  return reply as T;
}

/** Runs one program on the platform. A program's own error is a normal answer (status "error"), not a throw. */
export async function runOnServer(request: RequestLike | null | undefined, program: ServerProgram): Promise<CodeRun> {
  const reply = await codeCall<{ status: CodeRun["status"]; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; ms: number }>(
    request,
    "/exec",
    { language: program.language, code: program.code, ...(program.stdin ? { stdin: program.stdin } : {}), ...(program.files?.length ? { files: program.files } : {}) },
    "Running code",
  );
  return { runtime: "exec", status: reply.status, exitCode: reply.exitCode, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", truncated: Boolean(reply.truncated), ms: reply.ms ?? 0 };
}
