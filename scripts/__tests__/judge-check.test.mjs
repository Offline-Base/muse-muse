// The judge-path checker against a fake site. No network: every request goes to a fake fetch.
// Run: npx tsx --test scripts/__tests__/judge-check.test.mjs (not in CI, the real script needs the network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeCheck, renderReport, docLinks, zeroLeaksWithoutCount, liveAndNotPublished, publishedLink } from "../judge-check.mjs";

const SITE = "https://muse-muse.vercel.app";
const nav = `<nav><a href="/">Home</a><a href="/gallery">Gallery</a><a href="/private">Muse Privacy</a><a href="/api/health">api</a><a href="/icon.svg">i</a></nav>`;
const page = (main) => `<!doctype html><html><body>${nav}<main>${main}</main><script>self.__next_f.push(["Not published Live 0 leaks"])</script></body></html>`;
const livePill = `<span class="pill pill-live"><span class="pill-dot" aria-hidden="true"></span>Live</span>`;

function productPage(name, liveUrl) {
  return page(`<header><h1>${name}</h1>${livePill}</header>` +
    (liveUrl
      ? `<section class="frame-card"><div class="frame-head"><a class="btn" href="${liveUrl}" target="_blank">Open</a></div><iframe src="${liveUrl}" title="${name}, the live product"></iframe></section>`
      : `<div class="empty"><h2>Not published</h2><p>No live link.</p></div>`) +
    `<a href="/p/x/get/cli">CLI</a>`);
}

function fakeSite(overrides = {}) {
  const pages = {
    "/": page(`<h1>What should Muse make?</h1><a href="/how-it-works">How</a>`),
    "/gallery": page(`<article class="gx-card"><h3><a href="/p/alpha">Alpha</a></h3></article><article class="gx-card"><h3><a href="/p/beta">Beta</a></h3></article>`),
    "/private": page(`<p>What the tests show</p><dl><dd>0</dd><dt>0 leaks of names or identifiers across 300 invented items on the device</dt></dl>`),
    "/how-it-works": page(`<p>How it works</p>`),
    "/p/alpha": productPage("Alpha", "https://musemuse-alpha.vercel.app"),
    "/p/beta": productPage("Beta", "https://musemuse-beta.vercel.app"),
    "/fine-tuning": page(`<p>Results</p>`),
    ...overrides.pages,
  };
  const external = { "https://musemuse-alpha.vercel.app/": 200, "https://musemuse-beta.vercel.app/": 200, ...overrides.external };
  const redirects = { ...overrides.redirects };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    const u = new URL(url);
    if (u.origin === SITE) {
      if (redirects[u.pathname]) return new Response(null, { status: 307, headers: { location: redirects[u.pathname] } });
      const body = pages[u.pathname];
      if (body === undefined) return new Response("<h1>404</h1>", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const status = external[u.href] ?? 404;
    return new Response("ok", { status, headers: { "content-type": "text/html" } });
  };
  return { fetch, calls };
}

const docs = [
  { name: "README.md", text: "**Live:** https://muse-muse.vercel.app. Results at [/fine-tuning](https://muse-muse.vercel.app/fine-tuning): each job." },
  { name: "docs/SUBMISSION.md", text: "- **Live site:** https://muse-muse.vercel.app (open to anyone)" },
];

const run = (site, extra = {}) => judgeCheck({ fetch: site.fetch, docs, sleep: async () => {}, ...extra });

test("a clean site has no problems, and only GETs pages, published links and doc links", async () => {
  const site = fakeSite();
  const r = await run(site);
  assert.deepEqual(r.problems, []);
  assert.ok(site.calls.every((c) => c.method === "GET"));
  assert.ok(!site.calls.some((c) => new URL(c.url).pathname.startsWith("/api/")), "never an /api/ route");
  assert.ok(!site.calls.some((c) => /\/get\/|icon\.svg/.test(c.url)), "no download routes or files");
  const urls = site.calls.map((c) => c.url);
  assert.ok(urls.includes("https://musemuse-alpha.vercel.app"));
  assert.ok(urls.includes(`${SITE}/fine-tuning`), "the README link is opened");
  assert.equal(r.galleryRows.length, 2);
  assert.ok(r.galleryRows.every((g) => g.linkStatus === "200"));
  const md = renderReport(r, { when: new Date("2026-11-02T12:00:00Z") });
  assert.match(md, /No problems found/);
  assert.match(md, /api\/health/, "the skipped /api/ link is reported, not opened");
});

test("flags Live and Not published together, and a published link that fails", async () => {
  const site = fakeSite({ pages: { "/p/beta": productPage("Beta", null) }, external: { "https://musemuse-alpha.vercel.app/": 404 } });
  const r = await run(site);
  const kinds = r.problems.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["Live and Not published together", "published link fails"]);
  assert.match(r.problems.find((p) => p.kind === "published link fails").where, /\/p\/alpha$/);
  assert.equal(r.galleryRows.find((g) => g.key.endsWith("/p/beta")).linkStatus, "no published link on the page");
});

test("flags a link to a 404, a page that isn't 200, and a redirect to an error", async () => {
  const site = fakeSite({
    pages: { "/how-it-works": page(`<a href="/gone">old</a><a href="/moved">moved</a>`) },
    redirects: { "/moved": "/404" },
  });
  const r = await run(site);
  const byKind = (k) => r.problems.filter((p) => p.kind === k);
  assert.equal(byKind("link to a 404").length, 2, "/gone, and /moved which ends at /404");
  assert.ok(byKind("link to a 404").some((p) => p.where.endsWith("/how-it-works") && /\/gone/.test(p.what)));
  assert.ok(byKind("page not 200").some((p) => p.where.endsWith("/gone")));
  assert.ok(byKind("page not 200").some((p) => p.where.endsWith("/moved") && /after redirect to .*\/404/.test(p.what)));
});

test('flags "0 leaks" shown without a count of items', async () => {
  const site = fakeSite({ pages: { "/private": page(`<p>The final check found 0 leaks.</p>`) } });
  const r = await run(site);
  assert.deepEqual(r.problems.map((p) => p.kind), ['"0 leaks" without a count']);
  assert.deepEqual(zeroLeaksWithoutCount("with 0 leaks on 200 items"), []);
  assert.deepEqual(zeroLeaksWithoutCount("on the 100 holdout items it agreed 82% of the time, with 0 leaks"), []);
  assert.equal(zeroLeaksWithoutCount("0 leaks, always").length, 1);
});

test("stops at the request cap and says what it didn't open", async () => {
  const site = fakeSite();
  const r = await run(site, { maxRequests: 3 });
  assert.equal(site.calls.length, 3);
  assert.equal(r.requests, 3);
  assert.ok(r.notOpened.length > 0);
  assert.match(renderReport(r), /not opened because of the request cap/);
});

test("waits between requests", async () => {
  const site = fakeSite();
  const waits = [];
  await run(site, { sleep: async (ms) => void waits.push(ms) });
  assert.equal(waits.length, site.calls.length - 1);
  assert.ok(waits.every((ms) => ms === 300));
});

test("helpers: doc links, the live frame, cards", () => {
  assert.deepEqual(docLinks(docs[0].text), [SITE, `${SITE}/fine-tuning`]);
  assert.equal(publishedLink(productPage("A", "https://x.vercel.app")), "https://x.vercel.app");
  assert.equal(publishedLink(productPage("A", null)), null);
  const cards = page(`<article><h3>One</h3>${livePill}<h2>Not published</h2></article><article><h3>Two</h3>${livePill}</article>`);
  assert.deepEqual(liveAndNotPublished(cards, false), ["One"]);
  assert.deepEqual(liveAndNotPublished(page(`<p>Live turn by turn view</p><h2>Not published</h2>`), true), [], "the word inside a sentence isn't a pill");
});
