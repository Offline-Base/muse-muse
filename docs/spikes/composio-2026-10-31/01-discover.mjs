// Free metadata pass: no tool executions. Lists tools per toolkit, with pricing and Instant flags.
//   sh docs/spikes/composio-2026-10-31/run.sh docs/spikes/composio-2026-10-31/01-discover.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = "https://backend.composio.dev";
const KEY = process.env.COMPOSIO_API_KEY;
const OUT = path.join(import.meta.dirname, "results");
mkdirSync(OUT, { recursive: true });

async function api(pathname) {
  const started = Date.now();
  const res = await fetch(BASE + pathname, { headers: { "x-api-key": KEY } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  return { status: res.status, ms: Date.now() - started, body };
}

const toolkits = ["tavily", "serpapi", "firecrawl", "exa", "composio_search", "gmail", "googlecalendar"];
const summary = {};
for (const tk of toolkits) {
  const all = [];
  let cursor;
  let status;
  do {
    const q = new URLSearchParams({ toolkit_slug: tk, include_pricing: "true", limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const r = await api(`/api/v3.1/tools?${q}`);
    status = r.status;
    if (r.status !== 200) {
      summary[tk] = { status: r.status, error: r.body };
      break;
    }
    all.push(...r.body.items);
    cursor = r.body.next_cursor;
  } while (cursor);
  if (status !== 200) continue;
  summary[tk] = all.map((t) => ({
    slug: t.slug,
    version: t.version,
    tags: t.tags,
    instant: t.instant,
  }));
}
// One tool per line: hundreds of tools, and this keeps the diff and the file readable.
const lines = Object.entries(summary).flatMap(([tk, v]) =>
  Array.isArray(v)
    ? v.map((t) => JSON.stringify({ toolkit: tk, ...t }))
    : [JSON.stringify({ toolkit: tk, ...v })],
);
writeFileSync(path.join(OUT, "01-discover.jsonl"), lines.join("\n") + "\n");
for (const [k, v] of Object.entries(summary)) {
  if (!Array.isArray(v)) {
    console.log(k, JSON.stringify(v).slice(0, 400));
    continue;
  }
  console.log(`\n== ${k}: ${v.length} tools, instant: ${v.filter((t) => t.instant?.supported).length}`);
  for (const t of v) {
    if (t.instant?.supported || /SEARCH|SCRAPE|SEND|DRAFT|FETCH|LIST|CREATE|EVENTS|NEWS|SCHOLAR|MAPS|PLACES/.test(t.slug)) {
      console.log(
        " ",
        t.slug,
        t.version,
        JSON.stringify(t.tags),
        t.instant?.supported ? "INSTANT" : "-",
        JSON.stringify(t.instant?.price ?? null),
      );
    }
  }
}
