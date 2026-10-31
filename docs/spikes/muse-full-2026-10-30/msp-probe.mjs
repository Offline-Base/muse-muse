// A tiny Muse Session Protocol client for the spike. Logs every frame to argv[2] as JSONL.
//   node msp-probe.mjs <out.jsonl> <list|live>   (env: WS, SERVE_ARGS, MODEL, OBJECTIVE, STEER)
import { spawnMspConnection, createUuidV7Mint } from "@muse-code/sdk";
import { appendFileSync } from "node:fs";
const [out, mode = "list"] = process.argv.slice(2);
const log = (o) => appendFileSync(out, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const mint = createUuidV7Mint();
const args = (process.env.SERVE_ARGS || "serve").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let activeTurn = null;
let completed = false;
const hs = spawnMspConnection({ command: "muse", args, cwd: process.env.WS, env: process.env, onStderr: (c) => log({ stderr: String(c).slice(0, 3000) }) });
hs.onNotification((n) => {
  log({ note: n });
  if (n.method === "turn/started") activeTurn = n.params?.turnId ?? n.params?.turn?.turnId ?? activeTurn;
  if (n.method === "turn/completed") completed = true;
});
hs.onServerRequest(async (req) => { log({ serverRequest: req }); return {}; });
hs.onProtocolError((e) => log({ protocolError: String(e) }));
async function call(method, params) {
  try { const r = await conn.request(method, params); log({ call: method, ok: true, result: r }); return r; }
  catch (e) { log({ call: method, ok: false, error: String(e), code: e?.code, kind: e?.kind, data: e?.data }); return null; }
}
let conn;
try {
  const spawned = await hs.initialize({ clientInfo: { name: "musemuse_spike", version: "0.0.1" } });
  conn = spawned.connection;
  log({ initialized: spawned.initializeResult, fingerprintWarning: spawned.fingerprintWarning ?? null });
  const started = await call("session/start", { commandId: mint(), workspaceRoot: process.env.WS, approvalMode: "allowAll", ...(process.env.MODEL ? { modelId: process.env.MODEL } : {}) });
  const sessionId = started?.session?.sessionId ?? started?.session?.id;
  log({ sessionId });
  for (const m of ["hook/list", "skill/list", "model/list", "task/list"]) await call(m, { sessionId });
  if (sessionId && process.env.OBJECTIVE) {
    const g = await call("goal/set", { commandId: mint(), sessionId, objective: process.env.OBJECTIVE });
    if (g?.turnId) activeTurn = g.turnId;
  }
  if (mode === "live" && sessionId) {
    for (let i = 0; i < 120 && !activeTurn; i++) await sleep(500);
    log({ activeTurn });
    if (activeTurn && process.env.STEER) {
      await sleep(4000);
      await call("turn/steer", { commandId: mint(), sessionId, expectedTurnId: activeTurn, input: [{ type: "text", text: process.env.STEER }] });
    }
    for (let i = 0; i < 360 && !completed; i++) await sleep(500);
    await call("usage/read", { sessionId });
  } else {
    await sleep(15000);
  }
} catch (e) {
  log({ fatal: String(e), stack: e?.stack?.slice(0, 1500) });
} finally {
  const exit = await hs.close().catch((e) => ({ closeError: String(e) }));
  log({ closed: exit });
}
