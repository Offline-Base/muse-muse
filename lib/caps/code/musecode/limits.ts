import { sandboxCostUsd, SANDBOX_TRANSFER_USD_PER_GB } from "@/lib/caps/code/limits";

/**
 * Limits for Muse Code sessions in products (docs/CAPABILITIES.md, 15b; ~/mm-wt/_plan/muse-code-products.md, "Limits").
 * Every number here is one a person or the build prompt can see, so the text that names it reads it from here.
 */
export const MUSE_CODE_LIMITS = {
  /** One live session: Meta spend through the gateway, and how long it may run. Then it stops and keeps what it made. */
  sessionUsd: 1,
  sessionMs: 15 * 60_000,
  /** Sessions running at once. */
  atOncePerProduct: 2,
  atOnceInAll: 8,
  /** A build's own sessions, all of them together: real sessions, minutes and dollars. */
  buildSessions: 2,
  buildMs: 5 * 60_000,
  buildUsd: 0.5,
  /** The least budget or time a session starts with. Less than this is refused rather than started to fail. */
  minStartUsd: 0.05,
  minStartMs: 60_000,
  /** Starts a minute per token, and a live product's starts a day. */
  perTokenPerMinute: 6,
  perProductPerDay: 40,
  /** The owner, and each visitor or signed-in person when MUSE_CODE_VISITORS is on. */
  perOwnerPerDay: 20,
  perPersonPerDay: 3,
  /** Visitors only (the design's 3 a day per address). */
  perIpPerDay: 3,
  /** What a person sends. */
  taskMaxChars: 8_000,
  steerMaxChars: 4_000,
  bodyMaxBytes: 2 * 1024 * 1024,
  /** Files the task brings: plain names, inline text or base64, or a public Blob URL from the gateway's /uploads. */
  filesMax: 20,
  inlineFilesMaxBytes: 1024 * 1024,
  urlFilesMaxBytes: 20 * 1024 * 1024,
  /** The result: per file, in all, and how many files. */
  resultFileMaxBytes: 10 * 1024 * 1024,
  resultMaxBytes: 50 * 1024 * 1024,
  resultMaxFiles: 500,
  /** How long the result zip stays on Blob. The cleanup sweep deletes it after this. */
  resultKeepMs: 24 * 3_600_000,
  /** The sandbox. */
  vcpus: 2,
  /** The sandbox stops itself this long after the session's own limit, whatever happens to the platform. */
  sandboxGraceMs: 3 * 60_000,
  /** One request that starts a session gives up on its sandbox calls after this. */
  startDeadlineMs: 75_000,
  createTimeoutMs: 30_000,
  /** Every sandbox call in one poll or stop is cut off after this, inside the route's 120 s, so its lock is given back. */
  pollDeadlineMs: 100_000,
  /** One poll reads at most this much new log. */
  pollLogBytes: 512 * 1024,
  /** Events a session keeps. Older ones go first. */
  eventsKept: 400,
  /** Muse Code's step cap for a session's turn. The money and the time stop it well before this, as a rule. */
  maxModelSteps: 150,
} as const;

/** The worst a session's sandbox can cost: its whole life at its vCPUs, plus 100 MB of transfer (npm, the gateway). */
export function sessionSandboxWorstUsd(limitMs: number): number {
  return sandboxCostUsd(limitMs + MUSE_CODE_LIMITS.sandboxGraceMs, MUSE_CODE_LIMITS.vcpus) + SANDBOX_TRANSFER_USD_PER_GB * 0.1;
}

/** What a session's sandbox cost for the time it was up. */
export function sessionSandboxUsd(ms: number): number {
  return sandboxCostUsd(Math.max(0, ms), MUSE_CODE_LIMITS.vcpus);
}

/** The plain disclosure every product shows next to a Muse Code session. No em dashes. */
export const MUSE_CODE_DISCLOSURE = "Runs Muse Code in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta.";
