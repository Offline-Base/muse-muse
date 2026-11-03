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
  it("holds the eight products that look like the organizers' overdone list, each a plain slug once", () => {
    assert.deepEqual([...HIDDEN_FROM_GALLERY].sort(), [
      "class-capture-notes",
      "everyday-helper-chat",
      "gym-snap-coach",
      "marathon-plan-keeper",
      "object-count-studio",
      "parking-lot-counter",
      "rate-change-tutor",
      "start-here-chat",
    ]);
    for (const slug of [...HIDDEN_FROM_GALLERY, ...GALLERY_FIRST]) assert.match(slug, /^[a-z0-9-]{1,80}$/);
    assert.equal(new Set(GALLERY_FIRST).size, GALLERY_FIRST.length);
    assert.ok(!GALLERY_FIRST.some(isHiddenFromGallery), "a first-shown product can't also be hidden");
  });

  it("starts the gallery with dinner-split-helper, which has the device stage", () => {
    assert.deepEqual(GALLERY_FIRST, ["dinner-split-helper"]);
  });

  it("leaves out hidden products, puts the first ones first, and keeps the rest in order", () => {
    const shown = galleryOrder(cards("newest", "gym-snap-coach", "middle", "dinner-split-helper", "start-here-chat", "oldest"));
    assert.deepEqual(shown.map((c) => c.slug), ["dinner-split-helper", "newest", "middle", "oldest"]);
    assert.deepEqual(galleryOrder([]), []);
    assert.equal(isHiddenFromGallery("parking-lot-counter"), true);
    assert.equal(isHiddenFromGallery("dinner-split-helper"), false);
  });
});
