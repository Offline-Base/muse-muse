// Unit tests for components/Markdown.tsx, rendered to HTML. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The repo root's tsconfig leaves template/ out, so tsx compiles the component's JSX to React.createElement calls.
globalThis.React = React;
const { Markdown } = await import("../../components/Markdown");
const createElement = React.createElement;

const md = (text) => renderToStaticMarkup(createElement(Markdown, { text })).replace(/^<div class="prose">|<\/div>$/g, "");

test("a reply with one part per line keeps its line breaks", () => {
  assert.equal(
    md("Wins: You shipped 20 orders.\nThemes: You balanced shop work and launch prep.\nNext steps: Share the launch post."),
    "<p>Wins: You shipped 20 orders.<br/>Themes: You balanced shop work and launch prep.<br/>Next steps: Share the launch post.</p>",
  );
  assert.equal(md("**Wins**\nYou shipped 20 orders."), "<p><strong>Wins</strong><br/>You shipped 20 orders.</p>");
});

test("a sentence wrapped by hand joins up again, unless the line ends in a markdown break", () => {
  assert.equal(md("All requests use a bearer token for\nauthentication, and limits apply\n(100 a minute)."), "<p>All requests use a bearer token for authentication, and limits apply (100 a minute).</p>");
  assert.equal(md("Keep **bold\nacross lines** and `code\nsplit` too."), "<p>Keep <strong>bold across lines</strong> and <code>code split</code> too.</p>");
  assert.equal(md("A line with two spaces  \nends here"), "<p>A line with two spaces<br/>ends here</p>");
  assert.equal(md("A backslash\\\nends here too"), "<p>A backslash<br/>ends here too</p>");
});

test("blank lines still split paragraphs, and headings and rules stand alone", () => {
  assert.equal(md("# Your week\nShort and steady.\n\nMore next week."), "<h3>Your week</h3><p>Short and steady.</p><p>More next week.</p>");
  assert.equal(md("## Authentication ##\nUse a token."), "<h3>Authentication</h3><p>Use a token.</p>");
  assert.equal(md("Part one.\n\n---\n\nPart two."), "<p>Part one.</p><hr/><p>Part two.</p>");
  assert.equal(md("#hashtag is not a heading"), "<p>#hashtag is not a heading</p>");
});

test("lists keep wrapped items, blank lines between items and their first number", () => {
  assert.equal(md("- one\n- two that\n  wraps\n\n- three"), "<ul><li>one</li><li>two that wraps</li><li>three</li></ul>");
  assert.equal(md("Steps:\n1. Mix\n2. Bake"), "<p>Steps:</p><ol><li>Mix</li><li>Bake</li></ol>");
  assert.equal(md("3. Rest\n4. Serve"), '<ol start="3"><li>Rest</li><li>Serve</li></ol>');
  assert.equal(md("- a\n\nAfter the list."), "<ul><li>a</li></ul><p>After the list.</p>");
  assert.equal(md("* * *"), "<hr/>");
});

test("code blocks, inline code and bold are unchanged", () => {
  assert.equal(md("```\nconst a = 1;\n  return a;\n```"), "<pre><code>const a = 1;\n  return a;</code></pre>");
  assert.equal(md("Call `GET /widgets` for **every** page."), "<p>Call <code>GET /widgets</code> for <strong>every</strong> page.</p>");
});

const titled = (text, title) =>
  renderToStaticMarkup(createElement(Markdown, { text, title })).replace(/^<div class="prose">|<\/div>$/g, "");

test("a first heading that repeats the card's title is left out, ignoring case and punctuation", () => {
  assert.equal(titled("# Faster Batch Reads with Acme Cache v2.4\n\nOne lookup is cheap.", "Faster batch reads with Acme Cache v2.4!"), "<p>One lookup is cheap.</p>");
  assert.equal(titled("\n## **Your week** ##\nShort and steady.", "Your week"), "<p>Short and steady.</p>");
  // A different heading, a heading after other text, or no title: the heading stays.
  assert.equal(titled("# Batch reads\nText.", "Faster batch reads"), "<h3>Batch reads</h3><p>Text.</p>");
  assert.equal(titled("Intro.\n\n# Your week", "Your week"), "<p>Intro.</p><h3>Your week</h3>");
  assert.equal(titled("Your week\nShort.", "Your week"), "<p>Your week<br/>Short.</p>");
  assert.equal(md("# Your week\nShort."), "<h3>Your week</h3><p>Short.</p>");
});
