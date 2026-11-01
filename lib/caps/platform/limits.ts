/** Limits on platform powers (docs/PLATFORM_POWERS.md) that aren't dollars. The dollars are env settings. */
export const POWER_LIMITS = {
  /** Starts per UTC day, for each product. */
  sandboxesPerDay: 10,
  keysPerDay: 10,
  productsPerDay: 2,
  perTokenPerMinute: 10,
  /** A key's longest life, and the shortest budget worth minting. */
  keyMaxHours: 24,
  keyMinUsd: 0.05,
  labelMaxChars: 80,
  noteMaxChars: 8_000,
  bodyMaxBytes: 32 * 1024,
} as const;
