/**
 * Network policy for a builder sandbox, in the shape the Vercel Sandbox firewall documents for `networkPolicy`
 * (https://vercel.com/docs/sandbox/concepts/firewall). Check it against the @vercel/sandbox types at kickoff.
 *
 * Deny by default. The real Meta key is injected into requests to api.meta.ai by the firewall
 * (credentials brokering), so code inside the sandbox, including generated product code, never sees it.
 */
export interface TransformRule {
  transform: Array<{ headers: Record<string, string> }>;
}

export type AllowMap = Record<string, TransformRule[]>;

export interface BuilderPolicyOptions {
  /** The platform's Meta key. It goes into the firewall rule only, never into the sandbox env. */
  modelApiKey: string;
  /** Host of this platform, so product tests can reach the gateway with the build token. */
  platformHost: string;
}

export function builderNetworkPolicy(opts: BuilderPolicyOptions): { allow: AllowMap } {
  return {
    allow: {
      "api.meta.ai": [{ transform: [{ headers: { Authorization: `Bearer ${opts.modelApiKey}` } }] }],
      "registry.npmjs.org": [],
      [opts.platformHost]: [],
    },
  };
}

/**
 * Snapshot creation runs once with allow-all so the Muse Code installer, npm packages and Playwright's Chromium can
 * download. Builds then run from that snapshot with builderNetworkPolicy().
 */
export const SNAPSHOT_POLICY = "allow-all" as const;
