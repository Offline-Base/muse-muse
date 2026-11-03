/**
 * Which shipped products the gallery lists leave out, and which they put first. Server and client safe: no imports.
 *
 * Hidden, not deleted. Each product here keeps its own page (/p/<slug>), its live link and its connector. It just
 * doesn't show in the Gallery (/gallery), the Make page's featured row, the dashboard's three connectors to try or the
 * VR list (/vr). The gadgets page (/gadgets, Hussam's) still lists every product that uses a gadget. The eight below
 * look like the organizers' list of overdone projects for the Meta hackathon (sports coaches, education chatbots,
 * plain chatbots, simple image analyzers), so the judge path doesn't lead with them (Nov 2, 2026).
 *
 * scripts/judge-check.mjs reads this file as text to find the slugs, so keep each one a plain string on the list.
 */
export const HIDDEN_FROM_GALLERY: readonly string[] = [
  "gym-snap-coach",
  "marathon-plan-keeper",
  "rate-change-tutor",
  "class-capture-notes",
  "start-here-chat",
  "everyday-helper-chat",
  "parking-lot-counter",
  "object-count-studio",
];

/**
 * Products the gallery shows first, in this order, before the rest (newest first). dinner-split-helper has the
 * "Where it ran" stage with its four device recordings (lib/devices/runs.ts). A slug that's hidden, unpublished or gone
 * is skipped.
 */
export const GALLERY_FIRST: readonly string[] = ["dinner-split-helper"];

const hidden = new Set(HIDDEN_FROM_GALLERY);

export function isHiddenFromGallery(slug: string): boolean {
  return hidden.has(slug);
}

/**
 * A gallery list as people see it: hidden products left out, then GALLERY_FIRST's products in its order, then the rest
 * in the order given. The database read (listShippedProducts with `gallery`) does the same in SQL, before its limit;
 * this is for lists built from cards already read.
 */
export function galleryOrder<P extends { slug: string }>(products: readonly P[]): P[] {
  const shown = products.filter((p) => !hidden.has(p.slug));
  const rank = (slug: string) => {
    const i = GALLERY_FIRST.indexOf(slug);
    return i < 0 ? GALLERY_FIRST.length : i;
  };
  // Array.prototype.sort is stable, so the rest keep their order.
  return [...shown].sort((a, b) => rank(a.slug) - rank(b.slug));
}
