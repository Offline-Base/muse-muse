/**
 * The live check (ENGINE_LIVE_SMOKE, docs/CAPABILITIES.md section 8 and decision 15): after deploy, before a product is
 * marked live, its live link must load, and its routes must be there. It makes no model call and costs nothing:
 *
 * 1. GET / answers 200 with an HTML page, retried a few times while a fresh deployment warms up.
 * 2. Each action route answers OPTIONS with POST allowed. Next answers OPTIONS itself for a route that doesn't export
 *    it, so no product code runs, and a missing route answers 404.
 * 3. A product with platform services also answers GET /api/musemuse/health with {"ok":true} (the core overlay's route),
 *    which says the deploy env reached it, without showing any value.
 * 4. Each route a cap adds (CAP_LIVE_PATHS in lib/caps/live.ts) answers GET with {"ok":true}, such as the runtime cap's
 *    Python health function. None for a product without them.
 */

export interface LiveCheckResult {
  ok: boolean;
  url: string;
  at: string;
  reason?: string;
  checks: Array<{ path: string; ok: boolean; status: number | null }>;
}

export interface LiveCheckInput {
  url: string;
  /** Action names from the product's musemuse.json. At most MAX_ACTIONS are probed. */
  actions: string[];
  /** True when the product has the core overlay's health route. */
  health: boolean;
  /** Routes its caps add, each loaded after the health route (lib/caps/live.ts). */
  capPaths?: ReadonlyArray<{ path: string; what: string }>;
  fetch?: typeof fetch;
  /** Tries for the page, for a deployment that is still warming up. */
  attempts?: number;
  waitMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export const MAX_ACTIONS = 6;
export const HEALTH_PATH = "/api/musemuse/health";

function origin(url: string): string {
  return url.replace(/\/+$/, "");
}

async function get(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return f(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "MuseMuse-LiveCheck/1", ...(init.headers ?? {}) } });
}

function why(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return `no answer within ${Math.round(timeoutMs / 1000)} seconds`;
  return "the link couldn't be reached";
}

export async function liveCheck(input: LiveCheckInput): Promise<LiveCheckResult> {
  const f = input.fetch ?? fetch;
  const attempts = Math.max(1, input.attempts ?? 3);
  const waitMs = input.waitMs ?? 3000;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const base = origin(input.url);
  const checks: LiveCheckResult["checks"] = [];
  const at = (input.now ?? (() => new Date()))().toISOString();
  const fail = (reason: string): LiveCheckResult => ({ ok: false, url: base, at, reason, checks });

  let page: { status: number | null; reason: string | null } = { status: null, reason: "it was never loaded" };
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, waitMs));
    try {
      const res = await get(f, `${base}/`, { method: "GET" }, timeoutMs);
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (res.status === 200 && type.includes("text/html") && /<html[\s>]/i.test(body)) {
        page = { status: 200, reason: null };
        break;
      }
      page = {
        status: res.status,
        reason:
          res.status === 401 || res.status === 403
            ? `the page asks for a sign-in (HTTP ${res.status}), so visitors can't open it`
            : res.status === 200
              ? "the page answered without an HTML page"
              : `the page answered HTTP ${res.status}`,
      };
      if (res.status === 401 || res.status === 403 || res.status === 404) break;
    } catch (err) {
      page = { status: null, reason: `the page gave ${why(err, timeoutMs)}` };
    }
  }
  checks.push({ path: "/", ok: page.reason === null, status: page.status });
  if (page.reason) return fail(page.reason);

  for (const name of input.actions.slice(0, MAX_ACTIONS)) {
    const path = `/api/actions/${encodeURIComponent(name)}`;
    try {
      const res = await get(f, `${base}${path}`, { method: "OPTIONS" }, timeoutMs);
      await res.arrayBuffer().catch(() => undefined);
      const allow = (res.headers.get("allow") ?? "").toUpperCase();
      const ok = res.status < 400 && (!allow || allow.includes("POST"));
      checks.push({ path, ok, status: res.status });
      if (!ok) {
        return fail(
          res.status === 404
            ? `the action route ${path} is missing`
            : res.status < 400
              ? `the action route ${path} doesn't take POST`
              : `the action route ${path} answered HTTP ${res.status}`,
        );
      }
    } catch (err) {
      checks.push({ path, ok: false, status: null });
      return fail(`the action route ${path} gave ${why(err, timeoutMs)}`);
    }
  }

  if (input.health) {
    try {
      const res = await get(f, `${base}${HEALTH_PATH}`, { method: "GET" }, timeoutMs);
      const json = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      const ok = res.status === 200 && json?.ok === true;
      checks.push({ path: HEALTH_PATH, ok, status: res.status });
      if (!ok) return fail(res.status === 200 ? "its health check says the platform services aren't set up" : `its health check answered HTTP ${res.status}`);
    } catch (err) {
      checks.push({ path: HEALTH_PATH, ok: false, status: null });
      return fail(`its health check gave ${why(err, timeoutMs)}`);
    }
  }

  // ---------- Wave 3, unit 10: routes the caps add (lib/caps/live.ts). None for a product without them ----------
  for (const extra of input.capPaths ?? []) {
    try {
      const res = await get(f, `${base}${extra.path}`, { method: "GET" }, timeoutMs);
      const json = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      const ok = res.status === 200 && json?.ok === true;
      checks.push({ path: extra.path, ok, status: res.status });
      if (!ok) return fail(`${extra.what} (${extra.path} answered HTTP ${res.status})`);
    } catch (err) {
      checks.push({ path: extra.path, ok: false, status: null });
      return fail(`${extra.what} (${extra.path} gave ${why(err, timeoutMs)})`);
    }
  }
  // ---------- end Wave 3, unit 10 ----------
  return { ok: true, url: base, at, checks };
}
