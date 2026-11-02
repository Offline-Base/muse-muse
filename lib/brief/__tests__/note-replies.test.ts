import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** STEER_CHAT's prompt line, off for every prompt that doesn't ask for it (flags-off.test.ts holds the rest as golden). */
describe("the note reply line", () => {
  const source = readFileSync("lib/brief/render.ts", "utf8");

  it("sits behind noteReplies, inside ownerNotes, and adds no spend or time", () => {
    const at = source.indexOf("if (notes.noteReplies)");
    assert.ok(at > source.indexOf("if (notes.ownerNotes)"));
    assert.match(source.slice(at), /It never adds spend or time/);
  });
});
