// Platform file (Muse Muse platform services). Don't edit: call it from your job routes.
//
// Background jobs. Each is a route, app/api/jobs/<name>/route.ts, that the platform calls on a schedule or when a webhook
// or enqueue() queues it:
//
//   export const maxDuration = 60;
//   export const POST = jobHandler("digest", async (job) => {
//     const items = await data(job.request).collection("news").list();
//     ...
//   });
//
// A call without the platform's job token is refused before your code runs. Inside the handler every call to the Muse
// Muse gateway counts as this job, so pass job.request to metaClient and the other helpers as usual, and make clients
// inside the handler. Server code only.
import { AsyncLocalStorage } from "node:async_hooks";
import { clientIpHeaders, type RequestLike } from "@/lib/meta/client";
import { OWNER_HEADER, ownerSession } from "@/lib/platform/identity";

export const JOB_HEADER = "x-musemuse-job";

/** What every jobs helper throws: a code, an HTTP status the route can answer with, and a plain message. */
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

export interface Job<I = unknown, S = unknown> {
  runId: string;
  name: string;
  /** 1 on a run's first tick. A run has at most 10. */
  tick: number;
  /** What enqueue() passed, or { payload, receivedAt } when a webhook started it. Null on a schedule. */
  input: I;
  /** What the last tick saved with checkpoint(), or null on the first. */
  checkpoint: S | null;
  /** Where this run stops, in dollars. */
  budgetUsd: number;
  /** True in a build: nothing goes to a real person. */
  simulated: boolean;
  /** Pass this to metaClient and every other helper. */
  request: Request;
}

/** What checkpoint() gives back, for the handler to return. */
export interface Checkpointed {
  checkpointed: true;
}

const running = new AsyncLocalStorage<string>();

function settings(): { base: string; token: string } {
  const base = process.env.GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.PRODUCT_TOKEN;
  if (!base || !token) throw new CapError("not_configured", 500, "Background jobs aren't set up on this server. The Muse Muse platform sets them when it deploys the product.");
  return { base, token };
}

/**
 * Inside a job, every call to the gateway carries the job's token, whichever helper makes it, so its model calls count
 * against its dollars and its saves follow a job's rules. Anywhere else, and to any other address, fetch is untouched.
 */
function carryJobToken(): void {
  const mark = "__museMuseJobFetch";
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[mark]) return;
  g[mark] = true;
  const inner = globalThis.fetch;
  const wrapped = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const token = running.getStore();
    const base = process.env.GATEWAY_URL?.replace(/\/+$/, "");
    if (!token || !base) return inner(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== base && !url.startsWith(`${base}/`)) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(JOB_HEADER, token);
    return inner(input, { ...init, headers });
  }) as typeof fetch;
  globalThis.fetch = Object.assign(wrapped, inner);
}

carryJobToken();

async function call<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const { base, token } = settings();
  const res = await fetch(`${base}/jobs/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new CapError("unreachable", 502, "Muse Muse's jobs service is unreachable right now.");
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (res.status === 404 && reply?.error?.code === "unknown_endpoint") throw new CapError("switched_off", 404, "Background jobs are switched off on Muse Muse right now.");
  if (!res.ok) throw new CapError(reply?.error?.code ?? "cap_failed", res.status, reply?.error?.message ?? "That didn't work this time.");
  return reply as T;
}

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * The route for one job: `export const POST = jobHandler("digest", async (job) => { ... })`. Refuses any call without the
 * platform's token. Return nothing when the run is finished, or `return checkpoint(job, state)` to go on at the next tick.
 * A thrown error ends the run and tells the owner, in one plain line.
 */
export function jobHandler<I = unknown, S = unknown>(name: string, fn: (job: Job<I, S>) => Promise<Checkpointed | void | undefined> | Checkpointed | void | undefined) {
  return async function POST(request: Request): Promise<Response> {
    const token = request.headers.get(JOB_HEADER);
    if (!token) return answer({ error: "This route runs only when Muse Muse calls it." }, 401);
    const headers = { [JOB_HEADER]: token };
    let verified: { runId: string; name: string; tick: number; input: I; checkpoint: S | null; budgetUsd: number; simulated?: boolean };
    try {
      verified = await call("verify", {}, headers);
    } catch (err) {
      const e = err as CapError;
      return answer({ error: e.message }, e.code === "switched_off" ? 404 : e.status === 401 || e.status === 403 ? 401 : (e.status ?? 500));
    }
    if (verified.name !== name) return answer({ error: `This route is for the job ${name}, not ${verified.name}.` }, 400);
    const job: Job<I, S> = { runId: verified.runId, name, tick: verified.tick, input: verified.input, checkpoint: verified.checkpoint, budgetUsd: verified.budgetUsd, simulated: verified.simulated === true, request };
    try {
      const result = await running.run(token, () => fn(job));
      if (result && result.checkpointed) return answer({ ok: true, status: "queued", tick: job.tick });
      await call("checkpoint", { state: null, done: true }, headers);
      return answer({ ok: true, status: "done", tick: job.tick });
    } catch (err) {
      const e = err as Error;
      const line = String(e?.message ?? "It failed.").split("\n")[0]!.slice(0, 300);
      console.error(`[job ${name}]`, line);
      await call("checkpoint", { state: null, done: true, error: line }, headers).catch(() => undefined);
      return answer({ error: line }, 500);
    }
  };
}

/**
 * Saves `state` (at most 64 KB) and ends this tick. The next tick, within about 5 minutes, starts with it in
 * job.checkpoint: `return checkpoint(job, { cursor })`.
 */
export async function checkpoint<S>(job: Job<unknown, S>, state: S): Promise<Checkpointed> {
  await call("checkpoint", { state, done: false }, { [JOB_HEADER]: job.request.headers.get(JOB_HEADER) ?? "" });
  return { checkpointed: true };
}

/** A notice for the product's owner, shown in Muse Muse, at most 10 a day. In a build it's recorded and shown to no one. */
export async function notifyOwner(job: Job, notice: { title: string; body?: string }): Promise<void> {
  await call("notify", { title: notice.title, ...(notice.body === undefined ? {} : { body: notice.body }) }, { [JOB_HEADER]: job.request.headers.get(JOB_HEADER) ?? "" });
}

/**
 * Queues a job for the next tick, within about 5 minutes, up to 50 a day. Only the product's owner or another job can:
 * a visitor gets a CapError with code sign_in_required.
 */
export async function enqueue(request: RequestLike | null | undefined, job: { name: string; input?: unknown }): Promise<{ runId: string }> {
  const owner = ownerSession(request);
  return call("enqueue", { name: job.name, ...(job.input === undefined ? {} : { input: job.input }) }, { ...clientIpHeaders(request), ...(owner ? { [OWNER_HEADER]: owner } : {}) });
}
