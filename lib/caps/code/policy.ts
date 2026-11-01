import type { NetworkPolicy } from "@vercel/sandbox";

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
 * name resolves to there.
 */
export const PRIVATE_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
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
