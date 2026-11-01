import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";
import type { GatewayEndpoint, MetaModelId } from "@/lib/types";

export const UPSTREAM_BASE_URL = "https://api.meta.ai/v1";

/** Which models each mirrored endpoint accepts. The files endpoint takes no model. */
export const ENDPOINT_MODELS: Record<GatewayEndpoint, readonly MetaModelId[]> = {
  // muse-spark-1.3 stays so products built to call it still pass; the handler serves them with Spark 1.3 Contributor.
  responses: ["muse-spark-1.3", "muse-wonder-1.0", "muse-image-1.0", "sam-3.1"],
  "images/generations": ["muse-image-1.0"],
  "images/edits": ["muse-image-1.0"],
  files: [],
  "asr/transcribe": ["muse-voice-transcribe-1.0"],
};

export const GATEWAY_ENDPOINTS = Object.keys(ENDPOINT_MODELS) as GatewayEndpoint[];

/** Starting limits. Tune during the build week. */
export const DEFAULT_LIMITS = {
  /**
   * What one build's tests may spend on Meta through its build token: every verify run, every fix round and the demo
   * recording share it. The gateway reserves each call's estimate up front, from its max_output_tokens. One figure for
   * every build: a product's own text and vision calls use Muse Wonder, about $0.30 a test run, so about 15 verify
   * runs, the fix rounds and the demo come to about $4.50. Refinements of older Spark products get the same room.
   */
  buildTokenBudgetUsd: 10,
  /** A live product's daily Meta budget at least. It resets at 00:00 UTC. */
  liveTokenDailyBudgetUsd: 3,
  /** Runs a live product's daily budget covers at its brief's estimated cost per run, when that is more than the floor. */
  liveTokenDailyRuns: 20,
  /** The most a live product's daily budget grows to, so one busy product can't spend the platform's whole daily cap. */
  liveTokenDailyBudgetMaxUsd: 10,
  perTokenRequestsPerMinute: 120,
  /** Applies when the product forwards its end user's IP in x-musemuse-client-ip. */
  perIpRequestsPerMinute: 20,
  /** Meta calls one token may have running at once, so parallel calls can't overshoot the budget before metering. */
  perTokenInFlight: 4,
  /** In-flight slots are counted per bucket of this length, so a slot a crashed request never gave back expires. */
  inFlightBucketMs: 10 * 60_000,
  uploadMaxBytes: 100 * 1024 * 1024,
  uploadTtlHours: 24,
  /** Upload tickets per product token, and per end user when the product forwards x-musemuse-client-ip. */
  uploadTicketsPerToken: 30,
  uploadTicketsPerIp: 10,
  uploadTicketWindowMs: 10 * 60_000,
  /** How long a signed upload ticket stays usable. */
  uploadTicketValidMs: 5 * 60_000,
  /** Vercel Functions reject request bodies over 4.5 MB. Bigger files go through {GATEWAY_URL}/uploads. */
  requestBodyMaxBytes: 4.5 * 1024 * 1024,
  /** Cap for the asr/transcribe JSON extension's audioUrl download. */
  asrAudioMaxBytes: 60 * 1024 * 1024,
  upstreamTimeoutMs: 290_000,
  /** How long an MCP tool call waits for the product's /api/actions/<name>. */
  mcpActionTimeoutMs: 120_000,
} as const;

/**
 * The allowedModels entry that marks a product built as an agent. It is not a model, so no model check ever matches it.
 * Existing tokens don't have it: it only raises limits, and nothing requires it.
 */
export const AGENT_MARKER = "agent";

export function hasAgentMarker(allowedModels: readonly string[]): boolean {
  return allowedModels.includes(AGENT_MARKER);
}

/**
 * The allowedModels entry that marks a product whose brief picked a long-run recipe (lib/recipes). Not a model either, and
 * separate from the agent marker: these products write their own loop, so they get no catalog tools, only the long run
 * limits (RUN_LIMITS.longAgent).
 */
export const AGENT_LONG_MARKER = "agent-long";

export function hasLongAgentMarker(allowedModels: readonly string[]): boolean {
  return allowedModels.includes(AGENT_LONG_MARKER);
}

/**
 * Built-in tool calls (web searches, tool search) one Responses call may make. Meta has no maximum of its own
 * (tool-calling, "max_tool_calls limits built-in tools only"), and each search is billed and adds input.
 */
export const BUILTIN_TOOL_CALL_CAPS = { build: 2, live: 5, agent: 8 } as const;

/** Limits that differ for tokens with the agent marker. An agent's loop runs tools and model calls side by side. */
export const AGENT_LIMITS = { perTokenInFlight: 8 } as const;

/**
 * The build token's budget: the same for every build, whatever models the product may call (DEFAULT_LIMITS). The
 * argument is ignored and kept so older callers still compile.
 */
export function buildTokenBudgetFor(_models: readonly string[] = []): number {
  return DEFAULT_LIMITS.buildTokenBudgetUsd;
}

/**
 * A live product's daily budget: room for 20 runs at its brief's estimated cost per run, plus one more run for the
 * estimates the gateway reserves while calls are still running, rounded up to whole dollars, between the $3 floor and
 * the $10 ceiling. A product whose brief has no estimate gets the floor.
 */
export function liveTokenDailyBudgetFor(estimatedCostPerRunUsd: number | null | undefined): number {
  const perRun = Number.isFinite(estimatedCostPerRunUsd) && (estimatedCostPerRunUsd as number) > 0 ? (estimatedCostPerRunUsd as number) : 0;
  const fits = Math.ceil(perRun * (DEFAULT_LIMITS.liveTokenDailyRuns + 1) - 1e-9);
  return Math.min(DEFAULT_LIMITS.liveTokenDailyBudgetMaxUsd, Math.max(DEFAULT_LIMITS.liveTokenDailyBudgetUsd, fits));
}

/** Header a product sets to its end user's IP so the gateway can rate limit per person. Never used for auth. */
export const CLIENT_IP_HEADER = "x-musemuse-client-ip";

/** Header a product sets to name one agent run, so its turns, tool calls and dollars are capped together. */
export const RUN_HEADER = "x-musemuse-run-id";
/** Header a product sets to its visitor's id, used only for the hashed safety_identifier. Never used for auth. */
export const VISITOR_HEADER = "x-musemuse-visitor";
/** Header a product sets to the owner session the platform signed for its owner. */
export const OWNER_HEADER = "x-musemuse-owner";
/** Reply header saying what the gateway changed in the request, in a sentence or two. */
export const NOTE_HEADER = "x-musemuse-note";

/** Hosts the asr/transcribe JSON extension may download audio from (public Vercel Blob). */
export const AUDIO_URL_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Request checks, in order. Implemented by handleGateway in lib/gateway/handler.ts.
 *   1. Allowed endpoint.
 *   2. Bearer product token, looked up by hash. The product must not be disabled or failed.
 *   3. Model in the token's allowlist and the endpoint's.
 *   4. Responses requests are rewritten (lib/gateway/rewrite.ts): background refused, agent tokens kept off Contributor,
 *      max_tool_calls clamped and a hashed safety_identifier added. Changes are said in x-musemuse-note.
 *   5. Per-token and per-IP rate limits, then an in-flight slot (at most perTokenInFlight calls per token, or
 *      AGENT_LIMITS.perTokenInFlight with the agent marker).
 *   6. Per-run caps, when the token has them and the request names a run (lib/gateway/runs.ts).
 *   7. Token daily budget and platform daily cap, counting this call's estimated cost and the estimates of calls still
 *      running. The estimate is recorded as a usage row before forwarding.
 *   8. Forward to UPSTREAM_BASE_URL with MODEL_API_KEY and stream the response through.
 *   9. Replace the estimate with the metered usage, search fees included, settle the run, then give the slot back.
 */
export const GATEWAY_CHECKS = [
  "endpoint",
  "token",
  "allowlist",
  "rewrite",
  "rate_limit",
  "in_flight",
  "run",
  "budget",
  "forward",
  "meter",
] as const;

// ---------- Wave 3, unit 9: the code_session scope (docs/CAPABILITIES.md, 15b) ----------

/** A Muse Code session's own token (lib/caps/code/musecode/token.ts). */
export const CODE_SESSION_SCOPE = "code_session";

/**
 * The models a session token can carry. Its token names exactly one (allowedModels[0]), set by the platform at the
 * start: Muse Wonder for a person's task, muse-spark-1.3-contributor only for a build's own test sessions while
 * TEST_MODEL names it off production or BUILDS_ON_CONTRIBUTOR is on (Meta may train on that tier, terms 6.2). muse-spark-1.3 is never one of them.
 */
export const CODE_SESSION_MODELS = ["muse-wonder-1.0", SPARK_STANDIN] as const;

/**
 * Why a session token's call is refused, or null. Checked before the model allowlist, which a session token replaces:
 *   - only POST /v1/responses (the method is the handler's first check)
 *   - only its one model, never another, and muse-spark-1.3 refused outright rather than served as Contributor
 *   - Contributor only while `testModel` (buildTestModel in lib/env.ts) names it
 * Its budget and its end (stop, or its limit) are the token row's: lib/caps/code/musecode/gateway.ts.
 */
export function codeSessionRefusal(endpoint: GatewayEndpoint, model: string | null, token: { allowedModels: readonly string[] }, testModel: string | null): { status: number; code: string; message: string } | null {
  if (endpoint !== "responses") return { status: 403, code: "session_scope", message: "A Muse Code session's token calls only /v1/responses." };
  if (!model) return null;
  const own = token.allowedModels[0];
  if (model === RETIRED_SPARK) return { status: 404, code: "model_not_found", message: `${RETIRED_SPARK} is never used here.` };
  if (model !== own || !(CODE_SESSION_MODELS as readonly string[]).includes(model)) {
    return { status: 404, code: "model_not_found", message: `This session runs on ${own ?? "no model"} only.` };
  }
  if (model === SPARK_STANDIN && testModel !== SPARK_STANDIN) {
    return { status: 403, code: "model_not_for_sessions", message: `${SPARK_STANDIN} runs only test sessions, with TEST_MODEL set off production.` };
  }
  return null;
}

/** Tool types a session may send: Muse Code's own, run in its sandbox. Meta runs no tool for a session. */
const SESSION_TOOL_TYPES = new Set(["function", "custom", "namespace"]);
/** Part fields that make Meta fetch something, or read a file stored under the platform's key. */
const REMOTE_FIELDS = new Set(["file_url", "image_url", "video_url", "audio_url"]);
const MEDIA_PART = /^input_(image|file|video|audio)$/;
const WALK_DEPTH = 64;

function sessionToolProblem(tool: unknown, depth = 0): string | null {
  if (depth > WALK_DEPTH) return "tools nested too deep";
  const type = (tool as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !SESSION_TOOL_TYPES.has(type)) return `the tool type ${JSON.stringify(type ?? null).slice(0, 60)}`;
  const inner = (tool as { tools?: unknown }).tools;
  if (type === "namespace" && Array.isArray(inner)) {
    for (const t of inner) {
      const problem = sessionToolProblem(t, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

const notInline = (url: unknown): boolean => typeof url === "string" && url !== "" && !url.startsWith("data:");

/** What in a body's `input` points outside it. Plain text is never read as a link: a task may talk about URLs. */
function remoteInput(value: unknown, depth = 0): string | null {
  if (depth > WALK_DEPTH) return "input nested too deep";
  if (Array.isArray(value)) {
    for (const v of value) {
      const problem = remoteInput(v, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const part = value as Record<string, unknown>;
  if (part.type === "item_reference") return "a stored item";
  for (const [key, field] of Object.entries(part)) {
    if (key === "file_id" && field) return "a stored file";
    if (REMOTE_FIELDS.has(key) && notInline(field && typeof field === "object" ? (field as { url?: unknown }).url : field)) return `a remote ${key}`;
    if (key === "url" && typeof part.type === "string" && MEDIA_PART.test(part.type) && notInline(field)) return `a remote ${part.type}`;
    const problem = remoteInput(field, depth + 1);
    if (problem) return problem;
  }
  return null;
}

/**
 * Why a session token's body is refused, or null. The firewall is a session's only boundary, and the agent's shell can
 * read the token and call the one route it allows, so this route must not reach anywhere else for it. So no tool Meta
 * runs itself (web search, tool search, MCP and the like), no media by URL, and nothing stored under the platform's one
 * key (previous responses, conversations, files, prompts). The spike saw none of these in Muse Code's bodies (a
 * `namespace` of its own tools, `store: false`, inline text and images).
 */
export function codeSessionBodyRefusal(json: Record<string, unknown>): { status: number; code: string; message: string } | null {
  const refuse = (what: string) => ({ status: 400, code: "session_body", message: `A Muse Code session can't use ${what} here: it runs with no way out of its workspace but this route.` });
  const set = (v: unknown) => v !== undefined && v !== null && v !== false && v !== "";
  for (const field of ["background", "previous_response_id", "conversation", "prompt"]) if (set(json[field])) return refuse(field);
  if (json.store === true) return refuse("store");
  if (json.tools !== undefined && json.tools !== null) {
    if (!Array.isArray(json.tools)) return refuse("tools in that shape");
    for (const tool of json.tools) {
      const problem = sessionToolProblem(tool);
      if (problem) return refuse(problem);
    }
  }
  const remote = remoteInput(json.input);
  return remote ? refuse(remote) : null;
}

/** A session's body as Meta gets it: never stored, and with no name for the person but the one the platform holds. */
export function codeSessionBody(json: Record<string, unknown>): Record<string, unknown> {
  const { safety_identifier: _named, user: _alsoNamed, ...rest } = json;
  return { ...rest, store: false };
}
