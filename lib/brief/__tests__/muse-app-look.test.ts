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
import { env } from "@/lib/env";
import { judgeInstructions, JUDGE_INSTRUCTIONS } from "@/lib/prompts/judge";
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

  it("changes only the build, fix and change prompts and the judge, and only where they name the look", () => {
    const surface = flagsOffSurface();
    const moved = Object.keys(surface).filter((name) => surface[name] !== golden(name));
    assert.deepEqual(moved.sort(), ["build-prompt.txt", "fix-prompt.txt", "judge-instructions.txt", "refine-prompt.txt"]);
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
    const text = judgeInstructions({ museAppLook: true });
    assert.equal(flagsOffSurface()["judge-instructions.txt"], text);
    assert.match(text, /one of two Meta-inspired house styles/);
    assert.match(text, /Muse Muse's own app look, laid out like Meta's assistant app on the web/);
    assert.match(text, /a purple gradient on AI credits and AI results\. Either style is expected: it is not copying a real product's look/);
    const { added, removed } = changed(JUDGE_INSTRUCTIONS, text);
    assert.equal(added.length, 1, "one paragraph");
    assert.equal(removed.length, 1);
    // The rules that fail a product for Meta's marks or for implying Meta made it are untouched.
    assert.ok(text.includes("- The page implies Meta made it, or uses Meta's logos or marks."));
    assert.equal(judgeInstructions(), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions({ museAppLook: false }), JUDGE_INSTRUCTIONS);
  });
});
