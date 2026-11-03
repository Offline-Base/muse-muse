// Unit tests for judgeShot's phone checks in tests/judge-shot.ts: controls too small to tap, and text too faint to read
// on what is behind it. The rules are plain functions tested here; the browser half runs in Chromium against the
// template's own parts (they must pass in light and dark mode, with and without the muse-app look) and against the
// defects the Nov 3 audit found (they must fail). Run from the repo root:
//   npx tsx --test template/scripts/__tests__/screen-checks.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULES = path.join(TEMPLATE, "node_modules");
const hasPlaywright = existsSync(path.join(MODULES, "@playwright/test/package.json"));
// Without template/node_modules, judge-shot.ts's Playwright import gets a stub, so the plain rules still run.
if (!hasPlaywright) {
  const stub = `data:text/javascript,${encodeURIComponent("export const test = {}; export const expect = () => ({});")}`;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === "@playwright/test" ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : n(s, c); }`)}`);
}
const J = await import("../../tests/judge-shot.ts");

const tap = (over) => ({ name: "Send", tag: "button", width: 44, height: 44, inText: false, dense: 1, ...over });
const text = (over) => ({ text: "Hello", color: "rgb(8, 8, 9)", layers: ["rgb(255, 255, 255)"], size: 16, weight: 400, ...over });

describe("contrast math", () => {
  test("parseRgb reads the forms getComputedStyle gives, and nothing else", () => {
    assert.deepEqual(J.parseRgb("rgb(22, 12, 6)"), [22, 12, 6, 1]);
    assert.deepEqual(J.parseRgb("rgba(238, 243, 237, 0.14)"), [238, 243, 237, 0.14]);
    assert.deepEqual(J.parseRgb("rgb(1 2 3 / 50%)"), [1, 2, 3, 0.5]);
    assert.deepEqual(J.parseRgb("rgba(0, 0, 0, 0)"), [0, 0, 0, 0]);
    assert.equal(J.parseRgb("oklch(0.7 0.1 200)"), null);
    assert.equal(J.parseRgb("transparent"), null);
  });

  test("contrastRatio follows WCAG: 21:1 for black on white, 1:1 for a color on itself, either order", () => {
    assert.equal(J.contrastRatio([0, 0, 0], [255, 255, 255]), 21);
    assert.equal(J.contrastRatio([255, 255, 255], [0, 0, 0]), 21);
    assert.equal(J.contrastRatio([36, 44, 41], [36, 44, 41]), 1);
    // #767676 is the lightest gray that passes AA on white.
    assert.ok(Math.abs(J.contrastRatio([0x76, 0x76, 0x76], [255, 255, 255]) - 4.54) < 0.01);
    // The audit's dockline bubble: dark text on the dark gray it was moved onto.
    assert.ok(Math.abs(J.contrastRatio([22, 12, 6], [36, 44, 41]) - 1.3) < 0.05);
  });

  test("paintOver mixes a see-through color into what is under it", () => {
    assert.deepEqual(J.paintOver([255, 255, 255, 0.5], [0, 0, 0, 1]), [127.5, 127.5, 127.5, 1]);
    assert.deepEqual(J.paintOver([10, 20, 30, 1], [0, 0, 0, 1]), [10, 20, 30, 1]);
    assert.deepEqual(J.paintOver([10, 20, 30, 0], [200, 200, 200, 1]), [200, 200, 200, 1]);
  });

  test("large text is 24 px, or 18.66 px and bold", () => {
    assert.equal(J.isLargeText(24, 400), true);
    assert.equal(J.isLargeText(23.9, 600), false);
    assert.equal(J.isLargeText(18.66, 700), true);
    assert.equal(J.isLargeText(18.66, 600), false);
    assert.equal(J.isLargeText(16, 900), false);
  });

  test("sampleContrast paints the layers from the solid ground up, then the text over them", () => {
    assert.equal(J.sampleContrast(text({ color: "rgb(0, 0, 0)" })), 21);
    // 50% white over black is mid gray; black text on it.
    const mid = J.sampleContrast(text({ color: "rgb(0, 0, 0)", layers: ["rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)"] }));
    assert.ok(Math.abs(mid - J.contrastRatio([0, 0, 0], [127.5, 127.5, 127.5])) < 1e-9);
    // See-through text mixes into its ground first: 59% black on white.
    const faint = J.sampleContrast(text({ color: "rgba(0, 4, 9, 0.59)" }));
    assert.ok(faint > 4.5 && faint < 5.5, String(faint));
    // Left out: a reason to skip, no layers, no solid ground, invisible text, or a color it can't read.
    for (const over of [{ skip: "image" }, { skip: "media" }, { layers: [] }, { layers: ["rgba(0, 0, 0, 0.5)"] }, { color: "rgba(0, 0, 0, 0)" }, { color: "oklch(0 0 0)" }]) {
      assert.equal(J.sampleContrast(text(over)), null, JSON.stringify(over));
    }
  });
});

describe("contrastProblems", () => {
  test("names the audit's 1.3:1 chat bubble with its ratio, and passes good text", () => {
    const [problem, ...rest] = J.contrastProblems([
      text({ text: "Which dock runs hottest?", color: "rgb(22, 12, 6)", layers: ["rgb(36, 44, 41)"] }),
      text({ text: "Check P1 first.", color: "rgb(238, 243, 237)", layers: ["rgb(16, 19, 18)"] }),
    ]);
    assert.deepEqual(rest, []);
    assert.match(problem, /^Text too faint to read on what is behind it: "Which dock runs hottest\?" 1\.3:1\. Text needs 4\.5:1/);
    assert.match(problem, /--bubble-out and --on-bubble-out together/);
    assert.doesNotMatch(problem, /Check P1/);
    assert.deepEqual(J.contrastProblems([text({})]), []);
  });

  test("large text needs 3:1, body text 4.5:1", () => {
    // #949494 on white is about 3.03:1.
    const gray = { color: "rgb(148, 148, 148)" };
    assert.deepEqual(J.contrastProblems([text({ ...gray, size: 24 })]), []);
    assert.deepEqual(J.contrastProblems([text({ ...gray, size: 19, weight: 700 })]), []);
    assert.equal(J.contrastProblems([text({ ...gray, size: 19, weight: 600 })]).length, 1);
    assert.equal(J.contrastProblems([text({ ...gray, size: 16 })]).length, 1);
  });

  test("leaves out text over images, gradients, photos and glass, and names each faint text once, 3 at most", () => {
    const faint = { color: "rgb(200, 200, 200)" };
    assert.deepEqual(J.contrastProblems(["image", "media", "faded", "floating", "no-ground"].map((skip) => text({ ...faint, skip }))), []);
    const [problem] = J.contrastProblems(["A", "B", "A", "C", "D", "E"].map((t) => text({ ...faint, text: t })));
    assert.match(problem, /"A" 1\.6:1, "B" 1\.6:1, "C" 1\.6:1 and 2 more\./);
  });
});

describe("tap targets", () => {
  test("a control under 44 px either way is too small", () => {
    assert.equal(J.TAP_MIN, 44);
    assert.equal(J.isSmallTarget(tap({ width: 36, height: 36 })), true, "the audit's Send button");
    assert.equal(J.isSmallTarget(tap({ width: 34, height: 34 })), true, "a map dot");
    assert.equal(J.isSmallTarget(tap({ width: 40, height: 40 })), true, "a row's delete button");
    assert.equal(J.isSmallTarget(tap({ tag: "a", width: 133, height: 19 })), true, "a link standing on its own");
    assert.equal(J.isSmallTarget(tap({ width: 44, height: 43 })), true);
    assert.equal(J.isSmallTarget(tap({ width: 44, height: 44 })), false);
    assert.equal(J.isSmallTarget(tap({ width: 320, height: 44 })), false);
    assert.equal(J.isSmallTarget(tap({ width: 43.6, height: 44 })), false, "half a pixel of rounding");
  });

  test("a link inside a sentence and the cells of a dense board may be smaller", () => {
    assert.equal(J.isSmallTarget(tap({ tag: "a", width: 80, height: 20, inText: true })), false);
    assert.equal(J.isSmallTarget(tap({ width: 38, height: 38, dense: 81 })), false, "a 9 by 9 board");
    assert.equal(J.isSmallTarget(tap({ width: 34, height: 34, dense: 8 })), true, "8 dots on a photo aren't a board");
  });

  test("tapTargetProblems names each offender once with its size, 4 at most", () => {
    assert.deepEqual(J.tapTargetProblems([tap({}), tap({ width: 200, height: 48 })]), []);
    const [one] = J.tapTargetProblems([tap({ width: 36, height: 36 }), tap({ name: "Patterns", tag: "a", width: 71.4, height: 19 })]);
    assert.match(one, /^Too small to tap on a phone \(under 44x44 px\): <button> "Send" 36x36, <a> "Patterns" 71x19\. /);
    assert.match(one, /background-clip: content-box/);
    const many = J.tapTargetProblems(Array.from({ length: 6 }, (_, i) => tap({ name: `Dot ${i + 1}`, width: 34, height: 34 })));
    assert.equal(many.length, 1);
    assert.match(many[0], /"Dot 4" 34x34 and 2 more\./);
  });
});

test("judgeShot runs both checks on the smoke project only, and the browser halves never call module code", () => {
  const source = readFileSync(path.join(TEMPLATE, "tests/judge-shot.ts"), "utf8");
  assert.match(source, /tapTargetProblems\(await page\.evaluate\(collectTapTargets\)\)/);
  assert.match(source, /contrastProblems\(await page\.evaluate\(collectTextSamples\)\)/);
  assert.match(source, /const problems = smoke\s*\?/);
  assert.match(source, /navClipProblems\(await page\.evaluate\(collectNavItems\)\)/);
  for (const name of ["collectTapTargets", "collectTextSamples", "collectNavItems"]) {
    const body = source.slice(source.indexOf(`export function ${name}`));
    const end = body.indexOf("\n}\n");
    assert.ok(end > 0);
    for (const helper of ["isSmallTarget", "tapTargetProblems", "parseRgb", "paintOver", "contrastRatio", "luminance", "sampleContrast", "isLargeText", "navClipProblems"]) {
      assert.doesNotMatch(body.slice(0, end), new RegExp(`\\b${helper}\\(`), `${name} calls ${helper}, which page.evaluate can't reach`);
    }
  }
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
const icon = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16" stroke="currentColor"/></svg>';
const photo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#f5f5f5"/></svg>')}`;

// The template's parts as its components render them (components/*.tsx) and as the skills show them, on one screen.
const TEMPLATE_SCREEN = `
<header class="appbar"><div class="appbar-inner"><a class="appbar-name" href="/">Receipt Reader</a>
  <div class="appbar-action"><button class="text">Start over</button></div></div></header>
<main class="stack">
  <header class="hero"><h1>Read a receipt</h1><p class="tagline">Take a photo and get every item.</p></header>
  <nav class="row"><a href="/">Home</a><a href="/history">History</a><a href="/faq">FAQ</a></nav>
  <section class="card">
    <div class="field"><span class="label" id="seg">Where</span>
      <div class="segmented" role="radiogroup" aria-labelledby="seg" data-layout="row" data-wide="row">
        <label><input type="radio" name="w" value="in" checked>Indoor</label><label><input type="radio" name="w" value="out">Outdoor</label></div></div>
    <div class="field"><span class="label" id="fp">Receipt</span>
      <label class="dropzone"><input type="file" class="visually-hidden" aria-labelledby="fp">
        <span class="icon-circle" aria-hidden="true">${icon}</span>
        <span class="dropzone-text"><span class="dropzone-title">Take or choose a photo</span><span class="dropzone-hint">JPG or PNG</span></span></label></div>
    <div class="field"><span class="label" id="fp2">Second receipt</span>
      <label class="dropzone" data-filled=""><input type="file" class="visually-hidden" aria-labelledby="fp2">
        <span class="icon-circle" aria-hidden="true">${icon}</span>
        <span class="dropzone-text"><span class="dropzone-title">Sample receipt</span><span class="dropzone-hint">Choose another</span></span></label></div>
    <div class="fields two">
      <div class="field"><label for="t">Title</label><input id="t" value="Lunch"><p class="hint">A short name</p></div>
      <div class="field"><label for="s">Size</label><select id="s"><option>Small</option><option>Large</option></select></div>
    </div>
    <label><input type="checkbox" checked> Include tax in the total</label>
    <label><input type="checkbox"> I agree to the <a href="/terms">terms</a></label>
    <input type="range" aria-label="Tip" min="0" max="30" value="15">
    <div class="chips"><button class="chip" aria-pressed="true">Food</button><button class="chip" aria-pressed="false">Drinks</button>
      <span class="chip">Saved</span><span class="chip positive">${icon}Paid</span><span class="chip negative">Late</span><span class="tag">Beta</span></div>
    <ul class="rows">
      <li class="rows-head" aria-hidden="true"><span>Item</span><span>Price</span><span></span></li>
      <li><textarea aria-label="Item 1">Bread</textarea><input class="num" aria-label="Price 1" value="3.20"><button class="icon" aria-label="Remove item 1">${icon}</button></li>
    </ul>
    <details><summary>More options</summary><p>Hidden until opened</p></details>
    <p class="note">Your photo is sent to Muse Wonder to read it.</p>
    <div class="error" role="alert"><strong>Couldn't read that receipt.</strong> Try a sharper photo.</div>
    <ul class="limits"><li>Up to 20 items</li></ul>
    <div class="actions"><button class="primary">Read it</button><button class="secondary">Edit</button><button class="tinted">Explain</button>
      <button class="icon" aria-label="Search">${icon}</button><button class="primary" disabled>Save</button><button class="text">Undo</button></div>
    <div class="stack"><p class="hint">Files changed: 2</p><a href="/files.zip" download>Download the files</a></div>
  </section>
  <section class="card ai" data-result>
    <div class="card-head"><h2>Your items</h2><span class="chip ai">${icon}Read by Muse Wonder</span></div>
    <p class="big-number">$12.40</p>
    <dl class="kv"><dt>Total</dt><dd>$12.40</dd><dt>Tax</dt><dd>$0.80</dd></dl>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Price</th></tr></thead>
      <tbody><tr><td>Bread</td><td class="num">3.20</td></tr></tbody><tfoot><tr><td>Total</td><td class="num">3.20</td></tr></tfoot></table></div>
    <div class="bars"><div class="bar" style="--value: 40">4\nMon</div><div class="bar" style="--value: 80">8\nTue</div></div>
    <ul class="list"><li><a class="list-row" href="/r/1"><span class="avatar">AB</span>
      <span class="list-text"><span class="list-title">Anna's lunch</span><span class="meta">2 items</span></span></a></li></ul>
    <p class="working">Reading the receipt</p>
    <figure class="media"><img src="${photo}" alt="The receipt"><span class="ai-badge">${icon}Read by Muse Wonder</span><figcaption>Found 3 items</figcaption></figure>
    <div class="gallery"><figure class="media"><img src="${photo}" alt="Scene 1"><figcaption><span>Scene 1</span><button class="icon" aria-label="Download scene 1">${icon}</button></figcaption></figure></div>
  </section>
  <section class="card">
    <div class="thread">
      <div class="bubble out" data-user-text>Which dock runs hottest?</div>
      <div class="bubble in"><div class="prose"><p>Dock 2, from <a href="#l1">line 1</a> and <a href="#l4">line 4</a>.</p><ul><li><a href="#src">Cold room log</a></li></ul></div></div>
    </div>
    <form class="composer"><label class="visually-hidden" for="c">Message</label>
      <textarea id="c" rows="1" placeholder="Ask about it" data-user-text>And dock 3?</textarea>
      <button type="submit" class="send" aria-label="Send">${icon}</button></form>
  </section>
  <div class="empty"><span class="icon-circle">${icon}</span><h3>No receipts yet</h3><p>Take a photo to start.</p></div>
</main>
<footer style="max-width: calc(var(--page-width) + 2 * var(--gutter)); margin: 0 auto; padding: 8px var(--gutter) 40px; color: var(--fg-2); font: var(--type-meta)">
  <p style="margin: 0 0 8px">Idea from <a href="https://example.com/v" target="_blank" rel="noreferrer">a Meta developer video</a>.</p>
  Built with Muse Muse. Not an official Meta product.</footer>`;

// The audit's defects, each the way a product wrote it, beside things the checks must leave alone.
const AUDIT_SCREEN = `
<style>
  :root { --bg: #111413; --surface: #1c2220; --surface-2: #242c29; --fg: #eef3ed; --fg-2: #a7b5ae; --accent: #ff6b2c; --on-accent: #160c06; --link: #7dd8ff; }
  .bubble.out { background: var(--surface-2); }
  .composer .send { width: 36px; height: 36px; padding: 0; }
  .tabs { display: flex; gap: 16px; }
  .tabs a { font: 400 13px/16px var(--font); }
  .photo { position: relative; }
  .dot { position: absolute; width: 34px; height: 34px; border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); }
  .board { display: grid; grid-template-columns: repeat(9, 1fr); width: 351px; }
  .board button { height: 39px; border: 0; background: var(--surface); color: var(--fg); }
  .hero-band { padding: 16px; background: linear-gradient(90deg, #ffffff, #fefefe); color: #f0f0f0; }
  .on-photo { position: relative; } .on-photo span { position: absolute; left: 8px; top: 8px; color: #fafafa; }
  .gone { display: none; color: #222; }
</style>
<main class="stack">
  <div class="tabs"><a href="/feed">Feed</a><a href="/patterns">Patterns</a></div>
  <section class="card">
    <div class="thread"><div class="bubble out" data-user-text>Which dock runs hottest?</div></div>
    <form class="composer"><label class="visually-hidden" for="c">Message</label><textarea id="c" rows="1">Why?</textarea><button type="submit" class="send" aria-label="Send">${icon}</button></form>
    <div class="photo"><img src="${photo}" alt="Fridge"><button class="dot" style="left: 10px; top: 10px" aria-label="Milk">1</button></div>
    <p>Read <a href="/help">the help page</a> for more.</p>
    <div class="board">${Array.from({ length: 81 }, (_, i) => `<button aria-label="Cell ${i + 1}">${(i % 9) + 1}</button>`).join("")}</div>
    <button style="width: 20px; height: 20px; padding: 0" disabled aria-label="Off">x</button>
    <div class="hero-band">Text on a gradient is left alone</div>
    <div class="on-photo"><img src="${photo}" alt="Shelf"><span>A label on a photo</span></div>
    <p class="gone">Hidden text is left alone</p>
  </section>
</main>`;

async function check(body, { css = [GLOBALS], colorScheme = "light" } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
  try {
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css.join("\n")}</style></head><body>${body}</body></html>`);
    // tsx names the functions it compiles with a __name helper that a page doesn't have. Playwright's own compiler doesn't.
    await page.evaluate("window.__name = (f) => f;");
    await page.evaluate(() => document.fonts.ready);
    const targets = await page.evaluate(J.collectTapTargets);
    const samples = await page.evaluate(J.collectTextSamples);
    const nav = await page.evaluate(J.collectNavItems);
    const screen = await page.evaluate(J.findScreenProblems);
    return { targets, samples, nav, screen, tap: J.tapTargetProblems(targets), contrast: J.contrastProblems(samples), navClip: J.navClipProblems(nav) };
  } finally {
    await page.close();
  }
}

describe("the template's own parts pass both checks, in Chromium", { skip: browserProblem ?? false }, () => {
  for (const look of ["base", "muse-app"]) {
    for (const colorScheme of ["light", "dark"]) {
      test(`${look} look, ${colorScheme} mode`, async () => {
        const css = look === "base" ? [GLOBALS] : [GLOBALS, MUSE_APP];
        const { targets, samples, tap, contrast, navClip } = await check(TEMPLATE_SCREEN, { css, colorScheme });
        assert.deepEqual(tap, []);
        assert.deepEqual(contrast, []);
        assert.deepEqual(navClip, []);
        // The checks really looked: the parts were measured and the text read.
        const names = targets.map((t) => t.name);
        for (const name of ["Receipt Reader", "Download the files", "Send", "Remove item 1", "Food", "Indoor", "Include tax in the total", "History", "Tip"]) assert.ok(names.includes(name), `${name} not measured: ${names.join(", ")}`);
        assert.ok(targets.find((t) => t.name === "a Meta developer video")?.inText, "the footer's credit sits in a sentence");
        assert.ok(targets.find((t) => t.name === "line 1")?.inText, "model text is prose");
        assert.ok(targets.find((t) => t.name === "terms")?.inText, "a link in a checkbox's sentence stays in its sentence");
        const send = targets.find((t) => t.name === "Send");
        assert.deepEqual([send.width, send.height], [44, 44]);
        const read = samples.filter((s) => !s.skip).map((s) => s.text);
        for (const t of ["Which dock runs hottest?", "Your items", "Bread", "Food", "4 Mon", "Built with Muse Muse. Not an official Meta product."]) assert.ok(read.some((r) => t.startsWith(r.replace(/\.\.\.$/, ""))), `${t} not read`);
        assert.equal(samples.find((s) => s.text === "Read by Muse Wonder")?.skip !== undefined, true, "the AI chip's gradient outline is left out");
      });
    }
  }
});

describe("the audit's defects fail, and the noise around them doesn't, in Chromium", { skip: browserProblem ?? false }, () => {
  test("the Send button, a dot on a photo and tab links are too small; a link in a sentence, a disabled button and a board's cells aren't", async () => {
    const { tap, contrast } = await check(AUDIT_SCREEN);
    assert.equal(tap.length, 1);
    assert.match(tap[0], /<a> "Feed" \d+x16, <a> "Patterns" \d+x16, <button> "Send" 36x36, <button> "Milk" 34x34\./);
    assert.doesNotMatch(tap[0], /help page|Cell|Off/);
    assert.equal(contrast.length, 1);
    assert.match(contrast[0], /^Text too faint to read on what is behind it: "Which dock runs hottest\?" 1\.\d:1\. /);
    assert.doesNotMatch(contrast[0], /gradient|photo|Hidden/);
  });

  test("a board in a table is left alone, while scattered dots and a column of row buttons are caught", async () => {
    const cells = Array.from({ length: 9 }, (_, r) => `<tr>${Array.from({ length: 9 }, (_, c) => `<td><button aria-label="Cell ${r * 9 + c + 1}">${c + 1}</button></td>`).join("")}</tr>`).join("");
    const dots = Array.from({ length: 14 }, (_, i) => `<button class="d" style="left: ${(i * 53) % 300}px; top: ${(i * 37) % 180}px" aria-label="Dot ${i + 1}">${i + 1}</button>`).join("");
    const rows = Array.from({ length: 13 }, (_, i) => `<li style="display: flex; justify-content: space-between; align-items: center; min-height: 48px"><span>Row ${i + 1}</span><button class="x" aria-label="Delete ${i + 1}">x</button></li>`).join("");
    const { tap } = await check(`<style>
      .board td { padding: 0; } .board button { width: 38px; height: 38px; border: 0; }
      .pic { position: relative; height: 220px; } .d { position: absolute; width: 30px; height: 30px; border: 0; }
      .x { width: 40px; height: 40px; border: 0; }
    </style><main class="stack"><table class="board">${cells}</table><div class="pic">${dots}</div><ul>${rows}</ul></main>`);
    assert.equal(tap.length, 1);
    assert.match(tap[0], /"Dot 1" 30x30, .* and 23 more\./);
    assert.doesNotMatch(tap[0], /Cell/);
  });

  test("text on a hero's overlay or on a positioned dark layer is left alone, and a card-wide link keeps its layout", async () => {
    const { contrast, targets } = await check(`<style>
      .hero { position: relative; padding: 40px 16px; } .hero::before { content: ""; position: absolute; inset: 0; background: #102030; }
      .hero h2 { position: relative; color: #fff; }
      .layered { position: relative; padding: 24px; } .layered .shade { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.8); }
      .layered p { position: relative; color: #fff; }
    </style><main class="stack">
      <div class="hero"><h2>Plan your trip</h2></div>
      <div class="layered"><div class="shade"></div><p>Over a dark layer</p></div>
      <p style="color: #ccc">Really faint text here</p>
      <a href="/item/1"><h3>Item one</h3><p>Its description runs here.</p></a>
    </main>`);
    assert.equal(contrast.length, 1);
    assert.match(contrast[0], /"Really faint text here"/);
    const card = targets.find((t) => t.name.startsWith("Item one"));
    assert.ok(card.height > 60, `the link's heading and line stay stacked (${card.width}x${card.height})`);
  });

  test("a product that moves the bubble through its token pair passes", async () => {
    const fixed = AUDIT_SCREEN.replace(".bubble.out { background: var(--surface-2); }", ":root { --bubble-out: var(--surface-2); --on-bubble-out: var(--fg); }");
    assert.deepEqual((await check(fixed)).contrast, []);
  });

  test("on a desktop-width screen the tap check stays out of the way", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`<style>${GLOBALS}</style>${AUDIT_SCREEN}`);
      await page.evaluate("window.__name = (f) => f;");
      assert.deepEqual(await page.evaluate(J.collectTapTargets), []);
    } finally {
      await page.close();
    }
  });
});

describe("navigation cut off at the edge of a phone (the Nov 3 targets audit, issue 11)", () => {
  test("navClipProblems names what is cut and passes a row that scrolls with a visible fade", () => {
    const nav = (over) => ({ name: "PDF Preview", tag: "a", width: 120, shown: 40, reason: "edge", cue: false, ...over });
    const [problem] = J.navClipProblems([nav(), nav({ name: "Board Mo", tag: "button", reason: "text" })]);
    assert.match(problem, /<a> "PDF Preview" shows 40 of 120px, <button> "Board Mo" has its words clipped\./);
    assert.deepEqual(J.navClipProblems([nav({ cue: true })]), []);
    assert.deepEqual(J.navClipProblems([]), []);
  });

  // The crumb build's strip: pill links in a row that scrolls sideways, marked data-allow-clip, so the box checks let it go.
  const STRIP = `<style>
    .app-tabs { display: flex; gap: 16px; overflow-x: auto; scrollbar-width: none; padding: 8px 16px; }
    .app-tab { flex: none; white-space: nowrap; padding: 12px 24px; border: 2px solid; border-radius: 999px; }
  </style>`;
  const tabs = '<a class="app-tab" href="/">Week Inbox</a><a class="app-tab" href="/board">Weekly Summary Board</a><a class="app-tab" href="/pdf">PDF Preview</a>';

  test("the crumb strip in data-allow-clip and a tab that cuts its own words fail; the box checks missed both", { skip: browserProblem ?? false }, async () => {
    const { navClip, nav, screen } = await check(`${STRIP}<style>
      .mode { display: flex; } .mode button { width: 84px; overflow: hidden; white-space: nowrap; font-size: 16px; }
    </style><header><nav class="app-tabs" data-allow-clip>${tabs}</nav></header>
    <main class="stack"><div class="mode" role="tablist"><button role="tab">Status</button><button role="tab">Board Mode Preview</button></div></main>`);
    assert.equal(navClip.length, 1);
    assert.match(navClip[0], /"Weekly Summary Board" shows \d+ of \d+px, <a> "PDF Preview" shows 0 of \d+px/);
    assert.match(navClip[0], /"Board Mode Preview" has its words clipped/);
    assert.ok(!nav.some((n) => n.name === "Week Inbox"), "a tab that shows whole isn't listed");
    assert.ok(!screen.some((p) => /Weekly Summary|Board Mode/.test(p)), `the box checks already caught it: ${screen.join(" | ")}`);
  });

  test("a strip that wraps, one that scrolls with a fade, and a desktop screen pass", { skip: browserProblem ?? false }, async () => {
    const wraps = await check(`<nav class="tab-bar" aria-label="Views">${tabs}<a href="/more">Settings and more</a></nav>`);
    assert.deepEqual(wraps.navClip, []);
    const faded = await check(`${STRIP}<style>.app-tabs { mask-image: linear-gradient(90deg, #000 85%, transparent); }</style><nav class="app-tabs" data-allow-clip>${tabs}</nav>`);
    assert.ok(faded.nav.length > 0, "the cut tab was measured");
    assert.deepEqual(faded.navClip, []);
    // A closed drawer waits wholly off screen, outside any row that scrolls.
    const drawer = await check(`<nav style="position: fixed; top: 0; right: 0; width: 280px; transform: translateX(100%)"><a href="/a">History</a><a href="/b">Settings</a></nav>`);
    assert.deepEqual(drawer.navClip, []);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`${STRIP}<nav class="app-tabs" style="width: 300px" data-allow-clip>${tabs}</nav>`);
      await page.evaluate("window.__name = (f) => f;");
      assert.deepEqual(await page.evaluate(J.collectNavItems), []);
    } finally {
      await page.close();
    }
  });
});
