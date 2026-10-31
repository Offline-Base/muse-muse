// A small MSP client for the one thing the bridge has no command for: session/compact. Turn, compact, turn. Logs method names.
import { appendFileSync, readFileSync } from "node:fs";
import { spawnMspConnection, createUuidV7Mint } from "@muse-code/sdk";

const [out, ws, ...settings] = process.argv.slice(2);
const log = (o) => appendFileSync(out, `${JSON.stringify({ t: Date.now(), ...o })}\n`);
const mint = createUuidV7Mint();
const args = ["serve", "--disable-sandbox", "--trust-workspace", "--disable-request-user-input", "--model", "muse-spark-1.3-contributor", ...settings.flatMap((s) => ["-c", s])];
const host = spawnMspConnection({ command: "muse", args, cwd: ws, env: process.env, onStderr: (c) => log({ stderr: String(c).slice(0, 600) }), shutdownTimeoutMs: 8000 });
let done = 0;
host.onNotification((n) => {
  if (n.method === "turn/completed") done += 1;
  const p = n.params ?? {};
  const item = p.item ?? {};
  log({ note: n.method, terminal: p.terminal, error: p.error, itemKind: item.kind, usage: n.method === "session/tokenUsage" ? p.usage : undefined });
});
host.onServerRequest(async () => ({}));
const sessionId = mint();
const { connection: conn } = await host.initialize({ clientInfo: { name: "musecode_spike", version: "0.0.1" } }).then((s) => ({ connection: s.connection }));
const call = async (method, params) => {
  try {
    const r = await conn.request(method, params);
    log({ call: method, ok: true, keys: Object.keys(r ?? {}) });
    return r;
  } catch (e) {
    log({ call: method, ok: false, error: String(e).slice(0, 300), code: e?.code, kind: e?.kind });
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilDone = async (n, s) => {
  const by = Date.now() + s * 1000;
  while (done < n && Date.now() < by) await sleep(250);
};
await call("session/start", { commandId: mint(), sessionId, workspaceRoot: ws, approvalMode: "allowAll", modelId: "muse-spark-1.3-contributor" });
await call("session/setReasoningEffort", { commandId: mint(), sessionId, reasoningEffort: "low" });
const turn = (text) => call("turn/start", { commandId: mint(), sessionId, input: [{ type: "text", text }], ifBusy: "queue", reasoningEffort: "low" });
await turn("Reply with the word ONE and nothing else.");
await untilDone(1, 40);
await call("session/compact", { commandId: mint(), sessionId });
await sleep(1000);
await untilDone(2, 40);
await turn("Reply with the word TWO and nothing else.");
await untilDone(3, 40);
await sleep(2000);
await host.close().catch(() => {});
log({ closed: true, done });
process.exit(0);
