// Second live pass: output shapes for the other public tools, version pinning, enforcement, connection errors,
// Connect Links. The Connect Link is created and then deleted, never completed. Expect about $0.03 in charges.
//   COMPOSIO_SDK_DIR=<folder> sh docs/spikes/composio-2026-10-31/run.sh docs/spikes/composio-2026-10-31/03-behaviour.mjs
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK = path.join(process.env.COMPOSIO_SDK_DIR ?? ".", "node_modules/@composio/core/dist/index.mjs");
const { Composio, SessionPreset } = await import(pathToFileURL(SDK).href);
const BASE = "https://backend.composio.dev";
const KEY = process.env.COMPOSIO_API_KEY;
const OUT = path.join(import.meta.dirname, "results");
mkdirSync(OUT, { recursive: true });
const composio = new Composio({ apiKey: KEY, allowTracking: false });

const report = {};
const save = () => writeFileSync(path.join(OUT, "03-behaviour.json"), JSON.stringify(report, null, 2) + "\n");
const log = (line) => appendFileSync(path.join(OUT, "paid-calls.log"), `${new Date().toISOString()} ${line}\n`);

// Provider URLs can carry account-specific segments, and a Connect Link token is a credential of sorts.
const scrub = (s) =>
  s
    .replace(/serpapi\.com\/searches\/[A-Za-z0-9_-]+/g, "serpapi.com/searches/<redacted>")
    .replace(/api_key=[^&"\s]+/g, "api_key=<redacted>")
    .replace(/(\/link\/)[A-Za-z0-9_-]+/g, "$1<redacted>")
    .replace(/https:\/\/encrypted-tbn0\.gstatic\.com\/[^"\s]+/g, "<thumbnail>");

function errInfo(e) {
  return {
    name: e?.name,
    code: e?.code,
    status: e?.status ?? e?.statusCode ?? e?.cause?.status,
    message: scrub(String(e?.message ?? e)).slice(0, 800),
    cause: e?.cause ? scrub(String(e.cause.message ?? e.cause)).slice(0, 800) : undefined,
    body: e?.cause?.error ?? e?.error,
  };
}

function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length === 0 ? [] : [`(${v.length} items)`, shape(v[0], depth + 1)];
  if (v && typeof v === "object") {
    if (depth > 4) return "{...}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  if (typeof v === "string") return v.length > 60 ? `${scrub(v).slice(0, 60)}... (${v.length} chars)` : scrub(v);
  return v;
}

async function rest(method, pathname, body) {
  const started = Date.now();
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = scrub(text).slice(0, 600);
  }
  return { status: res.status, ms: Date.now() - started, json };
}

const usage = () => rest("POST", "/api/v3.1/project/usage/summary", {});
report.usageBefore = await usage();
save();

const toolkits = ["tavily", "serpapi", "firecrawl"];
const session = await composio.sessions.create("spike_c0_public", {
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  toolkits: { enable: toolkits },
  tools: {
    tavily: { enable: ["TAVILY_SEARCH"] },
    serpapi: { enable: ["SERPAPI_SCHOLAR_SEARCH", "SERPAPI_GOOGLE_MAPS_SEARCH", "SERPAPI_EVENT_SEARCH"] },
    firecrawl: { enable: ["FIRECRAWL_SCRAPE"] },
  },
  tags: { disable: ["destructiveHint"] },
  instant: { toolkits: { enable: toolkits }, returnInstantCharge: true },
  manageConnections: { enable: false },
  sandbox: { enable: false },
});

async function run(label, slug, args, s = session, options) {
  const started = Date.now();
  try {
    const r = await s.execute(slug, args, options);
    const ms = Date.now() - started;
    const raw = JSON.stringify(r.data ?? null);
    report[label] = {
      ms,
      resultType: r.resultType,
      error: r.error ? scrub(String(r.error)).slice(0, 600) : null,
      instantCharge: r.instantCharge ?? null,
      dataBytes: raw.length,
      containsApiKeyParam: /api_key=/.test(raw),
      containsSerpSearchUrl: /serpapi\.com\/search/.test(raw),
      dataShape: shape(r.data),
    };
    log(`${slug} ${label} ${ms}ms ${JSON.stringify(r.instantCharge ?? null)} ${r.resultType}`);
    console.log(label, ms, "ms", r.resultType, JSON.stringify(r.instantCharge ?? null), report[label].error ?? "");
  } catch (e) {
    report[label] = { ms: Date.now() - started, threw: errInfo(e) };
    log(`${slug} ${label} threw ${String(e?.name)}`);
    console.log(label, "threw", JSON.stringify(report[label].threw).slice(0, 700));
  }
  save();
}

// Output shapes for the rest of the public catalog.
await run("scholar", "SERPAPI_SCHOLAR_SEARCH", { query: "WebXR accessibility", num: 3 });
await run("places", "SERPAPI_GOOGLE_MAPS_SEARCH", { q: "coffee shops near Union Square San Francisco" });
await run("events", "SERPAPI_EVENT_SEARCH", { query: "WebXR meetup San Francisco" });

// A bad argument: is a failed call charged, and what comes back?
await run("firecrawl_bad_url", "FIRECRAWL_SCRAPE", { url: "not a url" });

// A slug outside the session's enable list: expect a refusal and no charge.
await run("not_enabled", "TAVILY_EXTRACT", { urls: ["https://example.com"] });

// Version pinning. Session execute has no documented version field, so send one and see.
const sessionExecuteWithVersion = await rest("POST", `/api/v3.1/tool_router/session/${session.sessionId}/execute`, {
  tool_slug: "FIRECRAWL_SCRAPE",
  arguments: { url: "https://example.com" },
  version: "00000000_00",
});
report.sessionExecuteWithBogusVersion = {
  status: sessionExecuteWithVersion.status,
  ms: sessionExecuteWithVersion.ms,
  keys: Object.keys(sessionExecuteWithVersion.json ?? {}),
  error: sessionExecuteWithVersion.json?.error,
  instant_charge: sessionExecuteWithVersion.json?.instant_charge,
};
log(`FIRECRAWL_SCRAPE session-with-version status ${sessionExecuteWithVersion.status} ${JSON.stringify(sessionExecuteWithVersion.json?.instant_charge ?? null)}`);
save();

// Direct execute is the documented way to pin a version.
const direct = await rest("POST", "/api/v3.1/tools/execute/FIRECRAWL_SCRAPE", {
  connected_account_id: "instant_account",
  user_id: "spike_c0_public",
  version: "20261030_00",
  arguments: { url: "https://example.com" },
});
report.directExecutePinned = {
  status: direct.status,
  ms: direct.ms,
  keys: Object.keys(direct.json ?? {}),
  successful: direct.json?.successful,
  error: direct.json?.error,
  instant_charge: direct.json?.instant_charge,
  log_id: direct.json?.log_id,
  dataKeys: Object.keys(direct.json?.data ?? {}),
};
log(`FIRECRAWL_SCRAPE direct-pinned status ${direct.status} ${JSON.stringify(direct.json?.instant_charge ?? null)}`);
save();
console.log("direct pinned", JSON.stringify(report.directExecutePinned).slice(0, 700));

// Reading a cached session back and updating it, as tool_sessions will.
try {
  const again = await composio.sessions.use(session.sessionId);
  const before = again.configVersion;
  const updated = await again.update({
    tools: { tavily: { enable: ["TAVILY_SEARCH"] }, serpapi: { enable: ["SERPAPI_NEWS_SEARCH"] }, firecrawl: { enable: ["FIRECRAWL_SCRAPE"] } },
  });
  report.sessionReuse = { ok: true, before, after: updated?.configVersion ?? again.configVersion, updatedKeys: Object.keys(updated ?? {}).slice(0, 12) };
} catch (e) {
  report.sessionReuse = { ok: false, error: errInfo(e) };
}
save();
console.log("reuse", JSON.stringify(report.sessionReuse).slice(0, 500));

// Personal toolkit, throwaway user. The session asks for a destructive tool too, to see how the tag filter acts.
const owner = await composio.sessions.create("spike_c0_throwaway", {
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  toolkits: { enable: ["gmail", "tavily"] },
  tools: { gmail: { enable: ["GMAIL_FETCH_EMAILS", "GMAIL_DELETE_DRAFT"] }, tavily: { enable: ["TAVILY_SEARCH"] } },
  tags: { disable: ["destructiveHint"] },
  instant: { toolkits: { enable: ["tavily"] }, returnInstantCharge: true },
  manageConnections: { enable: false },
  sandbox: { enable: false },
});
const ownerTools = await owner.tools();
report.ownerSession = {
  tools: Array.isArray(ownerTools) ? ownerTools.map((t) => t.function?.name ?? t.name ?? t.slug) : Object.keys(ownerTools ?? {}),
  warnings: owner.warnings,
};
save();
console.log("owner session", JSON.stringify(report.ownerSession).slice(0, 500));

await run("gmail_not_connected", "GMAIL_FETCH_EMAILS", { max_results: 1 }, owner);
await run("destructive_blocked", "GMAIL_DELETE_DRAFT", { draft_id: "nothing" }, owner);

try {
  const statuses = await owner.toolkits({ toolkits: ["gmail"] });
  report.toolkitsStatus = shape(statuses);
} catch (e) {
  report.toolkitsStatus = { error: errInfo(e) };
}
save();

// Connect Link for a domain nobody has allowlisted. Created, inspected, deleted, never completed.
const callback = "https://callback-spike.example.com/api/gateway/tools/callback?state=spike-state-value";
try {
  const started = Date.now();
  const req = await owner.authorize("gmail", { callbackUrl: callback });
  const url = req.redirectUrl ? new URL(req.redirectUrl) : null;
  report.connectLink = {
    ok: true,
    ms: Date.now() - started,
    json: { ...req.toJSON(), redirectUrl: req.redirectUrl ? scrub(req.redirectUrl) : null },
    host: url?.host,
    pathPrefix: url?.pathname.split("/").slice(0, 2).join("/"),
    queryKeys: url ? [...url.searchParams.keys()] : [],
    idPrefix: req.id?.slice(0, 3),
  };
  if (url) {
    const page = await fetch(url, { redirect: "manual" });
    report.connectLink.pageStatus = page.status;
    report.connectLink.pageLocationHost = page.headers.get("location") ? new URL(page.headers.get("location"), url).host : null;
  }
  const listed = await composio.connectedAccounts.list({
    userIds: ["spike_c0_throwaway"],
    toolkitSlugs: ["gmail"],
    statuses: ["ACTIVE"],
  });
  report.connectLink.activeAccounts = listed.items?.length;
  const pending = await composio.connectedAccounts.list({ connectedAccountIds: [req.id] });
  report.connectLink.pendingAccount = pending.items?.map((a) => ({
    status: a.status,
    userId: a.userId,
    toolkit: a.toolkit?.slug,
    keys: Object.keys(a),
    authConfig: { isComposioManaged: a.authConfig?.isComposioManaged, isDisabled: a.authConfig?.isDisabled },
  }));
  const deleted = await composio.connectedAccounts.delete(req.id);
  report.connectLink.deleted = deleted;
} catch (e) {
  report.connectLink = { ok: false, error: errInfo(e) };
}
save();
console.log("connect", JSON.stringify(report.connectLink).slice(0, 1200));

report.usageAfter = await usage();
save();
console.log("usage before", JSON.stringify(report.usageBefore.json).slice(0, 500));
console.log("usage after", JSON.stringify(report.usageAfter.json).slice(0, 500));
