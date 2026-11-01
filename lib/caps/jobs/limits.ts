/** The jobs cap's limits (docs/CAPABILITIES.md, section 12). Dollars and daily runs are settings in lib/env.ts. */
export const JOBS_LIMITS = {
  minEveryMinutes: 15,
  /** About a month: anything rarer isn't a schedule a person keeps track of. */
  maxEveryMinutes: 43_200,
  /** A job token lasts this long. A run's ticks each get a new one. */
  tokenMs: 10 * 60_000,
  /** The cron waits this long for a product's job route. */
  fireTimeoutMs: 60_000,
  /** How many job routes the cron calls at once. */
  concurrency: 10,
  /** The cron stops starting new ticks after this long, within its 300 s. */
  cronBudgetMs: 200_000,
  /** Schedules the cron looks at per pass. */
  duePerPass: 200,
  /** A tick still running after this is over: its token has expired. */
  staleMs: 10 * 60_000,
  /** Tries for one tick before the run fails. */
  maxAttempts: 2,
  ticksPerRun: 10,
  checkpointMaxBytes: 64 * 1024,
  inputMaxBytes: 64 * 1024,
  enqueuePerProductPerDay: 50,
  /** Runs one product can have waiting. Hooks and enqueue are refused past this until some have run. */
  queuedPerProduct: 100,
  notifyPerProductPerDay: 10,
  /** Messages jobs may draft for the owner in a day. */
  heldPerProductPerDay: 20,
  /** A draft nobody answers is dropped after this, with its addresses and words. */
  heldKeepMs: 14 * 24 * 3_600_000,
  noticeTitleMax: 120,
  noticeBodyMax: 2_000,
  hookBodyMaxBytes: 64 * 1024,
  hookPerMinute: 60,
  hookPerDay: 1_000,
  webhooksPerProduct: 2,
  /**
   * Test fires a build's whole life may ask for, and as many hook addresses, counted apart. Smoke runs repeat: Muse Code runs
   * verify itself, and the platform verifies once a round, for up to 4 rounds. The biggest brief fires 8 a run. Each run stays
   * within its dollars and the build token's budget, so this only has to outlast a normal build.
   */
  testFiresPerBuild: 100,
  testFiresPerMinute: 30,
  /** A run's limits besides its dollars, so a loop stops even on a very cheap model. */
  runTurns: 60,
  runToolCalls: 60,
  /** A run with less than this left of its dollars is over: about 500 output tokens on Muse Wonder. */
  smallestCallUsd: 0.01,
  /** JOBS_RUN_USD can't go above this. */
  runUsdCeiling: 0.5,
  /** Counters for a run last this long, and so can the run: nothing fires a run older than this. */
  runMaxAgeMs: 48 * 3_600_000,
  /** Finished runs and read notices stay on the owner's page this long. */
  keepRunsMs: 30 * 24 * 3_600_000,
  keepNoticesMs: 90 * 24 * 3_600_000,
  buildNamespaceMaxAgeMs: 24 * 3_600_000,
  revokedKeepMs: 24 * 3_600_000,
} as const;

const UNSTORABLE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** False for a NUL or a broken surrogate anywhere in a value, keys included: Postgres text and jsonb refuse them. */
export function storableText(value: unknown): boolean {
  let ok = true;
  JSON.stringify(value, (key, v) => {
    if (UNSTORABLE.test(key) || (typeof v === "string" && UNSTORABLE.test(v))) ok = false;
    return v;
  });
  return ok;
}

/** A job's name, which is also its route: app/api/jobs/<name>/route.ts. */
export const JOB_NAME = /^[a-z][a-z0-9-]{0,39}$/;
