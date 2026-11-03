// Unit tests for components/UsageStrip.tsx (cost and usage, shown once) and components/ConfirmButton.tsx (clear,
// delete and reset ask first), rendered to HTML. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/usage-confirm.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./agent-kit.mjs"; // resolves @/ the way a product does

globalThis.React = React;
const { UsageStrip, formatUsd, shownStrip, usageText } = await import("../../components/UsageStrip.tsx");
const { ConfirmButton } = await import("../../components/ConfirmButton.tsx");
const h = React.createElement;

test("money has one rounding rule, so two places can't disagree ($0.084 and $0.08 in the Nov 3 audit)", () => {
  assert.equal(formatUsd(0.084), "$0.084");
  assert.equal(formatUsd(0.0844), "$0.084");
  assert.equal(formatUsd(0.12), "$0.12");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(0.0004), "under $0.001");
  assert.equal(formatUsd(0), "$0");
});

test("the strip puts cost, tokens and cached tokens on one line, and a cache count of 0 still shows", () => {
  assert.equal(usageText({ costUsd: 0.084, input: 314, output: 871, cached: 0 }), "About $0.084 in model costs · 1,185 tokens · 0 from cache");
  assert.equal(usageText({ costUsd: 0.04 }, "in model and tool costs"), "About $0.040 in model and tool costs");
  assert.equal(usageText({ input: 2000, cached: 1500 }), "2,000 tokens · 1,500 from cache");
  assert.equal(usageText({ costUsd: 0 }), "");
  const html = renderToStaticMarkup(h(UsageStrip, { usage: { costUsd: 0.2, input: 10, output: 5 } }));
  assert.equal(html, '<p class="meta" data-usage="true">About $0.20 in model costs · 15 tokens</p>');
  assert.equal(renderToStaticMarkup(h(UsageStrip, { usage: {} })), "", "nothing to show, no empty line");
});

test("only one strip shows on a page: the app's first, or a kit's fallback when the app placed none", () => {
  assert.equal(shownStrip([]), null);
  assert.equal(shownStrip([{ id: "agent", fallback: true }]), "agent");
  assert.equal(shownStrip([{ id: "agent", fallback: true }, { id: "app", fallback: false }]), "app");
  assert.equal(shownStrip([{ id: "app1", fallback: false }, { id: "app2", fallback: false }]), "app1");
});

test("a destructive action is a small text button that only opens a dialog, with Keep it focused", () => {
  const html = renderToStaticMarkup(h(ConfirmButton, { label: "Clear saved run", question: "Clear this run?", detail: "Its groups go too. This can't be undone.", onConfirm() {} }));
  assert.match(html, /^<button type="button" class="text" data-destructive="true">/);
  assert.doesNotMatch(html.slice(0, html.indexOf("<dialog")), /primary|secondary|tinted/, "never a filled or full-width button");
  const dialog = html.slice(html.indexOf("<dialog"));
  const labelled = /<dialog aria-labelledby="([^"]+)">/.exec(dialog);
  assert.ok(labelled, "the dialog is named by its question");
  assert.match(dialog, new RegExp(`<h2 id="${labelled[1]}">Clear this run\\?</h2>`));
  assert.match(dialog, /<p>Its groups go too\. This can&#x27;t be undone\.<\/p>/);
  assert.match(dialog, /class="primary">Clear saved run<\/button>/);
  assert.match(dialog, /class="secondary"[^>]*>Keep it<\/button>/);
  assert.doesNotMatch(dialog, /<dialog[^>]* open/, "closed until the button is pressed");
});
