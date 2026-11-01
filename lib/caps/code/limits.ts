/**
 * The code cap's limits (docs/CAPABILITIES.md, section 15). The person using a product sees the ones its build prompt
 * names: 15 seconds, 64 KB of code and output, 1 MB of files, 20 runs a day.
 */
export const EXEC_LIMITS = {
  codeMaxBytes: 64 * 1024,
  stdinMaxBytes: 64 * 1024,
  /** All files together, decoded. */
  filesMaxBytes: 1024 * 1024,
  filesMax: 20,
  /** stdout and stderr are each cut here. */
  outputMaxBytes: 64 * 1024,
  runSeconds: 15,
  vcpus: 1,
  perPersonPerDay: 20,
  perProductPerDay: 200,
  /** One address, whoever it says it is: a visitor can change their cookie, but not their address. */
  perIpPerDay: 40,
  /**
   * Real runs one build may make, across all its verifies. The smoke test makes at most SMOKE_EXEC_RUNS a verify, and a
   * build verifies at most BUILD_VERIFIES_MAX times (milestones, the first check and every fix round), plus a margin for
   * Muse Code trying its own route while it builds.
   */
  perBuild: 40,
  atOncePerProduct: 2,
  atOnceInAll: 4,
  perTokenPerMinute: 10,
  /** The request body: code and stdin, plus files as base64. */
  bodyMaxBytes: 64 * 1024 * 2 + Math.ceil((1024 * 1024 * 4) / 3) + 16 * 1024,
} as const;

/** Server runs the build prompt and the skill let one smoke test make. */
export const SMOKE_EXEC_RUNS = 3;
/**
 * The most verifies one build can run: every Muse Code round of a build (milestones, then the fix rounds) stays under
 * REFINE_ROUND_STRIDE (10, lib/sandbox/muse.ts), and each round is checked at most once.
 */
export const BUILD_VERIFIES_MAX = 10;

export const BROWSE_LIMITS = {
  seconds: 30,
  actionsMax: 5,
  perPersonPerDay: 5,
  perProductPerDay: 50,
  perIpPerDay: 10,
  atOnceInAll: 2,
  /** Recorded pages one build's tests may open. */
  perBuild: 20,
  perTokenPerMinute: 10,
  inputMaxChars: 2000,
  urlMaxChars: 2000,
  selectorMaxChars: 200,
  typeMaxChars: 500,
  waitMaxMs: 5000,
  textMaxChars: 20_000,
  titleMaxChars: 300,
  /** The screenshot comes back in the reply, as a JPEG data URL. */
  screenshotMaxBytes: 400 * 1024,
  vcpus: 2,
  bodyMaxBytes: 16 * 1024,
} as const;

/**
 * Vercel Sandbox's posted prices (vercel.com/docs/vercel-sandbox/pricing, as read Oct 31): active CPU per vCPU-hour and
 * provisioned memory per GB-hour, with 2 GB of memory per vCPU. A run is charged for the whole time its sandbox is up,
 * which is at least what Vercel bills.
 */
export const SANDBOX_PRICES = { vcpuHourUsd: 0.128, gbHourUsd: 0.0106, gbPerVcpu: 2 } as const;

/** What `ms` of a sandbox with `vcpus` costs at the posted prices. */
export function sandboxCostUsd(ms: number, vcpus: number): number {
  const hours = Math.max(0, ms) / 3_600_000;
  return hours * vcpus * (SANDBOX_PRICES.vcpuHourUsd + SANDBOX_PRICES.gbPerVcpu * SANDBOX_PRICES.gbHourUsd);
}

/**
 * Starting and stopping a sandbox, on top of the run itself. A sandbox's own timeout is the run plus this, so it can
 * never outlive what its reservation holds, even when the function that started it dies.
 */
export const SANDBOX_OVERHEAD_MS = 45_000;

/** Each sandbox's own timeout: Vercel stops it then, whatever happens to the caller. */
export const EXEC_SANDBOX_MS = EXEC_LIMITS.runSeconds * 1000 + SANDBOX_OVERHEAD_MS;
export const BROWSE_SANDBOX_MS = BROWSE_LIMITS.seconds * 1000 + SANDBOX_OVERHEAD_MS;

/**
 * Network transfer, which Vercel Sandbox also bills (about $0.15 per GB, as read Oct 31). Exec has no network. A browse
 * page load is allowed 100 MB in the reservation, far more than a page needs.
 */
export const SANDBOX_TRANSFER_USD_PER_GB = 0.15;
export const BROWSE_TRANSFER_ALLOWANCE_GB = 0.1;

/** The worst case each reservation holds: the sandbox's whole lifetime, and for browse its network allowance. */
export const EXEC_WORST_USD = sandboxCostUsd(EXEC_SANDBOX_MS, EXEC_LIMITS.vcpus);
export const BROWSE_WORST_USD = sandboxCostUsd(BROWSE_SANDBOX_MS, BROWSE_LIMITS.vcpus) + SANDBOX_TRANSFER_USD_PER_GB * BROWSE_TRANSFER_ALLOWANCE_GB;

/**
 * How long a whole run may take from the start of its sandbox, create included, so it finishes well inside the route's
 * maxDuration (90 s for /exec, 120 s for /browse) and the finally blocks that give back the slots always run.
 */
export const SANDBOX_CREATE_MS = 30_000;
export const EXEC_DEADLINE_MS = 70_000;
export const BROWSE_DEADLINE_MS = 100_000;
