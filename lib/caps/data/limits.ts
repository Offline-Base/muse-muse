/**
 * The data cap's limits (docs/CAPABILITIES.md, section 9). The live namespace's per-product numbers come from the env
 * (DATA_PRODUCT_ROWS, DATA_PRODUCT_MB, DATA_DAILY_WRITES) and are passed in; everything else is fixed here.
 */
export const DATA_LIMITS = {
  /** One item's JSON. */
  docMaxBytes: 64 * 1024,
  /** A request body: one item plus its envelope. */
  bodyMaxBytes: 72 * 1024,
  /** Every data call one token makes, a minute. Reads are 120 a minute per token in the contract; writes count too. */
  perTokenPerMinute: 120,
  /** Every data call for one end user (their forwarded IP), a minute. */
  perIpPerMinute: 60,
  collectionsPerProduct: 20,
  rowsPerVisitor: 200,
  rowsPerUser: 1000,
  /** A build's own namespace, b:<buildId>. */
  buildRows: 500,
  buildBytes: 5 * 1024 * 1024,
  /** A shared collection anyone may write: per end user's IP a minute, and per visitor a day. */
  anyoneWritesPerIpPerMinute: 30,
  anyoneWritesPerVisitorPerDay: 500,
  pageDefault: 50,
  pageMax: 100,
  whereMaxFields: 8,
  signInCodeValidMs: 5 * 60_000,
  userSessionValidMs: 30 * 24 * 3_600_000,
  /** A made-up user's session, for a build's tests. Longer than a build token's six hours. */
  testSessionValidMs: 12 * 3_600_000,
  /** POST /identity/user, per end user's IP, a minute. */
  exchangesPerIpPerMinute: 10,
  testUsersPerBuild: 20,
  /** The passkey routes on the platform, per IP, a minute. */
  passkeyPerIpPerMinute: 10,
  /** A passkey ceremony's challenge. */
  challengeValidMs: 5 * 60_000,
  displayNameMax: 40,
  /** A soft-deleted row is removed this long after its delete. */
  purgeAfterMs: 3_600_000,
  /** A crashed build's namespace is cleared this long after its last write. */
  buildNamespaceMaxAgeMs: 24 * 3_600_000,
} as const;

/** The per-product numbers the env sets, for the live namespace. */
export interface DataQuotas {
  productRows: number;
  productBytes: number;
  dailyWrites: number;
}
