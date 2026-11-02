import type { ProductCardView } from "@/components/view-types";

/**
 * The products on the Make page, picked by hand. Varied on purpose. A product here must work with no upload, sign-in or
 * account, and `tryThis` names its real buttons (each checked against its live page on Nov 2, 2026).
 */
export const FEATURED: ReadonlyArray<{ slug: string; kind: string; tryThis: string }> = [
  { slug: "kingside-duo-chess", kind: "Game", tryThis: "Move a white pawn. The board enforces the rules and a model comments on the move." },
  { slug: "rustic-bakery-boards", kind: "Image maker", tryThis: "Press Try the sample, then Make my board. It takes about 20 seconds." },
  { slug: "rate-change-tutor", kind: "Tutor", tryThis: "Press Try a sample, then Start my assignment, and answer the tutor." },
  { slug: "scale-my-recipe", kind: "Kitchen helper", tryThis: "Press Try the pancake sample, then Scale my recipe." },
  { slug: "tiny-grid-lab", kind: "Spreadsheet", tryThis: "Press Try a sample sheet, then Preview chart." },
  { slug: "parking-lot-counter", kind: "Photo counter", tryThis: "Press Try the sample photo, then Count cars and spots. It takes about 40 seconds." },
];

export const FEATURED_SLUGS: readonly string[] = FEATURED.map((f) => f.slug);

export type FeaturedProduct = ProductCardView & { kind: string; tryThis: string };

/**
 * The featured products that are live with a link right now, in FEATURED's order. One that's gone, unpublished or only
 * partial is left out, so the row never offers a product whose checks failed.
 */
export function pickFeatured(products: readonly ProductCardView[]): FeaturedProduct[] {
  return FEATURED.flatMap(({ slug, kind, tryThis }) => {
    const product = products.find((p) => p.slug === slug);
    return product?.liveUrl && product.status === "live" ? [{ ...product, kind, tryThis }] : [];
  });
}
