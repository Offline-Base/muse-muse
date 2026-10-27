/**
 * Arguments for running Muse Code headless inside a builder sandbox.
 * Flags come from https://dev.meta.ai/docs/muse-code/configuration and /extending.
 */
export type BuildModel = "muse-spark-1.3" | "muse-wonder-1.0";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface MuseExecOptions {
  promptFile: string;
  model?: BuildModel;
  reasoningEffort?: ReasoningEffort;
  maxModelSteps?: number;
  /** Resume an earlier session for fix rounds and user refinements. */
  sessionId?: string;
  /**
   * Inspo images to attach, as paths inside the sandbox. One third-party guide lists `--image` for `muse exec`.
   * Meta's docs don't, so spike 1 checks it. Without it, the brief's written descriptions carry the inspo.
   */
  images?: string[];
}

export function museExecArgs(opts: MuseExecOptions): string[] {
  const args = [
    "exec",
    "--json",
    // Muse Code's own sandbox needs bubblewrap. The disposable, firewalled microVM is the boundary instead.
    "--yolo",
    "--prompt-file",
    opts.promptFile,
    "--model",
    opts.model ?? "muse-spark-1.3",
    "--reasoning-effort",
    opts.reasoningEffort ?? "high",
    "--max-model-steps",
    String(opts.maxModelSteps ?? 200),
  ];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  for (const image of opts.images ?? []) args.push("--image", image);
  return args;
}

/**
 * Env for the sandbox. META_API_KEY is a placeholder: the firewall swaps in the real Authorization header.
 * Day-one spike 1 confirms Muse Code accepts this.
 */
export const SANDBOX_ENV = { META_API_KEY: "brokered" } as const;

/** Muse Code exit codes. 0 means the turn ended, not that the product works. Always gate on npm run verify. */
export const MUSE_EXIT = { completed: 0, failed: 1, usage: 2 } as const;
