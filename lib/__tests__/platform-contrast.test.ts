/**
 * The platform's text and fill pairs (docs/BRAND.md, Color) pass WCAG AA in light and in both dark blocks, reading the
 * tokens straight from app/globals.css, and the rules that paint those pairs use the tokens checked here. The measured
 * placeholder and the gradient button's label are left out: they are owner calls, under AA on purpose (BRAND.md).
 *   npx tsx --test lib/__tests__/platform-contrast.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const APP = path.join(import.meta.dirname, "../../app");
const CSS = readFileSync(path.join(APP, "globals.css"), "utf8");
const DOCS_CSS = readFileSync(path.join(APP, "docs/docs.css"), "utf8");

interface Rule {
  prelude: string;
  body: string;
  children: Rule[];
}

/** Splits CSS into a tree of rules, with comments removed. */
function parse(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const block = (): Rule[] => {
    const nodes: Rule[] = [];
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

/** The custom properties a rule declares itself. */
function tokensOf(rule: Rule | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (rule?.body ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  return out;
}

const tree = parse(CSS);
const top = (prelude: string) => tree.find((n) => n.prelude === prelude);
const darkMedia = tree.find((n) => /^@media\s*\(prefers-color-scheme:\s*dark\)$/.test(n.prelude));
const LIGHT = tokensOf(top(":root"));
const DARK_MEDIA = tokensOf(darkMedia?.children.find((n) => n.prelude === ':root:not([data-theme="light"])'));
const DARK_PICKED = tokensOf(top(':root[data-theme="dark"]'));
const THEMES: Array<[string, Record<string, string>]> = [
  ["light", LIGHT],
  ["dark (system)", { ...LIGHT, ...DARK_MEDIA }],
  ["dark (picked)", { ...LIGHT, ...DARK_PICKED }],
];

/** A token's final value, following var() references. */
function resolve(tokens: Record<string, string>, value: string, seen = new Set<string>()): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    if (seen.has(name)) throw new Error(`${name} refers to itself`);
    if (!(name in tokens)) throw new Error(`${name} is not defined`);
    return resolve(tokens, tokens[name], new Set([...seen, name]));
  });
}

type RGBA = [number, number, number, number];

/** A color from #rrggbb, #rrggbbaa, rgb(), rgba(), white, or color-mix(in srgb, <color> N%, <color>). */
function color(text: string): RGBA {
  const t = text.trim().toLowerCase();
  if (t === "white") return [255, 255, 255, 1];
  let m = t.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/);
  if (m) {
    const h = m[1];
    const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
    return [r, g, b, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  m = t.match(/^color-mix\(in srgb,\s*(\S+)\s+([\d.]+)%,\s*(\S+)\)$/);
  if (m) {
    const [a, p, b] = [color(m[1]), Number(m[2]) / 100, color(m[3])];
    return [0, 1, 2, 3].map((k) => a[k] * p + b[k] * (1 - p)) as RGBA;
  }
  throw new Error(`can't read the color "${text}"`);
}

/** Paints `top` (which may be translucent) over an opaque `base`. */
const over = (front: RGBA, base: RGBA): RGBA => [0, 1, 2].map((k) => front[k] * front[3] + base[k] * (1 - front[3])).concat(1) as RGBA;
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGBA) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function ratio(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A stack like "--surface + --ok-soft", bottom first, painted over --bg. */
function paint(tokens: Record<string, string>, stack: string): RGBA {
  let out = color(resolve(tokens, "var(--bg)"));
  for (const layer of stack.split("+").map((s) => s.trim())) out = over(color(resolve(tokens, `var(${layer})`)), out);
  return out;
}

// [text, background stack, where it's used]. Text needs 4.5:1.
const TEXT: Array<[string, string, string]> = [
  ["--fg", "--bg", "body text"],
  ["--fg-2", "--bg", "emphasized secondary text"],
  ["--muted", "--bg", "secondary text"],
  ["--accent-text", "--bg", "links"],
  ["--fg-2", "--surface + --surface-3", "the Concept tag, pills, vibe tags and step numbers"],
  ["--fg-2", "--surface-2", "notes on a filled band"],
  ["--fg", "--surface + --surface-3", "secondary buttons"],
  ["--ok-text", "--surface + --ok-soft", "the live pill, a done step, the done callout"],
  ["--warn-text", "--surface + --warn-soft", "the partial pill, warning callouts, the ask tag"],
  ["--bad", "--surface + --bad-soft", "the failed pill and error boxes"],
  ["--accent-text", "--surface + --accent-soft", "the building pill and the you tag"],
  ["--accent-ink", "--accent-fill", "the skip link and the current step's number"],
];

// Icons, dots, rings and bars need 3:1.
const SHAPES: Array<[string, string, string]> = [
  ["--ok", "--surface + --ok-soft", "a done icon on its tint"],
  ["--warn", "--surface + --warn-soft", "a warning icon on its tint"],
  ["--bad", "--surface + --bad-soft", "an error icon on its tint"],
  ["--accent-ink", "--accent-fill", "the check in a done box or step"],
  ["--focus", "--bg", "focus outlines"],
  ["--accent", "--bg", "switches, meters and progress"],
];

function failures(tokens: Record<string, string>, pairs: Array<[string, string, string]>, min: number): string[] {
  const out: string[] = [];
  for (const [fg, bg, where] of pairs) {
    const back = paint(tokens, bg);
    const r = ratio(over(color(resolve(tokens, `var(${fg})`)), back), back);
    if (r < min) out.push(`${fg} on ${bg} (${where}): ${r.toFixed(2)}`);
  }
  return out;
}

/** The declarations a top-level rule makes, as "property: value" lines. */
function declarations(prelude: string): string[] {
  const rule = top(prelude);
  assert.ok(rule, `no top-level rule "${prelude}" in app/globals.css`);
  return rule.body
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

describe("platform contrast (app/globals.css)", () => {
  it("sets the same dark tokens under prefers-color-scheme and data-theme", () => {
    assert.ok(Object.keys(DARK_MEDIA).length > 20, "no dark :root block under prefers-color-scheme: dark");
    assert.deepEqual(DARK_PICKED, DARK_MEDIA);
  });

  for (const [mode, tokens] of THEMES) {
    it(`passes AA (4.5:1) for every text pair in ${mode}`, () => {
      assert.deepEqual(failures(tokens, TEXT, 4.5), []);
    });

    it(`gives icons, rings and bars 3:1 in ${mode}`, () => {
      assert.deepEqual(failures(tokens, SHAPES, 3), []);
    });
  }

  it("paints status text on tints, and white on accent fills, with the tokens checked above", () => {
    const uses: Array<[string, string]> = [
      [".pill-live", "color: var(--ok-text)"],
      [".vibe-done", "color: var(--ok-text)"],
      [".vibe-step-done .vibe-step-num", "color: var(--ok-text)"],
      [".pill-partial", "color: var(--warn-text)"],
      [".train-callout-warn", "color: var(--warn-text)"],
      [".vibe-callout", "color: var(--warn-text)"],
      [".vibe-tag-ask", "color: var(--warn-text)"],
      [".concept", "color: var(--fg-2)"],
      [".vibe-tag", "color: var(--fg-2)"],
      [".skip-link", "background: var(--accent-fill)"],
      [".vibe-trylive-icon", "background: var(--accent-fill)"],
      [".vibe-step-current .vibe-step-num", "background: var(--accent-fill)"],
      [".todo-completed .todo-box", "background: var(--accent-fill)"],
      [".rail-done .rail-dot", "background: var(--accent-fill)"],
    ];
    for (const [prelude, decl] of uses) assert.ok(declarations(prelude).includes(decl), `${prelude} should set ${decl}`);
  });

  it("holds the tokens added after the docs freeze at the docs' own values", () => {
    const freeze = tokensOf(parse(DOCS_CSS).find((n) => n.prelude.replace(/\s+/g, " ") === ":root:has(.docs-frame), :root:has(.docs-nav)"));
    assert.equal(freeze["--accent-fill"], "var(--accent)");
    assert.equal(freeze["--ok-text"], "var(--ok)");
    assert.equal(freeze["--warn-text"], "var(--warn)");
  });
});
