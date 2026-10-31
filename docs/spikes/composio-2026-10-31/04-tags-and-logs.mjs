// Does a session tag filter beat an explicit enable list, and which version did a session call run? At most one
// paid call ($0.005, only if the tag filter does not block it).
//   COMPOSIO_SDK_DIR=<folder> sh docs/spikes/composio-2026-10-31/run.sh docs/spikes/composio-2026-10-31/04-tags-and-logs.mjs
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK = path.join(process.env.COMPOSIO_SDK_DIR ?? ".", "node_modules/@composio/core/dist/index.mjs");
const { Composio, SessionPreset } = await import(pathToFileURL(SDK).href);
const KEY = process.env.COMPOSIO_API_KEY;
const OUT = path.join(import.meta.dirname, "results");
const composio = new Composio({ apiKey: KEY, allowTracking: false });
const report = {};

// TAVILY_SEARCH carries createHint, so a filter on createHint should remove it if tags beat the enable list.
const session = await composio.sessions.create("spike_c0_public", {
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  toolkits: { enable: ["tavily"] },
  tools: { tavily: { enable: ["TAVILY_SEARCH", "TAVILY_EXTRACT"] } },
  tags: { disable: ["createHint"] },
  instant: { toolkits: { enable: ["tavily"] }, returnInstantCharge: true },
  manageConnections: { enable: false },
  sandbox: { enable: false },
});
const tools = await session.tools();
report.tagFilter = {
  toolsListed: Array.isArray(tools) ? tools.map((t) => t.function?.name ?? t.name ?? t.slug) : Object.keys(tools ?? {}),
};
try {
  const r = await session.execute("TAVILY_SEARCH", { query: "Meta Quest browser WebXR", max_results: 1 });
  report.tagFilter.execute = { resultType: r.resultType, instantCharge: r.instantCharge ?? null, error: r.error };
  appendFileSync(path.join(OUT, "paid-calls.log"), `${new Date().toISOString()} TAVILY_SEARCH tag-filter ${JSON.stringify(r.instantCharge ?? null)} ${r.resultType}\n`);
} catch (e) {
  report.tagFilter.execute = { threw: String(e?.message ?? e).slice(0, 500) };
}

async function log(id) {
  const res = await fetch(`https://backend.composio.dev/api/v3.1/logs/tool_execution/${id}`, { headers: { "x-api-key": KEY } });
  const j = await res.json();
  if (res.status !== 200) return { status: res.status, body: j };
  return {
    status: res.status,
    keys: Object.keys(j),
    tool_slug: j.tool_slug,
    tool_version: j.tool_version ?? j.version,
    metadata: j.metadata,
    credential_source: j.credential_source,
    charge: j.metadata?.instant_charge ?? j.instant_charge,
  };
}
report.logs = {
  sessionCall: await log(process.argv[2]),
  directPinnedCall: await log(process.argv[3]),
};
const out = path.join(OUT, "04-tags-and-logs.json");
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2).slice(0, 3500));
