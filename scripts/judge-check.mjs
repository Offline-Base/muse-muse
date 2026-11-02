#!/usr/bin/env node
// Walks the live site the way a judge would and prints a markdown report. Plain HTTP GET only: no browser, no
// JavaScript, never a POST, never an /api/ route, one request at a time about 300 ms apart, at most 200 requests.
//
//   node scripts/judge-check.mjs            print the report, exit 1 when it finds a problem
//   node scripts/judge-check.mjs --site https://muse-muse.vercel.app
//
// It starts at /, follows same-site page links found in the server HTML, opens the gallery and every product page,
// sends one GET to each product's published link, and opens every muse-muse.vercel.app link in README.md and
// docs/SUBMISSION.md. It flags: a page that isn't a 200 (or redirects to an error), a link on a 200 page that points
// at a 404, a card or product page showing "Live" and "Not published" together, a gallery product whose published
// link fails, and "0 leaks" shown without a count of items. It spends nothing and writes nothing.
// The test (scripts/__tests__/judge-check.test.mjs) uses a fake fetch. It isn't in CI because the real run needs the
// network.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SITE = "https://muse-muse.vercel.app";
export const DOC_FILES = ["README.md", "docs/SUBMISSION.md"];
const USER_AGENT = "muse-muse-judge-check/1 (plain GET, scripts/judge-check.mjs)";
const MAX_HOPS = 5;

// Paths that are route handlers or files, not pages. A judge can click them, but they aren't pages to walk, and some
// (the /get/ downloads, /q/, /orders/x/open) do work on the server when opened.
const SKIP_PATH = [
  /^\/api(\/|$)/,
  /^\/_next\//,
  /^\/_vercel\//,
  /^\/p\/[^/]+\/get(\/|$)/,
  /^\/p\/[^/]+\/skill\.md$/,
  /^\/p\/[^/]+\/code\/source\.zip$/,
  /^\/orders\/[^/]+\/open$/,
  /^\/q\//,
  /^\/docs\/md\//,
  /\.[a-z0-9]{1,5}$/i,
];

const ERROR_PATH = /(^|\/)(404|500|not-found|_not-found|error|_error)(\/|$)/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

/** The HTML a person sees: scripts, styles and templates removed (the RSC payload repeats every string). */
export function visibleHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<template\b[\s\S]*?<\/template>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

export function htmlText(html) {
  return decodeEntities(visibleHtml(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every <a href> in the visible HTML, resolved against the page. */
export function extractLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of visibleHtml(html).matchAll(re)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(u.href);
    } catch {
      // A malformed href is left for a person to look at; it can't be fetched.
    }
  }
  return out;
}

/** The product's published link: the live frame's src, or the frame's Open link. */
export function publishedLink(html) {
  const vis = visibleHtml(html);
  const frame = vis.match(/<iframe\b[^>]*\stitle="[^"]*the live product"[^>]*>/i) ?? vis.match(/<section class="frame-card"[\s\S]*?<iframe\b[^>]*>/i);
  const src = frame?.[0].match(/\ssrc="([^"]+)"/i)?.[1];
  if (src) return decodeEntities(src);
  const card = vis.match(/<section class="frame-card"[\s\S]*?<\/section>/i)?.[0];
  const open = card?.match(/<a\b[^>]*\shref="(https?:[^"]+)"/i)?.[1];
  return open ? decodeEntities(open) : null;
}

const LIVE = />\s*Live\s*</;
const NOT_PUBLISHED = />\s*Not published\s*</i;

/** Each scope (the whole product page, or each card) that shows "Live" and "Not published" together. */
export function liveAndNotPublished(html, isProductPage) {
  const vis = visibleHtml(html);
  const main = vis.match(/<main\b[\s\S]*<\/main>/i)?.[0] ?? vis;
  const scopes = isProductPage ? [main] : [...main.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]);
  const hits = [];
  for (const scope of scopes) {
    if (LIVE.test(scope) && NOT_PUBLISHED.test(scope)) {
      const name = htmlText(scope.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? "").slice(0, 80);
      hits.push(name || "(untitled)");
    }
  }
  return hits;
}

/** Each "0 leaks" in the page text with no count of items within a sentence or so of it. */
export function zeroLeaksWithoutCount(text) {
  const out = [];
  for (const m of text.matchAll(/\b0 leaks?\b/gi)) {
    const around = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 200);
    if (!/\b\d[\d,]*\s+(?:[A-Za-z-]+\s+){0,3}items?\b/i.test(around)) out.push(around.trim());
  }
  return out;
}

/** muse-muse.vercel.app links in a markdown file. */
export function docLinks(markdown, site = SITE) {
  const host = new URL(site).host.replace(/\./g, "\\.");
  const re = new RegExp(`https?://${host}[^\\s)\\]>"'\`<]*`, "g");
  return [...new Set((markdown.match(re) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, "")))];
}

function pageKey(href) {
  const u = new URL(href);
  let p = u.pathname.replace(/\/+$/, "") || "/";
  return u.origin + p;
}

function skipReason(u, site) {
  if (u.origin !== new URL(site).origin) return "other site";
  for (const re of SKIP_PATH) if (re.test(u.pathname)) return /^\/api/.test(u.pathname) ? "api route" : "file or route handler";
  return null;
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the walk. Everything that touches the network goes through `fetch`, so the test can pass a fake.
 * @param {{ fetch?: typeof fetch, site?: string, docs?: {name: string, text: string}[], delayMs?: number,
 *   maxRequests?: number, sleep?: (ms: number) => Promise<void>, log?: (s: string) => void, timeoutMs?: number }} opts
 */
export async function judgeCheck(opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const site = (opts.site ?? SITE).replace(/\/+$/, "");
  const origin = new URL(site).origin;
  const delayMs = opts.delayMs ?? 300;
  const maxRequests = opts.maxRequests ?? 200;
  const sleep = opts.sleep ?? sleepDefault;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 25000;

  let requests = 0;
  const problems = [];
  const notes = [];
  const problem = (kind, where, what) => problems.push({ kind, where, what });

  /** One GET, with redirects followed by hand so each hop is counted and seen. */
  async function get(href, { wantBody }) {
    const hops = [];
    let url = href;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = new URL(url);
      if (u.origin === origin && /^\/api(\/|$)/.test(u.pathname)) return { url: href, finalUrl: url, status: 0, hops, error: "redirected to an /api/ route, not followed" };
      if (requests >= maxRequests) return { url: href, finalUrl: url, status: 0, hops, error: "request cap reached", capped: true };
      if (requests > 0) await sleep(delayMs);
      requests++;
      let res;
      try {
        res = await fetchFn(url, { method: "GET", redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        return { url: href, finalUrl: url, status: 0, hops, error: String(err?.message ?? err) };
      }
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel?.().catch(() => {});
        const next = new URL(loc, url).href;
        hops.push({ status: res.status, to: next });
        url = next;
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      let body = null;
      if (wantBody && res.status === 200 && /text\/html/i.test(type)) body = await res.text();
      else await res.body?.cancel?.().catch(() => {});
      return { url: href, finalUrl: url, status: res.status, hops, type, body };
    }
    return { url: href, finalUrl: url, status: 0, hops, error: `more than ${MAX_HOPS} redirects` };
  }

  // Tiers: 0 the start, the gallery and the doc links; 1 pages linked from /; 2 product pages; then the published
  // links (their own queue); 3 every other same-site page, in the order found.
  const tiers = [[], [], [], []];
  const queued = new Map(); // key -> { href, tier, from: Set }
  const results = new Map(); // key -> result
  const linksFrom = []; // { from, to(key), href }
  const skipped = { api: new Set(), handler: new Set(), external: new Set() };
  const galleryProducts = new Map(); // key -> { href, name }
  const products = new Map(); // product page key -> { link, linkResult }

  function enqueue(href, tier, from) {
    const key = pageKey(href);
    const have = queued.get(key);
    if (have) {
      if (from) have.from.add(from);
      if (tier < have.tier && !results.has(key)) {
        tiers[have.tier] = tiers[have.tier].filter((k) => k !== key);
        have.tier = tier;
        tiers[tier].push(key);
      }
      return;
    }
    queued.set(key, { href: key, tier, from: new Set(from ? [from] : []) });
    tiers[tier].push(key);
  }

  const isProduct = (key) => /^\/p\/[^/]+$/.test(new URL(key).pathname);

  enqueue(site + "/", 0);
  enqueue(site + "/gallery", 0);
  const docUrls = [];
  for (const doc of opts.docs ?? []) {
    for (const href of docLinks(doc.text, site)) {
      docUrls.push({ doc: doc.name, href });
      const u = new URL(href);
      const why = skipReason(u, site);
      if (why) notes.push(`${doc.name} links to ${href}, skipped (${why}).`);
      else enqueue(href, 0, doc.name);
    }
  }

  const publishedQueue = [];
  for (;;) {
    let key = null;
    let tier = -1;
    for (let t = 0; t < tiers.length; t++) {
      if (t === 3 && publishedQueue.length) break; // published links go before the rest of the site
      if (tiers[t].length) {
        key = tiers[t].shift();
        tier = t;
        break;
      }
    }
    if (!key && publishedQueue.length) {
      // Published links, after every product page has been opened.
      const item = publishedQueue.shift();
      log(`GET ${item.link}`);
      const r = await get(item.link, { wantBody: false });
      products.get(item.page).linkResult = r;
      if (r.capped) break;
      continue;
    }
    if (!key) break;
    log(`GET ${key}`);
    const r = await get(key, { wantBody: true });
    if (r.capped) {
      tiers[tier].unshift(key);
      break;
    }
    results.set(key, r);
    const finalPath = new URL(r.finalUrl).pathname;
    if (r.status !== 200) {
      problem("page not 200", key, r.error ? `request failed: ${r.error}` : `${r.status}${r.hops.length ? ` after redirect to ${r.finalUrl}` : ""}`);
      continue;
    }
    if (r.hops.length && ERROR_PATH.test(finalPath)) problem("redirect to an error", key, `redirects to ${r.finalUrl}`);
    else if (r.hops.length) notes.push(`${key} redirects to ${r.finalUrl} (${r.hops.map((h) => h.status).join(", ")}).`);
    if (!r.body) continue;

    const text = htmlText(r.body);
    if (new URL(r.finalUrl).origin !== origin) continue; // a redirect off the site: status checked, not walked

    for (const name of liveAndNotPublished(r.body, isProduct(key))) problem("Live and Not published together", key, `"${name}" shows a Live pill and "Not published"`);
    for (const ctx of zeroLeaksWithoutCount(text)) problem('"0 leaks" without a count', key, `"${ctx.slice(0, 160)}"`);

    const isGallery = new URL(key).pathname === "/gallery";
    for (const href of extractLinks(r.body, r.finalUrl)) {
      const u = new URL(href);
      const why = skipReason(u, site);
      if (why === "other site") {
        skipped.external.add(href);
        continue;
      }
      if (why === "api route") {
        skipped.api.add(u.pathname);
        continue;
      }
      if (why) {
        skipped.handler.add(u.pathname);
        continue;
      }
      const to = pageKey(href);
      linksFrom.push({ from: key, to, href });
      const targetIsProduct = isProduct(to);
      if (isGallery && targetIsProduct) galleryProducts.set(to, { href: to });
      enqueue(href, targetIsProduct ? 2 : key === pageKey(site + "/") ? 1 : 3, key);
    }

    if (isProduct(key)) {
      const link = publishedLink(r.body);
      const name = htmlText(r.body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || new URL(key).pathname;
      products.set(key, { name, link, linkResult: null });
      if (link) publishedQueue.push({ page: key, link });
    }
  }

  // Links on 200 pages that point at a 404.
  const broken = new Map();
  for (const l of linksFrom) {
    const t = results.get(l.to);
    const from = results.get(l.from);
    if (!t || !from || from.status !== 200) continue;
    if (t.status === 404 || t.status === 410) {
      const k = `${l.from} -> ${l.to}`;
      if (!broken.has(k)) broken.set(k, { from: l.from, to: l.href, status: t.status });
    }
  }
  for (const b of broken.values()) problem("link to a 404", b.from, `links to ${b.to} (${b.status})`);

  // Gallery products and their published links.
  const galleryRows = [];
  for (const [key] of galleryProducts) {
    const page = results.get(key);
    const p = products.get(key);
    const row = { key, name: p?.name ?? new URL(key).pathname, pageStatus: page ? (page.status || page.error) : "not opened", link: p?.link ?? null, linkStatus: null };
    if (p?.link) {
      const lr = p.linkResult;
      if (!lr) row.linkStatus = "not checked (request cap)";
      else if (lr.capped) row.linkStatus = "not checked (request cap)";
      else {
        row.linkStatus = lr.status ? String(lr.status) + (lr.hops.length ? ` via ${lr.hops.length} redirect${lr.hops.length > 1 ? "s" : ""}` : "") : `failed: ${lr.error}`;
        if (lr.status !== 200) problem("published link fails", key, `${p.link} returned ${lr.status || lr.error}${lr.hops.length ? ` after redirect to ${lr.finalUrl}` : ""}`);
        else if (lr.hops.length && ERROR_PATH.test(new URL(lr.finalUrl).pathname)) problem("published link fails", key, `${p.link} redirects to ${lr.finalUrl}`);
      }
    } else if (page?.status === 200) row.linkStatus = "no published link on the page";
    galleryRows.push(row);
  }

  const notOpened = [...queued.values()].filter((q) => !results.has(q.href));
  const docRows = docUrls.map((d) => {
    const r = results.get(pageKey(d.href));
    return { doc: d.doc, href: d.href, status: r ? r.status || r.error : skipReason(new URL(d.href), site) ? "skipped" : "not opened" };
  });

  return {
    site,
    requests,
    maxRequests,
    delayMs,
    problems,
    notes,
    pages: [...results.entries()].map(([key, r]) => ({ key, status: r.status, error: r.error, finalUrl: r.finalUrl, hops: r.hops.length })),
    galleryRows,
    docRows,
    notOpened: notOpened.map((q) => q.href),
    skipped: { api: [...skipped.api], handler: [...skipped.handler], external: skipped.external.size },
  };
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport(r, { when = new Date() } = {}) {
  const show = (k) => {
    const u = new URL(k);
    return u.origin === new URL(r.site).origin ? u.pathname : k;
  };
  const lines = [];
  lines.push(`# Judge-path check: ${new URL(r.site).host}`);
  lines.push("");
  lines.push(`Run ${when.toISOString().replace(/\.\d+Z$/, "Z")} by \`node scripts/judge-check.mjs\`. Plain HTTP GET only, no browser and no JavaScript, never an /api/ route. ${r.requests} requests (cap ${r.maxRequests}), one at a time, about ${r.delayMs} ms apart.`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(r.problems.length ? `**${r.problems.length} problem${r.problems.length === 1 ? "" : "s"} found.**` : "**No problems found.**");
  lines.push("");
  lines.push(`- Pages opened: ${r.pages.length}, of which ${r.pages.filter((p) => p.status === 200).length} returned 200.`);
  const withLink = r.galleryRows.filter((g) => g.link);
  const linkOk = withLink.filter((g) => g.linkStatus?.startsWith("200"));
  lines.push(`- Gallery products: ${r.galleryRows.length}. ${withLink.length} have a published link on their page, ${linkOk.length} of those returned 200. ${r.galleryRows.length - withLink.length} have no published link.`);
  lines.push(`- Links from README.md and docs/SUBMISSION.md: ${r.docRows.length}.`);
  lines.push("");
  if (r.problems.length) {
    lines.push("## Problems");
    lines.push("");
    lines.push("| # | Kind | Where | What |");
    lines.push("|---|---|---|---|");
    r.problems.forEach((p, i) => lines.push(`| ${i + 1} | ${cell(p.kind)} | ${cell(show(p.where))} | ${cell(p.what)} |`));
    lines.push("");
  }
  lines.push("## Gallery products");
  lines.push("");
  lines.push("| Product | Page | Published link | Link status |");
  lines.push("|---|---|---|---|");
  for (const g of r.galleryRows) lines.push(`| ${cell(g.name)} | ${cell(show(g.key))} (${cell(g.pageStatus)}) | ${cell(g.link ?? "none")} | ${cell(g.linkStatus ?? "")} |`);
  lines.push("");
  lines.push("## Links in the docs");
  lines.push("");
  lines.push("| File | Link | Status |");
  lines.push("|---|---|---|");
  for (const d of r.docRows) lines.push(`| ${cell(d.doc)} | ${cell(d.href)} | ${cell(d.status)} |`);
  lines.push("");
  lines.push("## Pages opened");
  lines.push("");
  lines.push("| Page | Status |");
  lines.push("|---|---|");
  for (const p of r.pages.filter((p) => !/^\/p\/[^/]+$/.test(new URL(p.key).pathname))) lines.push(`| ${cell(show(p.key))} | ${cell(p.status || p.error)}${p.hops ? ` (redirected to ${cell(show(p.finalUrl))})` : ""} |`);
  lines.push("");
  lines.push("Product pages are listed under Gallery products.");
  lines.push("");
  lines.push("## Not checked");
  lines.push("");
  if (r.notOpened.length) lines.push(`- ${r.notOpened.length} same-site pages were found but not opened because of the request cap, for example: ${r.notOpened.slice(0, 8).map((k) => show(k)).join(", ")}.`);
  if (r.skipped.api.length) lines.push(`- Links to /api/ routes, never opened: ${r.skipped.api.slice(0, 8).join(", ")}${r.skipped.api.length > 8 ? ", and more" : ""}.`);
  if (r.skipped.handler.length) lines.push(`- ${r.skipped.handler.length} links to files or download routes (such as /p/x/get/...) were not opened.`);
  lines.push(`- ${r.skipped.external} links to other sites (other than published product links) were not opened.`);
  lines.push("- Anything that needs JavaScript, a click, a form, or sign-in. The check reads the server HTML only, so it doesn't see what a page draws after it loads, and it doesn't run a build or any product.");
  lines.push("- A 200 from a published link means the page loaded. It doesn't mean the product works.");
  if (r.notes.length) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(argv) {
  const siteArg = argv.indexOf("--site");
  const site = siteArg >= 0 ? argv[siteArg + 1] : SITE;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const docs = [];
  for (const name of DOC_FILES) {
    try {
      docs.push({ name, text: await readFile(path.join(root, name), "utf8") });
    } catch {
      process.stderr.write(`(couldn't read ${name}, its links are skipped)\n`);
    }
  }
  const result = await judgeCheck({ site, docs, log: (s) => process.stderr.write(s + "\n") });
  process.stdout.write(renderReport(result));
  return result.problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`judge-check crashed: ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
