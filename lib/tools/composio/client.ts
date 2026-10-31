/**
 * The provider behind the tool gateway, as an injected interface so tests use fakes. The real one wraps @composio/core,
 * pinned in package.json.
 *
 * The SDK is imported lazily and kept external to the bundle (next.config.ts). Its engines field asks for Node 22.22.3 or
 * newer. Vercel runs this project on 24.x, a laptop on 22.22.2 only gets npm's warning and runs it the same (the spike and
 * this unit's live checks did), and nothing that doesn't call a tool ever loads it.
 *
 * Execute never passes a version: session execute ignores one, and Composio runs the latest for Instant whatever is
 * pinned. The SDK sends every execute with no retries of its own, and the handler adds none.
 */

export interface ComposioSessionConfig {
  sessionPreset: "direct_tools";
  toolkits: { enable: string[] };
  tools: Record<string, { enable: string[] }>;
  /** Absent on an owner's session, which has only personal toolkits. */
  instant?: { toolkits: { enable: string[] }; returnInstantCharge: true };
  manageConnections: { enable: false };
  sandbox: { enable: false; enableProxyExecution: false };
}

export interface ToolReply {
  data: unknown;
  error: string | null;
  resultType: string;
  logId?: string;
  instantCharge?: { amount?: unknown; currency?: string; charged_by?: string } | null;
}

export interface ComposioApi {
  createSession(userId: string, config: ComposioSessionConfig): Promise<{ sessionId: string }>;
  updateSession(sessionId: string, config: ComposioSessionConfig): Promise<void>;
  /** Never takes a version. A tool failure resolves with resultType "failed"; refusals throw. */
  execute(sessionId: string, slug: string, args: Record<string, unknown>, opts: { signal: AbortSignal }): Promise<ToolReply>;
  authorize(sessionId: string, toolkit: string, callbackUrl: string): Promise<{ id: string; redirectUrl: string }>;
  /** True only when this account is ACTIVE, not disabled, on this user and this toolkit. */
  verifyConnection(o: { connectedAccountId: string; userId: string; toolkit: string }): Promise<boolean>;
  deleteConnection(connectedAccountId: string): Promise<void>;
}

/** Composio's refusals, by the number in `error.code`. 4324 is the same refusal as 4310, when the whole toolkit is off. */
export const COMPOSIO_CODES = { noConnection: 4302, toolNotEnabled: 4310, toolkitNotAllowed: 4324 } as const;
const WALLET_EMPTY = "Metering_WalletBalanceExhausted";

export type ComposioFailure =
  /** 402: the prepaid balance is gone. Its exact shape is from Composio's docs, so the slug and the status both count. */
  | { kind: "wallet_empty" }
  | { kind: "no_connection" }
  | { kind: "not_enabled" }
  /** Composio refused and no tool ran, so nothing is owed. */
  | { kind: "refused"; status: number }
  /** A timeout, a dropped connection or a 5xx: the tool may have done billable work. */
  | { kind: "unknown" };

function bodyOf(err: unknown): { code?: unknown; slug?: unknown } {
  const e = err as { error?: unknown; cause?: { error?: unknown }; message?: unknown } | null;
  const body = (e?.error ?? e?.cause?.error) as { error?: unknown } | undefined;
  if (body && typeof body === "object") return ((body.error ?? body) as { code?: unknown; slug?: unknown }) ?? {};
  // The SDK's message is "400 {json}" when it doesn't keep the body as a field.
  const json = typeof e?.message === "string" ? e.message.match(/\{[\s\S]*\}/)?.[0] : undefined;
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as { error?: unknown };
    return ((parsed.error ?? parsed) as { code?: unknown; slug?: unknown }) ?? {};
  } catch {
    return {};
  }
}

/**
 * True when the reply says the tool failed. Most failures come back as resultType "failed", but a page Firecrawl can't
 * reach comes back "completed" with success: false and its reason in data.error.
 */
export function replyFailed(reply: Pick<ToolReply, "resultType" | "data">): boolean {
  if (reply.resultType !== "completed") return true;
  const data = reply.data as { success?: unknown; error?: unknown } | null | undefined;
  return data?.success === false && typeof data.error === "string";
}

/** Sorts a thrown error from the SDK into what the gateway does about it. */
export function classifyFailure(err: unknown): ComposioFailure {
  const e = err as { status?: unknown; statusCode?: unknown; cause?: { status?: unknown } } | null;
  const status = Number(e?.status ?? e?.statusCode ?? e?.cause?.status);
  const body = bodyOf(err);
  if (status === 402 || body.slug === WALLET_EMPTY || String((err as { message?: unknown })?.message ?? "").includes(WALLET_EMPTY)) {
    return { kind: "wallet_empty" };
  }
  if (Number(body.code) === COMPOSIO_CODES.noConnection) return { kind: "no_connection" };
  if (Number(body.code) === COMPOSIO_CODES.toolNotEnabled || Number(body.code) === COMPOSIO_CODES.toolkitNotAllowed) return { kind: "not_enabled" };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: "refused", status };
  return { kind: "unknown" };
}

type Sdk = typeof import("@composio/core");
type Composio = InstanceType<Sdk["Composio"]>;
/** The parts of a session the gateway uses. The SDK's declared overloads hide execute's request options. */
interface Session {
  execute(slug: string, args: Record<string, unknown>, options: undefined, request: { signal: AbortSignal }): Promise<unknown>;
  update(config: Omit<ComposioSessionConfig, "sessionPreset">): Promise<unknown>;
  authorize(toolkit: string, options: { callbackUrl: string }): Promise<{ id: string; redirectUrl?: string | null }>;
}

/** Settles with the work, or rejects when the signal fires first. For SDK calls that take no signal of their own. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Sessions already read back in this instance, so an execute doesn't cost an extra round trip each time. */
const SESSIONS_CACHED = 200;

/** The real client. Lazy, so the SDK and its dependencies load only when a tool actually runs. */
export function composioApi(apiKey: () => string): ComposioApi {
  let client: Promise<Composio> | null = null;
  const sessions = new Map<string, Session>();

  const sdk = () =>
    (client ??= import("@composio/core").then(({ Composio }) => new Composio({ apiKey: apiKey(), allowTracking: false })).catch((err) => {
      client = null;
      throw err;
    }));

  const sessionOf = async (id: string): Promise<Session> => {
    const cached = sessions.get(id);
    if (cached) return cached;
    const session = (await (await sdk()).sessions.use(id)) as unknown as Session;
    if (sessions.size >= SESSIONS_CACHED) sessions.delete(sessions.keys().next().value as string);
    sessions.set(id, session);
    return session;
  };

  return {
    async createSession(userId, config) {
      const session = await (await sdk()).sessions.create(userId, config);
      return { sessionId: session.sessionId };
    },
    async updateSession(sessionId, { sessionPreset: _preset, ...config }) {
      await (await sessionOf(sessionId)).update(config);
    },
    async execute(sessionId, slug, args, { signal }) {
      const session = await untilAborted(sessionOf(sessionId), signal);
      const reply = await session.execute(slug, args, undefined, { signal });
      return reply as ToolReply;
    },
    async authorize(sessionId, toolkit, callbackUrl) {
      const request = await (await sessionOf(sessionId)).authorize(toolkit, { callbackUrl });
      return { id: request.id, redirectUrl: request.redirectUrl ?? "" };
    },
    async verifyConnection({ connectedAccountId, userId, toolkit }) {
      // Items don't name their user, so asking per user is what ties the account to this person.
      const list = await (await sdk()).connectedAccounts.list({
        userIds: [userId],
        toolkitSlugs: [toolkit],
        statuses: ["ACTIVE"],
      });
      return list.items.some((a) => a.id === connectedAccountId && a.status === "ACTIVE" && !a.isDisabled);
    },
    async deleteConnection(connectedAccountId) {
      await (await sdk()).connectedAccounts.delete(connectedAccountId);
    },
  };
}
