import type { ComposioApi, ComposioSessionConfig, ToolReply } from "@/lib/tools/composio/client";
import type { ToolsDeps } from "@/lib/tools/handler";
import { toolMarker, type ToolId } from "@/lib/tools/ids";
import type { ModelUsage, ProductStatus } from "@/lib/types";

process.env.GATEWAY_TOKEN_PEPPER ??= "pepper-for-tool-tests";

export const NOW = new Date("2026-10-31T12:34:56.000Z");
export const PRODUCT = "11111111-1111-4111-8111-111111111111";
export const OTHER_PRODUCT = "22222222-2222-4222-8222-222222222222";
export const TOKEN = "mm_live_tokentokentokentokentoken";
export const BUILD_TOKEN = "mm_build_tokentokentokentokentoken";

export const agentModels = (...ids: ToolId[]) => ["muse-wonder-1.0", "agent", ...ids.map(toolMarker)];

/** A provider that records every call, so a test can assert one was never made. */
export function fakeComposio(overrides: Partial<ComposioApi> = {}) {
  const calls = {
    create: [] as Array<{ userId: string; config: ComposioSessionConfig }>,
    update: [] as Array<{ sessionId: string; config: ComposioSessionConfig }>,
    execute: [] as Array<{ sessionId: string; slug: string; args: Record<string, unknown>; extraKeys: string[] }>,
    authorize: [] as Array<{ sessionId: string; toolkit: string; callbackUrl: string }>,
    verify: [] as Array<{ connectedAccountId: string; userId: string; toolkit: string }>,
    delete: [] as string[],
  };
  const reply: ToolReply = { data: { results: { organic_results: [{ title: "A paper", link: "https://papers.test/1", snippet: "Words" }] } }, error: null, resultType: "completed", instantCharge: { amount: "0.009167", currency: "USD" } };
  const api: ComposioApi = {
    createSession: async (userId, config) => {
      calls.create.push({ userId, config });
      return { sessionId: `sess_${calls.create.length}` };
    },
    updateSession: async (sessionId, config) => {
      calls.update.push({ sessionId, config });
    },
    execute: async (sessionId, slug, args, opts) => {
      calls.execute.push({ sessionId, slug, args, extraKeys: Object.keys(opts).filter((k) => k !== "signal") });
      return reply;
    },
    authorize: async (sessionId, toolkit, callbackUrl) => {
      calls.authorize.push({ sessionId, toolkit, callbackUrl });
      return { id: "ca_new", redirectUrl: "https://connect.composio.dev/link/abc" };
    },
    verifyConnection: async (o) => {
      calls.verify.push(o);
      return true;
    },
    deleteConnection: async (id) => {
      calls.delete.push(id);
    },
    ...overrides,
  };
  return { api, calls };
}

/** Gateway state in memory, the way the database keeps it. */
export function fakeTools(o: {
  scope?: "build" | "live";
  models?: string[];
  status?: ProductStatus | null;
  agentsEnabled?: boolean;
  personalEnabled?: boolean;
  composio?: ComposioApi | null;
  manifest?: unknown;
  liveUrl?: string | null;
  budget?: number;
  spent?: number;
  toolsSpent?: number;
  platformSpent?: number;
  toolsCap?: number;
  toolsCalls?: number;
  dailyCap?: number;
  inFlightFull?: boolean;
  fixtures?: Record<string, unknown[]> | null;
  connections?: Array<{ toolkit: string; connectedAccountId: string; composioUserId?: string }>;
} = {}) {
  const fake = fakeComposio();
  const counters = new Map<string, number>();
  const at = (key: string, window: Date) => `${key}@${window.toISOString()}`;
  const hits = new Map<string, number>();
  const reservations = new Map<string, { ctx: unknown; model: string | null; costUsd: number }>();
  const settled: Array<{ id: string; item: ModelUsage | null }> = [];
  const recorded: Array<{ ctx: unknown; items: ModelUsage[] }> = [];
  const sessions = new Map<string, { sessionId: string; configHash: string }>();
  const connections = [...(o.connections ?? [])];
  const revoked: Array<{ productId: string; composioUserId: string; toolkit: string }> = [];
  const saved: unknown[] = [];
  let released = 0;
  let inFlight = 0;
  const deps: ToolsDeps = {
    agentsEnabled: o.agentsEnabled ?? true,
    personalEnabled: o.personalEnabled ?? true,
    findToken: async (token) =>
      token === TOKEN || token === BUILD_TOKEN
        ? { id: "tok", productId: PRODUCT, scope: o.scope ?? (token === BUILD_TOKEN ? "build" : "live"), allowedModels: o.models ?? agentModels("scholar", "read_page"), dailyBudgetUsd: o.budget ?? 3 }
        : null,
    productStatus: async () => (o.status === undefined ? "live" : o.status),
    productInfo: async () => ({ manifest: o.manifest ?? null, liveUrl: o.liveUrl === undefined ? "https://product.example" : o.liveUrl }),
    hitRateLimits: async (keys) => {
      const out: Record<string, number> = {};
      for (const key of keys) {
        const n = (hits.get(key) ?? 0) + 1;
        hits.set(key, n);
        out[key] = n;
      }
      return out;
    },
    acquireInFlight: async () => {
      if (o.inFlightFull) return null;
      inFlight += 1;
      return NOW;
    },
    releaseInFlight: async () => {
      inFlight -= 1;
      released += 1;
    },
    reserveCounter: async (key, window, amount, limit) => {
      const total = (counters.get(at(key, window)) ?? 0) + amount;
      if (total > limit) return null;
      counters.set(at(key, window), total);
      return total;
    },
    adjustCounter: async (key, window, delta) => {
      counters.set(at(key, window), Math.max(0, (counters.get(at(key, window)) ?? 0) + delta));
    },
    counterValue: async (key, window) => counters.get(at(key, window)) ?? 0,
    tokenSpendToday: async () => o.spent ?? 0,
    platformSpendToday: async () => o.platformSpent ?? 0,
    toolsSpendToday: async () => o.toolsSpent ?? 0,
    dailySpendCapUsd: o.dailyCap ?? 100,
    toolsDailySpendCapUsd: o.toolsCap ?? 10,
    toolsDailyCalls: o.toolsCalls ?? 3000,
    reserveSpend: async (ctx, model, costUsd) => {
      const id = `res_${reservations.size + 1}`;
      reservations.set(id, { ctx, model, costUsd });
      return id;
    },
    settleSpend: async (id, item) => {
      settled.push({ id, item });
    },
    recordUsage: async (ctx, items) => {
      recorded.push({ ctx, items });
    },
    buildFixtures: async () => o.fixtures ?? null,
    findToolSession: async (productId, userId) => sessions.get(`${productId}:${userId}`) ?? null,
    saveToolSession: async (row) => {
      sessions.set(`${row.productId}:${row.composioUserId}`, { sessionId: row.sessionId, configHash: row.configHash });
    },
    activeConnections: async (_productId, userId) => connections.filter((c) => !c.composioUserId || c.composioUserId === userId).map((c) => ({ toolkit: c.toolkit, connectedAccountId: c.connectedAccountId })),
    saveConnection: async (row) => {
      saved.push(row);
      connections.push({ toolkit: row.toolkit, connectedAccountId: row.connectedAccountId, composioUserId: row.composioUserId });
    },
    revokeConnection: async (productId, composioUserId, toolkit) => {
      revoked.push({ productId, composioUserId, toolkit });
      for (let i = connections.length - 1; i >= 0; i -= 1) if (connections[i].toolkit === toolkit) connections.splice(i, 1);
    },
    composio: () => (o.composio === undefined ? fake.api : o.composio),
    platformUrl: "https://platform.test",
    now: () => NOW,
  };
  return { deps, ...fake, counters, reservations, settled, recorded, sessions, connections, revoked, saved, inFlight: () => inFlight, released: () => released };
}

export function toolsRequest(path: string, body?: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN): Request {
  return new Request(`https://platform.test/api/gateway/tools${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; message: string; type: string } };
  return { status: res.status, ...body.error };
}
