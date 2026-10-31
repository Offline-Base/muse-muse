// Last two questions, one paid call each (about $0.01 total):
// does direct execute honour an older version, and what does a real event query return?
// Also lists toolkit slugs (free) so the denylist names toolkits that exist.
//   COMPOSIO_SDK_DIR=<folder> sh docs/spikes/composio-2026-10-31/run.sh docs/spikes/composio-2026-10-31/05-pin-and-events.mjs
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK = path.join(process.env.COMPOSIO_SDK_DIR ?? ".", "node_modules/@composio/core/dist/index.mjs");
const { Composio, SessionPreset } = await import(pathToFileURL(SDK).href);
const BASE = "https://backend.composio.dev";
const KEY = process.env.COMPOSIO_API_KEY;
const OUT = path.join(import.meta.dirname, "results");
const composio = new Composio({ apiKey: KEY, allowTracking: false });
const headers = { "x-api-key": KEY, "content-type": "application/json" };
const report = {};
const scrub = (s) => s.replace(/serpapi\.com\/searches\/[A-Za-z0-9_-]+/g, "serpapi.com/searches/<redacted>");

// 1. An older version through direct execute. The log says which version actually ran.
const older = "20261026_00";
const direct = await fetch(`${BASE}/api/v3.1/tools/execute/FIRECRAWL_SCRAPE`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    connected_account_id: "instant_account",
    user_id: "spike_c0_public",
    version: older,
    arguments: { url: "https://example.com" },
  }),
});
const directJson = await direct.json();
report.directOlderVersion = {
  requested: older,
  status: direct.status,
  successful: directJson.successful,
  error: directJson.error,
  logId: directJson.log_id,
};
if (directJson.log_id) {
  // Logs can lag a little behind the call, and this tells T how far.
  for (const waitMs of [0, 1000, 3000]) {
    await new Promise((r) => setTimeout(r, waitMs));
    const res = await fetch(`${BASE}/api/v3.1/logs/tool_execution/${directJson.log_id}`, { headers });
    const j = await res.json();
    report.directOlderVersion.log = {
      afterMs: waitMs,
      status: res.status,
      ranVersion: j.metadata?.tool?.version,
      charge: j.metadata?.instant_charge,
      credential: j.metadata?.credential_source,
    };
    if (res.status === 200 && j.metadata?.instant_charge) break;
  }
}
appendFileSync(path.join(OUT, "paid-calls.log"), `${new Date().toISOString()} FIRECRAWL_SCRAPE direct-older-version status ${direct.status} charge ${report.directOlderVersion.log?.charge ?? "unknown"}\n`);
console.log(JSON.stringify(report.directOlderVersion));

// 2. The query from the tool's own schema examples, to see the structured event shape.
const session = await composio.sessions.create("spike_c0_public", {
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  toolkits: { enable: ["serpapi"] },
  tools: { serpapi: { enable: ["SERPAPI_EVENT_SEARCH"] } },
  instant: { toolkits: { enable: ["serpapi"] }, returnInstantCharge: true },
  manageConnections: { enable: false },
  sandbox: { enable: false },
});
const started = Date.now();
const r = await session.execute("SERPAPI_EVENT_SEARCH", { query: "Live music in Austin this weekend" });
const ms = Date.now() - started;
const data = r.data ?? {};
const inner = data.results ?? data;
const list = inner.events_results ?? [];
report.eventsStructured = {
  ms,
  resultType: r.resultType,
  instantCharge: r.instantCharge ?? null,
  dataBytes: JSON.stringify(data).length,
  topKeys: Object.keys(data),
  innerKeys: Object.keys(inner),
  eventsCount: list.length,
  firstEventKeys: list[0] ? Object.keys(list[0]) : [],
  firstEventSample: list[0]
    ? JSON.parse(scrub(JSON.stringify({ title: list[0].title, date: list[0].date, address: list[0].address, link: list[0].link })))
    : null,
};
appendFileSync(path.join(OUT, "paid-calls.log"), `${new Date().toISOString()} SERPAPI_EVENT_SEARCH events-structured ${ms}ms ${JSON.stringify(r.instantCharge ?? null)} ${r.resultType}\n`);
console.log(JSON.stringify(report.eventsStructured));

// 3. Free: every toolkit slug, by category, for the denylist.
const toolkits = [];
let cursor;
do {
  const q = new URLSearchParams({ limit: "1000" });
  if (cursor) q.set("cursor", cursor);
  const res = await fetch(`${BASE}/api/v3.1/toolkits?${q}`, { headers });
  const j = await res.json();
  if (res.status !== 200) {
    report.toolkitsError = { status: res.status };
    break;
  }
  toolkits.push(...j.items);
  cursor = j.next_cursor;
} while (cursor);
report.toolkitCount = toolkits.length;
report.toolkitSlugs = toolkits.map((t) => `${t.slug}|${(t.meta?.categories ?? []).map((c) => c.slug ?? c.name ?? c).join(",")}`).sort();
writeFileSync(path.join(OUT, "05-pin-and-events.json"), JSON.stringify({ ...report, toolkitSlugs: undefined }, null, 2) + "\n");
const scratch = process.env.C0_SCRATCH;
if (scratch) writeFileSync(path.join(scratch, "toolkits.txt"), report.toolkitSlugs.join("\n") + "\n");
console.log("toolkits", report.toolkitCount);
