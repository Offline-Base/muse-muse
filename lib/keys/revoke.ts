/**
 * The kill switch's logic (scripts/keys/revoke-shared.ts, docs/BUILD_KEYS.md): every product project (musemuse-*) that
 * holds a shared key's name loses it. A dry run lists what it would remove and changes nothing. Only project names and
 * var names are ever printed, never a value.
 */
import { SHARED_ENV_NAMES } from "@/lib/keys/shared";

/** The prefix lib/publish/vercel.ts projectNameFor gives every product's project. */
export const PRODUCT_PROJECT_PREFIX = "musemuse-";

export interface RevokeApi {
  /** Every project the token can see whose name starts with PRODUCT_PROJECT_PREFIX. */
  listProjects(): Promise<Array<{ id: string; name: string }>>;
  /** The project's env vars: ids and names only are read. */
  listEnv(projectId: string): Promise<Array<{ id: string; key: string }>>;
  deleteEnv(projectId: string, envId: string): Promise<void>;
}

export interface RevokePlanItem {
  project: { id: string; name: string };
  vars: Array<{ id: string; key: string }>;
}

export interface RevokeResult {
  /** Projects looked at. */
  checked: number;
  plan: RevokePlanItem[];
  /** Vars removed: 0 on a dry run. */
  removed: number;
  /** Projects whose vars couldn't all be read or removed, with a plain reason. */
  failed: Array<{ project: string; reason: string }>;
}

/**
 * Finds every shared var on every product project and, with `apply`, deletes it. `only` keeps it to projects with those
 * names. Errors for one project are counted and the rest go on, so one bad project never leaves the others with keys.
 */
export async function revokeShared(api: RevokeApi, opts: { apply: boolean; only?: readonly string[]; log?: (line: string) => void }): Promise<RevokeResult> {
  const log = opts.log ?? (() => {});
  const names = new Set(SHARED_ENV_NAMES);
  const projects = (await api.listProjects()).filter((p) => p.name.startsWith(PRODUCT_PROJECT_PREFIX) && (!opts.only?.length || opts.only.includes(p.name)));
  const result: RevokeResult = { checked: projects.length, plan: [], removed: 0, failed: [] };
  for (const project of projects) {
    let vars: Array<{ id: string; key: string }>;
    try {
      vars = (await api.listEnv(project.id)).filter((e) => names.has(e.key)).map((e) => ({ id: e.id, key: e.key }));
    } catch (err) {
      result.failed.push({ project: project.name, reason: plainError(err) });
      continue;
    }
    if (!vars.length) continue;
    result.plan.push({ project, vars });
    const keys = vars.map((v) => v.key).join(", ");
    if (!opts.apply) {
      log(`would remove ${keys} from ${project.name}`);
      continue;
    }
    for (const v of vars) {
      try {
        await api.deleteEnv(project.id, v.id);
        result.removed += 1;
      } catch (err) {
        result.failed.push({ project: project.name, reason: `${v.key}: ${plainError(err)}` });
      }
    }
    log(`removed ${keys} from ${project.name}`);
  }
  return result;
}

/** An error's first line, cut short. Vercel's errors name things, never a var's value. */
function plainError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
}

/** The Vercel REST calls, with the platform's VERCEL_TOKEN for the team that holds the products (VERCEL_TEAM_ID). */
export function vercelRevokeApi(token: string, teamId: string | null, fetcher: typeof fetch = fetch): RevokeApi {
  const call = async <T>(method: string, path: string, query: Record<string, string> = {}): Promise<T> => {
    const url = new URL(path, "https://api.vercel.com");
    if (teamId) url.searchParams.set("teamId", teamId);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetcher(url, { method, headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) {
      let message = "";
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
      } catch {
        // Not JSON: the status says enough.
      }
      throw new Error(`Vercel API ${method} ${path} failed (${res.status})${message ? `: ${message}` : ""}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    async listProjects() {
      const out: Array<{ id: string; name: string }> = [];
      let next: string | number | null = null;
      for (let page = 0; page < 200; page++) {
        const query: Record<string, string> = { search: PRODUCT_PROJECT_PREFIX, limit: "100" };
        if (typeof next === "string") query.from = next;
        else if (typeof next === "number") query.until = String(next);
        const res = await call<{ projects?: Array<{ id: string; name: string }>; pagination?: { next?: string | number | null } } | Array<{ id: string; name: string }>>("GET", "/v10/projects", query);
        const projects = Array.isArray(res) ? res : (res?.projects ?? []);
        out.push(...projects.map((p) => ({ id: p.id, name: p.name })));
        next = Array.isArray(res) ? null : (res?.pagination?.next ?? null);
        if (next === null || !projects.length) break;
      }
      return out;
    },
    async listEnv(projectId) {
      const res = await call<{ envs?: Array<{ id: string; key: string }> }>("GET", `/v9/projects/${encodeURIComponent(projectId)}/env`);
      return (res?.envs ?? []).map((e) => ({ id: e.id, key: e.key }));
    },
    async deleteEnv(projectId, envId) {
      await call("DELETE", `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`);
    },
  };
}
