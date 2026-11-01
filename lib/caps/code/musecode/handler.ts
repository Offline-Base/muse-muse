import { capError, readJsonBody, runCapGate, unknownEndpoint, unknownKeys, type CapContext, type CapGateDeps, type CapLimit, type CapRoute, type CapStage, type CapToken } from "@/lib/caps/gate";
import { subjectKey } from "@/lib/caps/principal";
import { gatewayError } from "@/lib/gateway/errors";
import { MUSE_CODE_DISCLOSURE, MUSE_CODE_LIMITS, sessionSandboxUsd, sessionSandboxWorstUsd } from "@/lib/caps/code/musecode/limits";
import { redactText, redactValue } from "@/lib/caps/code/musecode/redact";
import { resultFromTar } from "@/lib/caps/code/musecode/result";
import { binaryHashesFrom, killScript, mailboxFile, packScript, prepareScript, runnerScript, SESSION_PATHS, SESSION_WORKSPACE, sessionBridgeConfig, sessionEffort, sessionPrompt, type SessionModel } from "@/lib/caps/code/musecode/sandbox";
import { sessionTokenFor } from "@/lib/caps/code/musecode/token";
import { ENDED_STATUSES, type CodeSessionDropped, type CodeSessionEvent, type CodeSessionFile, type CodeSessionPrincipal, type CodeSessionStatus } from "@/lib/caps/code/musecode/types";
import { sessionPolicy } from "@/lib/caps/code/policy";
import type { LaunchLongSession, LongSession, OpenSession } from "@/lib/caps/code/session";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import { BRIDGE_SCRIPT } from "@/lib/sandbox/bridge-protocol";
import { BRIDGE_SOURCE } from "@/lib/sandbox/bridge-source";
import { completeLines } from "@/lib/sandbox/muse-log";
import { condenseBridgeLines, emptyBridgeState, type BridgeCondenseState } from "@/lib/sandbox/msp-log";
import { newSessionId } from "@/lib/sandbox/muse";
import { publicHost } from "@/lib/sandbox/policy";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage } from "@/lib/types";

/**
 * Muse Code sessions in products (docs/CAPABILITIES.md, 15b; ~/mm-wt/_plan/muse-code-products.md), behind the cap gate
 * (lib/caps/gate.ts) as the code cap's museCode part:
 *
 *   POST {GATEWAY_URL}/code/sessions                 {task, files?}: starts a session, answers its id at once
 *   GET  {GATEWAY_URL}/code/sessions/:id/events?after=n   condensed steps after n, status, cost so far
 *   POST {GATEWAY_URL}/code/sessions/:id/steer       {text}: into the running turn
 *   POST {GATEWAY_URL}/code/sessions/:id/stop        stops it, keeps what it made
 *   GET  {GATEWAY_URL}/code/sessions/:id/result      final text, files, the zip's link, whether it worked
 *
 * The product calls these from its own server routes with PRODUCT_TOKEN and the owner pass. Each session runs in its
 * own sandbox the platform starts from the builder snapshot (never inside the build's sandbox), with an empty workspace,
 * no product code and no secrets, and a firewall that reaches only the gateway's model route (lib/caps/code/policy.ts).
 * Its model calls go through the gateway with a token of its own (scope code_session), so the gateway meters every one,
 * against the session's budget and the product's.
 *
 * Nothing needs a long function: the product polls events, and each poll reads the bridge's new log lines from the
 * sandbox, condenses them (lib/sandbox/msp-log.ts), scans them for secrets, and stores them. A session ends when the
 * bridge exits, at its limit, at a stop, or in the sweep (lib/caps/code/musecode/sweep.ts).
 */

export type CodeSessionRow = {
  id: string;
  productId: string;
  namespace: string;
  tokenId: string | null;
  parentTokenId: string | null;
  principal: CodeSessionPrincipal;
  subjectKey: string | null;
  model: string;
  status: CodeSessionStatus;
  reason: string | null;
  sandboxName: string;
  budgetUsd: number;
  limitMs: number;
  sandboxUsageId: string | null;
  costUsd: number;
  binaryHashes: string[];
  logOffset: number;
  condense: Record<string, unknown>;
  events: CodeSessionEvent[];
  nextEvent: number;
  finalText: string | null;
  exitCode: number | null;
  worked: boolean | null;
  files: CodeSessionFile[];
  dropped: CodeSessionDropped[];
  resultUrl: string | null;
  resultExpiresAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  endsAt: Date;
  endedAt: Date | null;
};

export type NewCodeSession = Pick<CodeSessionRow, "id" | "productId" | "namespace" | "parentTokenId" | "principal" | "subjectKey" | "model" | "sandboxName" | "budgetUsd" | "limitMs" | "endsAt">;

export interface CodeSessionStore {
  insert(row: NewCodeSession): Promise<void>;
  get(id: string): Promise<CodeSessionRow | null>;
  /** Applies `patch` when the row is still in one of `whileStatus` (any status when unset). True when it applied. */
  update(id: string, patch: Partial<CodeSessionRow>, whileStatus?: readonly CodeSessionStatus[]): Promise<boolean>;
  /** Sessions still starting or running whose limit (plus the sandbox's grace) hasn't passed: this product's, and all. */
  countActive(productId: string, now: Date): Promise<{ product: number; all: number }>;
  /** A build's sessions so far: how many, the minutes they used, their Meta spend, and how many worked. */
  buildTotals(namespace: string, now: Date): Promise<{ sessions: number; ms: number; usd: number; worked: number }>;
}

export interface MuseCodeDeps extends CapGateDeps {
  /** MUSE_CODE_ENABLED, as the code cap's museCode part (env.museCodeEnabled). */
  museCodeOn(): boolean;
  /** MUSE_CODE_VISITORS. */
  visitorsOn(): boolean;
  /** BUILDER_SNAPSHOT_ID, the sessions' image. */
  snapshotId(): string | null;
  /** PLATFORM_URL: the session's gateway is {PLATFORM_URL}/api/gateway/v1. */
  platformUrl(): string;
  /** env.previewBypass on a protected preview, added at the session's firewall like a build's. */
  bypass(): { host: string; secret: string } | null;
  pepper(): string;
  /** TEST_MODEL off production (testModel() in lib/env.ts), for a build's own sessions. */
  testModel(): string | null;
  /** The platform's secret values and these extra ones, for the scan (lib/caps/code/musecode/redact.ts). */
  secrets(extra: readonly string[]): string[];
  /** Whether the brief behind this token asks for Muse Code (its code block's museCode). */
  briefAllows(token: CapToken): Promise<boolean>;
  sessions: CodeSessionStore;
  launch: LaunchLongSession;
  open: OpenSession;
  storeToken(opts: { token: string; productId: string; model: string; budgetUsd: number; expiresAt: Date }): Promise<{ id: string }>;
  revokeToken(id: string, now: Date): Promise<void>;
  /** A token's spend today with its sessions' spend: what the product's daily budget sees. */
  familySpendToday(tokenId: string): Promise<number>;
  /** All a session token has spent. */
  sessionSpendUsd(tokenId: string): Promise<number>;
  /** Puts the result zip on Blob under an unguessable name and answers its URL. */
  putResult(sessionId: string, zip: Buffer): Promise<string>;
  /** A file the task brought by URL (a public Blob URL from /uploads), at most `maxBytes`. */
  fetchFile(url: string, maxBytes: number): Promise<Buffer>;
  /** Waits, between a stop and the reads after it. */
  sleep?(ms: number): Promise<void>;
  /** Milliseconds, for timing a sandbox. Date.now by default. */
  clock?(): number;
}

const OWNER_SPACE = "product-owner";
const WONDER = "muse-wonder-1.0";
const noStore = { "cache-control": "no-store" };
/** The most read of a command's output once the agent has run. */
const AFTER_AGENT_OUTPUT_BYTES = 64 * 1024;
const SKIPPED_LIST_BYTES = 64 * 1024;
const isBuild = (stage: Pick<CapStage, "token">) => stage.token.scope === "build";

/** Who the session is for, and their subject key (never a raw id). */
function whoRuns(stage: CapStage): { principal: CodeSessionPrincipal; subject: string | null } {
  const { caller, token } = stage;
  if (isBuild(stage)) return { principal: "build", subject: null };
  if (caller.owner) return { principal: "owner", subject: subjectKey("owner", token.productId, OWNER_SPACE) };
  if (caller.user) return { principal: "user", subject: subjectKey("user", token.productId, caller.user) };
  return { principal: "visitor", subject: caller.visitor ? subjectKey("visitor", token.productId, caller.visitor) : null };
}

const ownerOnly = () => capError("sign_in_required", "Only the product's owner can run Muse Code tasks here. Open the product as its owner from Muse Muse.");

/** The owner and a build always; a visitor or end user only with MUSE_CODE_VISITORS, and only one the gateway can count. */
function mayRun(stage: CapStage, visitors: boolean): boolean {
  if (isBuild(stage) || stage.caller.owner) return true;
  return visitors && Boolean(stage.caller.user || stage.caller.visitor) && whoRuns(stage).subject !== null;
}

/** The model for a session: Wonder, or Contributor for a build's own tests while TEST_MODEL names it off production. */
export function sessionModelFor(build: boolean, testModel: string | null): SessionModel {
  return build && testModel === SPARK_STANDIN ? SPARK_STANDIN : WONDER;
}

// ---------- Arguments ----------

export interface SessionFileArg {
  name: string;
  text?: string;
  base64?: string;
  url?: string;
}

export interface StartArgs {
  task: string;
  files: SessionFileArg[];
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BLOB_HOST = /^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/;

/** True for a public Blob URL the gateway's /uploads route made (https, uploads/ prefix). */
export function isUploadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && BLOB_HOST.test(u.hostname) && u.pathname.startsWith("/uploads/") && !u.pathname.includes("..") && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

export function readStartArgs(body: Record<string, unknown>): StartArgs | Response {
  const extra = unknownKeys(body, ["task", "files"]);
  if (extra) return extra;
  const task = body.task;
  if (typeof task !== "string" || !task.trim()) return capError("invalid_arguments", "Send the task as text in `task`.");
  if (task.length > MUSE_CODE_LIMITS.taskMaxChars) return capError("invalid_arguments", `A task is at most ${MUSE_CODE_LIMITS.taskMaxChars} characters.`);
  const files: SessionFileArg[] = [];
  if (body.files !== undefined) {
    if (!Array.isArray(body.files)) return capError("invalid_arguments", "`files` is a list.");
    if (body.files.length > MUSE_CODE_LIMITS.filesMax) return capError("invalid_arguments", `At most ${MUSE_CODE_LIMITS.filesMax} files.`);
    const names = new Set<string>();
    let inline = 0;
    for (const raw of body.files) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return capError("invalid_arguments", "Each file is {name, text}, {name, base64} or {name, url}.");
      const f = raw as Record<string, unknown>;
      const bad = unknownKeys(f, ["name", "text", "base64", "url"]);
      if (bad) return bad;
      if (typeof f.name !== "string" || !FILE_NAME.test(f.name) || f.name.startsWith(".")) return capError("invalid_arguments", "A file's name is one plain name: letters, digits, dots, dashes and underscores.");
      if (names.has(f.name)) return capError("invalid_arguments", `${f.name} is listed twice.`);
      names.add(f.name);
      const given = ["text", "base64", "url"].filter((k) => f[k] !== undefined);
      if (given.length !== 1 || typeof f[given[0]!] !== "string") return capError("invalid_arguments", `${f.name}: send one of text, base64 or url.`);
      if (f.url !== undefined) {
        if (!isUploadUrl(f.url as string)) return capError("invalid_arguments", `${f.name}: a file's url must be one the gateway's /uploads route gave.`);
        files.push({ name: f.name, url: f.url as string });
        continue;
      }
      if (f.base64 !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64 as string)) return capError("invalid_arguments", `${f.name}: that isn't base64.`);
      inline += f.text !== undefined ? Buffer.byteLength(f.text as string) : Math.floor(((f.base64 as string).length * 3) / 4);
      if (inline > MUSE_CODE_LIMITS.inlineFilesMaxBytes) return capError("invalid_arguments", "Files sent inline are at most 1 MB in all. Upload bigger ones through /uploads and send their url.");
      files.push(f.text !== undefined ? { name: f.name, text: f.text as string } : { name: f.name, base64: f.base64 as string });
    }
  }
  return { task, files };
}

// ---------- Routes ----------

type SessionAction = "events" | "steer" | "stop" | "result";

/** Routes by path: [] starts, [id, action] acts on one. Anything else is 404, and with the part off nothing is touched. */
export function handleCodeSessions(req: Request, path: readonly string[], deps: MuseCodeDeps): Promise<Response> {
  if (path.length === 0) return runCapGate(req, deps, startRoute(deps));
  const [id, action] = path;
  if (path.length === 2 && id && (["events", "steer", "stop", "result"] as const).includes(action as SessionAction)) {
    return runCapGate(req, deps, sessionRoute(deps, id, action as SessionAction));
  }
  return Promise.resolve(unknownEndpoint(`/code/sessions/${path.join("/")}`));
}

function limitsFor(stage: CapStage): CapLimit[] {
  const L = MUSE_CODE_LIMITS;
  const out: CapLimit[] = [{ key: `musecode:token:${stage.token.id}`, limit: L.perTokenPerMinute, window: "minute", who: "this product" }];
  if (isBuild(stage)) return out;
  out.push({ key: `musecode:product:${stage.token.productId}`, limit: L.perProductPerDay, window: "day", who: "this product" });
  const { principal, subject } = whoRuns(stage);
  if (subject) out.push({ key: `musecode:person:${stage.token.productId}:${subject}`, limit: principal === "owner" ? L.perOwnerPerDay : L.perPersonPerDay, window: "day", who: "you" });
  if (principal !== "owner" && stage.caller.ip) out.push({ key: `musecode:ip:${stage.token.productId}:${stage.caller.ip}`, limit: L.perIpPerDay, window: "day", who: "this address" });
  return out;
}

const URL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startRoute(deps: MuseCodeDeps): CapRoute<StartArgs> {
  return {
    cap: "code",
    what: "/code/sessions",
    enabled: deps.museCodeOn,
    allow: (stage) => (mayRun(stage, deps.visitorsOn()) ? null : ownerOnly()),
    async args({ req, token }) {
      if (req.method !== "POST") return capError("invalid_arguments", "Use POST to start a session.");
      if (!(await deps.briefAllows(token))) return capError("cap_not_allowed", "This product wasn't built to run Muse Code tasks.");
      const body = await readJsonBody(req, MUSE_CODE_LIMITS.bodyMaxBytes);
      return body instanceof Response ? body : readStartArgs(body);
    },
    limits: limitsFor,
    work: (ctx) => startSession(ctx, deps),
  };
}

interface SessionArgs {
  session: CodeSessionRow;
  after: number;
  text: string | null;
}

function sessionRoute(deps: MuseCodeDeps, id: string, action: SessionAction): CapRoute<SessionArgs> {
  return {
    cap: "code",
    what: `/code/sessions/:id/${action}`,
    enabled: deps.museCodeOn,
    allow: (stage) => (mayRun(stage, deps.visitorsOn()) ? null : ownerOnly()),
    async args(stage) {
      const { req } = stage;
      const wantPost = action === "steer" || action === "stop";
      if (req.method !== (wantPost ? "POST" : "GET")) return capError("invalid_arguments", `Use ${wantPost ? "POST" : "GET"}.`);
      const session = URL_UUID.test(id) ? await deps.sessions.get(id) : null;
      const namespace = isBuild(stage) ? `b:${stage.token.buildId}` : "live";
      const who = whoRuns(stage);
      // Another product's session, a build's from live or the other way round, or another person's, is not found.
      if (!session || session.productId !== stage.token.productId || session.namespace !== namespace || session.principal !== who.principal || session.subjectKey !== who.subject) {
        return capError("invalid_arguments", "There's no such session for this product.");
      }
      const after = Number(new URL(req.url).searchParams.get("after") ?? "-1");
      let text: string | null = null;
      if (action === "steer") {
        const body = await readJsonBody(req, 64 * 1024);
        if (body instanceof Response) return body;
        const extra = unknownKeys(body, ["text"]);
        if (extra) return extra;
        if (typeof body.text !== "string" || !body.text.trim()) return capError("invalid_arguments", "Send the note as text in `text`.");
        if (body.text.length > MUSE_CODE_LIMITS.steerMaxChars) return capError("invalid_arguments", `A note is at most ${MUSE_CODE_LIMITS.steerMaxChars} characters.`);
        text = body.text;
      }
      return { session, after: Number.isInteger(after) ? after : -1, text };
    },
    limits: (stage) => (action === "steer" ? [{ key: `musecode:steer:${id}`, limit: 20, window: "minute", who: "this session" }] : [{ key: `musecode:poll:${stage.token.id}`, limit: 240, window: "minute", who: "this product" }]),
    async work(ctx) {
      if (action === "events") return eventsReply(ctx, deps);
      if (action === "steer") return steerReply(ctx, deps);
      if (action === "stop") return stopReply(ctx, deps);
      return resultReply(ctx.args.session, deps, ctx.now);
    },
  };
}

// ---------- Start ----------

async function startSession(ctx: CapContext<StartArgs>, deps: MuseCodeDeps): Promise<Response> {
  const L = MUSE_CODE_LIMITS;
  const build = isBuild(ctx);
  const now = ctx.now;
  const snapshotId = deps.snapshotId();
  const host = publicHost(deps.platformUrl());
  if (!snapshotId || !host) return capError("cap_failed", "Muse Code tasks aren't set up on this Muse Muse site yet.");

  // Files by URL are read before anything is held.
  const files: Array<{ name: string; content: Buffer }> = [];
  let urlBytes = 0;
  for (const f of ctx.args.files) {
    if (f.url) {
      let content: Buffer;
      try {
        content = await deps.fetchFile(f.url, L.urlFilesMaxBytes - urlBytes);
      } catch {
        return capError("invalid_arguments", `${f.name} couldn't be downloaded, or is too big (${L.urlFilesMaxBytes / 1024 / 1024} MB in all).`);
      }
      urlBytes += content.length;
      files.push({ name: f.name, content });
    } else files.push({ name: f.name, content: f.text !== undefined ? Buffer.from(f.text, "utf8") : Buffer.from(f.base64 ?? "", "base64") });
  }

  // Admission: one start at a time across the platform, so the counts and the money below can't race.
  const admit = deps.acquireInFlight ? await deps.acquireInFlight("musecode:admit", 1, now) : null;
  if (deps.acquireInFlight && !admit) return capError("rate_limited", "Another Muse Code task is starting. Try again in a few seconds.", { "retry-after": "3" });
  const id = newSessionId(now.getTime());
  const model = sessionModelFor(build, deps.testModel());
  const who = whoRuns(ctx);
  let budget: number = L.sessionUsd;
  let limitMs: number = L.sessionMs;
  let endsAt: Date;
  let sandboxWorst: number;
  try {
    // The session's own room: $1 and 15 minutes, or what's left of a build's $0.50 and 5 minutes over its 2 sessions.
    if (build) {
      const done = await deps.sessions.buildTotals(ctx.namespace, now);
      budget = Math.min(budget, L.buildUsd - done.usd);
      limitMs = Math.min(limitMs, L.buildMs - done.ms);
      const usedAll = done.sessions >= L.buildSessions;
      const noRoom = budget < L.minStartUsd || limitMs < L.minStartMs;
      // Once one has worked, the kit replays from here on (lib/muse-code/client.ts), and the fixed check holds on that run.
      if ((usedAll || noRoom) && done.worked > 0) return gatewayError(429, "rate_limit_error", "build_tasks_used", "This build's real Muse Code tasks are used, and one worked. Use replay mode for the rest.", { retry: false });
      if (usedAll) return capError("rate_limited", `A build's tests can run ${L.buildSessions} real Muse Code tasks in all. Use replay mode for the rest.`);
      if (noRoom) return capError("budget_exceeded", "This build's Muse Code tasks have used their time or money. Use replay mode for the rest.");
    }
    // Shared with the product's daily budget (or the build's), and the platform's.
    const productLeft = ctx.token.dailyBudgetUsd - (await deps.familySpendToday(ctx.token.id));
    budget = Math.min(budget, productLeft);
    if (budget < L.minStartUsd) return capError("budget_exceeded", build ? "This build's Meta budget is used up." : "This product has used its daily budget. It resets at 00:00 UTC.");
    sandboxWorst = sessionSandboxWorstUsd(limitMs);
    if (deps.platformSpendToday && deps.dailySpendCapUsd !== undefined && (await deps.platformSpendToday()) + budget + sandboxWorst > deps.dailySpendCapUsd) {
      return capError("budget_exceeded", "Muse Muse has reached its daily budget. Try again tomorrow.");
    }
    if (!build && deps.builderDailyUsd !== undefined && deps.builderDailyUsd !== null && deps.builderSpendToday && (await deps.builderSpendToday(ctx.product.ownerId)) + budget + sandboxWorst > deps.builderDailyUsd) {
      return capError("budget_exceeded", "The person who made this product has used their daily budget across their products. It resets at 00:00 UTC.");
    }
    endsAt = new Date(now.getTime() + limitMs);
    const active = await deps.sessions.countActive(ctx.token.productId, now);
    if (active.product >= L.atOncePerProduct) return capError("rate_limited", `This product already has ${L.atOncePerProduct} Muse Code tasks running. Try again when one ends.`, { "retry-after": "30" });
    if (active.all >= L.atOnceInAll) return capError("rate_limited", "Muse Muse is running as many Muse Code tasks as it can right now. Try again in a few minutes.", { "retry-after": "60" });
    await deps.sessions.insert({ id, productId: ctx.token.productId, namespace: ctx.namespace, parentTokenId: ctx.token.id, principal: who.principal, subjectKey: who.subject, model, sandboxName: `mm-musecode-${id.replace(/-/g, "").slice(-16)}`, budgetUsd: round(budget), limitMs, endsAt });
  } finally {
    if (admit && deps.releaseInFlight) await deps.releaseInFlight("musecode:admit", admit).catch(() => undefined);
  }

  const clock = deps.clock ?? Date.now;
  const started = clock();
  const sessionToken = sessionTokenFor(id, deps.pepper());
  let tokenId: string | null = null;
  let reservation: string | null = null;
  let sandbox: LongSession | null = null;
  try {
    tokenId = (await deps.storeToken({ token: sessionToken, productId: ctx.token.productId, model, budgetUsd: round(budget), expiresAt: endsAt })).id;
    if (deps.reserveSpend) {
      // No token on this row: the sandbox's time counts toward the platform's daily cap, not the session's Meta budget.
      const usage: UsageContext = { source: "code_session", endpoint: "code_sessions", productId: ctx.token.productId, buildId: ctx.token.buildId, tokenId: null };
      reservation = await deps.reserveSpend(usage, "sandbox:code_session", sandboxWorst);
    }
    await deps.sessions.update(id, { tokenId, sandboxUsageId: reservation });
    sandbox = await deps.launch({
      purpose: "musecode",
      name: `mm-musecode-${id.replace(/-/g, "").slice(-16)}`,
      tags: { session: id },
      snapshotId,
      networkPolicy: sessionPolicy(host, deps.bypass()),
      vcpus: L.vcpus,
      timeoutMs: limitMs + L.sandboxGraceMs,
      createTimeoutMs: L.createTimeoutMs,
      deadlineMs: L.startDeadlineMs,
      productId: ctx.token.productId,
    });
    // The platform's own command, before the agent runs: the VM is as the snapshot made it, so these hashes hold.
    const prep = await sandbox.run("bash", ["-c", prepareScript()], { timeoutMs: 45_000 });
    if (prep.exitCode !== 0 || !prep.stdout.includes("sdk-ready")) throw new Error(`prepare exited ${prep.exitCode}`);
    const binaryHashes = binaryHashesFrom(prep.stdout);
    const gatewayV1 = `https://${host}/api/gateway/v1`;
    const config = sessionBridgeConfig({ sessionId: id, model, effort: sessionEffort(build), gatewayV1 });
    await sandbox.writeFiles([
      { path: BRIDGE_SCRIPT, content: Buffer.from(BRIDGE_SOURCE, "utf8") },
      { path: SESSION_PATHS.config, content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8") },
      { path: SESSION_PATHS.prompt, content: Buffer.from(sessionPrompt(ctx.args.task, files.map((f) => f.name)), "utf8") },
      { path: SESSION_PATHS.runner, content: Buffer.from(runnerScript(), "utf8") },
      ...files.map((f) => ({ path: `${SESSION_WORKSPACE}/${f.name}`, content: f.content })),
    ]);
    // The token goes to the runner's environment only, never into a file.
    await sandbox.startDetached("bash", [SESSION_PATHS.runner], { env: { META_API_KEY: sessionToken } });
    const stillOn = await deps.sessions.update(id, { status: "running", startedAt: new Date(now.getTime() + (clock() - started)), binaryHashes }, ["starting"]);
    // Stopped while it was starting, perhaps before its token or reservation were on the row: all of it goes now.
    if (!stillOn) {
      await sandbox.stop().catch(() => undefined);
      await deps.revokeToken(tokenId, new Date()).catch(() => undefined);
      if (reservation && deps.settleSpend) await deps.settleSpend(reservation, sandboxUsage(sessionSandboxUsd(clock() - started))).catch(() => undefined);
      return capError("invalid_arguments", "This task was stopped before it started.");
    }
  } catch (err) {
    console.error("[caps] code session start failed:", err instanceof Error ? redactText(err.message, deps.secrets([sessionToken])).text.slice(0, 300) : "unknown");
    if (sandbox) await sandbox.stop().catch(() => undefined);
    if (tokenId) await deps.revokeToken(tokenId, new Date()).catch(() => undefined);
    const cost = sessionSandboxUsd(clock() - started);
    if (reservation && deps.settleSpend) await deps.settleSpend(reservation, sandboxUsage(cost)).catch(() => undefined);
    await deps.sessions.update(id, { status: "failed", reason: "The workspace couldn't be started.", endedAt: new Date(), costUsd: round(cost) }).catch(() => undefined);
    return capError("cap_failed", "Muse Code couldn't start this time. Try again in a minute.");
  }
  return Response.json(
    { id, status: "running", model, budgetUsd: round(budget), endsAt: endsAt.toISOString(), disclosure: MUSE_CODE_DISCLOSURE },
    { status: 201, headers: noStore },
  );
}

const sandboxUsage = (costUsd: number): ModelUsage => ({ model: "sandbox:code_session", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd });
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const ended = (s: CodeSessionRow) => ENDED_STATUSES.includes(s.status);

// ---------- Following a session ----------

/** One poll at a time per session reads its sandbox. A second, at the same moment, answers from what's stored. */
export async function withSessionLock<T>(deps: MuseCodeDeps, id: string, now: Date, run: () => Promise<T>): Promise<T | null> {
  if (!deps.acquireInFlight || !deps.releaseInFlight) return run();
  const slot = await deps.acquireInFlight(`musecode:session:${id}`, 1, now);
  if (!slot) return null;
  try {
    return await run();
  } finally {
    await deps.releaseInFlight(`musecode:session:${id}`, slot).catch(() => undefined);
  }
}

interface Progress {
  exit: { code: number; reason?: string } | null;
  finalText: string | null;
  /** There's more log than this read reached (or it couldn't be read), so the log's end hasn't been seen. */
  more: boolean;
}

/**
 * Reads the session's new log lines, condenses and scans them, and stores the steps. The condensed state carries
 * between polls (open items, the run's final text).
 */
export async function readProgress(row: CodeSessionRow, sandbox: LongSession, deps: MuseCodeDeps): Promise<Progress> {
  const chunk = (await sandbox.readPart(SESSION_PATHS.log, row.logOffset, MUSE_CODE_LIMITS.pollLogBytes)) ?? Buffer.alloc(0);
  const { lines, consumed } = completeLines(chunk);
  if (!consumed) {
    // One line bigger than a whole read would stop the log here for good, so it is skipped. Its step just doesn't show.
    if (chunk.length >= MUSE_CODE_LIMITS.pollLogBytes) {
      await deps.sessions.update(row.id, { logOffset: row.logOffset + chunk.length });
      row.logOffset += chunk.length;
    }
    return { exit: null, finalText: row.finalText, more: chunk.length >= MUSE_CODE_LIMITS.pollLogBytes };
  }
  const state = (row.condense && Array.isArray((row.condense as { announced?: unknown }).announced) ? row.condense : emptyBridgeState()) as unknown as BridgeCondenseState;
  const condensed = condenseBridgeLines(lines, state);
  const secrets = deps.secrets([sessionTokenFor(row.id, deps.pepper())]);
  let n = row.nextEvent;
  const fresh: CodeSessionEvent[] = condensed.lines.map((line) => {
    const e: CodeSessionEvent = { n: n++, kind: line.kind, text: line.text };
    if (line.itemId) e.itemId = line.itemId;
    if (line.tool) e.tool = line.tool;
    if (line.ok !== undefined) e.ok = line.ok;
    if (line.files !== undefined) e.files = line.files;
    if (line.added !== undefined) e.added = line.added;
    if (line.removed !== undefined) e.removed = line.removed;
    return redactValue(e, secrets).value;
  });
  const finalText = condensed.finalText ? redactText(condensed.finalText, secrets).text : row.finalText;
  // The condensed state holds the host's stderr: it is scanned too before it is stored.
  const nextState = redactValue(condensed.state, secrets).value as unknown as Record<string, unknown>;
  const events = [...row.events, ...fresh].slice(-MUSE_CODE_LIMITS.eventsKept);
  await deps.sessions.update(row.id, { logOffset: row.logOffset + consumed, condense: nextState, events, nextEvent: n, finalText });
  Object.assign(row, { logOffset: row.logOffset + consumed, condense: nextState, events, nextEvent: n, finalText });
  return { exit: condensed.exit, finalText, more: chunk.length >= MUSE_CODE_LIMITS.pollLogBytes };
}

/** How a session ends. */
interface Ending {
  status: Extract<CodeSessionStatus, "completed" | "failed" | "stopped" | "expired">;
  reason: string;
  exitCode?: number | null;
}

/**
 * Ends a session once: revokes its token (dead at stop), stops the bridge if it still runs, packs the workspace and
 * builds the zip under the result rules, stops the sandbox, settles the sandbox's time, and records it all. Never
 * throws: whatever can't be done is said in the row's reason.
 */
export async function finishSession(row: CodeSessionRow, ending: Ending, deps: MuseCodeDeps, now: Date, sandbox?: LongSession | null): Promise<CodeSessionRow> {
  if (ended(row)) return row;
  if (row.tokenId) await deps.revokeToken(row.tokenId, now).catch(() => undefined);
  const secrets = deps.secrets([sessionTokenFor(row.id, deps.pepper())]);
  const box = sandbox === undefined ? await deps.open(row.sandboxName, { deadlineMs: MUSE_CODE_LIMITS.pollDeadlineMs }).catch(() => null) : sandbox;
  let files: CodeSessionFile[] = [];
  let dropped: CodeSessionDropped[] = [];
  let resultUrl: string | null = null;
  let note = "";
  if (box) {
    try {
      // The agent has run, so these commands' output isn't trusted: only a word is needed from it.
      await box.run("bash", ["-c", killScript()], { timeoutMs: 10_000, maxOutputBytes: AFTER_AGENT_OUTPUT_BYTES }).catch(() => undefined);
      const packed = await box.run("bash", ["-c", packScript()], { timeoutMs: 60_000, maxOutputBytes: AFTER_AGENT_OUTPUT_BYTES });
      const readCap = MUSE_CODE_LIMITS.resultMaxBytes + 4 * 1024 * 1024;
      const tar = packed.stdout.includes("packed") ? await box.readPart(SESSION_PATHS.tar, 0, readCap) : null;
      if (tar) {
        const list = await box.readPart(SESSION_PATHS.skipped, 0, SKIPPED_LIST_BYTES).catch(() => null);
        const skipped = list ? list.toString("utf8").split("\n").filter(Boolean).slice(0, 200) : [];
        const result = resultFromTar(tar, { binaryHashes: row.binaryHashes, secrets, skipped, cut: tar.length >= readCap });
        files = result.files;
        dropped = result.dropped;
        if (result.zip) resultUrl = await deps.putResult(row.id, result.zip);
      }
    } catch (err) {
      console.error("[caps] code session result failed:", err instanceof Error ? redactText(err.message, secrets).text.slice(0, 300) : "unknown");
      note = " Its files couldn't be collected.";
    }
    await box.stop().catch(() => undefined);
  } else if (!ended(row)) note = " Its workspace was already gone, so no files came back.";
  const startedAt = row.startedAt ?? row.createdAt;
  const upTo = Math.min(now.getTime(), row.endsAt.getTime() + MUSE_CODE_LIMITS.sandboxGraceMs);
  const sandboxCost = sessionSandboxUsd(upTo - startedAt.getTime());
  if (row.sandboxUsageId && deps.settleSpend) await deps.settleSpend(row.sandboxUsageId, sandboxUsage(sandboxCost)).catch(() => undefined);
  const metaCost = row.tokenId ? await deps.sessionSpendUsd(row.tokenId).catch(() => 0) : 0;
  const finalText = row.finalText ? redactText(row.finalText, secrets).text : null;
  // "Worked" is the files and the final text, not the exit code: a run can end at 0 having made nothing (the spike).
  const worked = ending.status === "completed" && files.length > 0 && Boolean(finalText?.trim());
  const patch: Partial<CodeSessionRow> = {
    status: ending.status,
    reason: redactText(`${ending.reason}${note}`.trim(), secrets).text.slice(0, 1000),
    exitCode: ending.exitCode ?? null,
    endedAt: now,
    files,
    dropped,
    resultUrl,
    resultExpiresAt: resultUrl ? new Date(now.getTime() + MUSE_CODE_LIMITS.resultKeepMs) : null,
    finalText,
    worked,
    costUsd: round(metaCost + sandboxCost),
  };
  // Only the first finisher records it.
  const applied = await deps.sessions.update(row.id, patch, ["starting", "running"]);
  return applied ? { ...row, ...patch } : ((await deps.sessions.get(row.id)) ?? { ...row, ...patch });
}

/**
 * A session that's running: reads its progress and ends it when the bridge has exited or its limit has passed. Failing
 * to reach the Sandbox API changes nothing: the next poll tries again. Only past the sandbox's own timeout, when it can't
 * still be up, does the session close with no sandbox.
 */
async function advance(row: CodeSessionRow, deps: MuseCodeDeps, now: Date): Promise<CodeSessionRow> {
  if (row.status !== "running") {
    // A start that never reached "running" and is past its limit is over.
    if (row.status === "starting" && now.getTime() > row.endsAt.getTime()) return finishSession(row, { status: "expired", reason: "It never started." }, deps, now);
    return row;
  }
  let sandbox: LongSession | null;
  try {
    sandbox = await deps.open(row.sandboxName, { deadlineMs: MUSE_CODE_LIMITS.pollDeadlineMs });
  } catch {
    if (now.getTime() <= row.endsAt.getTime() + MUSE_CODE_LIMITS.sandboxGraceMs) return row;
    sandbox = null;
  }
  if (!sandbox) return finishSession(row, { status: "expired", reason: "Its workspace stopped." }, deps, now, null);
  // The exit file first: when it's there the bridge is gone, so a log read after it has every line the bridge wrote.
  const exitFile = await sandbox.readPart(SESSION_PATHS.exit, 0, 16).catch(() => null);
  const progress = await readProgress(row, sandbox, deps).catch(() => ({ exit: null, finalText: row.finalText, more: true }) as Progress);
  if (progress.exit) {
    const status = progress.exit.code === 0 ? "completed" : "failed";
    return finishSession(row, { status, reason: status === "completed" ? "Muse Code finished." : `Muse Code stopped: ${progress.exit.reason ?? "it failed"}.`, exitCode: progress.exit.code }, deps, now, sandbox);
  }
  // Killed before it could write its exit record: an agent's own `pkill node` can do it. Without this it would hold its
  // slots and show Working until its limit.
  if (exitFile?.length && !progress.more) {
    const code = Number.parseInt(exitFile.toString("utf8"), 10);
    const tail = await sandbox.readPart(SESSION_PATHS.err, 0, 8 * 1024).catch(() => null);
    if (tail?.length) console.error("[caps] code session's bridge ended with no exit record:", redactText(tail.toString("utf8"), deps.secrets([sessionTokenFor(row.id, deps.pepper())])).text.slice(-500));
    return finishSession(row, { status: "failed", reason: "Muse Code stopped unexpectedly: its process ended before it finished.", exitCode: Number.isFinite(code) ? code : null }, deps, now, sandbox);
  }
  if (now.getTime() >= row.endsAt.getTime()) {
    return finishSession(row, { status: "stopped", reason: `It reached its ${Math.round(row.limitMs / 60_000)} minute limit and kept what it made.` }, deps, now, sandbox);
  }
  return row;
}

/** Advances a session from the row as it is now. The sweep's way in, under the session's lock. */
export async function advanceSession(row: CodeSessionRow, deps: MuseCodeDeps, now: Date): Promise<CodeSessionRow> {
  return advance((await deps.sessions.get(row.id)) ?? row, deps, now);
}

async function costSoFar(row: CodeSessionRow, deps: MuseCodeDeps, now: Date): Promise<number> {
  if (ended(row)) return row.costUsd;
  const meta = row.tokenId ? await deps.sessionSpendUsd(row.tokenId).catch(() => 0) : 0;
  return round(meta + sessionSandboxUsd(now.getTime() - (row.startedAt ?? row.createdAt).getTime()));
}

function summary(row: CodeSessionRow) {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    endsAt: row.endsAt.toISOString(),
    finalText: row.finalText,
    worked: row.worked,
    reason: row.reason,
  };
}

async function eventsReply(ctx: CapContext<SessionArgs>, deps: MuseCodeDeps): Promise<Response> {
  // Read again under the lock: a poll that held it may have moved the log offset since this request read the row.
  const row =
    (await withSessionLock(deps, ctx.args.session.id, ctx.now, async () => advance((await deps.sessions.get(ctx.args.session.id)) ?? ctx.args.session, deps, ctx.now))) ?? ((await deps.sessions.get(ctx.args.session.id)) ?? ctx.args.session);
  const events = row.events.filter((e) => e.n > ctx.args.after);
  return Response.json({ ...summary(row), events, next: row.nextEvent - 1, costUsd: await costSoFar(row, deps, ctx.now), disclosure: MUSE_CODE_DISCLOSURE }, { headers: noStore });
}

async function steerReply(ctx: CapContext<SessionArgs>, deps: MuseCodeDeps): Promise<Response> {
  const row = ctx.args.session;
  if (row.status !== "running") return capError("invalid_arguments", "This session isn't running, so the note wasn't sent.");
  const sandbox = await deps.open(row.sandboxName).catch(() => null);
  if (!sandbox) return capError("cap_failed", "The session's workspace isn't answering. Try again.");
  const file = mailboxFile({ type: "steer", text: ctx.args.text ?? "" }, ctx.now);
  await sandbox.writeFiles([{ path: file.path, content: Buffer.from(file.content, "utf8") }]);
  return Response.json({ id: row.id, sent: true }, { headers: noStore });
}

async function stopReply(ctx: CapContext<SessionArgs>, deps: MuseCodeDeps): Promise<Response> {
  const id = ctx.args.session.id;
  // Dead at stop: the token goes first, even if the session is busy, so no model call starts after this.
  if (ctx.args.session.tokenId && !ended(ctx.args.session)) await deps.revokeToken(ctx.args.session.tokenId, ctx.now).catch(() => undefined);
  const done = await withSessionLock(deps, id, ctx.now, async () => {
    const row0 = (await deps.sessions.get(id)) ?? ctx.args.session;
    if (ended(row0)) return row0;
    // A start may have put its token on the row since this request read it.
    if (row0.tokenId && row0.tokenId !== ctx.args.session.tokenId) await deps.revokeToken(row0.tokenId, ctx.now).catch(() => undefined);
    let sandbox: LongSession | null;
    try {
      sandbox = await deps.open(row0.sandboxName, { deadlineMs: MUSE_CODE_LIMITS.pollDeadlineMs });
    } catch {
      // Its token is dead, so it can spend no more. A second stop, or the sweep, collects its files.
      return null;
    }
    if (sandbox) {
      const file = mailboxFile({ type: "end", reason: "Stopped by the person." }, ctx.now, "owner");
      await sandbox.writeFiles([{ path: file.path, content: Buffer.from(file.content, "utf8") }]).catch(() => undefined);
      // The spike: a stop ends the bridge in under 2 s. Then its last lines and the final text are read.
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(2_000);
      await readProgress(row0, sandbox, deps).catch(() => undefined);
    }
    return finishSession(row0, { status: "stopped", reason: "Stopped by the person. It kept what it made." }, deps, ctx.now, sandbox);
  });
  if (!done) return capError("rate_limited", "The session is busy for a moment. Its model calls have stopped. Try stopping it again.", { "retry-after": "2" });
  return resultReply(done, deps, ctx.now);
}

async function resultReply(row: CodeSessionRow, deps: MuseCodeDeps, now: Date): Promise<Response> {
  if (!ended(row)) return Response.json({ ...summary(row), done: false, costUsd: await costSoFar(row, deps, now) }, { headers: noStore });
  const live = row.resultUrl && row.resultExpiresAt && row.resultExpiresAt.getTime() > now.getTime();
  return Response.json(
    {
      ...summary(row),
      done: true,
      files: row.files,
      dropped: row.dropped,
      zipUrl: live ? row.resultUrl : null,
      zipExpiresAt: live ? row.resultExpiresAt!.toISOString() : null,
      costUsd: row.costUsd,
    },
    { headers: noStore },
  );
}
