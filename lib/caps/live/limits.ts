/** The live cap's fixed numbers (docs/CAPABILITIES.md, section 13). LIVE_CAPTION_MINUTES is a setting in lib/env.ts. */
export const LIVE_LIMITS = {
  /** A chunk call's per-IP limit, for a token with cap:live: one chunk every 2 seconds. Other calls stay at 20. */
  asrPerIpPerMinute: 30,
  /** The longest piece of audio a live chunk may be. Chunks are 2 to 3 seconds; a longer file isn't a chunk. */
  chunkMaxSeconds: 10,
  /** An address may use this many visitors' caption minutes a day, so clearing the cookie doesn't give a fresh day. */
  captionMinutesIpTimes: 5,
  /** A read ticket's life. */
  ticketValidMs: 10 * 60_000,
  ticketsPerTokenPerMinute: 120,
  ticketsPerIpPerMinute: 30,
  /** How often an open stream asks the database for changes. */
  pollMs: 1500,
  /** A stream closes after this, inside the route's 60 s, and the browser reconnects with `after`. */
  streamMaxMs: 55_000,
  /** A comment line this often, so a quiet stream isn't cut by something on the way. */
  heartbeatMs: 15_000,
  /** Changes read per poll. A full page is read again at once. */
  batchRows: 100,
  /** One connection's most rows and bytes. A long catch-up closes and goes on over the next connection. */
  streamMaxRows: 2_000,
  streamMaxBytes: 8 * 1024 * 1024,
  streamsPerProduct: 20,
  streamsTotal: 200,
  /** A ticket that reconnects faster than this is broken, not catching up. */
  opensPerTicketPerMinute: 30,
  /** What a smoke test's captions may use, per verify. */
  smokeChunks: 6,
} as const;
