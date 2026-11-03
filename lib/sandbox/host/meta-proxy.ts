import { createHmac, timingSafeEqual } from "node:crypto";
import { BROKERED_META_ROUTES, META_BLOCKED_BODY } from "@/lib/sandbox/policy";

/**
 * The Meta proxy for Modal build sandboxes (SANDBOX_HOST=modal, docs/MODAL_HOST.md).
 *
 * On Vercel, the sandbox firewall swaps a per-sandbox placeholder for the real Meta key on BROKERED_META_ROUTES only
 * (lib/sandbox/policy.ts). Modal has no firewall that matches a route and a header, so a Modal sandbox never talks to
 * api.meta.ai with a key at all. Muse Code's endpoint is this platform instead (MODAL_META_PATH), and this route:
 *   1. answers 404 unless SANDBOX_HOST is modal, so on the default host it isn't there;
 *   2. takes only a token minted for one sandbox (mintSandboxMetaToken), signed with a key derived from the real key,
 *      and refuses it once it expires;
 *   3. forwards only BROKERED_META_ROUTES, with their methods, and answers everything else 403 itself;
 *   4. sends the request on to api.meta.ai with the real key from server env, and no other request header than
 *      Content-Type and Accept, so nothing from the sandbox (cookies, other auth) rides along.
 * The real key never goes into the sandbox, its env, its files or its egress rules.
 */

export const META_ORIGIN = "https://api.meta.ai";
/** Muse Code's base_url is `${platformUrl}${MODAL_META_PATH}`. It calls `${base_url}/responses`. */
export const MODAL_META_PATH = "/api/sandbox-meta/v1";
const TOKEN_PREFIX = "mmx";
const SANDBOX_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function signature(modelApiKey: string, sandboxName: string, expiresAt: number): string {
  return createHmac("sha256", modelApiKey).update(`musemuse-modal-meta:${sandboxName}:${expiresAt}`).digest("hex").slice(0, 48);
}

/**
 * The key Muse Code in a Modal sandbox sends: names the sandbox and when it stops working, and is signed with an HMAC
 * of the real key, so it needs no storage, can't be guessed and reveals nothing about the key. Only the Muse Code
 * runner exports it, as on Vercel.
 */
export function mintSandboxMetaToken(modelApiKey: string, sandboxName: string, expiresAt: number): string {
  if (!SANDBOX_NAME.test(sandboxName)) throw new Error(`Not a sandbox name: ${sandboxName}`);
  const exp = Math.floor(expiresAt);
  return `${TOKEN_PREFIX}.${exp.toString(36)}.${sandboxName}.${signature(modelApiKey, sandboxName, exp)}`;
}

/** The sandbox a token was minted for, or null when it is malformed, forged or expired. */
export function verifySandboxMetaToken(modelApiKey: string, token: string, now: number = Date.now()): { sandboxName: string } | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;
  const [, exp36, sandboxName, sig] = parts as [string, string, string, string];
  if (!/^[0-9a-z]{1,12}$/.test(exp36) || !SANDBOX_NAME.test(sandboxName) || !/^[0-9a-f]{48}$/.test(sig)) return null;
  const exp = parseInt(exp36, 36);
  if (!Number.isFinite(exp) || exp <= now) return null;
  const want = Buffer.from(signature(modelApiKey, sandboxName, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? { sandboxName } : null;
}

/**
 * Muse Code settings that point it at the proxy (docs/spikes/musecode-2026-10-31: the bearer is only sent off Meta's
 * own host when `auth` is pinned), and turn telemetry off, which otherwise goes to api.meta.ai directly.
 */
export function modalMuseSettings(platformUrl: string): string[] {
  const base = `${platformUrl.replace(/\/$/, "")}${MODAL_META_PATH}`;
  return [`endpoint_transport=${JSON.stringify({ base_url: base, auth: "bearer" })}`, "telemetry.enabled=false"];
}

/** The Meta path a proxied request is for: `/v1/<rest>` under MODAL_META_PATH, or Muse Code's catalog at the root. */
export function metaPathFor(segments: readonly string[]): string | null {
  if (segments.some((s) => !s || s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("%"))) return null;
  return `/${segments.join("/")}`;
}

export interface MetaProxyDeps {
  enabled: boolean;
  modelApiKey: () => string;
  fetch?: typeof fetch;
  now?: () => number;
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/** Handles one request to the proxy. `segments` is the Meta path split on "/", such as ["v1", "responses"]. */
export async function handleSandboxMeta(req: Request, segments: readonly string[], deps: MetaProxyDeps): Promise<Response> {
  if (!deps.enabled) return text(404, "Not found");
  const path = metaPathFor(segments);
  const method = req.method.toUpperCase();
  const route = path ? BROKERED_META_ROUTES.find((r) => r.path === path && r.methods.includes(method)) : undefined;
  if (!path || !route) return text(403, META_BLOCKED_BODY);
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "";
  const modelApiKey = deps.modelApiKey();
  if (!token || !verifySandboxMetaToken(modelApiKey, token, (deps.now ?? Date.now)())) return text(401, "This sandbox's Meta key isn't valid, or it has expired.");

  const headers: Record<string, string> = { authorization: `Bearer ${modelApiKey}` };
  for (const name of ["content-type", "accept"]) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  const upstream = await (deps.fetch ?? fetch)(`${META_ORIGIN}${path}`, {
    method,
    headers,
    ...(hasBody ? { body: req.body, duplex: "half" } : {}),
    redirect: "manual",
  } as RequestInit);
  const out = new Headers({ "cache-control": "no-store" });
  const type = upstream.headers.get("content-type");
  if (type) out.set("content-type", type);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
