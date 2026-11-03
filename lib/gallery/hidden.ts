/**
 * Which shipped products the gallery lists leave out, and which they put first. Server and client safe: no imports.
 *
 * Hidden, not deleted. Each product here keeps its own page (/p/<slug>), its live link and its connector. It just
 * doesn't show in the Gallery (/gallery), the Make page's featured row, the dashboard's three connectors to try or the
 * VR list (/vr). The gadgets page (/gadgets, Hussam's) still lists every product that uses a gadget. The eight below
 * look like the organizers' list of overdone projects for the Meta hackathon (sports coaches, education chatbots,
 * plain chatbots, simple image analyzers), so the judge path doesn't lead with them (Nov 2, 2026). The six after them
 * are hidden until they're rebuilt on a new builder snapshot (Nov 3, 2026; docs/HANDOFF.md, "Rebuild after the
 * snapshot"): their pages claim more than works, or contradict themselves.
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
  // Hidden Nov 3 until rebuilt. sim-desk-agent-demo draws SVG, so its model never runs.
  "sim-desk-agent-demo",
  // Old upload client (uploads 503) and a placeholder clip.
  "wag-sticker-studio",
  // Soft-locks partway through.
  "lantern-canal-drift",
  // Draws its boxes at a tenth of their size.
  "fresh-dot-fridge",
  // Partial: its page still shows the memo error as a known issue and says no requirement counts as working.
  "fable-case-ledger",
  // Its tagline says it keeps answering on the office board, and its page says "Not connected to a board".
  "cold-room-watcher-2",
];

/**
 * Products the gallery shows first, in this order, before the rest (newest first). The first five are the best working
 * ones the Nov 3 site audit checked live: quotes checked twice, a photo restyled step by step, a recording transcribed
 * to to-dos, a policy answered with quotes, and a VR hall. dinner-split-helper has the "Where it ran" stage with its four
 * device recordings (lib/devices/runs.ts). A slug that's hidden, unpublished or gone is skipped.
 */
export const GALLERY_FIRST: readonly string[] = [
  "handbook-proof-checker",
  "room-restyle-studio",
  "standup-scribe-notes",
  "parking-policy-reader",
  "paper-lantern-museum",
  "dinner-split-helper",
];

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
