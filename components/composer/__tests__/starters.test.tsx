/**
 * The Make page's starters (components/composer/Starters.tsx, docs/BRAND.md "Starters under the composer"): Meta
 * AI-style category pills over a grid of ideas or a strip of photo examples.
 *
 *   npx tsx --test --experimental-test-module-mocks components/composer/__tests__/starters.test.tsx
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { StarterTab } from "@/components/composer/Starters";

mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {} }) } });
mock.module("@/components/camera/CameraCapture", { namedExports: { CameraCapture: () => null, useCameraSupported: () => true } });

const ROOT = path.join(import.meta.dirname, "../../..");
const TABS: StarterTab[] = [
  { id: "discover", label: "Discover", kind: "ideas", ideas: [{ icon: "cart", label: "Turn a recipe into a shopping list", note: "Shopping list note" }] },
  { id: "photos", label: "From a photo", kind: "photos", examples: [{ label: "Receipt to spreadsheet", text: "A receipt as a CSV.", image: "/examples/receipt.jpg", note: "Receipt note" }] },
];

let renderStarters: (props: object) => string;
let renderComposer: (props: object) => string;
before(async () => {
  const { renderToString } = await import("react-dom/server");
  const { Starters } = await import("@/components/composer/Starters");
  const { Composer } = await import("@/components/composer/Composer");
  const clean = (html: string) => html.replace(/<!-- -->/g, "");
  renderStarters = (props) => clean(renderToString(createElement(Starters as ComponentType<never>, props as never)));
  renderComposer = (props) => clean(renderToString(createElement(Composer as ComponentType<never>, props as never)));
});

const base = { tabs: TABS, disabled: false, loadingLabel: null, onIdea() {}, onPhoto() {} };

describe("starters", () => {
  it("draws the pills as a tab list, the first one chosen, with its panel", () => {
    const html = renderStarters(base);
    assert.match(html, /role="tablist" aria-label="Starters"/);
    assert.equal(html.match(/role="tab"/g)?.length, 2);
    assert.match(html, /aria-selected="true" aria-controls="[^"]+" tabindex="0" class="starter-pill">Discover</);
    assert.match(html, /aria-selected="false" aria-controls="[^"]+" tabindex="-1" class="starter-pill">From a photo</);
    assert.match(html, /role="tabpanel"/);
  });

  it("shows ideas as an icon squircle beside the label", () => {
    const html = renderStarters(base);
    assert.match(html, /<ul class="starter-grid"><li><button type="button" class="starter-idea"><span class="starter-icon"><svg[^]*?<\/svg><\/span><span class="starter-label">Turn a recipe into a shopping list<\/span>/);
    assert.doesNotMatch(html, /ex-card/);
  });

  it("shows photo examples as a strip of cards, with no tag or camera button", () => {
    const html = renderStarters({ ...base, tabs: [TABS[1]!] });
    assert.match(html, /<ul class="ex-grid ex-strip">/);
    assert.match(html, /class="ex-card" title="A receipt as a CSV\."/);
    assert.match(html, /<img src="\/examples\/receipt\.jpg" alt="" loading="lazy"\/>/);
    assert.match(html, /<span class="ex-title">Receipt to spreadsheet<\/span>/);
    assert.doesNotMatch(html, /ex-tag|ex-camera|Use my camera/);
  });

  it("disables every choice while the composer is sending, and the photos while one loads", () => {
    assert.match(renderStarters({ ...base, disabled: true }), /class="starter-idea" disabled=""/);
    assert.match(renderStarters({ ...base, tabs: [TABS[1]!], loadingLabel: "Receipt to spreadsheet" }), /class="ex-card"[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it("draws nothing with no tabs", () => {
    assert.equal(renderStarters({ ...base, tabs: [] }), "");
  });
});

describe("the composer with starters", () => {
  it("shows the starters in place of the photo cards on the Make page", () => {
    const html = renderComposer({ mode: "new", signedIn: true, layout: "playground", starters: TABS, examples: [{ label: "Old", note: "n", image: "/examples/receipt.jpg" }] });
    assert.match(html, /class="starters"/);
    assert.doesNotMatch(html, /aria-label="Examples"/);
  });

  it("keeps the photo cards for a playground with examples and no starters", () => {
    const html = renderComposer({ mode: "new", signedIn: true, layout: "playground", examples: [{ label: "Old", note: "n", image: "/examples/receipt.jpg" }] });
    assert.match(html, /<ul class="ex-grid" aria-label="Examples">/);
    assert.doesNotMatch(html, /class="starters"/);
  });

  it("ignores starters outside the playground", () => {
    assert.doesNotMatch(renderComposer({ mode: "new", signedIn: true, starters: TABS }), /class="starters"/);
  });
});

describe("the Make page's starters", () => {
  const page = readFileSync(path.join(ROOT, "app/page.tsx"), "utf8");
  it("has four tabs, three of six ideas and five photos that exist", () => {
    assert.match(page, /starters=\{STARTERS\} layout="playground"/);
    const tabs = [...page.matchAll(/\{\s*id: "(\w+)",\s*label: "([^"]+)",\s*kind: "(ideas|photos)"/g)].map((m) => m[2]);
    assert.deepEqual(tabs, ["Discover", "For school", "For work", "From a photo"]);
    assert.equal(page.match(/\{ icon: "/g)?.length, 18);
    const photos = [...page.matchAll(/image: "(\/examples\/[a-z]+\.jpg)"/g)].map((m) => m[1]!);
    assert.equal(photos.length, 5);
    for (const p of photos) assert.ok(existsSync(path.join(ROOT, "public", p)), p);
  });

  it("writes plain copy with no em dashes", () => {
    assert.doesNotMatch(page, /—/);
    assert.doesNotMatch(readFileSync(path.join(ROOT, "components/composer/Starters.tsx"), "utf8"), /—/);
  });

  it("styles the pills, the grid and the strip with tokens", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const block = css.slice(css.indexOf(".starters {"), css.indexOf("/* The build setup"));
    assert.match(block, /\.starter-pill\[aria-selected="true"\] \{\s*border-color: transparent;\s*background: var\(--surface-2\);/);
    assert.match(block, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(block, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
    assert.doesNotMatch(block.replace(/rgba\(0, 0, 0, 0\.68\)/g, ""), /#[0-9a-f]{3,6}\b/i, "colors come from tokens");
  });
});
