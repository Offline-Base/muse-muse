/**
 * META_UI_ONLY (owner, Nov 3, corrected that evening, docs/BRAND.md): every new product has the Meta AI app look, the
 * muse-app overlay and its muse-app-ui skill, whatever MUSE_APP_LOOK, BUILDS_ON_CONTRIBUTOR or BUILD_RANGE say, with no
 * design direction and no asked look anywhere. BUILD_RANGE keeps its depth, limits and agents. A fix or change keeps the
 * look the product's own files have. Off, everything is as it was (flags-off.test.ts, range.test.ts, muse-app-look.test.ts).
 *
 *   npx tsx --experimental-test-module-mocks --test lib/brief/__tests__/meta-ui-only.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderBuildPrompt, renderFixPrompt, renderRefinePrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { env } from "@/lib/env";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { APP_LOOK_ONLY_LINE, briefInstructions } from "@/lib/prompts/brief";
import { JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { DIRECTION_STARTS, type Direction } from "@/lib/range/direction";

const NAMES = ["META_UI_ONLY", "MUSE_APP_LOOK", "BUILDS_ON_CONTRIBUTOR", "BUILD_RANGE", "MUSE_FULL"] as const;

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
const ASKED = "Dark with neon green.";
const WITH: Brief = { ...BRIEF, direction: DIRECTION, askedLook: ASKED };
const RANGE = { start: DIRECTION_STARTS[0], recent: [] };
const OPTS = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
/** What build-steps.ts lookNote() and rangeNote() give the prompts with META_UI_ONLY and BUILD_RANGE on. */
const NOTE = { museAppLook: true, metaUiOnly: true, buildRange: true };
/** The same with BUILD_RANGE off. */
const APP = { museAppLook: true, metaUiOnly: true };

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

  it("turns the muse-app look on by itself, and keeps it on whatever MUSE_APP_LOOK, BUILDS_ON_CONTRIBUTOR or BUILD_RANGE say", () => {
    assert.equal(env.museAppLook, false);
    process.env.META_UI_ONLY = "1";
    assert.equal(env.museAppLook, true, "alone");
    for (const name of ["MUSE_APP_LOOK", "BUILDS_ON_CONTRIBUTOR", "BUILD_RANGE"] as const) {
      for (const value of ["1", "0"]) {
        process.env[name] = value;
        assert.equal(env.museAppLook, true, `${name}=${value}`);
      }
      delete process.env[name];
    }
    delete process.env.META_UI_ONLY;
    assert.equal(env.museAppLook, false, "off again");
  });

  it("leaves BUILD_RANGE's other settings on", () => {
    Object.assign(process.env, { BUILD_RANGE: "1", META_UI_ONLY: "1" });
    assert.equal(env.buildRange, true);
    assert.equal(env.museFull, true);
  });
});

describe("the brief writer with META_UI_ONLY", () => {
  it("uses the muse-app borrow line with no asked-look part, and nothing else changes", () => {
    const text = briefInstructions(APP);
    const muse = briefInstructions({ museAppLook: true });
    assert.ok(text.includes(`\n${APP_LOOK_ONLY_LINE}\n`));
    assert.match(APP_LOOK_ONLY_LINE, /^- borrow .*Muse Muse's own app look \(a white page, hairline cards, regular-weight Inter, one blue for actions, a purple gradient only on what a model made\), so the mood carries over only/);
    assert.doesNotMatch(text, /askedLook|Montserrat|Design direction/);
    // The muse-app writer less its askedLook line and clause, byte for byte.
    const lines = muse.split("\n");
    const asked = lines.findIndex((l) => l.startsWith("- askedLook is null unless"));
    assert.ok(asked > 0);
    lines.splice(asked, 1);
    assert.equal(text, lines.join("\n").replace("so unless askedLook says otherwise the mood", "so the mood"));
  });

  it("with BUILD_RANGE picks no direction and no hex colors, and keeps its other lines", () => {
    const text = briefInstructions({ ...APP, range: RANGE });
    assert.ok(text.includes(`\n${APP_LOOK_ONLY_LINE}\n`));
    assert.doesNotMatch(text, /Design direction|direction is this product's own look|askedLook|approximate hex value|The mood may show in colors|Meta blue/);
    assert.ok(!text.includes(DIRECTION_STARTS[0]));
    assert.match(text, /Describe colors as roles \(a dark header, a warm accent\), not hex values\./);
    // BUILD_RANGE's other lines stay: more screens, every model that helps.
    assert.match(text, /screens lists the screens a real product needs/);
    assert.match(text, /Use every listed model that makes this product clearly better/);
  });

  it("asks for no direction or askedLook, and keeps BUILD_RANGE's limits", () => {
    const plain = (strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [] })) as { properties: object }).properties;
    assert.deepEqual((strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], ...APP })) as { properties: object }).properties, plain);
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: true, buildRange: true, metaUiOnly: true });
    const props = (strictJsonSchema(schema) as { properties: object }).properties;
    assert.ok(!("direction" in props));
    assert.ok(!("askedLook" in props));
    const screens = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, purpose: "p" }));
    assert.equal(schema.safeParse({ ...BRIEF, screens }).success, true);
    assert.equal(schema.safeParse({ ...BRIEF, screens: [...screens, { name: "x", purpose: "p" }] }).success, false);
  });

  it("off, the muse-app look still asks for askedLook, and BUILD_RANGE for a direction", () => {
    assert.ok("askedLook" in (strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: true })) as { properties: object }).properties);
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: true, buildRange: true });
    assert.ok((strictJsonSchema(schema) as { required: string[] }).required.includes("direction"));
    assert.match(briefInstructions({ museAppLook: true, range: RANGE }), /Design direction/);
    assert.match(briefInstructions({ museAppLook: true }), /askedLook is null unless/);
  });
});

describe("the judge with META_UI_ONLY", () => {
  const BOTH = judgeInstructions(BRIEF, { museAppLook: true });

  it("gets the muse-app house style (both house styles), with no direction or asked look, even with BUILD_RANGE", () => {
    assert.match(BOTH, /one of two Meta-inspired house styles/);
    assert.equal(judgeInstructions(WITH, { museAppLook: true, buildRange: true, metaUiOnly: true }), BOTH);
    assert.equal(judgeInstructions(WITH, { museAppLook: true, metaUiOnly: true }), BOTH);
    assert.doesNotMatch(BOTH, /on craft and on fit to this direction|Dark with neon green/);
  });

  it("off, BUILD_RANGE and an asked look still widen it, and the meta-ui judge is as it was", () => {
    assert.match(judgeInstructions(WITH, { museAppLook: true, buildRange: true }), /on craft and on fit to this direction/);
    assert.match(judgeInstructions(WITH, { museAppLook: true }), /Dark with neon green/);
    assert.equal(judgeInstructions(BRIEF), JUDGE_INSTRUCTIONS);
  });
});

describe("the build prompt with META_UI_ONLY", () => {
  it("is the muse-app build prompt, with no asked look", () => {
    assert.equal(renderBuildPrompt(BRIEF, { ...OPTS, ...APP }), renderBuildPrompt(BRIEF, { ...OPTS, museAppLook: true }));
    const asked = renderBuildPrompt({ ...BRIEF, askedLook: ASKED }, { ...OPTS, ...APP });
    assert.equal(asked, renderBuildPrompt(BRIEF, { ...OPTS, museAppLook: true }));
    assert.match(renderBuildPrompt({ ...BRIEF, askedLook: ASKED }, { ...OPTS, museAppLook: true }), /Dark with neon green/, "off, the ask is followed");
  });

  it("with BUILD_RANGE sends the build to muse-app-ui, with its depth and no direction", () => {
    for (const brief of [BRIEF, WITH]) {
      const text = renderBuildPrompt(brief, { ...OPTS, ...NOTE });
      assert.match(text, /read `\.agents\/skills\/muse-app-ui` for the look/);
      assert.match(text, /^The look always comes from the muse-app-ui skill and its tokens in `app\/muse-app\.css`\. The inspo's mood shows only in the copy/m);
      assert.doesNotMatch(text, /meta-ui|Meta blue|Design direction|design-looks|The inspo's mood may show in colors|Dark with neon green/);
      assert.match(text, /## Depth/);
      assert.match(text, /Then build every other screen/);
      assert.match(text, /really fails three times/);
      assert.match(text, /at most 10 model calls/);
    }
  });

  it("a complex build must still use agents, checking each screen against muse-app-ui", () => {
    const text = renderBuildPrompt({ ...WITH, complexity: "complex" }, { ...OPTS, ...NOTE, playbook: true });
    assert.match(text, /## How you must work\n\nThis build is complex, so these steps are required/);
    assert.match(text, /which subagents and workflows ran/);
    assert.match(text, /a read-only child per screen, comparing it with brief\.md and the muse-app-ui skill\./);
    assert.doesNotMatch(text, /Design direction|meta-ui/);
  });

  it("off, a complex build with a direction still checks against it", () => {
    const text = renderBuildPrompt({ ...WITH, complexity: "complex" }, { ...OPTS, museAppLook: true, buildRange: true, playbook: true });
    assert.match(text, /comparing it with brief\.md and the Design direction\./);
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

  it("keep the look the product's own files have, with no Design direction", () => {
    const fix = renderFixPrompt({ verify: null, judge: null, round: 1, ...NOTE });
    const refine = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], ...APP });
    for (const text of [fix, refine]) assert.match(text, KEEP);
    assert.match(fix, /if it exists\. Fix what the judge saw with those, not with new colors, fonts or styles\.\n/);
    assert.doesNotMatch(fix, /Keep the Design direction/);
    assert.match(fix, /subagent with worktree isolation/, "BUILD_RANGE's agents stay");
    assert.match(refine, /if it exists\. Don't restyle what the request doesn't change\.\n/);
    assert.equal(renderFixPrompt({ verify: null, judge: null, round: 1, ...APP }), renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true }));
  });

  it("off, they are as they were", () => {
    assert.equal(renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: false }), renderFixPrompt({ verify: null, judge: null, round: 1 }));
    assert.match(renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true, buildRange: true }), /Keep the Design direction/);
    assert.doesNotMatch(renderRefinePrompt({ message: "x", newReferences: [] }), /muse-app/);
  });
});
