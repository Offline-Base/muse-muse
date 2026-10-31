// A minimal stdio MCP server for the spike: one tool, spike_ping, that answers PONG-4217.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "spike", version: "0.0.1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "spike_ping", description: "Returns the spike's secret pong code.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "PONG-4217" }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
