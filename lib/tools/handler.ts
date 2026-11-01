import { gatewayError } from "@/lib/gateway/errors";
import { parseBearer } from "@/lib/gateway/extract";
import type { GatewayToken } from "@/lib/gateway/handler";
import { holdRun, parseRunId, releaseRun, runLimitsFor, settleRun, type RunCounters, type RunHold } from "@/lib/gateway/runs";
import { RUN_HEADER } from "@/lib/gateway/policy";
import { argumentsProblem, cleanArguments, recipientsOf, resolvesToPublic, withParsedUrl } from "@/lib/tools/args";
import { cannedOutput, personalToolkitsOf, simulatedConnection, type ToolConnectionView } from "@/lib/tools/canned";
import {
  allowedToolIds,
  catalogTool,
  denialOf,
  findFunction,
  functionDefinition,
  NAMESPACE_THRESHOLD,
  namespaceDefinition,
  toolkitLabel,
  type ListedFunction,
} from "@/lib/tools/catalog";
import { classifyFailure, replyFailed, untilAborted, type ComposioApi, type ComposioFailure, type ToolReply } from "@/lib/tools/composio/client";
import { ensureToolSession, sessionConfigFor, STALE_SESSION_HASH, type SessionStore } from "@/lib/tools/composio/sessions";
import type { CatalogFunction, CatalogTool } from "@/lib/tools/composio/sync";
import type { ToolErrorCode, ToolFixtures, ToolPrincipal } from "@/lib/tools/ids";
import { TOOL_ERRORS } from "@/lib/tools/ids";
import { applyOutputRules, extractSources, trimOutput } from "@/lib/tools/output";
import { TOOL_LIMITS, USER_INPUT_URL_PARAMS } from "@/lib/tools/policy";
import {
  composioUserId,
  mintOwnerSession,
  ownerSubject,
  productComposioUserId,
  readOwnerCode,
  resolvePrincipal,
  safeReturnPath,
  tierAllowed,
  visitorKeys,
  type Principal,
} from "@/lib/tools/principal";
import { chargeOf, estimateToolUsd, settledToolUsd, toolUsage } from "@/lib/tools/pricing";
import { checkApproval, mintApproval, mintConnectState, readConnectState } from "@/lib/tools/sign";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage, ProductStatus } from "@/lib/types";

/**
 * The tool gateway (docs/AGENT_TOOLS.md): TOOL_CHECKS in lib/tools/policy.ts, in order. The routes stay thin wrappers.
 * Nothing a product sees names the provider, so another one can sit behind these routes later.
 */

/** Everything the tool gateway touches outside the request, injected so tests run it without a database or a network. */
export interface ToolsDeps extends RunCounters, SessionStore {
  agentsEnabled: boolean;
  personalEnabled: boolean;
  findToken(token: string): Promise<GatewayToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  productInfo(productId: string): Promise<{ manifest: unknown; liveUrl: string | null } | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, slot: Date): Promise<void>;
  tokenSpendToday(tokenId: string): Promise<number>;
  platformSpendToday(): Promise<number>;
  toolsSpendToday(): Promise<number>;
  dailySpendCapUsd: number;
  toolsDailySpendCapUsd: number;
  toolsDailyCalls: number;
  reserveSpend(ctx: UsageContext, model: string | null, costUsd: number): Promise<string>;
  settleSpend(reservationId: string, item: ModelUsage | null): Promise<void>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  buildFixtures(productId: string): Promise<ToolFixtures | null>;
  activeConnections(productId: string, composioUserId: string): Promise<Array<{ toolkit: string; connectedAccountId: string }>>;
  saveConnection(row: { productId: string; principal: ToolPrincipal; composioUserId: string; toolkit: string; connectedAccountId: string }): Promise<void>;
  revokeConnection(productId: string, composioUserId: string, toolkit: string): Promise<void>;
  /** The provider, or null with no key: live calls then answer tools_paused. Builds never ask for it. */
  composio(): ComposioApi | null;
  platformUrl: string;
  /** Who this browser is signed in as on the platform. Only the connect callback asks, since it has no product token. */
  platformUserId(): Promise<string | null>;
  /** Every address a host resolves to. Throws when it doesn't resolve. */
  lookupHost(host: string): Promise<string[]>;
  /** TOOL_LIMITS.sessionTimeoutMs, unless a test shortens it. */
  sessionTimeoutMs?: number;
  /**
   * Wave 3, unit 1: the gateway's trust check (lib/trust/gateway.ts): a taken-down product or a banned owner's, and the
   * builder's daily dollars, which tool calls spend too. Unset while TRUST_REPORTS and TRUST_SIGNED_IN_CAPS are off.
   */
  trustCheck?(token: GatewayToken): Promise<Response | null>;
  now?(): Date;
}

const JSON_ERROR_TYPES: Record<ToolErrorCode, Parameters<typeof gatewayError>[1]> = {
  tool_not_allowed: "permission_error",
  sign_in_required: "permission_error",
  invalid_arguments: "invalid_request_error",
  rate_limited: "rate_limit_error",
  run_limit: "rate_limit_error",
  budget_exceeded: "insufficient_quota",
  tools_paused: "server_error",
  tool_failed: "server_error",
};

function toolError(code: ToolErrorCode, message: string, headers?: Record<string, string>): Response {
  return gatewayError(TOOL_ERRORS[code], JSON_ERROR_TYPES[code], code, message, { retry: false, headers });
}

const paused = () => toolError("tools_paused", "Tools are off here right now.");
const walletEmpty = () => toolError("tools_paused", "Tools are paused right now. Try again later.");

/** Provider text for our own logs, without what looks like an address, a token or an account id. */
function forLog(said: unknown): string {
  const text = said instanceof Error ? said.message : typeof said === "string" ? said : "unknown";
  return text
    .slice(0, 300)
    .replace(/\S+@\S+/g, "[address]")
    .replace(/\S{8,}/g, (word) => (/\d/.test(word) ? "[id]" : word));
}

function refusedBody(status: number, code: string, message: string): Response {
  return gatewayError(status, "invalid_request_error", code, message, { retry: false });
}

/**
 * Serves everything under {GATEWAY_URL}/tools: list, execute, connections, connect, disconnect and the callback. With
 * AGENTS_ENABLED off every route answers as disabled, so nothing here runs for today's products.
 */
export async function handleTools(req: Request, path: readonly string[], deps: ToolsDeps): Promise<Response> {
  const route = `${req.method} ${path.join("/")}`;
  try {
    if (route === "GET callback") return await handleCallback(req, deps);
    if (!deps.agentsEnabled) return paused();
    switch (route) {
      case "GET ":
        return await withToken(req, deps, (t) => listTools(req, t, deps));
      case "POST execute":
        return await withToken(req, deps, (t) => execute(req, t, deps));
      case "GET connections":
        return await withToken(req, deps, (t) => listConnections(req, t, deps));
      case "POST connect":
        return await withToken(req, deps, (t) => connect(req, t, deps));
      case "POST disconnect":
        return await withToken(req, deps, (t) => disconnect(req, t, deps));
      default:
        return gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${route} under /tools.`, { retry: false });
    }
  } catch (err) {
    console.error("[tools] unexpected error:", err);
    return gatewayError(500, "server_error", "gateway_error", "The gateway hit an unexpected error. Try again.");
  }
}

/** Step 1: bearer token, then product status. */
async function withToken(req: Request, deps: ToolsDeps, next: (token: GatewayToken) => Promise<Response>): Promise<Response> {
  const bearer = parseBearer(req.headers.get("authorization"));
  const token = bearer ? await deps.findToken(bearer) : null;
  if (!token) {
    return gatewayError(401, "authentication_error", "invalid_token", 'Send the product\'s token as "Authorization: Bearer <PRODUCT_TOKEN>".', { retry: false });
  }
  const status = await deps.productStatus(token.productId);
  if (!status || status === "disabled" || status === "failed") {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
  }
  // ---------- Wave 3, unit 1: trust (docs/CAPABILITIES.md, section 7). No check is wired with its flags off ----------
  { const refused = deps.trustCheck ? await deps.trustCheck(token) : null; if (refused) return refused; }
  return next(token);
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TOOL_LIMITS.bodyMaxBytes) return toolError("invalid_arguments", "The request is too big.");
  const raw = await req.arrayBuffer();
  if (raw.byteLength > TOOL_LIMITS.bodyMaxBytes) return toolError("invalid_arguments", "The request is too big.");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the same answer.
  }
  return refusedBody(400, "invalid_body", "The request body must be a JSON object.");
}

/** The tools this token may use, from the catalog, with personal ones gone while their flag is off. */
async function allowedTools(token: GatewayToken, deps: ToolsDeps): Promise<CatalogTool[]> {
  const info = token.scope === "build" ? null : await deps.productInfo(token.productId);
  return allowedToolIds(token, info?.manifest)
    .map((id) => catalogTool(id))
    .filter((t): t is CatalogTool => t !== null && (t.tier === "public" || deps.personalEnabled));
}

const composioSubject = (token: GatewayToken, principal: Principal) => composioUserId("o", token.productId, principal.subject ?? "none");

async function connectedToolkits(token: GatewayToken, principal: Principal, deps: ToolsDeps): Promise<Map<string, string>> {
  if (principal.kind !== "owner") return new Map();
  const rows = await deps.activeConnections(token.productId, composioSubject(token, principal));
  return new Map(rows.map((r) => [r.toolkit, r.connectedAccountId]));
}

function connectionView(toolkit: string, principal: Principal, connected: ReadonlyMap<string, string>): ToolConnectionView {
  const label = toolkitLabel(toolkit);
  if (principal.kind === "build") return simulatedConnection(toolkit, label);
  return { toolkit, label, connected: connected.has(toolkit), canConnect: principal.kind === "owner" };
}

/** GET /tools: a person who can't use a personal tool sees it without its functions, so the model can't try. */
async function listTools(req: Request, token: GatewayToken, deps: ToolsDeps): Promise<Response> {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "functions";
  if (format !== "functions" && format !== "namespaced") {
    return toolError("invalid_arguments", "format must be functions or namespaced.");
  }
  const wanted = url.searchParams.get("ids")?.split(",").map((s) => s.trim()).filter(Boolean);
  const now = deps.now?.() ?? new Date();
  const principal = resolvePrincipal(req, token, now);
  const tools = (await allowedTools(token, deps)).filter((t) => !wanted || wanted.includes(t.id));
  const usable = tools.filter((t) => tierAllowed(principal, t));
  const functionCount = usable.reduce((n, t) => n + t.functions.length, 0);
  const deferred = format === "namespaced" && functionCount > NAMESPACE_THRESHOLD;
  const connected = await connectedToolkits(token, principal, deps);
  const byNamespace = new Map<string, ListedFunction[]>();
  const listed = tools.map((t) => {
    const allowed = tierAllowed(principal, t);
    const functions = allowed && !t.builtin ? t.functions.map((f) => functionDefinition(f, deferred)) : null;
    if (deferred && functions?.length && t.toolkit) byNamespace.set(t.toolkit, [...(byNamespace.get(t.toolkit) ?? []), ...functions]);
    return {
      id: t.id,
      label: t.label,
      stepTitle: t.stepTitle,
      tier: t.tier,
      access: t.access,
      ...(t.builtin ? { builtin: true } : {}),
      ...(functions ? { functions } : {}),
      ...(deferred && functions?.length && t.toolkit ? { namespace: t.toolkit } : {}),
      ...(t.tier === "personal" && t.toolkit ? { connection: connectionView(t.toolkit, principal, connected) } : {}),
      ...(t.access !== "read" ? { confirm: true } : {}),
    };
  });
  return Response.json({
    simulated: token.scope === "build",
    principal: principal.kind,
    toolSearch: deferred,
    ...(deferred ? { namespaces: [...byNamespace].map(([toolkit, fns]) => namespaceDefinition(toolkit, fns)) } : {}),
    tools: listed,
  });
}

const WRITE_TITLES: Readonly<Record<string, string>> = {
  gmail_draft: "Save this email as a draft?",
  gmail_send: "Send this email?",
  calendar_add: "Add this to your calendar?",
  slack_send: "Post this in Slack?",
};

/**
 * What a card shows, one line per argument, so nothing the approval covers stays out of sight. Whitespace is collapsed,
 * which also stops blank lines from pushing text out of view, and anything invisible or that reorders text is marked.
 */
function shown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\p{Cc}\p{Cf}]/gu, "\uFFFD");
}

function shownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function approvalLines(tool: Pick<CatalogTool, "toolkit" | "recipientFields">, args: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const recipients = recipientsOf(tool, args);
  if (recipients.length) lines.push(`${tool.toolkit === "slack" ? "Channel" : "To"}: ${shown(recipients.join(", "))}`);
  for (const [name, value] of Object.entries(args)) {
    if (tool.recipientFields.includes(name)) continue;
    const text = shown(shownValue(value));
    if (text) lines.push(`${name.replace(/_/g, " ")}: ${text}`);
  }
  return lines;
}

function needsConfirmation(tool: CatalogTool, id: string, args: Record<string, unknown>, stale: boolean): Response {
  return Response.json({
    ok: false,
    code: "needs_confirmation",
    approval: { id, title: WRITE_TITLES[tool.id] ?? `${tool.label}?`, lines: approvalLines(tool, args) },
    ...(stale ? { stale: true } : {}),
  });
}

function needsConnection(toolkit: string, principal: Principal): Response {
  return Response.json({ ok: false, code: "needs_connection", toolkit, label: toolkitLabel(toolkit), canConnect: principal.kind === "owner" });
}

/** A day counter's window ends at the next UTC midnight, because the cleanup deletes windows that started over an hour ago. */
function dayWindow(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function secondsToNextMinute(now: Date): number {
  return Math.max(1, Math.ceil(60 - (now.getTime() % 60_000) / 1000));
}

/** Why a tool failed, in our words. A reply is someone else's text, and a page can write what ends up in it. */
const FAILURE_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/dns|unreachable|connection refused/i, "That page couldn't be reached."],
  [/invalid request/i, "It refused these arguments."],
  [/not.?found/i, "It wasn't found."],
];

function failedOutput(tool: CatalogTool, reply: ToolReply): Response {
  const data = reply.data as { error?: unknown; code?: unknown } | null;
  const said = reply.error ?? data?.error;
  console.error(`[tools] ${tool.id} failed:`, forLog(said));
  const words = `${typeof data?.code === "string" ? data.code : ""} ${typeof said === "string" ? said : ""}`.slice(0, 500);
  const reason = FAILURE_REASONS.find(([match]) => match.test(words))?.[1];
  return toolError("tool_failed", `${tool.label} didn't work.${reason ? ` ${reason}` : ""}`);
}

const tooMany = (limit: number, now: Date) => {
  const wait = secondsToNextMinute(now);
  return toolError("rate_limited", `Too many tool calls: the limit is ${limit} a minute. Try again in ${wait} s.`, { "retry-after": String(wait) });
};

async function execute(req: Request, token: GatewayToken, deps: ToolsDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const name = body.name;
  const rawArgs = body.arguments ?? {};
  if (typeof name !== "string" || !name) return toolError("invalid_arguments", 'Send {"name": "<function name>", "arguments": {...}}.');
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs) || rawArgs === null) return toolError("invalid_arguments", "arguments must be an object.");
  const approvalId = body.approval;
  if (approvalId !== undefined && approvalId !== null && typeof approvalId !== "string") return toolError("invalid_arguments", "approval must be the id from the confirmation.");
  const userInput = typeof body.userInput === "string" ? body.userInput : null;
  if (userInput !== null && Buffer.byteLength(userInput) > TOOL_LIMITS.userInputMaxBytes) return toolError("invalid_arguments", "userInput is too big.");

  // Step 2: on this product's list, not denied, and its tier's flag is on.
  if (catalogTool(name)?.builtin) return toolError("tool_not_allowed", `${name} runs on /v1/responses, not here.`);
  const found = findFunction(name);
  if (!found) return toolError("tool_not_allowed", `${name.slice(0, 80)} isn't a tool products can call.`);
  const { tool, fn } = found;
  const denied = denialOf(tool, fn);
  if (denied) {
    console.error("[tools] the catalog holds a denied function:", denied);
    return toolError("tool_not_allowed", `${name.slice(0, 80)} isn't a tool products can call.`);
  }
  if (tool.tier === "personal" && !deps.personalEnabled) return toolError("tool_not_allowed", `${tool.label} isn't on here.`);
  const allowed = await allowedTools(token, deps);
  if (!allowed.some((t) => t.id === tool.id)) {
    return toolError("tool_not_allowed", `This product's brief didn't pick ${tool.label}, so it can't call it.`);
  }
  const isBuild = token.scope === "build";
  const api = isBuild ? null : deps.composio();
  if (!isBuild && !api) return paused();

  // Step 3: who is asking. A personal tool also needs the person's account, and nothing about it costs anything yet.
  const principal = resolvePrincipal(req, token, now);
  if (!tierAllowed(principal, tool)) {
    return toolError("sign_in_required", `Only this app's owner can use ${tool.label} for now.`);
  }
  const ownerUserId = principal.kind === "owner" ? composioSubject(token, principal) : null;
  if (tool.tier === "personal" && !isBuild) {
    const connected = await connectedToolkits(token, principal, deps);
    if (!connected.has(tool.toolkit as string)) return needsConnection(tool.toolkit as string, principal);
  }

  // Step 4: arguments, recipients, then the confirmation.
  const args = rawArgs as Record<string, unknown>;
  const problem = argumentsProblem(tool, fn, args, userInput);
  if (problem) return toolError("invalid_arguments", problem);
  const clean = withParsedUrl(tool, cleanArguments(args));
  const scope = { productId: token.productId, subject: principal.subject ?? principal.kind, slug: fn.name, args: clean };
  let approved: { nonce: string; exp: Date } | null = null;
  if (tool.access !== "read") {
    approved = approvalId ? checkApproval(approvalId, scope, now) : null;
    if (!approved) return needsConfirmation(tool, mintApproval(scope, now), clean, Boolean(approvalId));
  }

  // Step 5: this token's and this person's rate limits, the daily cap, then a slot. Step 6 has the platform-wide limits.
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const limits: Record<string, number> = { [`tools-token:${token.id}`]: TOOL_LIMITS.perTokenPerMinute };
  for (const key of visitorKeys(req, token.productId)) limits[key] = TOOL_LIMITS.perVisitorPerMinute;
  const overLimit = await limitHit(limits, windowStart, deps);
  if (overLimit) return tooMany(overLimit, now);

  /** Given back unless the call goes through to the provider. */
  const undo: Array<() => Promise<unknown>> = [];
  const undoAll = () =>
    Promise.all(undo.splice(0).map((u) => u().catch((err) => console.error("[tools] giving back a hold failed:", err))));

  const runHeader = req.headers.get(RUN_HEADER);
  const runId = parseRunId(runHeader);
  if (runHeader !== null && !runId) {
    return gatewayError(400, "invalid_request_error", "invalid_run_id", `${RUN_HEADER} must be 8 to 64 letters, digits, dashes or underscores.`, { retry: false });
  }

  const day = dayWindow(now);
  if (!isBuild && tool.perDay) {
    const key = `tools-day:${token.productId}:${tool.id}`;
    if ((await deps.reserveCounter(key, day, 1, tool.perDay)) === null) {
      return toolError("rate_limited", `${tool.label} is limited to ${tool.perDay} a day for each app. It resets at 00:00 UTC.`);
    }
    undo.push(() => deps.adjustCounter(key, day, -1));
  }

  const slotKey = `tools-inflight:${token.id}`;
  const slot = await deps.acquireInFlight(slotKey, TOOL_LIMITS.perTokenInFlight, now);
  if (!slot) {
    await undoAll();
    return toolError("rate_limited", `This product already has ${TOOL_LIMITS.perTokenInFlight} tool calls running. Try again when one finishes.`, { "retry-after": "2" });
  }
  let runHold: RunHold | null = null;
  let spendHold: SpendHold | null = null;
  try {
    const estimate = isBuild ? 0 : estimateToolUsd(fn);

    // Step 6: budgets, then this call's share of its run, then the limits every product shares.
    if (!isBuild) {
      spendHold = await holdSpend(token, estimate, deps, day);
      const refused = await budgetRefusal(token, spendHold, deps, day);
      if (refused) {
        await undoAll();
        return refused;
      }
      undo.push(() => deps.adjustCounter(TOOL_CALLS_KEY, day, -1));
    }
    const runLimits = runLimitsFor(token);
    if (runId && runLimits) {
      const held = await holdRun(deps, { tokenId: token.id, runId, limits: runLimits, turns: 0, toolCalls: 1, usd: estimate, now });
      if (!held.ok) {
        await undoAll();
        return toolError("run_limit", "This run used up its tool calls or dollars. Finish with what it has, or start a new run.");
      }
      runHold = held.hold;
      const hold = held.hold;
      undo.push(() => releaseRun(deps, hold));
    }
    // Last of all, so a call that a narrower limit or a budget refused never counts against other products.
    if (!isBuild) {
      const shared: Record<string, number> = { [`tools-toolkit:${tool.toolkit}`]: TOOL_LIMITS.perToolkitPerMinute };
      if (tool.perMinute) shared[`tools-tool:${tool.id}`] = tool.perMinute;
      const overShared = await limitHit(shared, windowStart, deps);
      if (overShared) {
        await undoAll();
        return tooMany(overShared, now);
      }
      const hostProblem = await publicHostProblem(tool, clean, deps);
      if (hostProblem) {
        await undoAll();
        return hostProblem;
      }
    }

    // Step 7: the approval is spent here, not at step 4, so a rate limit can't burn one and no two calls share one.
    if (approved) {
      const fresh = await deps.reserveCounter(`tool-approval:${approved.nonce}`, approved.exp, 1, 1);
      if (fresh === null) {
        await undoAll();
        return needsConfirmation(tool, mintApproval(scope, now), clean, true);
      }
    }
    const ctx: UsageContext = { source: "tools", endpoint: "tools/execute", productId: token.productId, tokenId: token.id };

    // Step 8, for a build: canned, at $0, with one unit so the row stays.
    if (isBuild) {
      const data = cannedOutput(fn, clean, await deps.buildFixtures(token.productId));
      await deps.recordUsage(ctx, [toolUsage(fn.name, 0)]);
      if (runHold) await settleRun(deps, runHold, { toolCalls: 1, usd: 0 });
      undo.length = 0;
      return success(tool, data, 0, true);
    }

    const reservation = await deps.reserveSpend(ctx, `composio:${fn.name}`, estimate);
    const release = () => deps.settleSpend(reservation, null);
    const wanted = sessionFor(tool, token, principal, ownerUserId, allowed);
    let session: string;
    try {
      session = await untilAborted(ensureToolSession(api as ComposioApi, deps, wanted), AbortSignal.timeout(deps.sessionTimeoutMs ?? TOOL_LIMITS.sessionTimeoutMs));
    } catch (err) {
      // No tool ran. A session that can't be made says nothing about the tool, so this is never needs_connection.
      await release();
      await undoAll();
      if (classifyFailure(err).kind === "wallet_empty") return walletEmpty();
      console.error("[tools] getting a session failed:", forLog(err));
      return toolError("tool_failed", `${tool.label} isn't reachable right now. Try again.`);
    }
    let reply: ToolReply;
    try {
      reply = await (api as ComposioApi).execute(session, fn.name, clean, { signal: AbortSignal.timeout(TOOL_LIMITS.executeTimeoutMs) });
    } catch (err) {
      const failure = classifyFailure(err);
      if (failure.kind === "unknown") {
        // It may have run, so the estimate stands and a retry is the product's choice.
        console.error(`[tools] ${fn.name} failed:`, forLog(err));
        await deps.settleSpend(reservation, toolUsage(fn.name, estimate));
        if (runHold) await settleRun(deps, runHold, { toolCalls: 1, usd: estimate });
        undo.length = 0;
        return toolError("tool_failed", `${tool.label} didn't answer in time. Try again if it's still needed.`);
      }
      await release();
      await undoAll();
      if (failure.kind === "refused" && failure.status === 404) {
        await deps.saveToolSession({ productId: wanted.productId, composioUserId: wanted.composioUserId, sessionId: session, configHash: STALE_SESSION_HASH });
      }
      return await refusal(failure, tool, token, principal, ownerUserId, deps, err);
    }

    const failed = replyFailed(reply);
    const costUsd = settledToolUsd(fn, reply, failed);
    await deps.settleSpend(reservation, toolUsage(fn.name, costUsd));
    if (runHold) await settleRun(deps, runHold, { toolCalls: 1, usd: costUsd });
    undo.length = 0;
    if (failed) return failedOutput(tool, reply);
    if (chargeOf(reply) === null && fn.instant) console.error(`[tools] ${fn.name} came back with no charge, so its estimate stands.`);
    return success(tool, reply.data, costUsd, false);
  } finally {
    await undoAll();
    // After the settle, so at every moment this call counts as a hold, a usage row or both.
    await spendHold?.drop().catch((err) => console.error("[tools] dropping a spend hold failed:", err));
    await deps.releaseInFlight(slotKey, slot).catch((err) => console.error("[tools] releasing a slot failed:", err));
  }
}

const TOOL_CALLS_KEY = "tools-calls";

/** Adds one to each key, and returns the limit of one it took over, if any. */
async function limitHit(limits: Record<string, number>, windowStart: Date, deps: ToolsDeps): Promise<number | null> {
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  return over ? over[1] : null;
}

/** A live read_page must name a host that resolves to public addresses only. Nothing has cost anything yet. */
async function publicHostProblem(tool: CatalogTool, args: Record<string, unknown>, deps: ToolsDeps): Promise<Response | null> {
  const param = USER_INPUT_URL_PARAMS[tool.id];
  if (!param) return null;
  try {
    const isPublic = await untilAborted(resolvesToPublic(args[param] as string, deps.lookupHost), AbortSignal.timeout(TOOL_LIMITS.lookupTimeoutMs));
    return isPublic ? null : toolError("invalid_arguments", `${param} must be a public web address.`);
  } catch {
    return toolError("tool_failed", `${tool.label} didn't work. That page couldn't be reached.`);
  }
}

/** What's in flight right now, in dollars, for this token and for everyone, this call included. */
interface SpendHold {
  tokenUsd: number;
  allUsd: number;
  drop(): Promise<unknown>;
}

/** No real limit: the check is against what budgetRefusal reads, and a counter's column is a 32-bit integer of micro-dollars. */
const HOLD_CEILING = 2_000_000_000;

async function holdSpend(token: GatewayToken, estimate: number, deps: ToolsDeps, day: Date): Promise<SpendHold> {
  const micros = Math.ceil(estimate * 1e6);
  const keys = [`tools-usd-held:${token.id}`, "tools-usd-held"];
  const [mine, all] = await Promise.all(keys.map((key) => deps.reserveCounter(key, day, micros, HOLD_CEILING)));
  return {
    tokenUsd: mine === null ? Infinity : mine / 1e6,
    allUsd: all === null ? Infinity : all / 1e6,
    drop: () => Promise.all(keys.map((key) => deps.adjustCounter(key, day, -micros))),
  };
}

/**
 * Step 6's daily checks. TOOLS_DAILY_SPEND_CAP_USD is the only spend limit at the provider, which has none of its own.
 * Each call holds its estimate before reading the spend. Of two calls at once, the later one sees the other's hold, or
 * its usage row if that one has already finished, so they can't both take the last of a budget. A call in flight can
 * count twice, as a hold and a row, which only refuses a little early right at the limit.
 */
async function budgetRefusal(token: GatewayToken, hold: SpendHold, deps: ToolsDeps, day: Date): Promise<Response | null> {
  if (deps.toolsDailySpendCapUsd <= 0) return paused();
  const [spent, toolsSpent, platformSpent] = await Promise.all([deps.tokenSpendToday(token.id), deps.toolsSpendToday(), deps.platformSpendToday()]);
  if (spent + hold.tokenUsd > token.dailyBudgetUsd) {
    return toolError("budget_exceeded", `This call would go past this product's $${token.dailyBudgetUsd.toFixed(2)} daily budget. It resets at 00:00 UTC.`);
  }
  if (toolsSpent + hold.allUsd > deps.toolsDailySpendCapUsd || platformSpent + hold.allUsd > deps.dailySpendCapUsd) {
    return toolError("budget_exceeded", "Muse Muse reached today's limit for tools. It resets at 00:00 UTC.");
  }
  // A counter rather than a count of usage rows, so it is atomic and canned calls from builds don't use it up.
  if ((await deps.reserveCounter(TOOL_CALLS_KEY, day, 1, deps.toolsDailyCalls)) === null) {
    return toolError("budget_exceeded", "Muse Muse reached today's limit for tool calls. It resets at 00:00 UTC.");
  }
  return null;
}

/** A public tool runs on the product's one session, a personal tool on the owner's own, with no public tools in it. */
function sessionFor(tool: CatalogTool, token: GatewayToken, principal: Principal, ownerUserId: string | null, allowed: readonly CatalogTool[]) {
  if (tool.tier === "public") {
    return {
      productId: token.productId,
      composioUserId: productComposioUserId(token.productId),
      config: sessionConfigFor(allowed.filter((t) => t.tier === "public")),
    };
  }
  return {
    productId: token.productId,
    composioUserId: ownerUserId ?? composioSubject(token, principal),
    config: sessionConfigFor(allowed.filter((t) => t.tier === "personal")),
  };
}

async function refusal(
  failure: Exclude<ComposioFailure, { kind: "unknown" }>,
  tool: CatalogTool,
  token: GatewayToken,
  principal: Principal,
  ownerUserId: string | null,
  deps: ToolsDeps,
  err: unknown,
): Promise<Response> {
  switch (failure.kind) {
    case "wallet_empty":
      console.error("[tools] the provider's balance is used up.");
      return walletEmpty();
    case "no_connection":
      // Composio no longer has the account, so our row is stale.
      if (ownerUserId && tool.toolkit) await deps.revokeConnection(token.productId, ownerUserId, tool.toolkit);
      return needsConnection(tool.toolkit as string, principal);
    case "not_enabled":
      return toolError("tool_not_allowed", `${tool.label} isn't on for this product.`);
    case "refused":
      console.error(`[tools] ${tool.id} refused (${failure.status}):`, forLog(err));
      return toolError("tool_failed", `${tool.label} didn't work. Try again later.`);
  }
}

/** Step 9: output rules first, since a plain 32 KB cut would lose results, then sources, then the trim. */
function success(tool: CatalogTool, data: unknown, costUsd: number, simulated: boolean): Response {
  const kept = applyOutputRules(tool, data);
  const sources = extractSources(tool.sources, kept);
  const { output, truncated } = trimOutput(kept);
  return Response.json({ ok: true, output, sources, costUsd: Number(costUsd.toFixed(6)), simulated, ...(truncated ? { truncated: true } : {}) });
}

async function listConnections(req: Request, token: GatewayToken, deps: ToolsDeps): Promise<Response> {
  const principal = resolvePrincipal(req, token, deps.now?.() ?? new Date());
  const connected = await connectedToolkits(token, principal, deps);
  const toolkits = personalToolkitsOf(await allowedTools(token, deps));
  return Response.json({
    simulated: token.scope === "build",
    principal: principal.kind,
    connections: toolkits.map((t) => connectionView(t, principal, connected)),
  });
}

async function connectLimited(token: GatewayToken, deps: ToolsDeps, now: Date): Promise<Response | null> {
  const key = `tools-token:${token.id}`;
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const counts = await deps.hitRateLimits([key], windowStart);
  if ((counts[key] ?? 0) <= TOOL_LIMITS.perTokenPerMinute) return null;
  return toolError("rate_limited", `Too many calls: the limit is ${TOOL_LIMITS.perTokenPerMinute} a minute.`);
}

/** The shared start of connect and disconnect: the flag, the toolkit on this product's list, and who is asking. */
async function connectionRequest(req: Request, token: GatewayToken, deps: ToolsDeps) {
  if (!deps.personalEnabled) return toolError("tool_not_allowed", "Connecting accounts isn't on here.");
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const toolkit = body.toolkit;
  const allowed = await allowedTools(token, deps);
  if (typeof toolkit !== "string" || !personalToolkitsOf(allowed).includes(toolkit)) {
    return toolError("tool_not_allowed", "This product doesn't use that account type.");
  }
  const now = deps.now?.() ?? new Date();
  const limited = await connectLimited(token, deps, now);
  if (limited) return limited;
  const principal = resolvePrincipal(req, token, now);
  if (principal.kind !== "owner" && principal.kind !== "build") {
    return toolError("sign_in_required", `Only this app's owner can connect ${toolkitLabel(toolkit)} for now.`);
  }
  return { body, toolkit, allowed, now, principal };
}

async function connect(req: Request, token: GatewayToken, deps: ToolsDeps): Promise<Response> {
  const asked = await connectionRequest(req, token, deps);
  if (asked instanceof Response) return asked;
  const { body, toolkit, allowed, now, principal } = asked;
  const returnTo = safeReturnPath(body.returnTo);
  if (returnTo === null) return toolError("invalid_arguments", "returnTo must be a path on this app, such as /settings.");
  if (principal.kind === "build") return Response.json({ ok: true, url: null, simulated: true, connection: simulatedConnection(toolkit, toolkitLabel(toolkit)) });
  const api = deps.composio();
  if (!api) return paused();
  const userId = composioSubject(token, principal);
  const state = mintConnectState({ productId: token.productId, composioUserId: userId, toolkit, returnTo }, now);
  const callback = `${deps.platformUrl}/api/gateway/tools/callback?state=${encodeURIComponent(state)}`;
  try {
    const signal = AbortSignal.timeout(deps.sessionTimeoutMs ?? TOOL_LIMITS.sessionTimeoutMs);
    const session = await untilAborted(ensureToolSession(api, deps, { productId: token.productId, composioUserId: userId, config: sessionConfigFor(allowed.filter((t) => t.tier === "personal")) }), signal);
    const link = await untilAborted(api.authorize(session, toolkit, callback), signal);
    return Response.json({ ok: true, url: link.redirectUrl, simulated: false });
  } catch (err) {
    if (classifyFailure(err).kind === "wallet_empty") return walletEmpty();
    console.error("[tools] starting a connection failed:", forLog(err));
    return toolError("tool_failed", `Couldn't start connecting ${toolkitLabel(toolkit)}. Try again.`);
  }
}

const alreadyGone = (err: unknown) => {
  const failure = classifyFailure(err);
  return failure.kind === "refused" && failure.status === 404;
};

/**
 * Removes every account this owner has on the toolkit at the provider, row or no row: a callback that never landed
 * leaves an account our table doesn't know about. It says ok only once they are gone, and a failure keeps the row.
 */
async function disconnect(req: Request, token: GatewayToken, deps: ToolsDeps): Promise<Response> {
  const asked = await connectionRequest(req, token, deps);
  if (asked instanceof Response) return asked;
  const { toolkit, principal } = asked;
  if (principal.kind === "build") return Response.json({ ok: true, simulated: true });
  const api = deps.composio();
  if (!api) return paused();
  const userId = composioSubject(token, principal);
  const row = (await deps.activeConnections(token.productId, userId)).find((r) => r.toolkit === toolkit);
  try {
    if (row) await api.deleteConnection(row.connectedAccountId).catch((err) => { if (!alreadyGone(err)) throw err; });
    await api.deleteAccountsOf(userId, { toolkit });
  } catch (err) {
    console.error("[tools] disconnecting failed:", forLog(err));
    return toolError("tool_failed", `Couldn't disconnect ${toolkitLabel(toolkit)}. Try again.`);
  }
  if (row) await deps.revokeConnection(token.productId, userId, toolkit);
  return Response.json({ ok: true, simulated: false });
}

/** Deletes each account at the provider, then marks its row. One that fails stays for the next run. Returns how many went. */
export async function revokeConnections(
  api: Pick<ComposioApi, "deleteConnection">,
  rows: ReadonlyArray<{ id: string; connectedAccountId: string }>,
  mark: (id: string) => Promise<void>,
): Promise<number> {
  let revoked = 0;
  for (const row of rows) {
    try {
      await api.deleteConnection(row.connectedAccountId);
    } catch (err) {
      if (!alreadyGone(err)) {
        console.error("[tools] revoking a connection failed, so the next run tries again.");
        continue;
      }
    }
    await mark(row.id);
    revoked += 1;
  }
  return revoked;
}

/**
 * Sweeps the accounts of owners on products that are off, which also finds those no connection row knows about. A
 * session goes once its accounts have, so the next run doesn't ask again. One that fails stays for the next run.
 */
export async function clearOffProductAccounts(
  api: Pick<ComposioApi, "deleteAccountsOf">,
  sessions: ReadonlyArray<{ id: string; composioUserId: string }>,
  drop: (id: string) => Promise<void>,
): Promise<number> {
  let deleted = 0;
  for (const session of sessions) {
    try {
      deleted += await api.deleteAccountsOf(session.composioUserId);
      await drop(session.id);
    } catch (err) {
      console.error("[tools] clearing an off product's accounts failed, so the next run tries again:", forLog(err));
    }
  }
  return deleted;
}

function callbackPage(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * GET /tools/callback: where Composio sends the browser. There is no product token here, so the signed state says who
 * this is for, and the platform session says the browser is that person: a builder's connect link sent to somebody else
 * must not attach their mailbox. `status` and `connected_account_id` are only hints: the account is checked with Composio
 * before it counts. Anything short of connected clears what the attempt left, without touching the account on a row.
 */
async function handleCallback(req: Request, deps: ToolsDeps): Promise<Response> {
  if (!deps.agentsEnabled || !deps.personalEnabled) return callbackPage(503, "Connecting accounts isn't on here.");
  const now = deps.now?.() ?? new Date();
  const url = new URL(req.url);
  const state = readConnectState(url.searchParams.get("state") ?? "", now);
  if (!state) return callbackPage(400, "This link has expired. Go back to the app and connect again.");
  const once = await deps.reserveCounter(`tool-connect:${state.requestId}`, new Date(state.exp), 1, 1);
  if (once === null) return callbackPage(400, "This link was already used. Go back to the app and connect again.");

  const api = deps.composio();
  const clearAttempt = async () => {
    try {
      const row = (await deps.activeConnections(state.productId, state.composioUserId)).find((r) => r.toolkit === state.toolkit);
      await api?.deleteAccountsOf(state.composioUserId, { toolkit: state.toolkit, keep: row?.connectedAccountId });
    } catch (err) {
      console.error("[tools] clearing a failed connection failed:", forLog(err));
    }
  };

  const signedIn = await deps.platformUserId();
  if (!signedIn || composioUserId("o", state.productId, ownerSubject(signedIn)) !== state.composioUserId) {
    await clearAttempt();
    return callbackPage(403, "That didn't connect. Sign in to Muse Muse as the person who started connecting, then connect again.");
  }

  const [status, info] = await Promise.all([deps.productStatus(state.productId), deps.productInfo(state.productId)]);
  if (!status || status === "disabled" || status === "failed") {
    await clearAttempt();
    return callbackPage(403, "This product is turned off on Muse Muse.");
  }
  const back = (result: "connected" | "failed") => {
    if (!info?.liveUrl) return callbackPage(result === "connected" ? 200 : 502, result === "connected" ? "Connected. You can close this tab." : "That didn't connect. Go back to the app and try again.");
    const target = new URL("/api/musemuse/connected", info.liveUrl);
    target.searchParams.set("toolkit", state.toolkit);
    target.searchParams.set("returnTo", state.returnTo);
    if (result === "failed") target.searchParams.set("error", "connect_failed");
    return Response.redirect(target.toString(), 303);
  };
  const failed = async () => {
    await clearAttempt();
    return back("failed");
  };

  const accountId = url.searchParams.get("connected_account_id") ?? "";
  if (!api || !accountId || accountId.length > 128) return failed();
  try {
    const active = await api.verifyConnection({ connectedAccountId: accountId, userId: state.composioUserId, toolkit: state.toolkit });
    if (!active) return await failed();
    await deps.saveConnection({ productId: state.productId, principal: "owner", composioUserId: state.composioUserId, toolkit: state.toolkit, connectedAccountId: accountId });
    // One live account per toolkit: this also takes the one it replaced, and any link that was started and left.
    await api.deleteAccountsOf(state.composioUserId, { toolkit: state.toolkit, keep: accountId }).catch((err) => console.error("[tools] removing a replaced connection failed:", forLog(err)));
    return back("connected");
  } catch (err) {
    console.error("[tools] checking a connection failed:", forLog(err));
    return failed();
  }
}

/**
 * POST {GATEWAY_URL}/identity/owner with {code}: a product trades the code from /api/products/<slug>/owner-pass for the
 * 12-hour session it keeps in its mm_owner cookie. The code is for one product and works once.
 */
export async function handleOwnerExchange(req: Request, deps: ToolsDeps): Promise<Response> {
  try {
    if (req.method !== "POST") return gatewayError(405, "invalid_request_error", "method_not_allowed", "Use POST.", { retry: false, headers: { allow: "POST" } });
    if (!deps.agentsEnabled || !deps.personalEnabled) return paused();
    return await withToken(req, deps, async (token) => {
      if (token.scope === "build") return toolError("sign_in_required", "A build has no owner. It sees a sample account instead.");
      const body = await readJson(req);
      if (body instanceof Response) return body;
      const now = deps.now?.() ?? new Date();
      const code = typeof body.code === "string" ? readOwnerCode(body.code, now) : null;
      if (!code || code.productId !== token.productId) return toolError("sign_in_required", "This owner link is no good. Open the app again from Muse Muse.");
      if ((await deps.reserveCounter(`owner-code:${code.nonce}`, code.exp, 1, 1)) === null) {
        return toolError("sign_in_required", "This owner link was already used. Open the app again from Muse Muse.");
      }
      const { session, expiresAt } = mintOwnerSession({ productId: token.productId, subject: code.subject }, now);
      return Response.json({ session, expiresAt: expiresAt.toISOString() });
    });
  } catch (err) {
    console.error("[tools] owner exchange failed:", err);
    return gatewayError(500, "server_error", "gateway_error", "The gateway hit an unexpected error. Try again.");
  }
}
