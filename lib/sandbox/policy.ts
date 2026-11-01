import { createHmac } from "node:crypto";
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

/**
 * Network policy for a builder sandbox, in @vercel/sandbox's NetworkPolicy shape
 * (https://vercel.com/docs/sandbox/concepts/firewall).
 *
 * Deny by default. The real Meta key is injected into requests to api.meta.ai by the firewall (credentials
 * brokering, confirmed in docs/SPIKES.md), so code inside the sandbox, including generated product code, never sees
 * it. Only Muse Code's own calls get the key: they must be one of BROKERED_META_ROUTES and carry the sandbox's
 * placeholder key, which only the Muse Code runner exports. The firewall answers every other api.meta.ai request
 * itself with a 403. Product code reaches Meta through the platform gateway instead.
 */
export interface BuilderPolicyOptions {
  /** The platform's Meta key. It goes into the firewall rule only, never into the sandbox env or files. */
  modelApiKey: string;
  /** What Muse Code sends as its key (META_API_KEY), from placeholderKey(). Requests without it never get the real key. */
  placeholderKey: string;
  /** Host of this platform, so product tests can reach the gateway with the build token. Null when it isn't public. */
  platformHost: string | null;
  /**
   * Allow Vercel Blob's client-upload API, which products' browsers use after the gateway's /uploads route hands out
   * a client token. Needed when a smoke test uploads a fixture that way.
   */
  blobUploads?: boolean;
  /**
   * Local runs only (platformHost is null): the sandbox can't reach the gateway, so the product calls Meta itself with
   * the same placeholder key, and these extra routes are brokered too (DIRECT_PRODUCT_ROUTES).
   */
  directProducts?: boolean;
  /** Prove it's copy only: one live product's own host, so the outputs can be run against it. */
  extraHosts?: readonly string[];
  /**
   * Hosts a brief's caps need during the build (CAP_BUILD_HOSTS in lib/caps/hosts.ts, docs/CAPABILITIES.md section 3),
   * allowed with no rules. None for a brief without caps, so its policy is today's.
   */
  capHosts?: readonly string[];
  /**
   * Preview deployments only: Vercel's Protection Bypass for Automation secret and the one host it is for, the preview's
   * own (env.previewBypass). When that host is platformHost, the firewall adds the secret to every request to it as
   * x-vercel-protection-bypass, with Host pinned to it, and refuses a request for a bypass cookie, so the sandbox
   * reaches a protected Preview without ever seeing the secret or anything that does its job. For any other
   * platformHost the secret is left out, so it never goes to a host it isn't for.
   */
  platformBypass?: PlatformBypass | null;
}

/** A Protection Bypass for Automation secret, with the host it may be sent to. */
export interface PlatformBypass {
  host: string;
  secret: string;
}

/** The header Vercel reads a Protection Bypass for Automation secret from. */
export const PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * The header or query parameter that asks Vercel to answer a bypassed request with a cookie that bypasses Deployment
 * Protection on that host from then on. A sandbox never gets to ask: the cookie would land inside it, where the
 * product's code and Muse Code could read it and send it out, so it would do the secret's job outside the firewall.
 */
export const SET_BYPASS_COOKIE = "x-vercel-set-bypass-cookie";

/** Header names are compared in any case, as HTTP does. */
export const SET_BYPASS_COOKIE_HEADER_KEY = `(?i)^${SET_BYPASS_COOKIE}$`;

/**
 * Query keys in any case, and any key with a "%" in it, so an encoded spelling such as x-vercel-set-bypass%2Dcookie is
 * refused whether the firewall compares keys before or after decoding them. The platform's own calls never encode a key.
 */
export const SET_BYPASS_COOKIE_QUERY_KEY = `(?i)^${SET_BYPASS_COOKIE}$|%`;

export const BYPASS_COOKIE_BLOCKED_BODY = "Blocked by the Muse Muse build firewall. Sandboxes can't ask for a Deployment Protection bypass cookie.";

/**
 * The platform host's rules when the firewall adds the bypass secret (README.md, Preview database). Rules run in order
 * and the first that matches wins:
 * 1. A request that asks for a bypass cookie, as a header or as a query parameter, gets a 403 from the firewall itself
 *    and never reaches Vercel.
 * 2. Every other request gets the secret, with its Host header pinned to the platform's host. The firewall picks a
 *    domain's rules by the connection's SNI alone and passes the client's Host through, so without the pin, code in the
 *    sandbox could name the platform in the SNI and another site on Vercel's edge in Host (domain fronting), and the
 *    secret would go to that site. This rule has no match, so no request can skip the pin.
 */
function platformBypassRules(host: string, secret: string): NetworkPolicyRule[] {
  const refused = { statusCode: 403, body: BYPASS_COOKIE_BLOCKED_BODY, contentType: "text/plain" };
  return [
    { match: { headers: [{ key: { regex: SET_BYPASS_COOKIE_HEADER_KEY } }] }, response: refused },
    { match: { queryString: [{ key: { regex: SET_BYPASS_COOKIE_QUERY_KEY } }] }, response: refused },
    { transform: [{ headers: { Host: host, [PROTECTION_BYPASS_HEADER]: secret } }] },
  ];
}

/** Hosts @vercel/blob's client `upload()` talks to: the API that takes the PUT, and the store that serves it. */
export const BLOB_UPLOAD_HOSTS = ["vercel.com", "*.blob.vercel-storage.com"] as const;

/**
 * The only api.meta.ai calls that get the real key: what Muse Code 1.4.13's `muse exec` calls, from the routes in
 * its binary (Oct 27). Without /muse-code/models it exits with "failed to fetch model catalog: API error 403".
 * Listing, reading or deleting files, images, transcription, Muse Code's telemetry and web tools and everything else
 * are refused at the firewall.
 */
export const BROKERED_META_ROUTES: ReadonlyArray<{ methods: string[]; path: string }> = [
  // Model calls (streamed Responses API).
  { methods: ["POST"], path: "/v1/responses" },
  // Muse Code's model catalog, read at startup. Its method isn't visible in the binary, so both are allowed.
  { methods: ["GET", "POST"], path: "/muse-code/models" },
  // Upload only. Muse Code sends a video it reads to the Files API.
  { methods: ["POST"], path: "/v1/files" },
  { methods: ["GET"], path: "/v1/models" },
];

/** What a product calls besides /v1/responses and /v1/files when it talks to Meta directly (directProducts). */
export const DIRECT_PRODUCT_ROUTES: ReadonlyArray<{ methods: string[]; path: string }> = [
  { methods: ["POST"], path: "/v1/images/generations" },
  { methods: ["POST"], path: "/v1/images/edits" },
  { methods: ["POST"], path: "/v1/asr/transcribe" },
];

export const META_BLOCKED_BODY = "Blocked by the Muse Muse build firewall. Products call Meta through GATEWAY_URL.";

/**
 * A per-sandbox stand-in for the Meta key, derived from the real key so it needs no storage and can't be guessed.
 * It reveals nothing about the key.
 */
export function placeholderKey(modelApiKey: string, sandboxName: string): string {
  return `mm_sandbox_${createHmac("sha256", modelApiKey).update(`musemuse-placeholder:${sandboxName}`).digest("hex").slice(0, 40)}`;
}

export function builderNetworkPolicy(opts: BuilderPolicyOptions): NetworkPolicy {
  const placeholder = { key: { regex: "(?i)^authorization$" }, value: { exact: `Bearer ${opts.placeholderKey}` } };
  const routes = opts.directProducts ? [...BROKERED_META_ROUTES, ...DIRECT_PRODUCT_ROUTES] : BROKERED_META_ROUTES;
  const meta: NetworkPolicyRule[] = routes.map((route) => ({
    match: { method: [...route.methods], path: { exact: route.path }, headers: [placeholder] },
    transform: [{ headers: { Authorization: `Bearer ${opts.modelApiKey}` } }],
  }));
  meta.push({ response: { statusCode: 403, body: META_BLOCKED_BODY, contentType: "text/plain" } });
  const allow: Record<string, NetworkPolicyRule[]> = {
    "api.meta.ai": meta,
    "registry.npmjs.org": [],
  };
  if (opts.platformHost) {
    const bypass = opts.platformBypass;
    const forThisHost = Boolean(bypass?.secret) && bypass?.host.toLowerCase() === opts.platformHost.toLowerCase();
    allow[opts.platformHost] = bypass && forThisHost ? platformBypassRules(opts.platformHost, bypass.secret) : [];
  }
  if (opts.blobUploads) for (const host of BLOB_UPLOAD_HOSTS) allow[host] = [];
  for (const host of opts.extraHosts ?? []) allow[host] = [];
  // A cap host never replaces a rule above: api.meta.ai keeps its brokered routes whatever a cap lists.
  for (const host of opts.capHosts ?? []) allow[host] ??= [];
  return { allow };
}

/**
 * The host to allow for the platform, from an origin like https://musemuse.vercel.app. Null for localhost and bare
 * IPs: a sandbox can't reach a laptop, and the firewall takes domain names.
 */
export function publicHost(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  return host;
}

/**
 * Snapshot creation runs once with allow-all so the Muse Code installer, npm packages, apt and Playwright's Chromium
 * can download. Builds then run from that snapshot with builderNetworkPolicy().
 */
export const SNAPSHOT_POLICY: NetworkPolicy = "allow-all";
