import { env } from "@/lib/env";

/**
 * A taken-down product's site on Vercel (TRUST_REPORTS). Removing one domain isn't enough: a production deployment is
 * also served at its own unique URL and at a team-scoped alias, and products have no deployment protection. So the
 * takedown pauses the whole project, which blocks its active production deployment at every address and stops new
 * domains being assigned to it, and undoing it unpauses. Removing the production domain is the backup, for when the
 * pause call fails. Plain REST calls with VERCEL_TOKEN, scoped to VERCEL_TEAM_ID, as lib/publish/vercel.ts makes them:
 * POST /v1/projects/{id}/pause and /unpause (the routes @vercel/sdk 1.28's pauseProject and unpauseProject call),
 * DELETE /v9/projects/{id}/domains/{domain} and POST /v10/projects/{id}/domains. Tested against a fake API only: check
 * pause and unpause once on a throwaway project before TRUST_REPORTS goes on (docs/CAPABILITIES.md, 7a).
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
    /** Pauses the project: its active production deployment stops being served, at every address. */
    async pause(projectId: string): Promise<void> {
      const res = await call(cfg, "POST", `/v1/projects/${encodeURIComponent(projectId)}/pause`);
      if (!res.ok) await fail(res, "pausing the project");
    },
    /** Unpauses it. */
    async unpause(projectId: string): Promise<void> {
      const res = await call(cfg, "POST", `/v1/projects/${encodeURIComponent(projectId)}/unpause`);
      if (!res.ok) await fail(res, "unpausing the project");
    },
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
