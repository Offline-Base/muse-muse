// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Runs a person's task with Muse Code, a coding agent, through the Muse Muse gateway ({GATEWAY_URL}/code/sessions).
// The product never runs Muse Code itself: the platform starts a private temporary workspace for each task, in a
// sandbox of its own with no product code and no secrets, and deletes it when the task ends. At most 15 minutes and $1 a
// task, 2 at once per product. Only the product's owner can start tasks, unless the build prompt says Muse Muse lets
// anyone. Anyone else gets CapError sign_in_required.
//
//   museCode.start(request, { task, files })     starts a task; answers its id at once (a task takes seconds to minutes)
//   museCode.events(request, id, after)          the steps after step `after`, the status and the cost so far
//   museCode.steer(request, id, text)            a note into the running task
//   museCode.stop(request, id)                   stops it; it keeps what it made
//   museCode.result(request, id)                 the final answer, the files, the zip's link and whether it worked
//   museCode.link(page, id)                      a link to the product's page showing the run (for MCP actions)
//
// Server code only, and always pass the incoming request (or `await headers()`) so the gateway knows who is asking.
// In a build, `start(request, { task, replay: true })` plays a recorded sample run instead (lib/muse-code/replay.ts) and
// spends nothing; the live product never replays.
import { gatewayEnv, type RequestLike } from "@/lib/meta/client";
import { CapError } from "@/lib/platform/exec";
import { identityHeaders } from "@/lib/platform/identity";
import { userHeaders } from "@/lib/platform/user";
import { isReplayId, replayAllowed, replayEvents, replayResult, replayStart, type RunStep } from "@/lib/muse-code/replay";

export { CapError };
export type { RunStep };

/** Shown where the person types the task, word for word. */
export const MUSE_CODE_DISCLOSURE = "Runs Muse Code in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta.";

export interface TaskFile {
  /** One plain name. The task finds it in its workspace. */
  name: string;
  text?: string;
  base64?: string;
  /** A public Blob URL from the gateway's /uploads route, for files over 1 MB in all. */
  url?: string;
}

export interface RunStarted {
  id: string;
  status: string;
  model: string;
  budgetUsd: number;
  endsAt: string;
  replay?: boolean;
}

export interface RunProgress {
  id: string;
  status: "starting" | "running" | "completed" | "failed" | "stopped" | "expired" | string;
  events: RunStep[];
  /** The last step's number: pass it as `after` next time. */
  next: number;
  costUsd: number;
  finalText: string | null;
  /** Files came back and the agent said what it did. Null while it runs. */
  worked: boolean | null;
  reason: string | null;
  endsAt: string;
  replay?: boolean;
}

export interface RunResult {
  id: string;
  status: string;
  done: boolean;
  finalText: string | null;
  worked: boolean | null;
  files?: Array<{ path: string; bytes: number }>;
  /** What the zip left out, and why (links, program files, files too big). */
  dropped?: Array<{ path: string; why: string }>;
  /** The zip of the workspace, for 24 hours, or null. */
  zipUrl?: string | null;
  zipExpiresAt?: string | null;
  costUsd: number;
  reason?: string | null;
  replay?: boolean;
}

function settings(): { base: string; token: string } {
  try {
    const { baseURL, apiKey } = gatewayEnv();
    return { base: baseURL.replace(/\/v1\/?$/, "").replace(/\/+$/, ""), token: apiKey };
  } catch {
    throw new CapError("not_configured", 500, "Muse Code isn't set up on this server. The Muse Muse platform sets it when it deploys the product.");
  }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(id: string): string {
  if (typeof id !== "string" || !ID.test(id)) throw new CapError("invalid_arguments", 400, "That isn't a run's id.");
  return id;
}

async function call<T>(from: RequestLike | null | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { base, token } = settings();
  const res = await fetch(`${base}/code/sessions${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...identityHeaders(from), ...userHeaders(from) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    // A start makes a workspace: seconds as a rule, never more than about a minute and a half.
    signal: AbortSignal.timeout(110_000),
  }).catch(() => {
    throw new CapError("unreachable", 502, "Muse Code is unreachable right now. Try again in a minute.");
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) throw new CapError(reply?.error?.code ?? "cap_failed", res.status, reply?.error?.message ?? "Muse Code didn't work this time. Try again.");
  return reply as T;
}

function replayOnly(): void {
  if (!replayAllowed()) throw new CapError("replay_off", 400, "Replay mode is for a build's tests only.");
}

export const museCode = {
  async start(request: RequestLike | null | undefined, run: { task: string; files?: TaskFile[]; replay?: boolean }): Promise<RunStarted> {
    if (run.replay) {
      replayOnly();
      return replayStart();
    }
    return call<RunStarted>(request, "POST", "", { task: run.task, ...(run.files?.length ? { files: run.files } : {}) });
  },
  async events(request: RequestLike | null | undefined, id: string, after = -1): Promise<RunProgress> {
    if (isReplayId(id)) {
      replayOnly();
      return replayEvents(id, after) as RunProgress;
    }
    return call<RunProgress>(request, "GET", `/${checkedId(id)}/events?after=${Number.isFinite(Number(after)) ? Math.max(-1, Math.floor(Number(after))) : -1}`);
  },
  async steer(request: RequestLike | null | undefined, id: string, text: string): Promise<{ sent: boolean }> {
    if (isReplayId(id)) {
      replayOnly();
      return { sent: true };
    }
    return call<{ sent: boolean }>(request, "POST", `/${checkedId(id)}/steer`, { text });
  },
  async stop(request: RequestLike | null | undefined, id: string): Promise<RunResult> {
    if (isReplayId(id)) {
      replayOnly();
      return { ...replayResult(id), status: "stopped", done: true } as RunResult;
    }
    return call<RunResult>(request, "POST", `/${checkedId(id)}/stop`, {});
  },
  async result(request: RequestLike | null | undefined, id: string): Promise<RunResult> {
    if (isReplayId(id)) {
      replayOnly();
      return replayResult(id) as RunResult;
    }
    return call<RunResult>(request, "GET", `/${checkedId(id)}/result`);
  },
  /** The product's page that shows the run, with the run's id in `?run=`: what an MCP action answers, at once. */
  link(page: string | URL, id: string): string {
    const url = new URL(page.toString());
    url.searchParams.set("run", id);
    return url.toString();
  },
};

/** A route's answer for an error: a CapError's status and plain message, or a 502 that says nothing of the cause. */
export function failure(err: unknown): Response {
  const headers = { "cache-control": "no-store" };
  if (err instanceof CapError) return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers });
  return Response.json({ error: { code: "cap_failed", message: "Muse Code didn't work this time. Try again." } }, { status: 502, headers });
}
