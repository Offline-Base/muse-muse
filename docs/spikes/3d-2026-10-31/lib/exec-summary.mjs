// What one `muse exec --json` run did: its event types, its tool calls by kind, the end of its final message, and the
// proxy's lines for the same label (calls, refusals, models, auth kinds, tokens and cost).
//   node exec-summary.mjs <exec.jsonl> <proxy.jsonl> <label>
import { existsSync, readFileSync } from "node:fs";

const [execLog, proxyLog, label] = process.argv.slice(2);
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};
const events = lines(execLog).map(parse).filter(Boolean);
const count = (xs) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
const kinds = events.map((e) => e.type ?? e.event ?? e.msg?.type ?? "?");
const items = events.map((e) => e.item ?? e.msg ?? e).filter((x) => x && typeof x === "object");
const tools = items.map((x) => x.type ?? x.kind).filter((t) => t && /call|command|tool|exec|patch|file/i.test(t));
const texts = items.map((x) => x.text ?? x.message ?? x.last_agent_message).filter((t) => typeof t === "string" && t.trim());
const usage = events.map((e) => e.usage ?? e.msg?.usage ?? e.info?.total_token_usage).filter(Boolean).at(-1) ?? null;
console.log(`  exec events: ${events.length} ${JSON.stringify(count(kinds))}`);
console.log(`  tool items: ${JSON.stringify(count(tools))}`);
if (usage) console.log(`  exec usage: ${JSON.stringify(usage).slice(0, 300)}`);
if (texts.length) console.log(`  final text: ${texts.at(-1).replace(/\s+/g, " ").slice(0, 600)}`);

const proxy = lines(proxyLog).map(parse).filter((p) => p && p.label === label && p.n);
const cost = proxy.reduce((s, p) => s + (p.costUsd ?? 0), 0);
const tokens = proxy.reduce((s, p) => ({ input: s.input + (p.usage?.input ?? 0), cached: s.cached + (p.usage?.cached ?? 0), output: s.output + (p.usage?.output ?? 0) }), { input: 0, cached: 0, output: 0 });
console.log(`  proxy: ${proxy.length} requests, ${proxy.filter((p) => p.forwarded && p.path?.endsWith("/responses")).length} model calls forwarded, refused ${JSON.stringify(count(proxy.filter((p) => p.refused).map((p) => p.refused)))}`);
console.log(`  proxy routes ${JSON.stringify(count(proxy.map((p) => `${p.method} ${p.path} ${p.status ?? ""}`)))} models ${JSON.stringify(count(proxy.map((p) => p.model).filter(Boolean)))} auth ${JSON.stringify(count(proxy.map((p) => p.auth)))}`);
console.log(`  proxy tokens ${JSON.stringify(tokens)}, cost $${cost.toFixed(6)}, response models ${JSON.stringify(count(proxy.map((p) => p.respModel).filter(Boolean)))}`);
