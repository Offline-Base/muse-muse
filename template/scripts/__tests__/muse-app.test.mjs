// Tests for the muse-app look: the overlay in targets/muse-app/ that a build gets when MUSE_APP_LOOK is on
// (docs/BRAND.md). Its contrast checks are in contrast.test.mjs, next to the base theme's. Plain node. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
// Some overlay files are copies of base template files with a few lines changed (DERIVED). When a base file changes,
// remake them and read the diff:
//   UPDATE_OVERLAY=1 npx tsx --test template/scripts/__tests__/muse-app.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = path.join(TEMPLATE, "targets/muse-app");
const FILES = path.join(TARGET, "files");
const SKILL = path.join(FILES, ".agents/skills/muse-app-ui");
const read = (file) => readFileSync(file, "utf8");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const overlayFiles = () => walk(FILES).map((f) => path.relative(FILES, f)).sort();

/**
 * Overlay files that are a base template file with a few exact edits, so the look's words reach the places a build
 * reads first. Each `from` must be in the base file exactly once; `all: true` replaces every one.
 */
const DERIVED = [
  {
    path: "AGENTS.md",
    edits: [
      [
        "- Restyle with the tokens in `app/globals.css` and the meta-ui skill.",
        "- Restyle with the tokens in `app/globals.css` and `app/muse-app.css`, and the muse-app-ui skill.",
      ],
      [
        "The fonts are Inter and Montserrat, installed from npm (`@fontsource-variable/inter`, `@fontsource-variable/montserrat`) and imported in `app/layout.tsx`: use `--font` and `--font-display`, and add no other fonts.",
        "The font is Inter with its optical size axis, installed from npm (`@fontsource-variable/inter/opsz.css`) and imported in `app/layout.tsx`: use `--font` (`--font-display` is the same family), and add no other fonts.",
      ],
      [
        "- Follow `.agents/skills/meta-ui` for the look: the Meta design language, with Facebook's colors, Inter and Montserrat type, flat white cards and one blue-to-violet gradient that only marks AI.",
        "- Follow `.agents/skills/muse-app-ui` for the look: a white page, hairline cards, regular-weight Inter, one blue for actions and one purple gradient that only marks AI. Its tokens are in `app/muse-app.css`, which loads after `app/globals.css`.",
      ],
      ["Meta blue is the only signature color.", "The action blue is the only signature color."],
      ["listed in the meta-ui skill's Parts table", "listed in the muse-app-ui skill's Parts table"],
    ],
  },
  {
    path: ".agents/skills/product-ui/SKILL.md",
    edits: [
      [
        "for how every screen looks: the Meta tokens, type, parts and patterns. Use the tokens and classes in `app/globals.css` for every",
        "for how every screen looks: its tokens, type, parts and patterns. Use the tokens and classes in `app/globals.css` and `app/muse-app.css` for every",
      ],
      ["(Meta blue is the only signature color)", "(the action blue is the only signature color)"],
      ["meta-ui", "muse-app-ui", { all: true }],
    ],
  },
  {
    path: "app/layout.tsx",
    edits: [
      ['import "@fontsource-variable/inter";\nimport "@fontsource-variable/montserrat";\n', 'import "@fontsource-variable/inter/opsz.css";\n'],
      ['import "./globals.css";\n', 'import "./globals.css";\nimport "./muse-app.css";\n'],
      ['{ media: "(prefers-color-scheme: dark)", color: "#252728" }', '{ media: "(prefers-color-scheme: dark)", color: "#181819" }'],
    ],
  },
  {
    path: "app/page.tsx",
    edits: [["(meta-ui skill for the look)", "(muse-app-ui skill for the look)"]],
  },
];

function derive({ path: file, edits }) {
  let text = read(path.join(TEMPLATE, file));
  for (const [from, to, opts] of edits) {
    const count = text.split(from).length - 1;
    if (opts?.all) assert.ok(count > 0, `${file} no longer says "${from}". Update DERIVED in muse-app.test.mjs.`);
    else assert.equal(count, 1, `${file} changed where the muse-app overlay edits it ("${from.slice(0, 70)}"). Update DERIVED in muse-app.test.mjs.`);
    text = text.split(from).join(to);
  }
  return text;
}

describe("the overlay", () => {
  test("adds no npm dependencies: Inter's optical size files come with the template's own @fontsource-variable/inter", () => {
    assert.deepEqual(JSON.parse(read(path.join(TARGET, "deps.json"))), {});
    const pkg = JSON.parse(read(path.join(TEMPLATE, "package.json")));
    assert.equal(pkg.dependencies["@fontsource-variable/inter"], "5.3.0");
  });

  test("its platform files exist, and the skill is one", () => {
    const platform = JSON.parse(read(path.join(TARGET, "platform-files.json")));
    for (const file of platform) assert.ok(existsSync(path.join(FILES, file)), `${file} is missing`);
    assert.deepEqual(platform, [".agents/skills/muse-app-ui"]);
  });

  test("holds the skill, the look's tokens, the files that load them and the files that name the skill", () => {
    assert.deepEqual(overlayFiles(), [
      ".agents/skills/meta-ui/SKILL.md",
      ".agents/skills/meta-ui/reference/components.md",
      ".agents/skills/meta-ui/reference/sources.md",
      ".agents/skills/meta-ui/reference/tokens.md",
      ".agents/skills/muse-app-ui/SKILL.md",
      ".agents/skills/muse-app-ui/reference/components.md",
      ".agents/skills/muse-app-ui/reference/screens.md",
      ".agents/skills/muse-app-ui/reference/sources.md",
      ".agents/skills/muse-app-ui/reference/tokens.md",
      ".agents/skills/product-ui/SKILL.md",
      "AGENTS.md",
      "app/layout.tsx",
      "app/muse-app.css",
      "app/page.tsx",
    ]);
  });

  for (const spec of DERIVED) {
    test(`${spec.path} is the base template's with only the look's edits`, () => {
      const want = derive(spec);
      const file = path.join(FILES, spec.path);
      if (process.env.UPDATE_OVERLAY) writeFileSync(file, want);
      assert.equal(read(file), want, `targets/muse-app/files/${spec.path} is out of step with template/${spec.path}. Run UPDATE_OVERLAY=1 npx tsx --test template/scripts/__tests__/muse-app.test.mjs and read the diff.`);
    });
  }

  test("the copies name muse-app-ui wherever the base files name meta-ui", () => {
    for (const { path: file } of DERIVED) assert.doesNotMatch(read(path.join(FILES, file)), /meta-ui|Montserrat/, file);
  });

  test("the layout loads Inter's optical size axis, then globals.css, then the look's tokens", () => {
    const layout = read(path.join(FILES, "app/layout.tsx"));
    const order = ['import "@fontsource-variable/inter/opsz.css";', 'import "./globals.css";', 'import "./muse-app.css";'].map((s) => layout.indexOf(s));
    assert.ok(order.every((i) => i >= 0), "every import is there");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");
    assert.match(layout, /<Footer \/>/, "keeps the footer");
  });

  test("nothing comes from a font CDN or a remote host, and Meta's typeface is never named", () => {
    for (const file of overlayFiles()) {
      const text = read(path.join(FILES, file));
      assert.doesNotMatch(text, /fonts\.googleapis|fonts\.gstatic|from ["']next\/font\/google["']|@import\s+url\(\s*["']?https?:/i, file);
      assert.doesNotMatch(text, /optimistic/i, file);
    }
    assert.doesNotMatch(read(path.join(FILES, "app/muse-app.css")), /url\(/, "the CSS loads nothing");
  });

  test("no em dashes in any overlay file", () => {
    for (const file of overlayFiles()) assert.doesNotMatch(read(path.join(FILES, file)), /—/, file);
  });
});

describe("the muse-app-ui skill", () => {
  const skill = read(path.join(SKILL, "SKILL.md"));
  const refs = Object.fromEntries(["components", "screens", "tokens", "sources"].map((n) => [n, read(path.join(SKILL, `reference/${n}.md`))]));
  const css = read(path.join(TEMPLATE, "app/globals.css")) + read(path.join(FILES, "app/muse-app.css"));
  const snippets = [skill, refs.components, refs.screens].flatMap((md) => [...md.matchAll(/```(?:tsx|ts)\n([\s\S]*?)```/g)].map((m) => m[1]));

  test("is named for the prompts that point at it", () => {
    assert.match(skill, /^---\nname: muse-app-ui\ndescription: Use for every screen of this Muse Muse product\./);
    assert.match(read(path.join(FILES, ".agents/skills/meta-ui/SKILL.md")), /^---\nname: meta-ui\ndescription: Not this product's look\. This product uses muse-app-ui/);
  });

  test("has a part for every place that points at meta-ui, whose stub sends it here", () => {
    for (const heading of ["**First screen", "**Working.**", "**The result replaces the input.**", "**AI result card.**", "## Parts", "## Accessibility"]) assert.ok(skill.includes(heading), heading);
    assert.match(refs.components, /getComputedStyle\(b, "::before"\)/, "the bars check verify's skill points at");
    for (const heading of ["## Tool", "## Form", "## Results", "## Gallery", "## Chat"]) assert.ok(refs.screens.includes(heading), heading);
  });

  test("keeps the product the person's own: the footer, no Meta marks or names, no dead controls", () => {
    assert.ok(skill.includes('"Built with Muse Muse. Not an official Meta product."'));
    assert.match(skill, /## The product is the person's own/);
    assert.match(skill, /No dead controls\./);
    assert.match(skill, /one ModelChip on each result a model made/i);
    for (const code of snippets) assert.doesNotMatch(code, /Meta/, "no snippet says Meta");
  });

  test("snippets use tokens and the template's classes, never raw colors", () => {
    assert.ok(snippets.length >= 12, `${snippets.length} snippets`);
    for (const code of snippets) {
      assert.doesNotMatch(code, /#[0-9a-f]{3,8}\b|rgba?\(/i, code.slice(0, 80));
      const classes = [...code.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
      for (const name of classes) assert.match(css, new RegExp(`\\.${name}(?![\\w-])`), `.${name} isn't in globals.css or muse-app.css`);
    }
  });

  test("snippets use only the template's components and icons", () => {
    const icons = [...read(path.join(TEMPLATE, "components/Icon.tsx")).matchAll(/^\s+"?([a-z-]+)"?: [<(]/gm)].map((m) => m[1]);
    assert.ok(icons.includes("sparkle") && icons.includes("download"), `read the icon names: ${icons.join(", ")}`);
    for (const code of snippets) {
      for (const [, name] of code.matchAll(/<([A-Z]\w*)/g)) assert.ok(existsSync(path.join(TEMPLATE, `components/${name}.tsx`)), `<${name}> isn't a component`);
      for (const [, name] of code.matchAll(/<Icon name="([^"]+)"/g)) assert.ok(icons.includes(name), `no icon ${name}`);
    }
  });

  test("every token it lists is set in globals.css or muse-app.css, and every new one is listed", () => {
    const listed = new Set([...skill.matchAll(/`(--[\w-]+)`/g), ...refs.tokens.matchAll(/`(--[\w-]+)`/g)].map((m) => m[1]));
    for (const token of listed) if (!token.endsWith("-")) assert.match(css, new RegExp(`${token}\\s*:`), `${token} isn't set`);
    const base = read(path.join(TEMPLATE, "app/globals.css"));
    const added = [...read(path.join(FILES, "app/muse-app.css")).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]).filter((t) => !new RegExp(`${t}\\s*:`).test(base));
    assert.deepEqual([...new Set(added)].sort(), ["--glass", "--segment", "--send-from", "--send-to", "--shadow-card"]);
    for (const token of added) assert.ok(listed.has(token), `${token} isn't in tokens.md`);
  });
});

describe("muse-app.css", () => {
  const base = read(path.join(TEMPLATE, "app/globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const look = read(path.join(FILES, "app/muse-app.css")).replace(/\/\*[\s\S]*?\*\//g, "");

  test("changes values, not names: every class it styles is one globals.css has, apart from .hero.center", () => {
    const classes = new Set([...look.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]).filter((c) => !/^\d/.test(c)));
    for (const name of classes) if (name !== "center") assert.match(base, new RegExp(`\\.${name}(?![\\w-])`), `.${name} is new`);
  });

  test("keeps the parts verify and the judge's screenshots read", () => {
    assert.doesNotMatch(look, /data-result|\.card\.ai|display:\s*none/, "doesn't restyle what the checks find");
  });
});
