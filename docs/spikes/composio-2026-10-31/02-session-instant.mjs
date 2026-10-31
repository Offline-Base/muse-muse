// Live spike for sessions and Instant. Makes at most 3 paid tool calls unless --pin is passed (1 more).
//   COMPOSIO_SDK_DIR=<folder> sh docs/spikes/composio-2026-10-31/run.sh docs/spikes/composio-2026-10-31/02-session-instant.mjs
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK = path.join(process.env.COMPOSIO_SDK_DIR ?? ".", "node_modules/@composio/core/dist/index.mjs");
const { Composio, SessionPreset } = await import(pathToFileURL(SDK).href);
const OUT = path.join(import.meta.dirname, "results");
mkdirSync(OUT, { recursive: true });
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });

const report = { sdkPreset: SessionPreset, steps: {} };
const save = () => writeFileSync(path.join(OUT, "02-session-instant.json"), JSON.stringify(report, null, 2) + "\n");

function errInfo(e) {
  return {
    name: e?.name,
    code: e?.code,
    status: e?.status ?? e?.statusCode ?? e?.cause?.status,
    message: String(e?.message ?? e).slice(0, 800),
    cause: e?.cause ? String(e.cause.message ?? e.cause).slice(0, 800) : undefined,
    body: e?.cause?.error ?? e?.error,
  };
}

// Shape only: keys and types, with short samples, so nothing bulky lands in the repo.
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length === 0 ? [] : [`(${v.length} items)`, shape(v[0], depth + 1)];
  if (v && typeof v === "object") {
    if (depth > 4) return "{...}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  if (typeof v === "string") {
    const safe = v.replace(/serpapi\.com\/searches\/[A-Za-z0-9_-]+/g, "serpapi.com/searches/<redacted>");
    return safe.length > 80 ? `${safe.slice(0, 80)}... (${v.length} chars)` : safe;
  }
  return v;
}

const toolkits = ["tavily", "serpapi", "firecrawl"];
const config = {
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  toolkits: { enable: toolkits },
  tools: {
    tavily: { enable: ["TAVILY_SEARCH"] },
    serpapi: { enable: ["SERPAPI_NEWS_SEARCH"] },
    firecrawl: { enable: ["FIRECRAWL_SCRAPE"] },
  },
  tags: { disable: ["destructiveHint"] },
  instant: { toolkits: { enable: toolkits }, returnInstantCharge: true },
  manageConnections: { enable: false },
  sandbox: { enable: false },
};
report.steps.config = config;

let session;
try {
  const started = Date.now();
  session = await composio.sessions.create("spike_c0_public", config);
  report.steps.create = {
    ok: true,
    ms: Date.now() - started,
    keys: Object.keys(session),
    configVersion: session.configVersion,
    instant: session.config?.instant,
    sessionConfig: shape(session.config),
  };
} catch (e) {
  report.steps.create = { ok: false, error: errInfo(e) };
  save();
  console.error("session create failed", JSON.stringify(report.steps.create, null, 2));
  process.exit(1);
}
save();
console.log("session created", JSON.stringify(report.steps.create, null, 2).slice(0, 2500));

try {
  const tools = await session.tools();
  const names = Array.isArray(tools)
    ? tools.map((t) => t.function?.name ?? t.name ?? t.slug)
    : Object.keys(tools ?? {});
  report.steps.tools = { ok: true, names };
} catch (e) {
  report.steps.tools = { ok: false, error: errInfo(e) };
}
save();
console.log("tools", JSON.stringify(report.steps.tools));

const paid = [
  ["tavily", "TAVILY_SEARCH", { query: "Meta Quest browser WebXR", max_results: 3 }],
  ["serpapi_news", "SERPAPI_NEWS_SEARCH", { query: "Meta Quest browser WebXR" }],
  ["firecrawl", "FIRECRAWL_SCRAPE", { url: "https://example.com" }],
];

report.steps.paid = {};
for (const [label, slug, args] of paid) {
  const started = Date.now();
  try {
    const r = await session.execute(slug, args);
    const ms = Date.now() - started;
    const entry = {
      ms,
      topLevelKeys: Object.keys(r),
      resultType: r.resultType,
      error: r.error,
      instantCharge: r.instantCharge ?? null,
      logId: r.logId,
      dataShape: shape(r.data),
      dataBytes: JSON.stringify(r.data ?? null).length,
    };
    report.steps.paid[label] = entry;
    appendFileSync(path.join(OUT, "paid-calls.log"), `${new Date().toISOString()} ${slug} ${ms}ms ${JSON.stringify(r.instantCharge ?? null)} ${r.resultType}\n`);
    console.log(label, ms, "ms", r.resultType, JSON.stringify(r.instantCharge ?? null), r.error ?? "");
  } catch (e) {
    const entry = { ms: Date.now() - started, threw: errInfo(e) };
    report.steps.paid[label] = entry;
    appendFileSync(path.join(OUT, "paid-calls.log"), `${new Date().toISOString()} ${slug} REFUSED ${JSON.stringify(entry.threw.message).slice(0, 200)}\n`);
    console.log(label, "threw", JSON.stringify(entry.threw).slice(0, 900));
    // A refusal for balance repeats on every call, so stop rather than try again another way.
    if (/WalletBalance|402|balance/i.test(JSON.stringify(entry.threw))) {
      report.steps.paid.stoppedOnBalance = true;
      break;
    }
  }
  save();
}
save();
