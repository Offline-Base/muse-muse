/**
 * MUSE_APP_LOOK (docs/BRAND.md): with it on, the build, fix and change prompts and the judge name the muse-app look, and
 * nothing else moves. With it off they are the goldens byte for byte (flags-off.test.ts).
 *
 *   npx tsx --test lib/brief/__tests__/muse-app-look.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderBuildPrompt, renderFixPrompt, renderRefinePrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { env } from "@/lib/env";
import { judgeContent, metaLookBrief } from "@/lib/judge";
import { judgeInstructions, JUDGE_INSTRUCTIONS } from "@/lib/prompts/judge";
import type { Direction } from "@/lib/range/direction";
import { RANGE_FIX_LOOK } from "@/lib/range/prompts";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { flagsOffSurface } from "./flags-off-surface";

const GOLDEN = join(import.meta.dirname, "golden");
const golden = (name: string) => readFileSync(join(GOLDEN, name), "utf8");

/** The lines of `after` that aren't in `before`, and the other way round. */
function changed(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MUSE_APP_LOOK;
  process.env.MUSE_APP_LOOK = "1";
});
afterEach(() => {
  if (saved === undefined) delete process.env.MUSE_APP_LOOK;
  else process.env.MUSE_APP_LOOK = saved;
});

describe("with MUSE_APP_LOOK on", () => {
  it("reads as on for 1, true, yes or on, and off otherwise", () => {
    for (const on of ["1", "true", "YES", " on "]) {
      process.env.MUSE_APP_LOOK = on;
      assert.equal(env.museAppLook, true, on);
    }
    for (const off of ["", "0", "off", "muse-app"]) {
      process.env.MUSE_APP_LOOK = off;
      assert.equal(env.museAppLook, false, off);
    }
  });

  it("changes only the brief writer, the build, fix and change prompts and the judge, and only where they name the look", () => {
    const surface = flagsOffSurface();
    const moved = Object.keys(surface).filter((name) => surface[name] !== golden(name));
    assert.deepEqual(moved.sort(), ["brief-instructions.txt", "build-prompt.txt", "fix-prompt.txt", "judge-instructions.txt", "refine-prompt.txt"]);
    // The brief writer: its borrow line names the muse-app look, and askedLook follows it (asked-look.test.ts).
    const brief = changed(golden("brief-instructions.txt"), surface["brief-instructions.txt"]);
    assert.equal(brief.removed.length, 1);
    assert.match(brief.removed[0], /^- borrow .*Montserrat/);
    assert.equal(brief.added.length, 2);
    assert.match(brief.added[0], /^- borrow .*Muse Muse's own app look/);
    assert.match(brief.added[1], /^- askedLook is null unless/);
    for (const name of ["build-prompt.txt", "fix-prompt.txt", "refine-prompt.txt"]) {
      const { added, removed } = changed(golden(name), surface[name]);
      assert.ok(added.length > 0 && added.length === removed.length, `${name}: one line for one line`);
      for (const line of added) assert.match(line, /muse-app-ui/, `${name}: ${line}`);
      for (const line of removed) assert.match(line, /meta-ui/, `${name}: ${line}`);
    }
  });

  it("sends the build to muse-app-ui and its tokens, never meta-ui", () => {
    const build = flagsOffSurface()["build-prompt.txt"];
    assert.match(build, /read `\.agents\/skills\/muse-app-ui` for the look/);
    assert.match(build, /^The look always comes from the muse-app-ui skill and its tokens in `app\/muse-app\.css`\. The inspo's mood/m);
    assert.doesNotMatch(build, /meta-ui|Meta blue/);
    const playbook = renderBuildPrompt(BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40, playbook: true, museAppLook: true });
    assert.match(playbook, /comparing it with brief\.md and the muse-app-ui skill\./);
    assert.match(renderBuildPrompt(BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40, playbook: true }), /comparing it with brief\.md and the meta-ui skill\./);
  });

  it("keeps a fixed or changed product's own look, whichever it was built with", () => {
    const fix = renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true });
    const refine = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], museAppLook: true });
    for (const text of [fix, refine]) {
      assert.match(text, /- Keep the product's current look: the tokens and parts in `app\/globals\.css`, with `app\/muse-app\.css` and `\.agents\/skills\/muse-app-ui` when the product has them, or else `\.agents\/skills\/meta-ui` if it exists\./);
    }
    assert.match(fix, /if it exists\. Fix what the judge saw with those, not with new colors, fonts or styles\.\n/);
    assert.match(refine, /if it exists\. Don't restyle what the request doesn't change\.\n/);
  });

  it("tells the judge both house styles are expected, and changes nothing else it reads", () => {
    const text = judgeInstructions(BRIEF, { museAppLook: true });
    assert.equal(flagsOffSurface()["judge-instructions.txt"], text);
    assert.match(text, /one of two Meta-inspired house styles/);
    assert.match(text, /Muse Muse's own app look, laid out like Meta's assistant app on the web/);
    assert.match(text, /a purple gradient on AI credits and AI results\. Either style is expected: it is not copying a real product's look/);
    const { added, removed } = changed(JUDGE_INSTRUCTIONS, text);
    assert.equal(added.length, 1, "one paragraph");
    assert.equal(removed.length, 1);
    // The rules that fail a product for Meta's marks or for implying Meta made it are untouched.
    assert.ok(text.includes("- The page implies Meta made it, or uses Meta's logos or marks."));
    assert.equal(judgeInstructions(BRIEF), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions(BRIEF, { museAppLook: false }), JUDGE_INSTRUCTIONS);
  });

  it("keeps a brief's target notes in the judge and the change prompt, after the look's lines", () => {
    const web = { id: "web" as const, why: "Always" };
    const agent = { task: "t", tools: [{ id: "web_search", need: "n", why: "w" }], connections: "none" as const, stepsPerRun: 3 };
    const brief: Brief = { ...BRIEF, targets: [web, { id: "agent", why: "x" }, { id: "vr", why: "y" }, { id: "glasses", why: "z" }], agent };
    const off = judgeInstructions(brief);
    const on = judgeInstructions(brief, { museAppLook: true });
    assert.ok(off.startsWith(`${JUDGE_INSTRUCTIONS}\n\n`));
    const notes = off.slice(JUDGE_INSTRUCTIONS.length);
    assert.match(notes, /This product is an agent that works in steps with tools/);
    assert.match(notes, /simulated Meta Quest 3 view/);
    assert.match(notes, /The glasses were simulated/);
    assert.equal(on, `${judgeInstructions(BRIEF, { museAppLook: true })}${notes}`, "the look's house styles, then the same notes");
    assert.match(on, /one of two Meta-inspired house styles/);

    const refine = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], brief, museAppLook: true });
    assert.match(refine, /or else `\.agents\/skills\/meta-ui` if it exists\. Don't restyle what the request doesn't change\.\n- This product also runs on: /);
    assert.match(refine, /`\.agents\/skills\/muse-vr`/);
  });
});

/** A polish with look "meta" (lib/polish/logic.ts) moved the product to meta-ui: nothing may pull it back. */
describe("after a polish switched the product to the Meta UI look", () => {
  const direction: Direction = {
    summary: "A printed almanac for bird watchers, warm and dense.",
    scheme: "light",
    palette: { background: "#f4ecd8", surface: "#fbf6e9", text: "#2a2118", mutedText: "#5c4e3c", accent: "#8c2f1b", onAccent: "#ffffff", secondary: "#3e6b57" },
    displayFont: { package: "@fontsource-variable/fraunces", family: "Fraunces Variable" },
    bodyFont: { package: "@fontsource/source-serif-4", family: "Source Serif 4" },
    density: "Tight, like a printed table.",
    layout: "One column, sections split by rules rather than cards.",
    shape: "Square corners.",
    motion: "Rows fade in.",
    imagery: "Engraving-style drawings.",
  };
  const ranged: Brief = { ...BRIEF, direction, askedLook: "Pink and gold, like a birthday card." };

  it("fix and change prompts keep meta-ui only, never muse-app or a Design direction", () => {
    const fix = renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true, buildRange: true, metaLook: true });
    const refine = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], museAppLook: true, metaLook: true });
    for (const text of [fix, refine]) {
      assert.ok(text.includes("- Keep the product's current look, the Meta UI look: the tokens and parts in `app/globals.css` and `.agents/skills/meta-ui`."));
      assert.ok(!text.includes("muse-app"));
    }
    assert.ok(!fix.includes(RANGE_FIX_LOOK));
    assert.match(fix, /`\.agents\/skills\/meta-ui`\. Fix what the judge saw with those, not with new colors, fonts or styles\.\n/);
    // Without it, a range product's fix still keeps its direction.
    assert.ok(renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true, buildRange: true }).includes(RANGE_FIX_LOOK));
  });

  it("the judge expects the Meta house style alone and reads no direction or asked look", () => {
    assert.equal(judgeInstructions(ranged, { museAppLook: true, buildRange: true, metaLook: true }), JUDGE_INSTRUCTIONS);
    assert.notEqual(judgeInstructions(ranged, { museAppLook: true, buildRange: true }), JUDGE_INSTRUCTIONS);
    const brief = metaLookBrief(ranged);
    assert.equal("direction" in brief || "askedLook" in brief, false);
    const text = judgeContent({ brief, references: [], screenshots: [] }).content.map((c) => ("text" in c ? c.text : "")).join("\n");
    assert.ok(!text.includes("Design direction") && !text.includes("The look they asked for"));
  });
});
