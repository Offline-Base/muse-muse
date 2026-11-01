/**
 * "Unless the person asks" (docs/BRAND.md): with MUSE_APP_LOOK every build follows the muse-app UI guidelines, and only
 * a look the person asked for in their own words (the brief's askedLook) changes its colors, fonts and mood. With the
 * flag off, or with no ask, every prompt is what it was (flags-off.test.ts, muse-app-look.test.ts).
 *
 *   npx tsx --test lib/brief/__tests__/asked-look.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { briefToMarkdown, renderBuildPrompt } from "@/lib/brief/render";
import { ASKED_LOOK_MAX, BriefSchema, newBriefSchemaFor, NewBriefSchema, NewBriefSchemaNoGadget, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { briefInstructions } from "@/lib/prompts/brief";
import { judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const ASK = "Dark, with neon green buttons and a rounded, playful font.";
const asked: Brief = { ...BRIEF, askedLook: ASK };
const render = (brief: Brief, museAppLook?: boolean) =>
  renderBuildPrompt(brief, { inspoFiles: [], fixtures: [], maxModelSteps: 40, museAppLook });

describe("the brief writer", () => {
  it("asks for askedLook only with the muse-app look, and keeps every other schema as it was", () => {
    for (const gadgets of [true, false]) {
      const base = gadgets ? NewBriefSchema : NewBriefSchemaNoGadget;
      assert.equal(newBriefSchemaFor({ gadgets, targets: [] }), base);
      assert.equal(newBriefSchemaFor({ gadgets, targets: [], museAppLook: false }), base);
      const on = strictJsonSchema(newBriefSchemaFor({ gadgets, targets: [], museAppLook: true })) as { properties: Record<string, unknown>; required: string[] };
      assert.ok("askedLook" in on.properties);
      assert.ok(on.required.includes("askedLook"), "strict output needs every property required; null means no ask");
    }
    for (const targets of [["phone"], ["agent"]] as const) {
      const on = strictJsonSchema(newBriefSchemaFor({ gadgets: true, targets, museAppLook: true })) as { properties: Record<string, unknown> };
      assert.ok("askedLook" in on.properties && "targets" in on.properties, targets.join());
      const off = strictJsonSchema(newBriefSchemaFor({ gadgets: true, targets })) as { properties: Record<string, unknown> };
      assert.ok(!("askedLook" in off.properties), targets.join());
    }
  });

  it("refuses an ask longer than the limit, and an older brief parses with none", () => {
    const schema = newBriefSchemaFor({ gadgets: true, targets: [], museAppLook: true });
    assert.ok(schema.safeParse({ ...BRIEF, askedLook: null }).success);
    assert.ok(schema.safeParse(asked).success);
    assert.ok(!schema.safeParse({ ...BRIEF, askedLook: "x".repeat(ASKED_LOOK_MAX + 1) }).success);
    assert.deepEqual(BriefSchema.parse(BRIEF), BRIEF);
    assert.equal(BriefSchema.parse(asked).askedLook, ASK);
  });

  it("explains askedLook with the flag on: the person's own words, never a screenshot alone or a real product's look", () => {
    const on = briefInstructions({ museAppLook: true });
    assert.match(on, /askedLook is null unless the person's own words/);
    assert.match(on, /A screenshot or photo alone is not an ask/);
    assert.match(on, /Never put a real product's or company's exact look, name or logo in askedLook/);
    assert.match(on, /Muse Muse's own app look \(a white page, hairline cards, regular-weight Inter/);
    assert.doesNotMatch(on, /Montserrat/);
    assert.doesNotMatch(on, /—/);
    assert.equal(briefInstructions({ museAppLook: false }), briefInstructions());
    assert.doesNotMatch(briefInstructions(), /askedLook/);
  });

  it("cleans the writer's answer: an empty ask is none, and a long one is cut", () => {
    const n = (askedLook: unknown) => (normalizeRawBrief({ ...BRIEF, askedLook }, []) as Brief).askedLook;
    assert.equal(n("   "), null);
    assert.equal(n(` ${ASK} `), ASK);
    assert.equal(n(null), null);
    assert.ok((n("y".repeat(900)) as string).length <= ASKED_LOOK_MAX);
  });
});

describe("the build prompt", () => {
  it("follows the UI guidelines when the person didn't ask for a look", () => {
    assert.equal(render({ ...BRIEF, askedLook: null }, true), render(BRIEF, true));
    assert.equal(render({ ...BRIEF, askedLook: "  " }, true), render(BRIEF, true));
    assert.match(render(BRIEF, true), /^The look always comes from the muse-app-ui skill/m);
  });

  it("follows the person's ask through the tokens, and keeps the rest of the skill", () => {
    const text = render(asked, true);
    assert.match(text, /The person asked for their own look: "Dark, with neon green buttons and a rounded, playful font\."/);
    assert.match(text, /changing the tokens in `app\/muse-app\.css` for light and dark/);
    assert.match(text, /keep everything else from the muse-app-ui skill: the screen patterns, the parts, spacing, states, readable contrast and focus rings/);
    assert.doesNotMatch(text, /The look always comes from/);
    // Still read the skill first, and still leave out a real product's look.
    assert.match(text, /read `\.agents\/skills\/muse-app-ui` for the look/);
    assert.match(text, /the exact look of a real product \(AGENTS\.md\)/);
    const lines = (t: string) => t.split("\n");
    const moved = lines(text).filter((l) => !lines(render(BRIEF, true)).includes(l));
    assert.equal(moved.length, 1, "only the look line changes");
  });

  it("ignores an ask on a product without the muse-app look", () => {
    assert.equal(render(asked, false), render(BRIEF, false));
    assert.equal(render(asked), render(BRIEF));
  });

  it("shows the ask in brief.md, and nothing new without one", () => {
    assert.match(briefToMarkdown(asked), /\*\*The look they asked for:\*\* Dark, with neon green buttons/);
    assert.equal(briefToMarkdown({ ...BRIEF, askedLook: null }), briefToMarkdown(BRIEF));
  });
});

describe("the judge", () => {
  it("expects the asked look instead of the house style, and still fails a real product's look", () => {
    const text = judgeInstructions(asked, { museAppLook: true });
    assert.ok(text.startsWith(`${judgeInstructions(BRIEF, { museAppLook: true })}\n\n`));
    assert.match(text, /The person asked for their own look: "Dark, with neon green buttons/);
    assert.match(text, /don't fail it for its colors, fonts or theme/);
    assert.match(text, /Still fail it for unreadable contrast, and for a real product's name, logo or exact look/);
    assert.equal(judgeInstructions(asked), judgeInstructions(BRIEF));
    assert.equal(judgeInstructions({ ...BRIEF, askedLook: null }, { museAppLook: true }), judgeInstructions(BRIEF, { museAppLook: true }));
  });
});
