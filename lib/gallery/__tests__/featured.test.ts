/**
 * The Make page's featured row (lib/gallery/featured.ts): only live products with a link, in the picked order.
 *
 *   npx tsx --test lib/gallery/__tests__/featured.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProductCardView } from "@/components/view-types";
import { FEATURED, FEATURED_SLUGS, pickFeatured } from "@/lib/gallery/featured";
import { HIDDEN_FROM_GALLERY } from "@/lib/gallery/hidden";

const card = (slug: string, over: Partial<ProductCardView> = {}): ProductCardView => ({
  slug,
  name: slug,
  tagline: "",
  status: "live",
  liveUrl: `https://musemuse-${slug}.vercel.app`,
  demoVideoUrl: null,
  demoPosterUrl: null,
  muse: null,
  models: [],
  buildMs: null,
  costUsd: null,
  fixRounds: null,
  rebuildOf: null,
  ...over,
});

describe("featured products", () => {
  it("are distinct, with plain words and no em dash", () => {
    assert.equal(new Set(FEATURED_SLUGS).size, FEATURED.length);
    for (const f of FEATURED) assert.ok(!`${f.kind}${f.tryThis}`.includes("—"), f.slug);
  });

  it("keep FEATURED's order and leave out one that's unpublished, partial, gone or not featured", () => {
    const [a, b, c, d] = FEATURED_SLUGS;
    const picked = pickFeatured([card(d!), card(c!, { status: "partial" }), card(b!, { liveUrl: null }), card(a!), card("someone-else")]);
    assert.deepEqual(picked.map((p) => p.slug), [a, d]);
    assert.equal(picked[0]!.tryThis, FEATURED[0]!.tryThis);
    assert.deepEqual(pickFeatured([]), []);
  });

  it("never feature a product hidden from the gallery", () => {
    for (const slug of FEATURED_SLUGS) assert.ok(!HIDDEN_FROM_GALLERY.includes(slug), slug);
    assert.deepEqual(pickFeatured(HIDDEN_FROM_GALLERY.map((slug) => card(slug))), []);
  });
});
