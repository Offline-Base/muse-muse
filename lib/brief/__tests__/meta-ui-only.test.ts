/**
 * META_UI_ONLY (owner, Nov 3, docs/BRAND.md): every new product on the meta-ui skill, whatever MUSE_APP_LOOK,
 * BUILDS_ON_CONTRIBUTOR or BUILD_RANGE say. BUILD_RANGE keeps its depth, limits and agents, and loses only its look. A fix
 * or change keeps the look the product's own files have. Off, everything is as it was (flags-off.test.ts, range.test.ts).
 *
 *   npx tsx --experimental-test-module-mocks --test lib/brief/__tests__/meta-ui-only.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderBuildPrompt, renderFixPrompt, renderRefinePrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { env } from "@/lib/env";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { briefInstructions } from "@/lib/prompts/brief";
import { JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { DIRECTION_STARTS, type Direction } from "@/lib/range/direction";
import { flagsOffSurface } from "./flags-off-surface";

const NAMES = ["META_UI_ONLY", "MUSE_APP_LOOK", "BUILDS_ON_CONTRIBUTOR", "BUILD_RANGE", "MUSE_FULL"] as const;
const GOLDEN = join(import.meta.dirname, "golden");
const golden = (name: string) => readFileSync(join(GOLDEN, name), "utf8");

const DIRECTION: Direction = {
  summary: "A printed almanac for bird watchers, warm and dense.",
  scheme: "light",
  palette: { background: "#f4ecd8", surface: "#fbf6e9", text: "#2a2118", mutedText: "#5c4e3c", accent: "#8c2f1b", onAccent: "#ffffff", secondary: "#3e6b57" },
  displayFont: { package: "@fontsource-variable/fraunces", family: "Fraunces Variable" },
  bodyFont: { package: "@fontsource/source-serif-4", family: "Source Serif 4" },
  density: "Tight, like a printed table.",
  layout: "One column on a phone, three panes on a desktop.",
  shape: "Square corners.",
  motion: "Rows fade in.",
  imagery: "Engraving-style drawings.",
};
const WITH: Brief = { ...BRIEF, direction: DIRECTION };
const RANGE = { start: DIRECTION_STARTS[0], recent: [] };
const OPTS = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
/** What build-steps.ts lookNote() and rangeNote() give the prompts with META_UI_ONLY and BUILD_RANGE on. */
const NOTE = { museAppLook: false, metaUiOnly: true, buildRange: true };

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("META_UI_ONLY in lib/env.ts", () => {
  it("is off by default and reads 1, true, yes or on", () => {
    assert.equal(env.metaUiOnly, false);
    for (const on of ["1", "true", "YES", " on "]) {
      process.env.META_UI_ONLY = on;
      assert.equal(env.metaUiOnly, true, on);
    }
    for (const off of ["", "0", "off", "meta-ui"]) {
      process.env.META_UI_ONLY = off;
      assert.equal(env.metaUiOnly, false, off);
    }
  });

  it("turns the muse-app look off whatever MUSE_APP_LOOK, BUILDS_ON_CONTRIBUTOR or BUILD_RANGE say", () => {
    for (const name of ["MUSE_APP_LOOK", "BUILDS_ON_CONTRIBUTOR", "BUILD_RANGE"] as const) {
      process.env[name] = "1";
      assert.equal(env.museAppLook, true, `${name} alone`);
      process.env.META_UI_ONLY = "1";
      assert.equal(env.museAppLook, false, `${name} with META_UI_ONLY`);
      delete process.env.META_UI_ONLY;
      delete process.env[name];
    }
    Object.assign(process.env, { MUSE_APP_LOOK: "1", BUILDS_ON_CONTRIBUTOR: "1", BUILD_RANGE: "1", META_UI_ONLY: "1" });
    assert.equal(env.museAppLook, false);
  });

  it("leaves BUILD_RANGE's other settings on", () => {
    Object.assign(process.env, { BUILD_RANGE: "1", META_UI_ONLY: "1" });
    assert.equal(env.buildRange, true);
    assert.equal(env.museFull, true);
  });

  it("with MUSE_APP_LOOK and BUILD_RANGE on, the writer, the build prompt and the judge are the meta-ui goldens", () => {
    // BUILDS_ON_CONTRIBUTOR also rewrites the model catalog, which isn't the look, so it stays out of this one.
    Object.assign(process.env, { MUSE_APP_LOOK: "1", BUILD_RANGE: "1", META_UI_ONLY: "1" });
    const surface = flagsOffSurface();
    for (const name of ["brief-instructions.txt", "build-prompt.txt", "judge-instructions.txt", "new-brief.schema.json", "brief.md"]) {
      assert.equal(surface[name], golden(name), name);
    }
  });
});

describe("the brief writer with META_UI_ONLY", () => {
  it("uses the meta-ui borrow line and picks no direction, even with BUILD_RANGE", () => {
    const text = briefInstructions({ museAppLook: false, range: RANGE, metaUiOnly: true });
    assert.match(text, /^- borrow .*Meta blue, Inter and Montserrat type, white cards/m);
    assert.doesNotMatch(text, /Design direction|direction is this product's own look|askedLook|approximate hex value|The mood may show in colors/);
    assert.ok(!text.includes(DIRECTION_STARTS[0]));
    assert.match(text, /Describe colors as roles \(a dark header, a warm accent\), not hex values\./);
    // BUILD_RANGE's other lines stay: more screens, every model that helps.
    assert.match(text, /screens lists the screens a real product needs/);
    assert.match(text, /Use every listed model that makes this product clearly better/);
  });

  it("is the meta-ui writer exactly without BUILD_RANGE, even if the muse-app look were asked for", () => {
    assert.equal(briefInstructions({ museAppLook: true, metaUiOnly: true }), briefInstructions());
  });

  it("asks for no direction or askedLook, and keeps BUILD_RANGE's limits", () => {
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: false, buildRange: true, metaUiOnly: true });
    const props = (strictJsonSchema(schema) as { properties: object }).properties;
    assert.ok(!("direction" in props));
    assert.ok(!("askedLook" in props));
    const screens = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, purpose: "p" }));
    assert.equal(schema.safeParse({ ...BRIEF, screens }).success, true);
    assert.equal(schema.safeParse({ ...BRIEF, screens: [...screens, { name: "x", purpose: "p" }] }).success, false);
  });

  it("off, BUILD_RANGE still asks for a direction", () => {
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: true, buildRange: true });
    assert.ok((strictJsonSchema(schema) as { required: string[] }).required.includes("direction"));
    assert.match(briefInstructions({ museAppLook: true, range: RANGE }), /Design direction/);
  });
});

describe("the judge with META_UI_ONLY", () => {
  it("gets the plain meta-ui house style, even with BUILD_RANGE and a direction", () => {
    assert.equal(judgeInstructions(WITH, { museAppLook: true, buildRange: true, metaUiOnly: true }), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions(BRIEF, { museAppLook: true, metaUiOnly: true }), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions({ ...BRIEF, askedLook: "Dark with neon green." }, { museAppLook: true, metaUiOnly: true }), JUDGE_INSTRUCTIONS);
  });

  it("off, BUILD_RANGE and MUSE_APP_LOOK still widen it", () => {
    assert.match(judgeInstructions(WITH, { museAppLook: true, buildRange: true }), /on craft and on fit to this direction/);
    assert.match(judgeInstructions(BRIEF, { museAppLook: true }), /one of two Meta-inspired house styles/);
  });
});

describe("the build prompt with META_UI_ONLY and BUILD_RANGE", () => {
  it("sends the build to meta-ui, with BUILD_RANGE's depth and no direction", () => {
    for (const brief of [BRIEF, WITH]) {
      const text = renderBuildPrompt(brief, { ...OPTS, ...NOTE });
      assert.match(text, /read `\.agents\/skills\/meta-ui` for the look/);
      assert.match(text, /^The look always comes from the meta-ui skill, in Meta blue\. The inspo's mood shows only in the copy/m);
      assert.doesNotMatch(text, /muse-app|Design direction|The inspo's mood may show in colors/);
      assert.match(text, /## Depth/);
      assert.match(text, /Then build every other screen/);
      assert.match(text, /really fails three times/);
      assert.match(text, /at most 10 model calls/);
    }
  });

  it("a complex build must still use agents", () => {
    const text = renderBuildPrompt({ ...BRIEF, complexity: "complex" }, { ...OPTS, ...NOTE, playbook: true });
    assert.match(text, /## How you must work\n\nThis build is complex, so these steps are required/);
    assert.match(text, /which subagents and workflows ran/);
  });

  it("a refused brief gets none of it", () => {
    assert.doesNotMatch(renderBuildPrompt({ ...BRIEF, verdict: "no", refusal: "No." }, { ...OPTS, ...NOTE }), /## Depth|How you must work/);
  });

  it("off, a brief with no direction keeps its old prompt", () => {
    assert.equal(renderBuildPrompt(BRIEF, { ...OPTS, museAppLook: true, buildRange: true }), renderBuildPrompt(BRIEF, { ...OPTS, museAppLook: true }));
  });
});

describe("fixes and changes with META_UI_ONLY", () => {
  const KEEP = /- Keep the product's current look: the tokens and parts in `app\/globals\.css`, with `app\/muse-app\.css` and `\.agents\/skills\/muse-app-ui` when the product has them, or else `\.agents\/skills\/meta-ui` if it exists\./;

  it("keep the look the product's own files have", () => {
    const fix = renderFixPrompt({ verify: null, judge: null, round: 1, ...NOTE });
    const refine = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], museAppLook: false, metaUiOnly: true });
    for (const text of [fix, refine]) assert.match(text, KEEP);
    assert.match(fix, /if it exists\. Fix what the judge saw with those, not with new colors, fonts or styles\.\n/);
    assert.doesNotMatch(fix, /Keep the Design direction/);
    assert.match(fix, /subagent with worktree isolation/, "BUILD_RANGE's agents stay");
    assert.match(refine, /if it exists\. Don't restyle what the request doesn't change\.\n/);
  });

  it("off, they are as they were", () => {
    assert.equal(renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: false }), renderFixPrompt({ verify: null, judge: null, round: 1 }));
    assert.match(renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true, buildRange: true }), /Keep the Design direction/);
    assert.doesNotMatch(renderRefinePrompt({ message: "x", newReferences: [] }), /muse-app/);
  });
});
