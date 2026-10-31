// A small Muse Session Protocol client for the Oct 31 serve test. One case per run; every frame goes to the JSONL file.
//   node msp-host-probe.mjs <out.jsonl> <case>
// Cases: tools (open a session and start one turn, nothing more; the firewall answers the model call), echo (a free run on
// the echo provider), live (a real paid turn), resume (open the session again on a new host).
// Env: WS, SERVE_ARGS (space-separated), SETTING and SETTING2 (one -c value each, with spaces kept), SESSION_ID, PROMPT, EFFORT, WAIT_S.
import { spawnMspConnection, createUuidV7Mint } from "@muse-code/sdk";
import { appendFileSync } from "node:fs";
const [out, mode = "tools"] = process.argv.slice(2);
const log = (o) => appendFileSync(out, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const mint = createUuidV7Mint();
const args = (process.env.SERVE_ARGS || "serve").split(" ").filter(Boolean);
if (process.env.SETTING) args.push("-c", process.env.SETTING);
if (process.env.SETTING2) args.push("-c", process.env.SETTING2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionId = process.env.SESSION_ID || mint();
let turnId = null;
let completed = 0;
const cursors = [];
const hs = spawnMspConnection({ command: "muse", args, cwd: process.env.WS, env: process.env, onStderr: (c) => log({ stderr: String(c).slice(0, 3000) }), shutdownTimeoutMs: 8000 });
hs.onNotification((n) => {
  log({ note: n });
  const p = n.params ?? {};
  if (typeof p.viewCursor === "string" && p.sourceRange !== undefined) cursors.push(p.viewCursor);
  if (n.method === "turn/started") turnId = p.turnId ?? turnId;
  if (n.method === "turn/completed") completed += 1;
});
hs.onServerRequest(async (req) => { log({ serverRequest: req }); return {}; });
hs.onProtocolError((e) => log({ protocolError: String(e) }));
let conn;
async function call(method, params, slim) {
  try {
    const r = await conn.request(method, params);
    log({ call: method, ok: true, result: slim ? slim(r) : r });
    return r;
  } catch (e) {
    log({ call: method, ok: false, error: String(e), code: e?.code, kind: e?.kind, data: e?.data });
    return null;
  }
}
const readSlim = (r) => ({ session: r?.session ? { status: r.session.status, activeTurnId: r.session.activeTurnId ?? null, keys: Object.keys(r.session) } : null, lastTurn: r?.lastTurn ?? null, keys: Object.keys(r ?? {}) });
const pageSlim = (r) => ({ keys: Object.keys(r ?? {}), events: (r?.events ?? []).length, nextCursor: r?.nextCursor ?? null, first: (r?.events ?? []).slice(0, 2), methods: [...new Set((r?.events ?? []).map((e) => e.method))] });
try {
  const spawned = await hs.initialize({ clientInfo: { name: "musemuse_probe", version: "0.0.1" } });
  conn = spawned.connection;
  log({ initialized: Object.keys(spawned.initializeResult ?? {}), fingerprintWarning: spawned.fingerprintWarning ?? null });
  const model = process.env.MODEL;
  const input = [{ type: "text", text: process.env.PROMPT || "Reply with the word READY." }];
  const effort = process.env.EFFORT;
  if (mode === "resume") {
    const r = await call("session/resume", { commandId: mint(), sessionId, excludeItems: true, ...(model ? { modelId: model } : {}) }, (x) => ({ keys: Object.keys(x ?? {}), session: x?.session ? { status: x.session.status, activeTurnId: x.session.activeTurnId ?? null, modelId: x.session.modelId, keys: Object.keys(x.session) } : null }));
    log({ resumed: Boolean(r) });
    await call("session/read", { sessionId }, readSlim);
  } else {
    await call("session/start", { commandId: mint(), sessionId, workspaceRoot: process.env.WS, approvalMode: "allowAll", ...(model ? { modelId: model } : {}) }, (x) => ({ keys: Object.keys(x ?? {}), session: x?.session ? { status: x.session.status, modelId: x.session.modelId, keys: Object.keys(x.session) } : null }));
    if (effort) await call("session/setReasoningEffort", { commandId: mint(), sessionId, reasoningEffort: effort });
    await call("session/read", { sessionId }, readSlim);
  }
  await call("turn/start", { commandId: mint(), sessionId, input, ifBusy: "queue", ...(effort ? { reasoningEffort: effort } : {}) });
  const waitS = Number(process.env.WAIT_S || 30);
  const until = Date.now() + waitS * 1000;
  let readDuring = false;
  let checks = 0;
  while (Date.now() < until && completed === 0) {
    await sleep(1000);
    checks += 1;
    if (turnId && !readDuring && checks >= 3) { readDuring = true; log({ during: true }); await call("session/read", { sessionId }, readSlim); }
  }
  log({ completed, cursors: cursors.length, turnId });
  await sleep(1000);
  await call("session/read", { sessionId }, readSlim);
  // view/page from the very start, from the first cursor, and past the end.
  await call("view/page", { sessionId, limit: 5 }, pageSlim);
  if (cursors.length) {
    const page = await call("view/page", { sessionId, cursor: cursors[0], limit: 200 }, pageSlim);
    log({ cursorsSeenLive: cursors.length, firstLive: cursors[0], lastLive: cursors[cursors.length - 1], pageCursors: (page?.events ?? []).map((e) => e?.params?.viewCursor ?? null).slice(0, 5) });
    if (page?.nextCursor) await call("view/page", { sessionId, cursor: page.nextCursor, limit: 200 }, pageSlim);
    await call("view/page", { sessionId, cursor: cursors[cursors.length - 1], limit: 200 }, pageSlim);
  }
  await call("usage/read", { sessionId });
} catch (e) {
  log({ fatal: String(e), stack: e?.stack?.slice(0, 1500) });
} finally {
  const exit = await hs.close().catch((e) => ({ closeError: String(e) }));
  log({ closed: exit, sessionId });
}
