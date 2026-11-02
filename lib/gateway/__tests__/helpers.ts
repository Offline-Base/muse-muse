import type { GatewayDeps, GatewayToken } from "@/lib/gateway/handler";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage, ProductStatus } from "@/lib/types";

export const TEST_TOKEN = "mm_live_testtokentesttokentesttoken";

export interface FakeGateway {
  deps: GatewayDeps;
  /** Metered usage: settled reservations and recordUsage calls. */
  usage: Array<{ ctx: UsageContext; items: ModelUsage[] }>;
  /** Reservations not settled yet, by id. */
  reservations: Map<string, { ctx: UsageContext; model: string | null; costUsd: number }>;
  /** In-flight slots held, by key. */
  inFlight: Map<string, number>;
  upstreamCalls: Array<{ url: string; init: RequestInit | undefined }>;
  rateKeys: string[][];
  /** Multi-unit counters (run caps), by "key" alone, whatever the window. */
  counters: Map<string, number>;
  /** Resolves when every deferred task (metering) has finished. */
  settled(): Promise<void>;
}

/**
 * Gateway deps with an in-memory token, product, spend, rate-limit counters, in-flight slots and usage log. Spend is
 * the starting spend plus every reservation and metered cost, like the usage table.
 */
export function fakeGateway(
  opts: {
    token?: Partial<GatewayToken>;
    productStatus?: ProductStatus | null;
    tokenSpend?: number;
    platformSpend?: number;
    counts?: Record<string, number>;
    fetch?: typeof fetch;
    upstreamKey?: string;
    buildTestModel?: string | null;
    contributorRuntime?: boolean;
  } = {},
): FakeGateway {
  const usage: FakeGateway["usage"] = [];
  const reservations: FakeGateway["reservations"] = new Map();
  const inFlight = new Map<string, number>();
  let nextReservation = 0;
  const upstreamCalls: FakeGateway["upstreamCalls"] = [];
  const rateKeys: string[][] = [];
  const deferred: Promise<unknown>[] = [];
  const counters = new Map<string, number>(Object.entries(opts.counts ?? {}));
  const multiCounters = new Map<string, number>();
  const token: GatewayToken = {
    id: "00000000-0000-4000-8000-000000000001",
    productId: "00000000-0000-4000-8000-000000000002",
    scope: "live",
    allowedModels: ["muse-spark-1.3", "muse-image-1.0", "sam-3.1", "muse-voice-transcribe-1.0"],
    dailyBudgetUsd: 3,
    ...opts.token,
  };
  const spend = (match: (ctx: UsageContext) => boolean) =>
    [...reservations.values()].filter((r) => match(r.ctx)).reduce((n, r) => n + r.costUsd, 0) +
    usage.filter((u) => match(u.ctx)).reduce((n, u) => n + u.items.reduce((m, i) => m + i.costUsd, 0), 0);
  const realFetch = opts.fetch ?? (async () => new Response("unexpected upstream call", { status: 599 }));
  const deps: GatewayDeps = {
    findToken: async (t) => (t === TEST_TOKEN ? token : null),
    productStatus: async () => (opts.productStatus === undefined ? "live" : opts.productStatus),
    tokenSpendToday: async (tokenId) => (opts.tokenSpend ?? 0) + spend((ctx) => ctx.tokenId === tokenId),
    platformSpendToday: async () => (opts.platformSpend ?? 0) + spend(() => true),
    dailySpendCapUsd: 40,
    hitRateLimits: async (keys) => {
      rateKeys.push(keys);
      return Object.fromEntries(keys.map((k) => [k, counters.set(k, (counters.get(k) ?? 0) + 1).get(k)!]));
    },
    acquireInFlight: async (key, limit, now) => {
      const held = inFlight.get(key) ?? 0;
      if (held >= limit) return null;
      inFlight.set(key, held + 1);
      return now;
    },
    releaseInFlight: async (key) => {
      inFlight.set(key, Math.max(0, (inFlight.get(key) ?? 0) - 1));
    },
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
    reserveCounter: async (key, _window, amount, limit) => {
      const total = (multiCounters.get(key) ?? 0) + amount;
      if (total > limit) return null;
      multiCounters.set(key, total);
      return total;
    },
    adjustCounter: async (key, _window, delta) => {
      multiCounters.set(key, Math.max(0, (multiCounters.get(key) ?? 0) + delta));
    },
    counterValue: async (key) => multiCounters.get(key) ?? 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), init });
      return realFetch(input, init);
    }) as typeof fetch,
    upstreamKey: () => opts.upstreamKey ?? "test-master-key",
    buildTestModel: opts.buildTestModel,
    contributorRuntime: opts.contributorRuntime,
    gatewayUrl: "https://platform.example/api/gateway",
    defer: (task) => {
      deferred.push(task());
    },
  };
  return {
    deps,
    usage,
    reservations,
    inFlight,
    upstreamCalls,
    rateKeys,
    counters: multiCounters,
    settled: async () => void (await Promise.all(deferred)),
  };
}

export function gatewayRequest(
  path: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request(`https://platform.example/api/gateway/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
    body,
  });
}

export const json = (value: unknown) => JSON.stringify(value);
