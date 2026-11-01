/** The connect cap's limits (docs/CAPABILITIES.md, section 11). Fixed here: none of them is a setting yet. */
export const CONNECT_LIMITS = {
  /** POST /fetch: one product's calls a minute, one end user's (their forwarded IP) a minute, and a product's a day. */
  fetchPerProductPerMinute: 60,
  fetchPerIpPerMinute: 20,
  fetchPerProductPerDay: 2_000,
  /** A build's fetches a day: its tests call a few times, so this only stops a loop. */
  fetchPerBuildPerDay: 300,
  fetchBodyMaxBytes: 4 * 1024,
  /** The most of an API's answer the gateway reads, keeps and passes on. */
  responseMaxBytes: 1024 * 1024,
  fetchTimeoutMs: 10_000,
  /** How long a 404 from a public API is cached. */
  notFoundCacheSeconds: 60,
  /** Same-host redirects followed, each to a path the allowlist takes. */
  maxRedirects: 2,
  /** POST /vault: keys a product keeps. */
  keysPerProduct: 10,
  keyMinChars: 8,
  keyMaxChars: 4096,
  vaultBodyMaxBytes: 16 * 1024,
  /** POST /vault/call. */
  callsPerProductPerDay: 500,
  callsPerTokenPerMinute: 60,
  callsPerIpPerMinute: 20,
  callBodyMaxBytes: 64 * 1024,
  callTimeoutMs: 15_000,
  /** POST /send. */
  sendsPerProductPerDay: 10,
  sendsPerTokenPerMinute: 30,
  recipientsMax: 5,
  subjectMaxChars: 200,
  emailBodyMaxChars: 10_000,
  chatBodyMaxChars: 3_000,
  sendBodyMaxBytes: 32 * 1024,
  sendTimeoutMs: 15_000,
  /** Owner key routes (list, save, revoke) a minute per token. */
  vaultPerTokenPerMinute: 30,
  /** Revoked keys and a crashed build's test keys are removed this long after. */
  revokedKeepMs: 24 * 3_600_000,
  buildNamespaceMaxAgeMs: 24 * 3_600_000,
} as const;
