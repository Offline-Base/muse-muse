import { env } from "@/lib/env";

/**
 * A taken-down product's public link (TRUST_REPORTS): its production domain on its Vercel project, removed at takedown
 * and added back when the takedown is undone. Plain REST calls with VERCEL_TOKEN, scoped to VERCEL_TEAM_ID, as
 * lib/publish/vercel.ts makes them: DELETE /v9/projects/{id}/domains/{domain} and POST /v10/projects/{id}/domains.
 */
const API = "https://api.vercel.com";

export interface AliasConfig {
  token: string;
  teamId?: string;
  fetch: typeof fetch;
}

async function call(cfg: AliasConfig, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(path, API);
  if (cfg.teamId) url.searchParams.set("teamId", cfg.teamId);
  return cfg.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => "");
  let message = "";
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    message = text.slice(0, 200);
  }
  throw new Error(`Vercel API ${what} failed (${res.status})${message ? `: ${message}` : ""}`);
}

export function productAlias(cfg: AliasConfig) {
  return {
    /** Removes the domain from the project. A domain that's already gone counts as removed. */
    async remove(projectId: string, host: string): Promise<void> {
      const res = await call(cfg, "DELETE", `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(host)}`);
      if (!res.ok && res.status !== 404) await fail(res, `removing ${host}`);
    },
    /** Adds the domain back. One that's already there counts as restored. */
    async restore(projectId: string, host: string): Promise<void> {
      const res = await call(cfg, "POST", `/v10/projects/${encodeURIComponent(projectId)}/domains`, { name: host });
      if (!res.ok && res.status !== 409) await fail(res, `adding ${host}`);
    },
  };
}

/** The real alias calls, or null where products aren't published (no VERCEL_TOKEN, or a local run). */
export function platformAlias(): ReturnType<typeof productAlias> | null {
  if (env.publishOffReason) return null;
  return productAlias({ token: env.vercelToken, teamId: env.vercelTeamId, fetch: (input, init) => fetch(input, init) });
}
