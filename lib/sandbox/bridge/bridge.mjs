/**
 * The Muse Code session bridge (docs/MUSE_CODE_FULL.md, "The engine"). For a round on the serve engine, the platform
 * writes this file and a BridgeConfig (lib/sandbox/bridge-protocol.ts) into the builder sandbox and runs
 * `node bridge.mjs <config.json>` detached. The bridge drives `muse serve` over the Muse Session Protocol with
 * @muse-code/sdk, installed next to it, and writes every notification, call and command it sees to the round's log as
 * BridgeLogRecord lines, which the platform polls like `muse exec --json` output. It applies the MuseCommandEnvelope
 * files the platform drops into the round's mailbox, and its last log line is always a `bridge`/`exit` record.
 *
 * Plain ESM for Node 24 with no build step, importing only node: built-ins and, inside main(), @muse-code/sdk. The core
 * is runBridge, which takes the connection, the file system and the clock as arguments, so node:test drives it with
 * fakes (lib/sandbox/__tests__/bridge.test.ts). lib/sandbox/bridge-source.ts carries this file's text to the sandbox;
 * after an edit, run `npx tsx scripts/gen-bridge-source.ts`.
 */
import { appendFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Exit codes, as `muse exec` uses them: 0 the last turn completed, 1 it failed or was stopped, 2 a config or start error. */
export const EXIT = Object.freeze({ completed: 0, failed: 1, usage: 2 });

/** How often the mailbox is read. */
export const POLL_MS = 1000;
/** After a turn completes, how long a queued or goal turn has to start before the bridge exits. */
export const SETTLE_MS = 3000;
/** How long the bridge waits for a turn it stopped to end before it exits anyway. */
export const INTERRUPT_WAIT_MS = 15_000;
/** While a turn runs and nothing has come from the host for this long, the bridge asks it how the session stands. */
export const QUIET_MS = 60_000;
/** How long one protocol call may go unanswered, so a wedged host can't freeze the mailbox. */
const REQUEST_MS = 60_000;
/** When a view/gap says events were dropped: how many one view/page asks for, and how many pages it reads at most. */
const GAP_PAGE_LIMIT = 200;
const GAP_MAX_PAGES = 50;
/** How long closing the host may take. The SDK drains it for SHUTDOWN_MS, then ends it. */
const CLOSE_MS = 20_000;
const SHUTDOWN_MS = 10_000;
/** After a stop signal, the exit record is written by this time even when the host never answers. */
const STOP_GRACE_MS = 3000;
/**
 * Largest inspo image the first turn attaches, and all of them together. One MSP frame holds 10 MB and base64 adds a
 * third, so bigger ones are left out (the agent can still read them from inspo/).
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 6 * 1024 * 1024;
const MEDIA_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTING = /^[A-Za-z_][A-Za-z0-9_.]*=./;
const TEXT_MAX = 4000;

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function str(v) {
  return typeof v === "string" && v ? v : null;
}

/** What an error says, in the BridgeLogRecord `call` error shape. */
function errorOf(err) {
  const e = obj(err);
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? null);
  return {
    message: String(message).slice(0, TEXT_MAX),
    ...(typeof e.code === "number" ? { code: e.code } : {}),
    ...(typeof e.kind === "string" ? { kind: e.kind } : {}),
  };
}

/** Why a BridgeConfig can't run, or null when it can. */
export function configProblem(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "the config isn't a JSON object";
  for (const key of ["workspace", "sessionId", "model", "reasoningEffort", "promptFile", "logPath", "mailboxDir"]) {
    if (typeof c[key] !== "string" || !c[key].trim()) return `${key} is missing`;
  }
  if (!UUID.test(c.sessionId)) return "sessionId isn't a UUID";
  if (!Array.isArray(c.images) || !c.images.every((i) => typeof i === "string")) return "images must be a list of paths";
  if (c.goal !== null && typeof c.goal !== "string") return "goal must be text or null";
  if (!Array.isArray(c.settings) || !c.settings.every((s) => typeof s === "string" && SETTING.test(s))) return "settings must be key=value strings";
  if (typeof c.disableRequestUserInput !== "boolean") return "disableRequestUserInput must be true or false";
  for (const key of ["maxModelSteps", "idleExitMs"]) {
    if (!Number.isInteger(c[key]) || c[key] <= 0) return `${key} must be a positive whole number`;
  }
  return null;
}

/** argv for the host, after `muse`. --disable-sandbox because the microVM has no bubblewrap; the VM is the boundary. */
export function serveArgs(config) {
  return [
    "serve",
    "--disable-sandbox",
    "--trust-workspace",
    ...(config.disableRequestUserInput ? ["--disable-request-user-input"] : []),
    "--model",
    config.model,
    ...config.settings.flatMap((s) => ["-c", s]),
  ];
}

/** Why a MuseCommand can't be applied as written, or null when it can. Model output never becomes a command. */
export function commandProblem(c) {
  const cmd = obj(c);
  const text = (v) => typeof v === "string" && v.trim() !== "";
  switch (cmd.type) {
    case "steer":
    case "queue":
      return text(cmd.text) ? null : `a ${cmd.type} needs text`;
    case "interrupt":
      return null;
    case "goal":
      if (cmd.action === "set" || cmd.action === "edit") return text(cmd.objective) ? null : "the goal needs an objective";
      return ["pause", "resume", "clear"].includes(cmd.action) ? null : "unknown goal action";
    case "answer":
      if (!text(cmd.userInputId)) return "an answer needs the question's userInputId";
      return Array.isArray(cmd.answers) && cmd.answers.length && cmd.answers.every((a) => text(obj(a).questionId)) ? null : "an answer needs one entry per question";
    case "workflow":
      if (!["pause", "resume", "cancel"].includes(cmd.action)) return "unknown workflow action";
      return cmd.workflowId === undefined || text(cmd.workflowId) ? null : "workflowId must be text";
    case "subagent":
      if (!["message", "interrupt", "stop"].includes(cmd.action)) return "unknown subagent action";
      if (!text(cmd.childSessionId)) return "a subagent command needs the childSessionId";
      return cmd.action !== "message" || text(cmd.text) ? null : "a message needs text";
    case "end":
      return cmd.reason === undefined || typeof cmd.reason === "string" ? null : "reason must be text";
    default:
      return "unknown command type";
  }
}

/**
 * The first turn's input: the prompt file's text, then each image that exists, fits MAX_IMAGE_BYTES and is a type
 * Muse Code takes. Returns what was left out too. Throws when the prompt can't be read.
 */
export async function firstTurnInput(config, fs) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(config.workspace, p));
  const text = await fs.readText(resolve(config.promptFile));
  if (!text.trim()) throw new Error(`${config.promptFile} is empty`);
  const input = [{ type: "text", text }];
  const left = [];
  let total = 0;
  for (const image of config.images) {
    let bytes;
    try {
      bytes = await fs.readBytes(resolve(image));
    } catch {
      continue;
    }
    const mediaType = MEDIA_TYPES[path.extname(image).toLowerCase()];
    if (!bytes.length) continue;
    if (!mediaType) {
      left.push(`${path.basename(image)} (not an image type Muse Code takes)`);
    } else if (bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_IMAGES_BYTES) {
      left.push(`${path.basename(image)} (too big to attach)`);
    } else {
      total += bytes.length;
      input.push({ type: "image", mediaType, base64Data: Buffer.from(bytes).toString("base64") });
    }
  }
  return { input, left };
}

function goalOf(g) {
  const goal = obj(g);
  if (typeof goal.objective !== "string") return null;
  return {
    objective: goal.objective,
    status: typeof goal.status === "string" ? goal.status : "active",
    ...(typeof goal.percentComplete === "number" ? { percentComplete: goal.percentComplete } : {}),
  };
}

/** When a goal last changed, so an older change that comes late doesn't undo a newer one. */
function goalTime(g) {
  const at = obj(g).updatedAtMs;
  return typeof at === "number" ? at : null;
}

/**
 * How a workflow or subagent item stands: "busy" while it works, "paused" for a paused workflow, null once it is done.
 * Muse Code reports the end of one that runs on after its turn in a turn of its own, and `muse exec` waits for it. A
 * subagent counts only while it starts or runs: one whose result is ready waits on its parent, not the other way round.
 */
function backgroundState(item) {
  if (item.status !== "inProgress") return null;
  if (item.kind === "workflow") return item.paused === true ? "paused" : "busy";
  const control = item.controlStatus;
  return control === undefined || control === "accepted" || control === "starting" || control === "running" ? "busy" : null;
}

/** Settles with `promise`, or rejects after `ms`. */
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms)));
  return Promise.race([Promise.resolve().then(() => promise), late]).finally(() => clearTimeout(timer));
}

/** Closes the host, waiting at most CLOSE_MS. Never throws. */
async function closeQuietly(conn) {
  try {
    await withTimeout(Promise.resolve().then(() => conn.close()), CLOSE_MS);
  } catch {
    // The process is ending either way.
  }
}

/**
 * Runs one round: opens the session, starts the turn, follows the stream, applies mailbox commands, and ends with
 * the exit record. Resolves to the exit code and never rejects.
 *
 * `connect(args, { stderr })` spawns `muse <args>`, sends the host's stderr to `stderr`, and resolves to an initialized
 * connection (or pass `connection` itself): request(method, params), onNotification(handler),
 * onServerRequest(handler), close(), exited (settles when the host process ends) and mint() (a UUIDv7 command id).
 * `fs`: append(file, text) (synchronous, so lines keep their order), readText, readBytes, list (names, [] when the
 * folder is missing), move, mkdirp. `clock`: now(), sleep(ms). `signal` aborting means the bridge was told to stop.
 */
export async function runBridge({ config, fs, clock, connect, connection: given, signal }) {
  const problem = configProblem(config);
  const logPath = config && typeof config.logPath === "string" && config.logPath ? config.logPath : null;
  let exited = false;
  const log = (record) => {
    // Nothing follows the exit record, so the platform can trust it is the last line.
    if (!logPath || exited) return;
    try {
      fs.append(logPath, `${JSON.stringify({ t: clock.now(), ...record })}\n`);
    } catch {
      // The log is the bridge's only output. If it can't be written there is nobody to tell.
    }
  };
  const writeExit = (exitCode, reason, s) => {
    if (exited) return exitCode;
    const finalText = s ? (s.finalText ?? s.agentText) : null;
    log({ kind: "bridge", event: "exit", exitCode, ...(finalText ? { finalText } : {}), goal: s?.goal ?? null, reason });
    exited = true;
    return exitCode;
  };
  if (logPath) await fs.mkdirp(path.dirname(logPath)).catch(() => {});
  if (problem) return writeExit(EXIT.usage, `config: ${problem}`, null);

  const sessionId = config.sessionId;
  const s = {
    running: false,
    turnId: null,
    /** Turns seen to start, so a session/read answer that crossed one isn't trusted over the stream. */
    starts: 0,
    ended: new Set(),
    queued: new Set(),
    completed: 0,
    last: null,
    idleAt: clock.now(),
    idleReason: null,
    goal: null,
    goalAt: null,
    finalText: null,
    agentText: null,
    steps: 0,
    capAt: null,
    interrupted: false,
    end: null,
    hostExit: null,
    closed: false,
    applied: new Set(),
    decided: new Set(),
    subagents: new Map(),
    workflows: [],
    /** Workflow and subagent items still at work, by item id: "busy" or "paused" (backgroundState). */
    background: new Map(),
    /** The latest revision seen of each workflow and subagent item. */
    revisions: new Map(),
    /** View cursors of the durable events received, so an event a filled gap brings again is followed once. */
    seen: new Set(),
    /** Holes in the stream that view/gap reported, for the loop to fill. */
    gaps: [],
    lastFrameAt: clock.now(),
    checkedAt: clock.now(),
  };
  let conn = given ?? null;
  try {
    log({ kind: "bridge", event: "started", sessionId });
    let first;
    try {
      first = await firstTurnInput(config, fs);
    } catch (err) {
      return writeExit(EXIT.usage, `config: can't read the prompt (${errorOf(err).message})`, s);
    }
    try {
      conn = conn ?? (await connect(serveArgs(config), { stderr: (text) => log({ kind: "stderr", text: String(text).slice(0, TEXT_MAX) }) }));
    } catch (err) {
      return writeExit(EXIT.usage, `host did not start: ${errorOf(err).message}`, s);
    }
    const mint = () => conn.mint();
    /** One protocol call, logged with its answer, or with `summary` of it for an answer too big to log whole. */
    const call = async (method, params, { summary } = {}) => {
      try {
        const result = await withTimeout(Promise.resolve().then(() => conn.request(method, params)), REQUEST_MS);
        log({ kind: "call", method, ok: true, result: summary ? summary(obj(result)) : result });
        return { ok: true, result: obj(result) };
      } catch (err) {
        const error = errorOf(err);
        log({ kind: "call", method, ok: false, error });
        return { ok: false, error };
      }
    };

    const startRunning = (turnId) => {
      if (turnId && s.ended.has(turnId)) return;
      s.running = true;
      s.starts += 1;
      s.turnId = turnId ?? s.turnId;
      if (turnId) s.queued.delete(turnId);
      s.interrupted = false;
      s.idleReason = null;
    };
    /** A turn ended, as turn/completed says, or as session/read says of one whose turn/completed never came. */
    const endTurn = (turnId, p) => {
      if (turnId) {
        s.ended.add(turnId);
        s.queued.delete(turnId);
      }
      if (!turnId || !s.turnId || turnId === s.turnId) {
        s.running = false;
        s.turnId = null;
      }
      s.completed += 1;
      s.last = { terminal: str(p.terminal) ?? "completed", message: str(obj(p.error).message) ?? str(p.reason) };
      s.idleAt = clock.now();
    };
    const decide = async (p) => {
      const approvalId = str(p.approvalId);
      if (!approvalId) return;
      const key = `${approvalId}:${obj(p.currentRequirementId).sourceIndex ?? 0}`;
      if (s.decided.has(key)) return;
      s.decided.add(key);
      const choices = Array.isArray(p.availableChoices) ? p.availableChoices.map(obj) : [];
      const allow =
        choices.find((c) => c.decision === "approvedForSession") ??
        choices.find((c) => c.decision === "approved") ??
        choices.find((c) => String(c.decision ?? "").startsWith("approved"));
      if (!allow) {
        log({ kind: "call", method: "approval/decide", ok: false, error: { message: `approval ${approvalId} offered no allow choice` } });
        return;
      }
      await call("approval/decide", { commandId: mint(), sessionId, approvalId, choiceId: allow.choiceId, requirementId: p.currentRequirementId });
    };
    const interrupt = async () => {
      if (!s.running) return { ok: false, error: "nothing is running" };
      const r = await call("turn/interrupt", { commandId: mint(), sessionId, ...(s.turnId ? { turnId: s.turnId } : {}) });
      return r.ok ? { ok: true } : { ok: false, error: r.error.message };
    };
    const busy = () => [...s.background.values()].includes("busy");
    const noteItem = (item, done) => {
      if (item.kind === "agentMessage") {
        if (done && typeof item.text === "string" && item.text.trim()) {
          s.agentText = item.text;
          if (item.messagePhase !== "commentary") s.finalText = item.text;
        }
        return;
      }
      if (item.kind !== "subagent" && item.kind !== "workflow") return;
      const id = str(item.itemId);
      // An item is only replaced by a later revision, so a copy that comes late never undoes a newer one.
      const revision = typeof item.revision === "number" ? item.revision : 0;
      if (id && (s.revisions.get(id) ?? revision) > revision) return;
      if (id) s.revisions.set(id, revision);
      if (item.kind === "subagent" && str(item.childSessionId) && str(item.subagentId)) s.subagents.set(item.childSessionId, item.subagentId);
      if (item.kind === "workflow" && str(item.workflowRunId)) {
        s.workflows = s.workflows.filter((w) => w !== item.workflowRunId);
        if (item.status === "inProgress") s.workflows.push(item.workflowRunId);
      }
      if (!id) return;
      const wasBusy = busy();
      const state = backgroundState(item);
      if (state) s.background.set(id, state);
      else s.background.delete(id);
      // Once the last one settles, a turn its end wakes gets the usual time to start.
      if (wasBusy && !busy() && !s.running) s.idleAt = clock.now();
    };
    const observe = (method, params) => {
      const p = obj(params);
      if (typeof p.sessionId === "string" && p.sessionId !== sessionId) return;
      switch (method) {
        case "turn/started":
          startRunning(str(p.turnId));
          break;
        case "turn/completed":
          endTurn(str(p.turnId), p);
          break;
        case "turn/unqueued":
          s.queued.delete(p.turnId);
          break;
        case "session/goalChanged": {
          const at = goalTime(p.goal);
          if (at !== null && s.goalAt !== null && at < s.goalAt) break;
          s.goal = goalOf(p.goal);
          s.goalAt = at ?? s.goalAt;
          break;
        }
        case "session/tokenUsage":
          // One per model completion of the main agent; subagents' and workflows' ride their own items.
          s.steps += 1;
          if (s.steps >= config.maxModelSteps && s.capAt === null) {
            s.capAt = clock.now();
            void interrupt();
          }
          break;
        case "item/started":
        case "item/updated":
        case "item/completed":
          noteItem(obj(p.item), method === "item/completed");
          break;
        case "approval/requested":
          void decide(p);
          break;
        case "session/closed":
          s.closed = true;
          break;
        case "view/gap":
          // Push delivery dropped events, maybe a turn's start or end. The loop pages them in, then checks the session.
          s.gaps.push({ after: str(p.after), next: str(p.next) });
          break;
      }
    };
    /** Logs an event and follows it, once: a durable event that comes again (from a filled gap) is known by its cursor. */
    const receive = (method, params) => {
      const p = obj(params);
      // Only durable events have cursors of their own: a status change borrows the one of the record behind it.
      const cursor = p.sourceRange !== undefined ? str(p.viewCursor) : null;
      if (cursor) {
        if (s.seen.has(cursor)) return;
        s.seen.add(cursor);
      }
      log({ kind: "note", method, ...(params !== undefined ? { params } : {}) });
      try {
        observe(method, params);
      } catch {
        // A frame of an unexpected shape is logged and otherwise ignored.
      }
    };
    conn.onNotification((n) => {
      const note = obj(n);
      s.lastFrameAt = clock.now();
      receive(typeof note.method === "string" ? note.method : "", note.params);
    });
    // An approval or question still open on resume is sent again as a server request. Each is logged as a note under
    // its own method; approvals are answered with an allow choice, questions wait for the owner's answer command.
    conn.onServerRequest(async (request) => {
      const req = obj(request);
      const method = typeof req.method === "string" ? req.method : "";
      log({ kind: "note", method, ...(req.params !== undefined ? { params: req.params } : {}) });
      if (method === "approval/request") void decide(obj(req.params));
      return {};
    });
    if (conn.exited) {
      Promise.resolve(conn.exited).then(
        (e) => (s.hostExit = obj(e)),
        () => (s.hostExit = {}),
      );
    }
    const stop = () => {
      if (s.end) return;
      s.end = { reason: "stopped", code: EXIT.failed, at: clock.now() };
      void interrupt();
      // The runner kills the process group soon after its stop signal, so the record can't wait on the host.
      const timer = setTimeout(() => writeExit(EXIT.failed, "stopped", s), STOP_GRACE_MS);
      timer.unref?.();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop);

    // Open the session: resume it when it exists, else start it under the build's id.
    let opened = "resumed";
    const resumed = await call("session/resume", { commandId: mint(), sessionId, excludeItems: true, modelId: config.model });
    let session = resumed.ok ? obj(resumed.result.session) : {};
    if (!resumed.ok) {
      opened = "started";
      const started = await call("session/start", {
        commandId: mint(),
        sessionId,
        workspaceRoot: config.workspace,
        approvalMode: "allowAll",
        modelId: config.model,
      });
      if (!started.ok) {
        await closeQuietly(conn);
        return writeExit(EXIT.usage, `host did not start: couldn't open the session (${resumed.error.message}; ${started.error.message})`, s);
      }
      session = obj(started.result.session);
    } else {
      // A resumed session keeps the approval mode it was made with, and a build has nobody to approve.
      await call("session/setApprovalMode", { commandId: mint(), sessionId, mode: "allowAll" });
    }
    log({ kind: "bridge", event: "session", sessionId, reason: opened });
    if (str(session.activeTurnId)) startRunning(session.activeTurnId);
    await call("session/setReasoningEffort", { commandId: mint(), sessionId, reasoningEffort: config.reasoningEffort });

    const startTurn = async (input, ifBusy, why) => {
      const r = await call("turn/start", { commandId: mint(), sessionId, input, ifBusy, reasoningEffort: config.reasoningEffort });
      if (!r.ok) return { ok: false, error: r.error.message };
      const turnId = str(r.result.turnId);
      if (r.result.disposition === "started") startRunning(turnId);
      else if (r.result.disposition === "queued" && turnId && !s.ended.has(turnId)) s.queued.add(turnId);
      log({ kind: "bridge", event: "turn", ...(turnId ? { turnId } : {}), reason: why });
      return { ok: true };
    };
    const why = first.left.length ? `prompt, without ${first.left.join(", ")}` : "prompt";
    const turn = await startTurn(first.input, "queue", why);
    if (!turn.ok) {
      await closeQuietly(conn);
      return writeExit(EXIT.usage, `host did not start: Muse Code didn't take the prompt (${turn.error})`, s);
    }
    if (config.goal?.trim()) await call("goal/set", { commandId: mint(), sessionId, objective: config.goal.trim() });

    const apply = async (c) => {
      const done = (r) => (r.ok ? { ok: true } : { ok: false, error: r.error.message });
      switch (c.type) {
        case "steer": {
          const input = [{ type: "text", text: c.text }];
          if (s.running && s.turnId) {
            const r = await call("turn/steer", { commandId: mint(), sessionId, expectedTurnId: s.turnId, input, reasoningEffort: config.reasoningEffort });
            if (r.ok) return { ok: true };
            // The turn ended between the read and the steer: the note starts the next one instead.
          }
          return startTurn(input, "steer", "steer");
        }
        case "queue":
          return startTurn([{ type: "text", text: c.text }], "queue", "queue");
        case "interrupt": {
          const r = await interrupt();
          if (r.ok) s.interrupted = true;
          return r;
        }
        case "goal": {
          const objective = c.action === "set" || c.action === "edit" ? { objective: c.objective.trim() } : {};
          return done(await call(`goal/${c.action}`, { commandId: mint(), sessionId, ...objective }));
        }
        case "answer":
          return done(await call("userInput/answer", { commandId: mint(), sessionId, userInputId: c.userInputId, answers: c.answers }));
        case "workflow": {
          const workflowRunId = c.workflowId ?? s.workflows[s.workflows.length - 1];
          if (!workflowRunId) return { ok: false, error: "no workflow is running" };
          return done(await call(`workflow/${c.action}`, { commandId: mint(), sessionId, workflowRunId }));
        }
        case "subagent": {
          // The build room names a child by its session; the protocol by its subagent id, which its item carries.
          const subagentId = s.subagents.get(c.childSessionId) ?? c.childSessionId;
          if (c.action === "message") {
            return done(await call("subagent/sendMessage", { commandId: mint(), sessionId, subagentId, body: c.text.trim() }));
          }
          return done(await call(`subagent/${c.action}`, { commandId: mint(), sessionId, subagentId, reason: "Stopped by the build's owner." }));
        }
        case "end": {
          const reason = c.reason?.trim() || "ended";
          // Work cut off, in the turn or in the background, ends the round as stopped.
          s.end = { reason, code: s.running || busy() ? EXIT.failed : undefined, at: clock.now() };
          if (s.running) await interrupt();
          return { ok: true };
        }
      }
      return { ok: false, error: "unknown command type" };
    };

    const doneDir = path.join(config.mailboxDir, "done");
    const retire = async (name) => {
      try {
        await fs.mkdirp(doneDir);
        await fs.move(path.join(config.mailboxDir, name), path.join(doneDir, name));
      } catch {
        // Applied once by id either way, so a file that won't move is never applied again.
      }
    };
    const readMailbox = async () => {
      let names;
      try {
        names = (await fs.list(config.mailboxDir)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (s.end) return;
        let envelope;
        try {
          envelope = JSON.parse(await fs.readText(path.join(config.mailboxDir, name)));
        } catch (err) {
          log({ kind: "command", id: name, command: {}, ok: false, error: `${name} isn't a command: ${errorOf(err).message}` });
          await retire(name);
          continue;
        }
        const e = obj(envelope);
        const id = str(e.id) ?? name;
        if (s.applied.has(id)) {
          await retire(name);
          continue;
        }
        s.applied.add(id);
        const bad = str(e.id) ? commandProblem(e.command) : "the envelope has no id";
        if (bad) {
          log({ kind: "command", id, command: obj(e.command), ok: false, error: bad });
        } else {
          let result;
          try {
            result = await apply(e.command);
          } catch (err) {
            result = { ok: false, error: errorOf(err).message };
          }
          log({ kind: "command", id, command: e.command, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
        }
        await retire(name);
      }
    };

    const lastCode = () => (s.last?.terminal === "completed" ? EXIT.completed : EXIT.failed);
    const lastReason = () => {
      if (!s.last) return "nothing ran";
      if (s.last.terminal === "completed") return "completed";
      return s.last.message ? `${s.last.terminal}: ${s.last.message}` : s.last.terminal;
    };
    /** Logs why the bridge waits with nothing running, once per reason, until a turn starts. */
    const idle = (reason) => {
      if (s.idleReason === reason) return;
      s.idleReason = reason;
      log({ kind: "bridge", event: "idle", reason });
    };
    /** The exit due now, or null to keep going. */
    const exitDue = (now) => {
      const host = s.hostExit
        ? `host exited${typeof s.hostExit.code === "number" ? ` with code ${s.hostExit.code}` : s.hostExit.signal ? ` on ${s.hostExit.signal}` : ""}`
        : s.closed
          ? "session closed"
          : null;
      if (s.end) {
        if (s.running && !host && now - s.end.at < INTERRUPT_WAIT_MS) return null;
        return { code: s.end.code ?? lastCode(), reason: s.end.reason };
      }
      if (s.capAt !== null) {
        if (s.running && !host && now - s.capAt < INTERRUPT_WAIT_MS) return null;
        // A turn whose last allowed step was its answer completed on its own.
        if (!s.running && s.last?.terminal === "completed") return { code: EXIT.completed, reason: "completed" };
        return { code: EXIT.failed, reason: `step cap of ${config.maxModelSteps} model steps` };
      }
      if (host) return s.running || !s.completed ? { code: EXIT.failed, reason: host } : { code: lastCode(), reason: lastReason() };
      if (s.running) return null;
      const idleFor = now - s.idleAt;
      const background = [...s.background.values()];
      // A workflow or subagent still at work reports back in a turn of its own. The platform's time cap bounds the wait.
      if (background.includes("busy")) {
        idle("background work");
        return null;
      }
      if (s.queued.size) return idleFor >= config.idleExitMs ? { code: lastCode(), reason: "a queued turn never started" } : null;
      if (s.goal?.status === "active") {
        idle("goal open");
        return idleFor >= config.idleExitMs ? { code: lastCode(), reason: "the goal is still open, but no turn ran" } : null;
      }
      if (background.includes("paused")) {
        idle("workflow paused");
        return idleFor >= config.idleExitMs ? { code: lastCode(), reason: "a workflow stayed paused" } : null;
      }
      if (s.interrupted) {
        idle("interrupted");
        return idleFor >= config.idleExitMs ? { code: EXIT.failed, reason: "interrupted" } : null;
      }
      if (s.completed) return idleFor >= SETTLE_MS ? { code: lastCode(), reason: lastReason() } : null;
      idle("waiting");
      return idleFor >= config.idleExitMs ? { code: EXIT.failed, reason: "nothing ran" } : null;
    };

    /**
     * Pages in the events a view/gap says were dropped, from `after` up to `next` or the first one already received,
     * and follows each as if it had come live. Events after `next` were delivered, or are on their way.
     */
    const fillGap = async (after, next) => {
      let cursor = after;
      for (let page = 0; page < GAP_MAX_PAGES; page++) {
        const r = await call(
          "view/page",
          { sessionId, cursor, limit: GAP_PAGE_LIMIT },
          { summary: (res) => ({ events: Array.isArray(res.events) ? res.events.length : 0, nextCursor: res.nextCursor ?? null }) },
        );
        if (!r.ok) return;
        const events = Array.isArray(r.result.events) ? r.result.events.map(obj) : [];
        for (const event of events) {
          const at = str(obj(event.params).viewCursor);
          if (!at) continue;
          if (at === next || s.seen.has(at)) return;
          receive(typeof event.method === "string" ? event.method : "", event.params);
        }
        const more = str(r.result.nextCursor);
        if (!more || more === cursor || !events.length) return;
        cursor = more;
      }
    };
    /**
     * Asks the host where the session stands (session/read) and follows what it says: a turn the bridge saw start has
     * ended, with how the last turn ended, or one it never saw start is running.
     */
    const reconcile = async () => {
      s.checkedAt = clock.now();
      const starts = s.starts;
      const r = await call("session/read", { sessionId });
      const session = obj(r.ok ? r.result.session : null);
      // An answer that crossed a turn's start knows less than the stream does.
      if (typeof session.status !== "string" || s.starts !== starts) return;
      const active = session.status === "running" ? str(session.activeTurnId) : null;
      if (s.running && (!active || (s.turnId && s.turnId !== active))) endTurn(s.turnId, obj(r.result.lastTurn));
      if (active && (!s.running || !s.turnId)) startRunning(active);
    };
    /** Fills the holes the stream reported and checks the session after them, or after a turn that went quiet. */
    const recover = async () => {
      if (s.hostExit || s.closed) return;
      let check = false;
      while (s.gaps.length) {
        const gap = s.gaps.shift();
        if (gap.after) await fillGap(gap.after, gap.next);
        check = true;
      }
      if (s.running && clock.now() - Math.max(s.lastFrameAt, s.checkedAt) >= QUIET_MS) check = true;
      if (check) await reconcile();
    };

    for (;;) {
      await readMailbox();
      await recover();
      const due = exitDue(clock.now());
      if (due) {
        await closeQuietly(conn);
        return writeExit(due.code, due.reason, s);
      }
      await clock.sleep(POLL_MS);
    }
  } catch (err) {
    if (conn) await closeQuietly(conn);
    return writeExit(EXIT.failed, `bridge error: ${errorOf(err).message}`, s);
  } finally {
    writeExit(EXIT.failed, "bridge error: no exit was recorded", s);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The real thing: Node's file system and clock, and the SDK's connection to `muse serve`.

const nodeFs = {
  append: (file, text) => appendFileSync(file, text),
  readText: (file) => readFile(file, "utf8"),
  readBytes: (file) => readFile(file),
  list: async (dir) => {
    try {
      return await readdir(dir);
    } catch (err) {
      if (obj(err).code === "ENOENT") return [];
      throw err;
    }
  },
  move: (from, to) => rename(from, to),
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
};

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Spawns `muse <args>` in the workspace with the SDK, initializes it, and adapts it to what runBridge expects. */
async function connectSdk(config, args, { stderr }) {
  const { spawnMspConnection, createUuidV7Mint } = await import("@muse-code/sdk");
  const early = [];
  let onNote = null;
  let onRequest = null;
  const host = spawnMspConnection({ command: "muse", args, cwd: config.workspace, env: process.env, onStderr: stderr, shutdownTimeoutMs: SHUTDOWN_MS });
  host.onNotification((n) => (onNote ? onNote(n) : early.push(n)));
  host.onServerRequest(async (r) => (onRequest ? onRequest(r) : {}));
  host.onProtocolError((e) => stderr(`bridge: protocol error: ${e instanceof Error ? e.message : String(e)}`));
  let spawned;
  try {
    spawned = await host.initialize({ clientInfo: { name: "musemuse_bridge", version: "1.0.0" } });
  } catch (err) {
    await closeQuietly(host);
    throw err;
  }
  // The SDK pairs with one Muse Code release; a host whose wire schema differs still runs, with this on record.
  if (spawned.fingerprintWarning) stderr(`bridge: ${JSON.stringify(spawned.fingerprintWarning).slice(0, 1000)}`);
  const mint = createUuidV7Mint();
  return {
    request: (method, params) => spawned.connection.request(method, params),
    onNotification(handler) {
      onNote = handler;
      for (const n of early.splice(0)) handler(n);
    },
    onServerRequest(handler) {
      onRequest = handler;
    },
    exited: spawned.exited,
    close: () => spawned.close(),
    mint,
  };
}

async function main() {
  const configPath = process.argv[2];
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    process.stderr.write(`bridge: can't read the config ${configPath}: ${errorOf(err).message}\n`);
    process.exit(EXIT.usage);
  }
  const problem = configProblem(config);
  if (problem) process.stderr.write(`bridge: ${problem}\n`);
  const stop = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => stop.abort());
  const code = await runBridge({ config, fs: nodeFs, clock: realClock, connect: (args, hooks) => connectSdk(config, args, hooks), signal: stop.signal });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
