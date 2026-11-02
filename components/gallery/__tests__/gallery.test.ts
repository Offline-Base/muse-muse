/** The Gallery, Media and Demos pages' logic: search and filters, what counts as a creation, and presets with real pictures. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { creationsOf, filterCreations, filterProducts } from "@/lib/gallery/filter";
import { GALLERY_PRESETS } from "@/lib/gallery/presets";

const product = (over: Record<string, unknown>) => ({ slug: "s", name: "Crumb Counter", tagline: "Cake orders", muse: null, demoVideoUrl: null, demoPosterUrl: null, rebuildOf: null, ...over });

describe("products", () => {
  it("searches name, tagline and muse by every word", () => {
    const list = [product({ muse: "a bakery page" }), product({ slug: "t", name: "Leaf Coach", tagline: "Plants" })];
    assert.deepEqual(filterProducts(list, "bakery CAKE", "all").map((p) => p.slug), ["s"]);
    assert.equal(filterProducts(list, "  ", "all").length, 2);
    assert.equal(filterProducts(list, "cake leaf", "all").length, 0);
  });

  it("filters to demos and rebuilds", () => {
    const list = [product({ demoVideoUrl: "/v.mp4" }), product({ slug: "t", rebuildOf: "x" })];
    assert.deepEqual(filterProducts(list, "", "video").map((p) => p.slug), ["s"]);
    assert.deepEqual(filterProducts(list, "", "rebuild").map((p) => p.slug), ["t"]);
  });
});

describe("creations", () => {
  const items = creationsOf([
    { slug: "a", name: "A", demoVideoUrl: "/a.mp4", demoPosterUrl: "/a.jpg" },
    { slug: "b", name: "B", demoVideoUrl: null, demoPosterUrl: "/b.jpg" },
    { slug: "c", name: "C", demoVideoUrl: null, demoPosterUrl: null },
  ]);

  it("shows one tile per product under All, preferring its video, and skips a product with neither", () => {
    assert.deepEqual(filterCreations(items, "all").map((i) => i.key), ["a:video", "b:image"]);
  });

  it("splits images and videos", () => {
    assert.deepEqual(filterCreations(items, "videos").map((i) => i.key), ["a:video"]);
    assert.deepEqual(filterCreations(items, "images").map((i) => i.key), ["a:image", "b:image"]);
  });
});

describe("presets", () => {
  it("each has a picture that exists and an idea to start from", () => {
    for (const preset of GALLERY_PRESETS) {
      assert.ok(existsSync(`public${preset.image}`), preset.image);
      assert.ok(preset.note.length > 20);
      assert.ok(!`${preset.title}${preset.note}`.includes("—"));
    }
  });
});
