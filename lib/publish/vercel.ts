/**
 * CONTRACT (owned by the sandbox agent). The platform, never the sandbox, talks to Vercel.
 */

export interface StartDeployInput {
  sandboxName: string;
  slug: string;
  productName: string;
  /** Set on the project as encrypted env vars: GATEWAY_URL and PRODUCT_TOKEN (the live token). */
  env: Record<string, string>;
  /** Reuse the product's project on redeploys. */
  projectId?: string | null;
}

/**
 * Reads the product's source out of the sandbox (no node_modules, .next, test-results, inspo or .env files), creates
 * or reuses the Vercel project `musemuse-<slug>` (framework nextjs, no deployment protection on production), sets the
 * env vars, and creates a production deployment from the files so Vercel builds it. Returns immediately.
 */
export async function startDeployFromSandbox(
  input: StartDeployInput,
): Promise<{ projectId: string; deploymentId: string; url: string }> {
  void input;
  throw new Error("startDeployFromSandbox: not implemented");
}

export interface DeployPoll {
  state: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
  /** The stable production URL (https://musemuse-<slug>.vercel.app or the project's production alias). */
  url: string;
  errorMessage?: string;
}

export async function pollDeploy(deploymentId: string): Promise<DeployPoll> {
  void deploymentId;
  throw new Error("pollDeploy: not implemented");
}
