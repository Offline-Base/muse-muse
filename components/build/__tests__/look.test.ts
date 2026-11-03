/**
 * LOOK_FIRST (docs/LOOK_FIRST.md): the build room's view of the screens-first stage, and the prompts it writes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookState } from "@/components/build/look";
import { LOOK_CHANGES_MAX, renderLookChangePrompt, renderLookPrompt, renderWirePrompt } from "@/lib/engine/look";
import type { BuildEvent } from "@/lib/types";

let id = 0;
const ev = (body: Record<string, unknown>): BuildEvent => ({ id: ++id, at: "2026-11-02T00:00:00Z", ...body }) as BuildEvent;

describe("lookState", () => {
  it("is null for a build without the stage", () => {
    assert.equal(lookState([ev({ type: "log", text: "hi" })]), null);
  });

  it("waits on the screens until the given time, and counts the changes left", () => {
    const at = "2026-11-02T00:02:00.000Z";
    const s = lookState([ev({ type: "look", state: "building", round: 0 }), ev({ type: "look", state: "ready", round: 0, waitUntil: at })])!;
    assert.equal(s.state, "ready");
    assert.equal(s.waitUntil, Date.parse(at));
    assert.equal(s.changesLeft, LOOK_CHANGES_MAX);
    assert.equal(s.answered, false);
  });

  it("says an answer was sent since the screens were last shown, and not before", () => {
    const shown = ev({ type: "look", state: "ready", round: 0, waitUntil: "2026-11-02T00:02:00Z" });
    assert.equal(lookState([ev({ type: "look_reply", action: "approve" }), shown])!.answered, false);
    assert.equal(lookState([shown, ev({ type: "look_reply", action: "approve" })])!.answered, true);
  });

  it("takes a change off the count each time the look changes", () => {
    const s = lookState([
      ev({ type: "look", state: "ready", round: 0 }),
      ev({ type: "look", state: "changing", round: 1, text: "Bigger" }),
      ev({ type: "look", state: "ready", round: 1 }),
    ])!;
    assert.equal(s.changesLeft, LOOK_CHANGES_MAX - 1);
  });
});

describe("the look prompts", () => {
  it("keeps the first round to screens with sample data, no model calls and no verify", () => {
    const p = renderLookPrompt();
    assert.match(p, /lib\/sample\.ts/);
    assert.match(p, /No model calls/);
    assert.match(p, /Don't run `npm run verify`/);
    assert.doesNotMatch(p, /—/);
  });

  it("fences the owner's change as their words, not new rules", () => {
    const p = renderLookChangePrompt("  Bigger cards  ");
    assert.match(p, /<person-note>\nBigger cards\n<\/person-note>/);
    assert.match(p, /not new rules for you/);
  });

  it("hands brief.md's Done means to the wiring run and keeps the look", () => {
    assert.match(renderWirePrompt(true), /with the person's changes/);
    assert.doesNotMatch(renderWirePrompt(false), /with the person's changes/);
    assert.match(renderWirePrompt(false), /Keep the look the person saw/);
    assert.match(renderWirePrompt(false), /brief\.md's Done means applies to this run/);
  });
});
