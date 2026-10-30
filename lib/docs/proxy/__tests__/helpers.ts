import type { DocsObjectKind } from "@/lib/docs/proxy/endpoints";
import { DOCS_DEFAULTS } from "@/lib/docs/proxy/policy";
import type { DocsConfig, DocsDeps, DocsHoldState } from "@/lib/docs/proxy/types";
import { visitorHash } from "@/lib/docs/proxy/visitor";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage } from "@/lib/types";

/** A stand-in for the docs key. Tests check it reaches the fake upstream and never a reply. */
export const TEST_KEY = "test-docs-key-0000";
export const HOST = "mm.example";
export const ORIGIN = `https://${HOST}`;
/** A visitor id in the cookie's form (22 base64url characters). */
export const VISITOR = "visitorAAAAAAAAAAAAAAA";
export const OTHER_VISITOR = "visitorBBBBBBBBBBBBBBB";
export const NEW_VISITOR = "visitorNNNNNNNNNNNNNNN";
export const IP = "203.0.113.9";
export const NOW = new Date("2026-10-30T12:00:30.000Z");

export interface FakeDocs {
  deps: DocsDeps;
  /** Metered usage: settled reservations and recordUsage calls. */
  usage: Array<{ ctx: UsageContext; items: ModelUsage[] }>;
  /** Reservations not settled yet, by id. */
  reservations: Map<string, { ctx: UsageContext; model: string | null; costUsd: number }>;
  /** rate_limits rows, keyed "<key>|<window start ISO>". */
  counters: Map<string, number>;
  objects: Array<{ id: string; kind: DocsObjectKind; visitor: string; hold?: DocsHoldState | null }>;
  inFlight: Map<string, number>;
  upstreamCalls: Array<{ url: string; init: RequestInit | undefined }>;
  /** Resolves when every deferred task (metering) has finished. */
  settled(): Promise<void>;
  counter(key: string, windowStart: Date): number;
}

export function fakeDocs(
  opts: {
    config?: Partial<DocsConfig>;
    fetch?: (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
    docsSpend?: number;
    platformSpend?: number;
    objects?: Array<{ id: string; kind: DocsObjectKind; visitor?: string; hold?: DocsHoldState | null }>;
    counters?: Record<string, number>;
    now?: Date;
  } = {},
): FakeDocs {
  const usage: FakeDocs["usage"] = [];
  const reservations: FakeDocs["reservations"] = new Map();
  const counters = new Map<string, number>(Object.entries(opts.counters ?? {}));
  const objects: FakeDocs["objects"] = (opts.objects ?? []).map((o) => ({ ...o, visitor: o.visitor ?? visitorHash(VISITOR) }));
  const inFlight = new Map<string, number>();
  const upstreamCalls: FakeDocs["upstreamCalls"] = [];
  const deferred: Promise<unknown>[] = [];
  let nextReservation = 0;
  const at = (key: string, windowStart: Date) => `${key}|${windowStart.toISOString()}`;
  const spent = () =>
    [...reservations.values()].reduce((n, r) => n + r.costUsd, 0) +
    usage.reduce((n, u) => n + u.items.reduce((m, i) => m + i.costUsd, 0), 0);
  const upstream = opts.fetch ?? (() => new Response("unexpected upstream call", { status: 599 }));

  const deps: DocsDeps = {
    config: {
      live: true,
      perIpRequestsPerMinute: DOCS_DEFAULTS.perIpRequestsPerMinute,
      perIpRequestsPerDay: DOCS_DEFAULTS.perIpRequestsPerDay,
      perIpInFlight: DOCS_DEFAULTS.perIpInFlight,
      perIpDailyUsd: DOCS_DEFAULTS.perIpDailyUsd,
      docsDailyCapUsd: DOCS_DEFAULTS.docsDailySpendCapUsd,
      platformDailyCapUsd: 100,
      ...opts.config,
    },
    hitRateLimits: async (keys, windowStart) =>
      Object.fromEntries(keys.map((k) => [k, counters.set(at(k, windowStart), (counters.get(at(k, windowStart)) ?? 0) + 1).get(at(k, windowStart))!])),
    acquireInFlight: async (key, limit, now) => {
      const held = inFlight.get(key) ?? 0;
      if (held >= limit) return null;
      inFlight.set(key, held + 1);
      return now;
    },
    releaseInFlight: async (key) => {
      inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 0) - 1));
    },
    reserveCounter: async (key, windowStart, amount, limit) => {
      const total = (counters.get(at(key, windowStart)) ?? 0) + amount;
      if (total > limit) return null;
      counters.set(at(key, windowStart), total);
      return total;
    },
    adjustCounter: async (key, windowStart, delta) => {
      counters.set(at(key, windowStart), Math.max(0, (counters.get(at(key, windowStart)) ?? 0) + delta));
    },
    counterValue: async (key, windowStart) => counters.get(at(key, windowStart)) ?? 0,
    docsSpendToday: async () => (opts.docsSpend ?? 0) + spent(),
    platformSpendToday: async () => (opts.platformSpend ?? 0) + spent(),
    reserveSpend: async (ctx, model, costUsd) => {
      const id = `res-${++nextReservation}`;
      reservations.set(id, { ctx, model, costUsd });
      return id;
    },
    settleSpend: async (id, item) => {
      const reservation = reservations.get(id);
      if (!reservation) throw new Error(`unknown reservation ${id}`);
      reservations.delete(id);
      if (item) usage.push({ ctx: reservation.ctx, items: [item] });
    },
    recordUsage: async (ctx, items) => {
      usage.push({ ctx, items });
    },
    recordObject: async (object) => {
      if (!objects.some((o) => o.id === object.id)) objects.push(object.hold ? object : { id: object.id, kind: object.kind, visitor: object.visitor });
    },
    pendingHold: async (id) => objects.find((o) => o.id === id)?.hold ?? null,
    claimHold: async (id) => {
      const object = objects.find((o) => o.id === id);
      const hold = object?.hold ?? null;
      if (object) delete object.hold;
      return hold;
    },
    ownedIds: async (visitor, ids) => objects.filter((o) => o.visitor === visitor && ids.includes(o.id)).map(({ id, kind }) => ({ id, kind })),
    visitorObjects: async (visitor, kind, limit) =>
      objects
        .filter((o) => o.visitor === visitor && o.kind === kind)
        .reverse()
        .slice(0, limit)
        .map((o) => o.id),
    forgetObject: async (id) => {
      const i = objects.findIndex((o) => o.id === id);
      if (i >= 0) objects.splice(i, 1);
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), init });
      return upstream(String(input), init);
    }) as typeof fetch,
    upstreamKey: () => TEST_KEY,
    upstreamBaseUrl: "https://api.meta.test/v1",
    defer: (task) => {
      deferred.push(task());
    },
    now: () => opts.now ?? NOW,
    newVisitorId: () => NEW_VISITOR,
  };
  return {
    deps,
    usage,
    reservations,
    counters,
    objects,
    inFlight,
    upstreamCalls,
    settled: async () => {
      // Deferred work can defer more (metering that records ids), so drain until nothing is left.
      for (let seen = 0; seen < deferred.length; ) {
        const batch = deferred.slice(seen);
        seen = deferred.length;
        await Promise.all(batch);
      }
    },
    counter: (key, windowStart) => counters.get(at(key, windowStart)) ?? 0,
  };
}

/** A same-origin request from the docs page, from VISITOR at IP unless told otherwise. */
export function docsRequest(
  path: string,
  init: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; visitor?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    host: HOST,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-real-ip": IP,
    "x-forwarded-proto": "https",
    ...init.headers,
  };
  const visitor = init.visitor === undefined ? VISITOR : init.visitor;
  if (visitor) headers.cookie = `mm_docs=${visitor}`;
  return new Request(`${ORIGIN}/api/docs/v1/${path}`, {
    method: init.method ?? (init.body === undefined || init.body === null ? "GET" : "POST"),
    headers,
    body: init.body ?? null,
  });
}

export const JSON_CT = { "content-type": "application/json" };

export const json = (value: unknown) => JSON.stringify(value);

/** A server-sent events body. Objects are JSON-encoded; strings (such as "[DONE]") go as is. */
export function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`)
    .join("");
}

/** A body that arrives in chunks of `size` bytes, to check parsers across chunk boundaries. */
export function streamOf(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
}

export async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { type: string; code: string; message: string } };
  return { status: res.status, ...body.error };
}

/** A minimal WAV: mono 16-bit PCM at `rate`, `ms` long, of silence. */
export function wavBytes(rate: number, ms: number, opts: { channels?: number; bits?: number; format?: number } = {}): Uint8Array<ArrayBuffer> {
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const dataBytes = Math.round((rate * ms) / 1000) * channels * (bits / 8);
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const write = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, opts.format ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}
