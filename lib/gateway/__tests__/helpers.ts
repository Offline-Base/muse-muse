import type { GatewayDeps, GatewayToken } from "@/lib/gateway/handler";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage, ProductStatus } from "@/lib/types";

export const TEST_TOKEN = "mm_live_testtokentesttokentesttoken";

export interface FakeGateway {
  deps: GatewayDeps;
  usage: Array<{ ctx: UsageContext; items: ModelUsage[] }>;
  upstreamCalls: Array<{ url: string; init: RequestInit | undefined }>;
  rateKeys: string[][];
  /** Resolves when every deferred task (metering) has finished. */
  settled(): Promise<void>;
}

/** Gateway deps with an in-memory token, product, spend, rate-limit counters and usage log. */
export function fakeGateway(
  opts: {
    token?: Partial<GatewayToken>;
    productStatus?: ProductStatus | null;
    tokenSpend?: number;
    platformSpend?: number;
    counts?: Record<string, number>;
    fetch?: typeof fetch;
    upstreamKey?: string;
  } = {},
): FakeGateway {
  const usage: FakeGateway["usage"] = [];
  const upstreamCalls: FakeGateway["upstreamCalls"] = [];
  const rateKeys: string[][] = [];
  const deferred: Promise<unknown>[] = [];
  const counters = new Map<string, number>(Object.entries(opts.counts ?? {}));
  const token: GatewayToken = {
    id: "00000000-0000-4000-8000-000000000001",
    productId: "00000000-0000-4000-8000-000000000002",
    scope: "live",
    allowedModels: ["muse-spark-1.3", "muse-image-1.0", "sam-3.1", "muse-voice-transcribe-1.0"],
    dailyBudgetUsd: 3,
    ...opts.token,
  };
  const realFetch = opts.fetch ?? (async () => new Response("unexpected upstream call", { status: 599 }));
  const deps: GatewayDeps = {
    findToken: async (t) => (t === TEST_TOKEN ? token : null),
    productStatus: async () => (opts.productStatus === undefined ? "live" : opts.productStatus),
    tokenSpendToday: async () => opts.tokenSpend ?? 0,
    platformSpendToday: async () => opts.platformSpend ?? 0,
    dailySpendCapUsd: 40,
    hitRateLimits: async (keys) => {
      rateKeys.push(keys);
      return Object.fromEntries(keys.map((k) => [k, counters.set(k, (counters.get(k) ?? 0) + 1).get(k)!]));
    },
    recordUsage: async (ctx, items) => {
      usage.push({ ctx, items });
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), init });
      return realFetch(input, init);
    }) as typeof fetch,
    upstreamKey: () => opts.upstreamKey ?? "test-master-key",
    gatewayUrl: "https://platform.example/api/gateway",
    defer: (task) => {
      deferred.push(task());
    },
  };
  return { deps, usage, upstreamCalls, rateKeys, settled: async () => void (await Promise.all(deferred)) };
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
