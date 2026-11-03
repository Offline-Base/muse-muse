/**
 * The gallery's hidden and first-shown products (lib/gallery/hidden.ts): hidden ones drop out of a list built from
 * cards, the first ones lead in their order, and the rest keep theirs. The judge-path checker's own read of this file
 * is tested in scripts/__tests__/judge-check.test.mjs.
 *
 *   npx tsx --test lib/gallery/__tests__/hidden.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GALLERY_FIRST, HIDDEN_FROM_GALLERY, galleryOrder, isHiddenFromGallery } from "@/lib/gallery/hidden";

const cards = (...slugs: string[]) => slugs.map((slug) => ({ slug }));

describe("gallery hidden list", () => {
  it("holds the eight overdone-looking products and the six waiting on a rebuild, each a plain slug once", () => {
    assert.deepEqual([...HIDDEN_FROM_GALLERY].sort(), [
      "class-capture-notes",
      "cold-room-watcher-2",
      "everyday-helper-chat",
      "fable-case-ledger",
      "fresh-dot-fridge",
      "gym-snap-coach",
      "lantern-canal-drift",
      "marathon-plan-keeper",
      "object-count-studio",
      "parking-lot-counter",
      "rate-change-tutor",
      "sim-desk-agent-demo",
      "start-here-chat",
      "wag-sticker-studio",
    ]);
    assert.equal(new Set(HIDDEN_FROM_GALLERY).size, HIDDEN_FROM_GALLERY.length);
    for (const slug of [...HIDDEN_FROM_GALLERY, ...GALLERY_FIRST]) assert.match(slug, /^[a-z0-9-]{1,80}$/);
    assert.equal(new Set(GALLERY_FIRST).size, GALLERY_FIRST.length);
    assert.ok(!GALLERY_FIRST.some(isHiddenFromGallery), "a first-shown product can't also be hidden");
  });

  it("leads with the five best working products, then dinner-split-helper, which has the device stage", () => {
    assert.deepEqual(GALLERY_FIRST, [
      "handbook-proof-checker",
      "room-restyle-studio",
      "standup-scribe-notes",
      "parking-policy-reader",
      "paper-lantern-museum",
      "dinner-split-helper",
    ]);
  });

  it("leaves out hidden products, puts the first ones first, and keeps the rest in order", () => {
    const shown = galleryOrder(
      cards("newest", "gym-snap-coach", "middle", "dinner-split-helper", "cold-room-watcher-2", "handbook-proof-checker", "oldest"),
    );
    assert.deepEqual(shown.map((c) => c.slug), ["handbook-proof-checker", "dinner-split-helper", "newest", "middle", "oldest"]);
    assert.deepEqual(galleryOrder([]), []);
    assert.equal(isHiddenFromGallery("parking-lot-counter"), true);
    assert.equal(isHiddenFromGallery("dinner-split-helper"), false);
  });
});
