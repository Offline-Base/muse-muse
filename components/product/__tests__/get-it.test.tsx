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
import { GET_IT_MORE, GET_IT_SLOTS, GetItPanel, type GetItSlots } from "@/components/product/GetItPanel";
import { QrCode } from "@/components/product/QrCode";
import { TARGETS } from "@/lib/brief/schema";
import { CAP_OUTPUTS, PRODUCT_OUTPUTS, RUNTIME_OUTPUTS } from "@/lib/native/targets";
import { qrMatrix } from "@/lib/qr";

const render = (slots: GetItSlots) => renderToString(createElement(GetItPanel, { slots })).replace(/<!-- -->/g, "");

describe("GetItPanel", () => {
  it("has a slot for every target, every product output, every runtime output (wave 3, unit 10) and the extension (unit 14), and no others", () => {
    assert.deepEqual([...GET_IT_SLOTS], [...TARGETS, ...PRODUCT_OUTPUTS, ...RUNTIME_OUTPUTS, ...CAP_OUTPUTS]);
    assert.deepEqual([...CAP_OUTPUTS], ["extension"]);
    assert.deepEqual([...PRODUCT_OUTPUTS], ["mcp", "cli", "skill", "claude_plugin", "chatgpt", "gadget"]);
    assert.deepEqual([...RUNTIME_OUTPUTS], ["vscode", "github_action", "self_host"]);
  });

  it("names the gadget tab Muse gadget", () => {
    const html = renderToString(createElement(GetItPanel, { slots: { mcp: "MCP steps", gadget: "Gadget steps" }, initial: "gadget" })).replace(/<!-- -->/g, "");
    const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["MCP", "Muse gadget"]);
  });

  // Nov 3, simplify-ui: a judge's first look shows the ways anyone can try; Claude, ChatGPT and the gadget need another
  // account or a device, so they wait behind one button.
  it("keeps the tabs that need another account or a device behind More ways to use it", () => {
    assert.deepEqual([...GET_IT_MORE], ["claude_plugin", "chatgpt", "gadget"]);
    const html = render({ mcp: "MCP steps", cli: "CLI steps", claude_plugin: "Plugin steps", chatgpt: "ChatGPT steps", gadget: "Gadget steps" });
    const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["MCP", "CLI"]);
    assert.match(html, /<button type="button" class="link-btn getit-more" aria-expanded="false">More ways to use it \(3\)<\/button>/);
    assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 2, "no panel for a tab that isn't shown");
    // Opening on one of them shows them all from the start.
    const open = renderToString(createElement(GetItPanel, { slots: { mcp: "MCP steps", chatgpt: "ChatGPT steps" }, initial: "chatgpt" })).replace(/<!-- -->/g, "");
    assert.deepEqual([...open.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]), ["MCP", "ChatGPT"]);
    assert.match(open, /aria-selected="true"[^>]*>ChatGPT</);
    assert.doesNotMatch(open, /More ways to use it/);
    // With nothing else to show, they are the tabs.
    const only = render({ claude_plugin: "Plugin steps", chatgpt: "ChatGPT steps" });
    assert.deepEqual([...only.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]), ["Claude", "ChatGPT"]);
    assert.doesNotMatch(only, /More ways to use it/);
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
    assert.deepEqual(tabs, ["Phone", "VR", "CLI"]);
    assert.match(html, /More ways to use it \(1\)/, "ChatGPT waits behind More ways to use it");
    assert.match(html, /aria-selected="true"[^>]*>Phone</);
    assert.ok(html.includes("Android and iPhone"));
    assert.ok(!html.includes("Open on Quest"), "other tabs load when opened");
    assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 3);
  });

  it("is on the product page, only for a shipped product, with the output tabs only while their flag is on", () => {
    const page = readFileSync(path.join(process.cwd(), "app/p/[slug]/page.tsx"), "utf8");
    // Wave 3, unit 10: the runtime outputs' tabs, only while RUNTIME_OUTPUTS is on. Unit 14: the extension's tab, only
    // while the extension cap is enabled (NATIVE_EXTENSION and its CAP_READY line). The edge slot (EdgeSlot.tsx) comes
    // right after the native ones.
    assert.match(
      page,
      /\{shipped \? \(\s*<GetItPanel slots=\{\{ \.\.\.native\.slots, \.\.\.edge, \.\.\.\(env\.productOutputs \? productOutputSlots\([^)]*\) : \{\}\), \.\.\.\(env\.runtimeOutputs \? runtimeOutputSlots\([^)]*\) : \{\}\), \.\.\.\(env\.enabledCaps\.includes\("extension"\) \? extensionSlots\([^)]*\) : \{\}\) \}\} initial=\{native\.initial\} \/>\s*\) : null\}/,
    );
  });

  it("opens on the tab it's told to, and on the first when that one is empty", () => {
    const slots: GetItSlots = { phone: "Android and iPhone", vr: "Open on Quest" };
    const vr = renderToString(createElement(GetItPanel, { slots, initial: "vr" })).replace(/<!-- -->/g, "");
    assert.match(vr, /aria-selected="true"[^>]*>VR</);
    assert.ok(vr.includes("Open on Quest"));
    assert.ok(!vr.includes("Android and iPhone"));
    const empty = renderToString(createElement(GetItPanel, { slots: { phone: "Android and iPhone", desktop: "Mac" }, initial: "vr" })).replace(/<!-- -->/g, "");
    assert.match(empty, /aria-selected="true"[^>]*>Phone</);
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
