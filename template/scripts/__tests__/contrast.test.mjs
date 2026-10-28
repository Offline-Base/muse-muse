// Checks that every text and fill pair the Meta theme relies on passes WCAG AA, in light and dark mode and for every
// data-accent hue, reading the tokens straight from app/globals.css. Plain node, no build step. Run from template/:
//   node --test scripts/__tests__/contrast.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CSS = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const HUES = ["cherry", "grape", "lemon", "lime", "pink", "teal"];

/** Splits CSS into a tree of { prelude, body, children }, with comments removed. */
function parse(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const block = () => {
    const nodes = [];
    let start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === "{") {
        const prelude = src.slice(start, i).trim();
        i++;
        const bodyStart = i;
        const children = block();
        nodes.push({ prelude, body: src.slice(bodyStart, i - 1), children });
        start = i;
      } else if (c === "}") {
        i++;
        return nodes;
      } else {
        if (c === ";") start = i + 1;
        i++;
      }
    }
    return nodes;
  };
  return block();
}

/** The custom properties declared directly in a rule body (not in nested blocks). */
function declarations(node) {
  const flat = node.children.length ? node.body.replace(/[^{};]*\{[^{}]*\}/g, "") : node.body;
  const out = {};
  for (const m of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  return out;
}

const tree = parse(CSS);
const rules = (nodes, selector) => nodes.filter((n) => n.prelude === selector).map(declarations);
const merge = (...maps) => Object.assign({}, ...maps.flat());
const darkMedia = tree.filter((n) => /^@media\s*\(prefers-color-scheme:\s*dark\)$/.test(n.prelude)).flatMap((n) => n.children);

const LIGHT = merge(rules(tree, ":root"));
const DARK = merge(LIGHT, rules(darkMedia, ":root"));
const accent = (hue, mode) => {
  const sel = `[data-accent="${hue}"]`;
  return mode === "light" ? merge(LIGHT, rules(tree, sel)) : merge(DARK, rules(tree, sel), rules(darkMedia, sel));
};
const THEMES = [
  ["light", LIGHT],
  ["dark", DARK],
];

/** Resolves a token to its final value, following var() references. */
function resolve(tokens, value, seen = new Set()) {
  return value.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (_, name, fallback) => {
    if (seen.has(name)) throw new Error(`${name} refers to itself`);
    if (!(name in tokens)) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${name} is not defined`);
    }
    return resolve(tokens, tokens[name], new Set([...seen, name]));
  });
}

/** [r, g, b, a] from #rgb, #rrggbb, #rrggbbaa, rgb() or rgba(). */
function color(text) {
  const t = text.trim().toLowerCase();
  if (t === "white") return [255, 255, 255, 1];
  let m = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const n = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
    return [...n, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
  }
  throw new Error(`can't read the color "${text}"`);
}

/** Paints `top` (which may be translucent) over an opaque `base`. */
const over = (top, base) => [0, 1, 2].map((k) => top[k] * top[3] + base[k] * (1 - top[3])).concat(1);
const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A layer stack like "--surface", "--tinted-bg" (painted over --surface) or "--accent + --accent-hover", bottom first.
 * Each layer is painted over the one below; the first layer sits on `base` (default --surface, which is opaque).
 */
function paint(tokens, stack, base = "--surface") {
  let out = color(resolve(tokens, `var(${base})`));
  for (const layer of stack.split("+").map((s) => s.trim())) out = over(color(layer.startsWith("--") ? resolve(tokens, `var(${layer})`) : layer), out);
  return out;
}

// [text, background stack, where it sits] for every pair a part relies on. Text needs 4.5:1.
const TEXT = [
  ["--fg", "--bg", "body text on the page"],
  ["--fg", "--surface", "body text on a card"],
  ["--fg", "--surface-2", "text in a note, table head or composer"],
  ["--fg", "--popover", "a menu"],
  ["--fg", "--toast-bg", "a toast"],
  ["--fg", "--input-bg", "a typed value"],
  ["--fg-2", "--bg", "tagline and footer on the page"],
  ["--fg-2", "--surface", "hint, meta and limits on a card"],
  ["--fg-2", "--surface-2", "note text, table heads"],
  ["--fg-2", "--surface + --hover", "secondary line of a hovered list row"],
  ["--placeholder", "--input-bg", "placeholder"],
  ["--link", "--surface", "links and text buttons on a card"],
  ["--link", "--bg", "links on the page"],
  ["--link", "--surface-2", "the filled dropzone's change link"],
  ["--on-accent", "--accent", "primary button, outgoing bubble"],
  ["--on-accent", "--accent + --accent-hover", "hovered primary button"],
  ["--tinted-fg", "--tinted-bg", "tinted button, selected chip or segment"],
  ["--tinted-fg", "--tinted-hover-bg", "hovered tinted button"],
  ["--tinted-fg", "--ai-soft", "busy tinted AI button, at the violet end of its moving fill"],
  ["--fg", "--secondary-bg", "secondary button, chip"],
  ["--fg", "--secondary-bg + --hover", "hovered secondary button"],
  ["--fg", "--surface + --hover", "hovered list row or segment"],
  ["--fg", "--tinted-bg", "dropzone while a file is dragged over it"],
  ["--fg", "--positive-soft", "positive chip"],
  ["--fg", "--negative-soft", "error box, negative chip"],
  ["--positive", "--surface", "positive text"],
  ["--negative", "--surface", "negative text"],
  ["--fg", "--bubble-in", "incoming bubble"],
  ["--signature-ink", "--signature-soft", "text in the signature element"],
  ["--signature-ink", "--surface", "signature text on a card"],
  ["--fg", "--signature-soft", "main text in the signature element"],
  ["--fg-2", "--signature-soft", "meta line in the signature element"],
  ["--on-media", "#ffffff + --scrim", "label on a photo, over its whitest part"],
];

// Shapes that must stand out from what is around them need 3:1.
const SHAPES = [
  ["--focus", "--surface", "focus ring on a card"],
  ["--focus", "--bg", "focus ring on the page"],
  ["--accent", "--surface", "primary button on a card"],
  ["--positive", "--surface", "positive icon"],
  ["--negative", "--surface", "negative icon"],
  ["--warning", "--surface", "warning icon"],
  ["--field-line", "--input-bg", "field border around its field"],
  ["--field-line", "--surface", "field border on a card"],
  ["--ai-end", "--surface", "sparkle on an AI label"],
];

function check(tokens, pairs, min) {
  const failures = [];
  for (const [fg, bg, where] of pairs) {
    const back = paint(tokens, bg);
    const front = over(color(resolve(tokens, `var(${fg})`)), back);
    const r = ratio(front, back);
    if (r < min) failures.push(`${fg} on ${bg} (${where}): ${r.toFixed(2)}`);
  }
  return failures;
}

test("the theme declares light and dark tokens", () => {
  for (const name of ["--bg", "--surface", "--fg", "--fg-2", "--accent", "--link", "--tinted-bg", "--ai-start", "--ai-end", "--signature"]) {
    assert.ok(name in LIGHT, `${name} missing from :root`);
  }
  assert.ok(Object.keys(rules(darkMedia, ":root")[0] ?? {}).length > 10, "no dark :root block under prefers-color-scheme: dark");
  assert.notEqual(resolve(DARK, "var(--bg)"), resolve(LIGHT, "var(--bg)"));
  for (const hue of HUES) {
    assert.ok(rules(tree, `[data-accent="${hue}"]`).length, `no light [data-accent="${hue}"]`);
    assert.ok(rules(darkMedia, `[data-accent="${hue}"]`).length, `no dark [data-accent="${hue}"]`);
  }
});

for (const [mode, tokens] of THEMES) {
  test(`every text pair passes AA (4.5:1) in ${mode} mode`, () => {
    assert.deepEqual(check(tokens, TEXT, 4.5), []);
  });

  test(`focus rings, buttons and status icons stand out (3:1) in ${mode} mode`, () => {
    assert.deepEqual(check(tokens, SHAPES, 3), []);
  });

  test(`white text stays AA along the whole AI gradient in ${mode} mode`, () => {
    const [a, b] = [color(resolve(tokens, "var(--ai-start)")), color(resolve(tokens, "var(--ai-end)"))];
    for (let t = 0; t <= 1.0001; t += 0.125) {
      const stop = [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t).concat(1);
      const r = ratio([255, 255, 255, 1], stop);
      assert.ok(r >= 4.5, `white on the AI gradient at ${Math.round(t * 100)}%: ${r.toFixed(2)}`);
    }
  });

  test(`every data-accent hue keeps its signature text AA in ${mode} mode`, () => {
    const signature = TEXT.filter(([fg, bg]) => fg === "--signature-ink" || bg.includes("--signature-soft"));
    for (const hue of HUES) assert.deepEqual(check(accent(hue, mode), signature, 4.5), [], hue);
  });

  test(`chart bars and strokes stand out (3:1) in every data-accent hue in ${mode} mode`, () => {
    const lines = [
      ["--signature-line", "--surface", "a stroke on a card"],
      ["--signature-line", "--surface-2", "a bar on the chart's gray"],
    ];
    assert.deepEqual(check(tokens, lines, 3), [], "no accent");
    for (const hue of HUES) assert.deepEqual(check(accent(hue, mode), lines, 3), [], hue);
  });
}

test("buttons, links and focus stay Meta blue whatever the accent", () => {
  for (const [mode] of THEMES) {
    for (const hue of HUES) {
      const tokens = accent(hue, mode);
      const base = mode === "light" ? LIGHT : DARK;
      for (const name of ["--accent", "--link", "--focus", "--tinted-bg", "--tinted-fg"]) {
        assert.equal(resolve(tokens, `var(${name})`), resolve(base, `var(${name})`), `${hue} changes ${name} in ${mode} mode`);
      }
    }
  }
});
