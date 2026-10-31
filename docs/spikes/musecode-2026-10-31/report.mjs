// Prints what one labeled run did: the proxy's requests, the sink's direct calls, and the bridge log's calls, usage and exit.
import { existsSync, readFileSync } from "node:fs";

const name = process.argv[2];
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const proxy = lines("/tmp/out/proxy.jsonl").filter((e) => e.label === name && e.method);
const sinkAll = lines("/tmp/out/sink.jsonl").filter((e) => e.label === name);
const sink = sinkAll.filter((e) => e.direct);
const conns = sinkAll.filter((e) => e.conn);
const tunnels = sinkAll.filter((e) => e.tunnel);
const bridge = lines(`/tmp/out/${name}.bridge.jsonl`);
const group = (items, f) => {
  const m = new Map();
  for (const i of items) m.set(f(i), (m.get(f(i)) ?? 0) + 1);
  return Object.fromEntries(m);
};
console.log(`[${name}] proxy requests ${proxy.length}:`, JSON.stringify(group(proxy, (e) => `${e.method} ${e.path} auth=${e.auth} model=${e.model ?? "-"} stream=${e.stream ?? "-"} bg=${e.background ?? "-"} ct=${e.contentType ?? "-"} ${e.forwarded ? `-> ${e.status}` : `refused:${e.refused ?? e.status}`}`)));
console.log(`[${name}] direct connections refused by the sink ${sink.length}:`, JSON.stringify(group(sink, (e) => (e.seen ? `${e.method} ${e.path} ct=${e.contentType ?? "-"} auth=${e.hasAuth}` : e.connect ? `CONNECT ${e.host}:${e.port}` : e.tlsError ? `tls:${e.tlsError}` : `${e.method} ${e.host}`))));
console.log(`[${name}] non-loopback sockets seen by ss:`, JSON.stringify(conns.map((e) => `${e.comm} ${e.peer}`)), `npm tunnels ${tunnels.length}`);
const forwarded = proxy.filter((e) => e.usage);
const sum = forwarded.reduce((a, e) => ({ input: a.input + e.usage.input, cached: a.cached + e.usage.cached, output: a.output + e.usage.output, cost: a.cost + e.costUsd }), { input: 0, cached: 0, output: 0, cost: 0 });
console.log(`[${name}] proxy metered: ${forwarded.length} calls, ${JSON.stringify(sum)}`);
if (forwarded.length) console.log(`[${name}] kinds:`, JSON.stringify(group(forwarded, (e) => `tools=${e.tools} instr=${e.instrSha} effort=${e.effort} model=${e.respModel}`)));
const notes = bridge.filter((r) => r.kind === "note");
console.log(`[${name}] bridge notes:`, JSON.stringify(group(notes, (r) => r.method)));
const calls = bridge.filter((r) => r.kind === "call").map((r) => `${r.method}:${r.ok ? "ok" : `FAIL ${JSON.stringify(r.error).slice(0, 300)}`}`);
console.log(`[${name}] calls:`, calls.join(" | "));
for (const r of bridge.filter((b) => b.kind === "stderr").slice(0, 12)) console.log(`[${name}] stderr: ${String(r.text).slice(0, 500)}`);
const failed = notes.filter((r) => r.method === "turn/completed").map((r) => ({ terminal: r.params?.terminal, error: r.params?.error, reason: r.params?.reason }));
console.log(`[${name}] turns:`, JSON.stringify(failed).slice(0, 900));
const usage = notes.filter((r) => r.method === "session/tokenUsage");
if (usage.length) {
  const last = usage[usage.length - 1].params;
  console.log(`[${name}] tokenUsage events ${usage.length}, last:`, JSON.stringify(last).slice(0, 800));
}
if (usage.length) {
  const tot = { input: 0, cached: 0, output: 0 };
  for (const n of usage) {
    tot.input += n.params?.usage?.inputTokens ?? 0;
    tot.cached += n.params?.usage?.cachedTokens ?? 0;
    tot.output += n.params?.usage?.outputTokens ?? 0;
  }
  const cost = ((tot.input - tot.cached) * 0.1 + tot.cached * 0.002 + tot.output * 0.2) / 1e6;
  console.log(`[${name}] session/tokenUsage summed: ${JSON.stringify(tot)} cost ${cost.toFixed(6)} (proxy ${sum.cost.toFixed(6)}, ${forwarded.length} proxy calls, ${usage.length} usage events)`);
}
const exit = bridge.filter((r) => r.kind === "bridge" && r.event === "exit").pop();
if (exit) console.log(`[${name}] exit:`, JSON.stringify({ code: exit.exitCode, reason: exit.reason, finalText: String(exit.finalText ?? "").slice(0, 500) }));
const t0 = bridge[0]?.t;
const firstEvent = notes[0]?.t;
if (firstEvent && process.env.SPIKE_T0_MS) console.log(`[${name}] from Sandbox.create: first session event ${((firstEvent - Number(process.env.SPIKE_T0_MS)) / 1000).toFixed(2)} s`);
const firstTurn = bridge.find((r) => r.kind === "bridge" && r.event === "turn")?.t;
if (t0) console.log(`[${name}] timing from bridge start: first note ${firstEvent ? firstEvent - t0 : "-"} ms, prompt taken ${firstTurn ? firstTurn - t0 : "-"} ms, end ${bridge[bridge.length - 1].t - t0} ms`);
