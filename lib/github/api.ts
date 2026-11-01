/** GitHub's web and REST calls the export needs, and the signed state of a sign-in (docs/GITHUB_EXPORT.md). No error carries a token. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export interface GitHubConfig {
  webUrl: string;
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/**
 * The one scope that can create a private repo with an OAuth App and push to it. GitHub has nothing narrower, so it also
 * reaches the person's other repos: lib/github/export.ts only ever writes to a repo it created.
 */
export const GITHUB_SCOPE = "repo";
export const CALLBACK_PATH = "/api/connect/github/callback";
export const STATE_COOKIE = "mm_github_state";
export const STATE_MINUTES = 10;

const loopback = (url: string) => {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

/** GitHub itself, or on a run outside Vercel, a mock on this machine. A deployed site can't be pointed anywhere else. */
function baseUrl(override: string | undefined, real: string): string {
  return override && !process.env.VERCEL_ENV && loopback(override) ? override.replace(/\/+$/, "") : real;
}

/** Null until the owner has set up the OAuth app and the sealing key. */
export function githubConfig(): GitHubConfig | null {
  const { githubClientId: clientId, githubClientSecret: clientSecret, connectedAccountsKey } = env;
  if (!clientId || !clientSecret || !connectedAccountsKey) return null;
  return { clientId, clientSecret, webUrl: baseUrl(process.env.GITHUB_WEB_URL_LOCAL, "https://github.com"), apiUrl: baseUrl(process.env.GITHUB_API_URL_LOCAL, "https://api.github.com") };
}

export const callbackUrl = () => `${env.platformUrl}${CALLBACK_PATH}`;

// ---------- The state of one sign-in ----------

export interface OAuthState {
  state: string;
  /** The owner who started, so a callback finishes only for them. */
  owner: string;
  slug: string;
  exp: number;
}

const signState = (payload: string) => createHmac("sha256", env.sessionSecret).update(`github-state\0${payload}`).digest("base64url");

export function newOAuthState(owner: string, slug: string, now = Date.now()): { state: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ state, owner, slug, exp: now + STATE_MINUTES * 60_000 } satisfies OAuthState)).toString("base64url");
  return { state, cookie: `${payload}.${signState(payload)}` };
}

export function readOAuthState(cookie: string | undefined, now = Date.now()): OAuthState | null {
  const [payload, mac, extra] = (cookie ?? "").split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const given = Buffer.from(mac);
  const wanted = Buffer.from(signState(payload));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    return typeof data.state === "string" && typeof data.owner === "string" && typeof data.slug === "string" && data.exp >= now ? data : null;
  } catch {
    return null;
  }
}

export function stateMatches(a: string, b: string | null): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authorizeUrl(config: GitHubConfig, state: string): string {
  const q = new URLSearchParams({ client_id: config.clientId, redirect_uri: callbackUrl(), scope: GITHUB_SCOPE, state });
  return `${config.webUrl}/login/oauth/authorize?${q}`;
}

// ---------- Calls ----------

const SIGNAL_MS = 20_000;

function restHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "muse-muse" };
}

export async function exchangeCode(config: GitHubConfig, code: string): Promise<{ token: string; scopes: string } | null> {
  const res = await (config.fetch ?? fetch)(`${config.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "muse-muse" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl() }),
    redirect: "error",
    signal: AbortSignal.timeout(SIGNAL_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: unknown; scope?: unknown };
  return typeof data.access_token === "string" && data.access_token ? { token: data.access_token, scopes: typeof data.scope === "string" ? data.scope : "" } : null;
}

export async function fetchAccount(config: GitHubConfig, token: string): Promise<{ id: string; login: string } | null> {
  const res = await (config.fetch ?? fetch)(`${config.apiUrl}/user`, { headers: restHeaders(token), redirect: "error", signal: AbortSignal.timeout(SIGNAL_MS) });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: unknown; login?: unknown };
  return typeof data.id === "number" && typeof data.login === "string" ? { id: String(data.id), login: data.login } : null;
}

/** GitHub lists granted scopes split by commas, and "repo" must be one of them to make a private repo. */
export const hasRepoScope = (scopes: string) => scopes.split(/[,\s]+/).includes(GITHUB_SCOPE);

export function isValidRepoName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(name) && !/^\.+$/.test(name) && !/\.git$/i.test(name);
}

export type CreateRepo = { ok: true; fullName: string; branch: string; isPrivate: boolean } | { ok: false; why: "name_taken" | "bad_token" | "failed" };

export async function createRepo(config: GitHubConfig, token: string, input: { name: string; isPrivate: boolean; description: string }): Promise<CreateRepo> {
  const res = await (config.fetch ?? fetch)(`${config.apiUrl}/user/repos`, {
    method: "POST",
    headers: { ...restHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, private: input.isPrivate, description: input.description.replace(/[\u0000-\u001f]/g, " ").slice(0, 300), auto_init: false }),
    redirect: "error",
    signal: AbortSignal.timeout(SIGNAL_MS),
  });
  if (res.status === 401) return { ok: false, why: "bad_token" };
  if (res.status === 422) return { ok: false, why: "name_taken" };
  if (res.status !== 201) return { ok: false, why: "failed" };
  const data = (await res.json()) as { full_name?: unknown; default_branch?: unknown; private?: unknown };
  if (typeof data.full_name !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(data.full_name)) return { ok: false, why: "failed" };
  const branch = typeof data.default_branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(data.default_branch) ? data.default_branch : "main";
  return { ok: true, fullName: data.full_name, branch, isPrivate: data.private !== false };
}

/** Whether the repo a push is about to go to still exists for this token. */
export async function repoState(config: GitHubConfig, token: string, fullName: string): Promise<"there" | "gone" | "bad_token" | "unknown"> {
  const res = await (config.fetch ?? fetch)(`${config.apiUrl}/repos/${fullName}`, { headers: restHeaders(token), redirect: "manual", signal: AbortSignal.timeout(SIGNAL_MS) });
  return res.status === 200 ? "there" : res.status === 404 ? "gone" : res.status === 401 ? "bad_token" : "unknown";
}

/** Asks GitHub to end this app's grant for the token. False when it couldn't: the person is then told to do it themselves. */
export async function revokeGrant(config: GitHubConfig, token: string): Promise<boolean> {
  try {
    const res = await (config.fetch ?? fetch)(`${config.apiUrl}/applications/${encodeURIComponent(config.clientId)}/grant`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "muse-muse", "content-type": "application/json" },
      body: JSON.stringify({ access_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(SIGNAL_MS),
    });
    return res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}
