/**
 * The product page's "Get it" panel: nothing at all until a slot has content, so pages look as they do today, a tab for
 * each filled slot in a fixed order, and the QR code component.
 *   npx tsx --test components/product/__tests__/get-it.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { GET_IT_SLOTS, GetItPanel, type GetItSlots } from "@/components/product/GetItPanel";
import { QrCode } from "@/components/product/QrCode";
import { TARGETS } from "@/lib/brief/schema";
import { PRODUCT_OUTPUTS } from "@/lib/native/targets";
import { qrMatrix } from "@/lib/qr";

const render = (slots: GetItSlots) => renderToString(createElement(GetItPanel, { slots })).replace(/<!-- -->/g, "");

describe("GetItPanel", () => {
  it("has a slot for every target and every product output, and no others", () => {
    assert.deepEqual([...GET_IT_SLOTS], [...TARGETS, ...PRODUCT_OUTPUTS]);
    assert.deepEqual([...PRODUCT_OUTPUTS], ["mcp", "cli", "skill", "claude_plugin", "chatgpt"]);
  });

  it("renders nothing at all when no slot has content", () => {
    assert.equal(render({}), "");
    assert.equal(render({ phone: null, desktop: undefined, vr: false, glasses: "", agent: [], mcp: [null, false] }), "");
  });

  it("shows one slot without tabs", () => {
    const html = render({ phone: createElement("p", null, "Download for Android") });
    assert.match(html, /<h2 id="get-it-title">Get it<\/h2>/);
    assert.match(html, /Download for Android/);
    assert.doesNotMatch(html, /role="tablist"/);
  });

  it("makes a tab for each filled slot only, in the fixed order, and shows the first", () => {
    const html = render({ chatgpt: "ChatGPT steps", mcp: null, vr: "Open on Quest", phone: "Android and iPhone", cli: createElement("code", null, "musemuse run") });
    const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["Phone", "VR", "CLI", "ChatGPT"]);
    assert.match(html, /aria-selected="true"[^>]*>Phone</);
    assert.ok(html.includes("Android and iPhone"));
    assert.ok(!html.includes("Open on Quest"), "other tabs load when opened");
    assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 4);
  });

  it("is on the product page, only for a shipped product", () => {
    const page = readFileSync(path.join(process.cwd(), "app/p/[slug]/page.tsx"), "utf8");
    assert.match(page, /\{shipped \? <GetItPanel slots=\{native\.slots\} \/> : null\}/);
  });
});

describe("QrCode", () => {
  it("draws the code for its value, labelled, on white", () => {
    const html = renderToString(createElement(QrCode, { value: "https://example.com/get", label: "Download for Android", size: 120 }));
    const side = qrMatrix("https://example.com/get").size + 8;
    assert.match(html, /role="img"/);
    assert.match(html, /aria-label="Download for Android"/);
    assert.match(html, /width="120"/);
    assert.match(html, new RegExp(`viewBox="0 0 ${side} ${side}"`));
    assert.match(html, /fill="#fff"/);
    assert.doesNotMatch(html, /example\.com/);
  });
});
