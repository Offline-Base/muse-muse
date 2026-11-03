// Unit tests for lib/client/media-store.ts (media in IndexedDB, never localStorage), lib/client/raster.ts (the model
// gets PNG, never SVG) and components/Tabs.tsx (tabs that fit a phone). The pure parts run in plain node; the store and
// the tabs also run in Chromium when template/node_modules is installed. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/media-tabs.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULES = path.join(TEMPLATE, "node_modules");
const hasPlaywright = existsSync(path.join(MODULES, "@playwright/test/package.json"));
if (!hasPlaywright) {
  const stub = `data:text/javascript,${encodeURIComponent("export const test = {}; export const expect = () => ({});")}`;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === "@playwright/test" ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : n(s, c); }`)}`);
}
const S = await import("../../lib/client/media-store.ts");
const { imageProblem } = await import("../../lib/client/raster.ts");
const { Tabs, tabKeyTarget } = await import("../../components/Tabs.tsx");
const J = await import("../../tests/judge-shot.ts");
const h = React.createElement;

const entry = (key, bytes, savedAt) => ({ key, bytes, savedAt });

describe("media store: what to remove when it is full", () => {
  test("nothing goes while the new value fits", () => {
    assert.deepEqual(S.planEviction([entry("a", 10, 1), entry("b", 10, 2)], { key: "c", bytes: 10 }, { maxBytes: 30 }), []);
  });

  test("the oldest go first, only as many as make room", () => {
    const entries = [entry("new", 40, 30), entry("old", 40, 10), entry("mid", 40, 20)];
    assert.deepEqual(S.planEviction(entries, { key: "next", bytes: 40 }, { maxBytes: 100 }), ["old", "mid"]);
    assert.deepEqual(S.planEviction(entries, { key: "next", bytes: 20 }, { maxBytes: 100 }), ["old"]);
  });

  test("the kept key (the version on screen) never goes, and the key being replaced doesn't count twice", () => {
    const entries = [entry("current", 50, 1), entry("v2", 50, 2), entry("v3", 50, 3)];
    assert.deepEqual(S.planEviction(entries, { key: "v4", bytes: 50 }, { maxBytes: 150 }, ["current"]), ["v2"]);
    assert.deepEqual(S.planEviction(entries, { key: "v3", bytes: 60 }, { maxBytes: 160 }), []);
  });

  test("a cap on items removes the oldest too", () => {
    const entries = [entry("a", 1, 1), entry("b", 1, 2), entry("c", 1, 3)];
    assert.deepEqual(S.planEviction(entries, { key: "d", bytes: 1 }, { maxItems: 3 }), ["a"]);
  });

  test("a value bigger than the store, or one that can't fit past the kept keys, is refused, not forced in", () => {
    assert.equal(S.planEviction([], { key: "a", bytes: 200 }, { maxBytes: 100 }), null);
    assert.equal(S.planEviction([entry("keep", 90, 1)], { key: "a", bytes: 20 }, { maxBytes: 100 }, ["keep"]), null);
  });

  test("when the browser itself is full, the oldest removable one goes next", () => {
    assert.equal(S.oldestRemovable([entry("b", 1, 5), entry("a", 1, 9), entry("c", 1, 1)], ["c"]), "b");
    assert.equal(S.oldestRemovable([entry("c", 1, 1)], ["c"]), null);
  });

  test("quota errors are known under every browser's name", () => {
    assert.ok(S.isQuotaError(new DOMException("full", "QuotaExceededError")));
    assert.ok(S.isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" }));
    assert.ok(S.isQuotaError({ code: 22 }));
    assert.ok(!S.isQuotaError(new Error("other")));
    assert.ok(!S.isQuotaError(null));
  });

  test("sizes: a Blob is its bytes, text two bytes a character, objects their JSON", () => {
    assert.equal(S.sizeOf(new Blob(["abcd"])), 4);
    assert.equal(S.sizeOf("abc"), 6);
    assert.equal(S.sizeOf({ a: 1 }), 14);
    assert.equal(S.sizeOf(new Uint8Array(8)), 8);
  });
});

describe("small state in localStorage", () => {
  test("refuses the audit's room versions: data URLs, at any depth, and files", () => {
    const version = { id: "v1", image: "data:image/webp;base64,UklGR..." };
    assert.match(S.smallStateProblem({ versions: [version] }), /data URL/);
    assert.match(S.smallStateProblem("data:audio/wav;base64,AAA"), /data URL/);
    assert.match(S.smallStateProblem({ clip: new Blob(["x"]) }), /file/);
    assert.match(S.smallStateProblem("x".repeat(S.SMALL_LIMIT + 10)), /over/);
  });

  test("lets settings, ids and checked lists through, including text that only mentions data:", () => {
    assert.equal(S.smallStateProblem({ checked: ["t1", "t2"], speaker: { A: "Priya" }, note: "data: the totals" }), null);
  });

  test("saveSmall never throws: refused media and a full storage both return false", () => {
    const items = new Map();
    let full = false;
    globalThis.localStorage = {
      setItem(k, v) {
        if (full) throw new DOMException("full", "QuotaExceededError");
        items.set(k, v);
      },
      getItem: (k) => items.get(k) ?? null,
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(S.saveSmall("a", { done: ["t1"] }), true);
      assert.deepEqual(S.loadSmall("a", null), { done: ["t1"] });
      assert.equal(S.saveSmall("b", { image: "data:image/png;base64,iVBOR" }), false);
      assert.equal(items.has("b"), false);
      full = true;
      assert.equal(S.saveSmall("c", { done: [] }), false);
      items.set("broken", "{not json");
      assert.equal(S.loadSmall("broken", "fallback"), "fallback");
    } finally {
      console.warn = warn;
      delete globalThis.localStorage;
    }
  });
});

describe("pictures for a model", () => {
  test("PNG, JPEG, WebP, GIF and https URLs pass; the audit's SVG screenshots don't", () => {
    for (const ok of ["data:image/png;base64,iVBOR", "data:image/jpeg;base64,/9j", "data:image/jpg;base64,/9j", "data:image/webp;base64,UklG", "data:image/gif;base64,R0lG", "https://x.example/a.png"]) {
      assert.equal(imageProblem(ok), null, ok);
    }
    assert.match(imageProblem("data:image/svg+xml;utf8,<svg/>"), /SVG isn't accepted.*canvas/);
    assert.match(imageProblem("data:image/svg+xml,%3Csvg"), /SVG/);
    assert.match(imageProblem("data:image/bmp;base64,Qk0"), /PNG, JPEG, WebP or GIF/);
    assert.match(imageProblem("blob:http://x/1"), /data URL or an https URL/);
  });
});

const AUDIT_TABS = ["Live", "Checklist", "Evidence", "Memo", "Run Summary", "Step Ledger", "Check History"].map((label) => ({ id: label.toLowerCase().replace(" ", "-"), label }));

describe("tabs", () => {
  test("a tab list of real tab buttons, the current one selected and focusable, with its panel", () => {
    const html = renderToStaticMarkup(h(Tabs, { label: "Run views", tabs: AUDIT_TABS.slice(0, 3), value: "checklist", onChange() {} }, h("p", null, "Items")));
    assert.match(html, /^<div class="tab-bar" role="tablist" aria-label="Run views">/);
    assert.equal(html.match(/role="tab"/g).length, 3);
    assert.match(html, /<button type="button" role="tab" id="([^"]+)" aria-selected="true" aria-controls="([^"]+)" tabindex="0">Checklist<\/button>/);
    assert.equal(html.match(/tabindex="-1"/g).length, 2, "the others are reached with arrow keys");
    const [, tabId, panelId] = /id="([^"]+)" aria-selected="true" aria-controls="([^"]+)"/.exec(html);
    assert.match(html, new RegExp(`<div class="tab-panel" role="tabpanel" id="${panelId}" aria-labelledby="${tabId}" tabindex="0"><p>Items</p></div>$`));
  });

  test("an unknown value selects the first tab, and no children means no empty panel", () => {
    const html = renderToStaticMarkup(h(Tabs, { label: "Views", tabs: AUDIT_TABS.slice(0, 2), value: "gone", onChange() {} }));
    assert.match(html, /aria-selected="true"[^>]*>Live</);
    assert.doesNotMatch(html, /tabpanel/);
  });

  test("arrow keys wrap around, Home and End jump, other keys do nothing", () => {
    assert.equal(tabKeyTarget("ArrowRight", 2, 3), 0);
    assert.equal(tabKeyTarget("ArrowLeft", 0, 3), 2);
    assert.equal(tabKeyTarget("Home", 2, 3), 0);
    assert.equal(tabKeyTarget("End", 0, 3), 2);
    assert.equal(tabKeyTarget("Enter", 0, 3), null);
    assert.equal(tabKeyTarget("ArrowRight", 0, 0), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// In Chromium: needs template/node_modules and Playwright's Chromium, skipped without them

const playwright = hasPlaywright ? await import(pathToFileURL(path.join(MODULES, "@playwright/test/index.mjs")).href).catch(() => null) : null;
let browserProblem = playwright ? null : "template/node_modules isn't installed";
const browser = playwright
  ? await playwright.chromium.launch().catch((err) => {
      browserProblem = `Playwright's Chromium didn't start (${String(err?.message ?? err).split("\n")[0]})`;
      return null;
    })
  : null;
after(() => browser?.close());

const GLOBALS = readFileSync(path.join(TEMPLATE, "app/globals.css"), "utf8");
const MUSE_APP = readFileSync(path.join(TEMPLATE, "targets/muse-app/files/app/muse-app.css"), "utf8");

describe("tabs at 390 px, in Chromium", { skip: browserProblem ?? false }, () => {
  const tabs = renderToStaticMarkup(h(Tabs, { label: "Run views", tabs: AUDIT_TABS, value: "memo", onChange() {} }, h("p", null, "The memo")));
  const links = '<nav class="tab-bar"><a href="/" aria-current="page">Board</a><a href="/plan">Final plan</a><a href="/log">Run log</a><a href="/crew">Agent crew</a></nav>';
  for (const look of ["base", "muse-app"]) {
    for (const colorScheme of ["light", "dark"]) {
      test(`seven tabs and a nav of links all show on a phone, ${look} look, ${colorScheme} mode`, async () => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme, hasTouch: true, isMobile: true });
        try {
          const css = look === "base" ? GLOBALS : `${GLOBALS}\n${MUSE_APP}`;
          await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main class="stack"><section class="card">${tabs}</section>${links}</main></body></html>`);
          await page.evaluate("window.__name = (f) => f;");
          await page.evaluate(() => document.fonts.ready);
          const boxes = await page.evaluate(() =>
            [...document.querySelectorAll(".tab-bar > *")].map((el) => {
              const r = el.getBoundingClientRect();
              return { text: el.textContent, left: r.left, right: r.right, top: r.top, lines: Math.round(r.height / 44) };
            }),
          );
          assert.equal(boxes.length, 11);
          for (const b of boxes) assert.ok(b.left >= 0 && b.right <= 390, `${b.text} runs off the screen: ${b.left} to ${b.right}`);
          assert.ok(new Set(boxes.slice(0, 7).map((b) => Math.round(b.top))).size >= 2, "the seven tabs wrap to a second row");
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), "the page doesn't scroll sideways");
          assert.deepEqual(J.tapTargetProblems(await page.evaluate(J.collectTapTargets)), []);
          assert.deepEqual(J.contrastProblems(await page.evaluate(J.collectTextSamples)), []);
        } finally {
          await page.close();
        }
      });
    }
  }
});

describe("the media store in a real browser, in Chromium", { skip: browserProblem ?? false }, () => {
  test("saves Blobs, removes the oldest past its size, keeps the kept key, and reports instead of throwing", async () => {
    const { transform } = await import("esbuild");
    const { code } = await transform(readFileSync(path.join(TEMPLATE, "lib/client/media-store.ts"), "utf8"), { loader: "ts", format: "esm" });
    const page = await browser.newPage();
    try {
      // IndexedDB needs a real origin, so serve a blank page from one.
      await page.route("http://store.test/**", (route) =>
        route.fulfill({ contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/html", body: route.request().url().endsWith(".js") ? code : "<!doctype html><title>t</title>" }),
      );
      await page.goto("http://store.test/");
      const result = await page.evaluate(async () => {
        const { mediaStore } = await import("http://store.test/media-store.js");
        const store = mediaStore("versions", { maxBytes: 3000 });
        const blob = (n) => new Blob([new Uint8Array(n)], { type: "image/webp" });
        const out = [];
        out.push(await store.put("v1", blob(1000)));
        await new Promise((r) => setTimeout(r, 5));
        out.push(await store.put("v2", blob(1000)));
        await new Promise((r) => setTimeout(r, 5));
        out.push(await store.put("v3", blob(1000)));
        await new Promise((r) => setTimeout(r, 5));
        out.push(await store.put("v4", blob(1000), { keep: ["v1"] }));
        out.push(await store.put("huge", blob(5000)));
        const got = await store.get("v4");
        return { out, keys: (await store.list()).map((e) => e.key), got: got instanceof Blob ? got.size : null, gone: (await store.get("v2")) ?? null };
      });
      assert.deepEqual(result.out.map((r) => r.ok), [true, true, true, true, false]);
      assert.deepEqual(result.out[3].evicted, ["v2"], "the oldest not kept goes");
      assert.equal(result.out[4].reason, "too-big");
      assert.deepEqual(result.keys, ["v1", "v3", "v4"]);
      assert.equal(result.got, 1000);
      assert.equal(result.gone, null);
    } finally {
      await page.close();
    }
  });
});
