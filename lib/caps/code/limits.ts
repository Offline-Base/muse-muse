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
  /** Real runs one build's tests may make. */
  perBuild: 5,
  atOncePerProduct: 2,
  atOnceInAll: 4,
  perTokenPerMinute: 10,
  /** The request body: code and stdin, plus files as base64. */
  bodyMaxBytes: 64 * 1024 * 2 + Math.ceil((1024 * 1024 * 4) / 3) + 16 * 1024,
} as const;

export const BROWSE_LIMITS = {
  seconds: 30,
  actionsMax: 5,
  perPersonPerDay: 5,
  perProductPerDay: 50,
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

/** Starting and stopping a sandbox, on top of the run itself, for the worst case a reservation holds. */
export const SANDBOX_OVERHEAD_MS = 30_000;

export const EXEC_WORST_USD = sandboxCostUsd(EXEC_LIMITS.runSeconds * 1000 + SANDBOX_OVERHEAD_MS, EXEC_LIMITS.vcpus);
export const BROWSE_WORST_USD = sandboxCostUsd(BROWSE_LIMITS.seconds * 1000 + SANDBOX_OVERHEAD_MS, BROWSE_LIMITS.vcpus);
