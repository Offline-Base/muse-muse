// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Reads one keyless public API through the Muse Muse gateway ({GATEWAY_URL}/fetch): only the APIs, paths and query
// parameters in .agents/skills/muse-connect/SKILL.md, cached by the platform for everyone. Pass the incoming request
// (or `await headers()`), so the gateway can hold each person to their own limit. Show `credit` next to what it gave.
// In a build every answer is a sample recorded from the real API, and nothing leaves the gateway.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RequestLike } from "@/lib/meta/client";
import { CapError, gatewayCall } from "@/lib/platform/connect";

export { CapError };

export interface PublicRequest {
  /** nws, wikipedia, openlibrary or usgs: only those the brief picked. */
  api: string;
  /** One of the API's paths with its values filled in, like "/points/38.8894,-77.0352". */
  path: string;
  query?: Record<string, string | number | boolean>;
}

export interface PublicAnswer<T = unknown> {
  /** The API's own HTTP status: 200, or 404 for a place or title it doesn't know, and so on. */
  status: number;
  data: T;
  /** The line to show next to it, like "Weather from the National Weather Service". */
  credit: string;
  cached: boolean;
  /** True in a build: a recorded sample. */
  simulated?: boolean;
}

interface Reply<T> extends PublicAnswer<T> {
  api: string;
  route: string;
}

/** Lets the build's smoke test check that the page shows what this server got (tests/caps/connect.ts). Builds only. */
function noteSample(reply: Reply<unknown>): void {
  try {
    const dir = path.join(process.cwd(), "test-results", "caps");
    const file = path.join(dir, "connect-fetched.json");
    mkdirSync(dir, { recursive: true });
    let seen: Record<string, unknown> = {};
    try {
      seen = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      seen = {};
    }
    seen[`${reply.api}.${reply.route}`] = reply.data;
    writeFileSync(file, JSON.stringify(seen));
  } catch {
    // Only the smoke test reads it.
  }
}

/** One call to a public API. Throws CapError when the gateway refuses it (not picked, a bad path, a limit). */
export async function fetchPublic<T = unknown>(request: RequestLike | null | undefined, req: PublicRequest): Promise<PublicAnswer<T>> {
  const reply = await gatewayCall<Reply<T>>(request, "POST", "/fetch", { api: req.api, path: req.path, ...(req.query ? { query: req.query } : {}) });
  if (reply.simulated) noteSample(reply);
  return { status: reply.status, data: reply.data, credit: reply.credit, cached: reply.cached, ...(reply.simulated ? { simulated: true } : {}) };
}
