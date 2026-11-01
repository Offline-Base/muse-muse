import type { NetworkPolicy } from "@vercel/sandbox";
import { BYPASS_COOKIE_BLOCKED_BODY, PROTECTION_BYPASS_HEADER, SET_BYPASS_COOKIE_HEADER_KEY, SET_BYPASS_COOKIE_QUERY_KEY } from "@/lib/sandbox/policy";

/**
 * The firewalls of the code cap's own sandboxes (docs/CAPABILITIES.md, section 15). They are not builder sandboxes, so
 * lib/sandbox/policy.ts's rules (the brokered Meta key, npm, the platform host) never apply to them.
 */

/** /exec: no network at all. The program gets no secrets either: the sandbox env is empty. */
export function execPolicy(): NetworkPolicy {
  return "deny-all";
}

/**
 * Private, loopback, link-local and shared address ranges. A browse sandbox may reach none of them, whatever the host's
 * name resolves to there. IPv4 only: Vercel's sandbox API answers 400 "Invalid CIDR" to an IPv6 range and starts nothing
 * (seen Nov 1, 2026, with "::1/128"). The firewall's host allow list is what keeps everything else out.
 */
export const PRIVATE_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

/** A host name as browse takes it: letters, digits, dots and dashes, with a dot. */
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A host browse can put in its firewall: lower case, letters, digits, dots and dashes, with a dot, no trailing dot. */
export function isBrowseHost(host: string): boolean {
  return HOST.test(host);
}

/** /browse: only the one host the person typed, and no private address. */
export function browsePolicy(host: string): NetworkPolicy {
  const h = host.toLowerCase();
  if (!isBrowseHost(h)) throw new Error("browsePolicy takes a plain host name.");
  return { allow: [h], subnets: { deny: [...PRIVATE_CIDRS] } };
}

// ---------- Wave 3, unit 9: Muse Code sessions (docs/CAPABILITIES.md, 15b) ----------

/** The one platform route a Muse Code session's sandbox may call: model calls through the gateway. */
export const SESSION_GATEWAY_PATH = "/api/gateway/v1/responses";

export const SESSION_BLOCKED_BODY = "Blocked by the Muse Muse session firewall. A Muse Code session reaches only the gateway's model route and npm downloads.";

/**
 * A Muse Code session's firewall (spike, "What it means for the design" 8). The agent's shell can reach whatever is
 * allowed, so the platform host allows only POST /api/gateway/v1/responses, with Host pinned to the platform (no
 * fronting to another site on the same edge), and the firewall's own 403 for everything else, catalog included (the
 * spike: /muse-code/models is optional). npm is GET only, for the bridge's SDK. Nothing else is reachable.
 *
 * The rules have the shape lib/sandbox/policy.ts's capHostRules and api.meta.ai's routes have (a match that passes with
 * Host pinned, then a 403); this file adds no new shape. On a protected preview, the bypass secret is added at the
 * firewall, outside the VM, and a request for a bypass cookie is refused first, as policy.ts does for builds.
 */
export function sessionPolicy(platformHost: string, bypass?: { host: string; secret: string } | null): NetworkPolicy {
  const host = platformHost.toLowerCase();
  const refused = { statusCode: 403, body: SESSION_BLOCKED_BODY, contentType: "text/plain" };
  const withBypass = Boolean(bypass?.secret) && bypass!.host.toLowerCase() === host;
  const cookieRefused = { statusCode: 403, body: BYPASS_COOKIE_BLOCKED_BODY, contentType: "text/plain" };
  return {
    allow: {
      [host]: [
        ...(withBypass
          ? [
              { match: { headers: [{ key: { regex: SET_BYPASS_COOKIE_HEADER_KEY } }] }, response: cookieRefused },
              { match: { queryString: [{ key: { regex: SET_BYPASS_COOKIE_QUERY_KEY } }] }, response: cookieRefused },
            ]
          : []),
        {
          match: { method: ["POST"], path: { exact: SESSION_GATEWAY_PATH } },
          transform: [{ headers: { Host: host, ...(withBypass ? { [PROTECTION_BYPASS_HEADER]: bypass!.secret } : {}) } }],
        },
        { response: refused },
      ],
      "registry.npmjs.org": [{ match: { method: ["GET"] }, transform: [{ headers: { Host: "registry.npmjs.org" } }] }, { response: refused }],
    },
    subnets: { deny: [...PRIVATE_CIDRS] },
  };
}
