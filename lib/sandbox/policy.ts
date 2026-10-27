import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

/**
 * Network policy for a builder sandbox, in @vercel/sandbox's NetworkPolicy shape
 * (https://vercel.com/docs/sandbox/concepts/firewall).
 *
 * Deny by default. The real Meta key is injected into requests to api.meta.ai by the firewall (credentials
 * brokering, confirmed in docs/SPIKES.md), so code inside the sandbox, including generated product code, never sees
 * it. Muse Code runs with META_API_KEY=brokered.
 */
export interface BuilderPolicyOptions {
  /** The platform's Meta key. It goes into the firewall rule only, never into the sandbox env or files. */
  modelApiKey: string;
  /** Host of this platform, so product tests can reach the gateway with the build token. Null when it isn't public. */
  platformHost: string | null;
  /**
   * Allow Vercel Blob's client-upload API, which products' browsers use after the gateway's /uploads route hands out
   * a client token. Needed when a smoke test uploads a fixture that way.
   */
  blobUploads?: boolean;
}

/** Hosts @vercel/blob's client `upload()` talks to: the API that takes the PUT, and the store that serves it. */
export const BLOB_UPLOAD_HOSTS = ["vercel.com", "*.blob.vercel-storage.com"] as const;

export function builderNetworkPolicy(opts: BuilderPolicyOptions): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = {
    "api.meta.ai": [{ transform: [{ headers: { Authorization: `Bearer ${opts.modelApiKey}` } }] }],
    "registry.npmjs.org": [],
  };
  if (opts.platformHost) allow[opts.platformHost] = [];
  if (opts.blobUploads) for (const host of BLOB_UPLOAD_HOSTS) allow[host] = [];
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
