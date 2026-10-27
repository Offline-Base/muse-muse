/**
 * Arguments for running Muse Code headless inside a builder sandbox. Flags confirmed in docs/SPIKES.md (spike 1).
 */
export type BuildModel = "muse-spark-1.3" | "muse-wonder-1.0";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface MuseExecOptions {
  /** Path relative to the product dir, such as brief.md or fix.md. */
  promptFile: string;
  /** A UUID. A fresh one starts a session; passing the same one again resumes it with its memory. */
  sessionId: string;
  model?: BuildModel;
  reasoningEffort?: ReasoningEffort;
  maxModelSteps?: number;
  /** Inspo images to attach with --image (repeatable), as paths relative to the product dir. */
  images?: string[];
  /** Muse Code's web tools can't reach anything through the build firewall, so they are off by default. */
  disableWebTools?: boolean;
}

export const DEFAULT_MAX_MODEL_STEPS = 200;

export function museExecArgs(opts: MuseExecOptions): string[] {
  const args = [
    "exec",
    "--json",
    // Muse Code's own sandbox needs bubblewrap. The disposable, firewalled microVM is the boundary instead.
    "--yolo",
    "--session-id",
    opts.sessionId,
    "--prompt-file",
    opts.promptFile,
    "--model",
    opts.model ?? "muse-spark-1.3",
    "--reasoning-effort",
    opts.reasoningEffort ?? "high",
    "--max-model-steps",
    String(opts.maxModelSteps ?? DEFAULT_MAX_MODEL_STEPS),
  ];
  if (opts.disableWebTools ?? true) args.push("--disable-web-tools");
  for (const image of opts.images ?? []) args.push("--image", image);
  return args;
}

/** Env for any muse command in the sandbox (docs/SPIKES.md). Stops the launcher from self-updating or starting a device sign-in. */
export const SANDBOX_ENV = { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" } as const;

/**
 * Env for a Muse Code run. META_API_KEY is the sandbox's placeholder (policy.ts placeholderKey): the firewall swaps in
 * the real Authorization header only for requests that carry it. Only the Muse Code runner exports it, so the
 * product's dev, verify and demo servers don't have it.
 */
export function museEnv(placeholder: string): Record<string, string> {
  return { ...SANDBOX_ENV, META_API_KEY: placeholder };
}

/** Muse Code exit codes. 0 means the turn ended, not that the product works. Always gate on npm run verify. */
export const MUSE_EXIT = { completed: 0, failed: 1, usage: 2 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return UUID.test(id);
}
