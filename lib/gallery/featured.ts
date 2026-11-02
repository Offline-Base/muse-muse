import type { ProductCardView } from "@/components/view-types";

/**
 * The products on the Make page, picked by hand. Varied on purpose. A product here must work with no upload, sign-in or
 * account, and `tryThis` names its real buttons (each checked against its live page on Nov 2, 2026).
 *
 * Its model calls must still run under BUILDS_ON_CONTRIBUTOR: a product published before the switch that calls Muse
 * Wonder, with no Contributor notice in its footer, gets "This product is off for now" from the gateway
 * (contributorSwitchRefusal in lib/gateway/policy.ts) unless it's one of WONDER_DEMO_SLUGS. That's why rate-change-tutor
 * (Muse Wonder, Nov 1, no notice) isn't here. These five call Muse Spark 1.3, which the gateway serves on Contributor
 * while TRUST_SPARK_TO_WONDER is off, and models other than Muse Wonder (Muse Image, SAM 3.1).
 */
export const FEATURED: ReadonlyArray<{ slug: string; kind: string; tryThis: string }> = [
  { slug: "kingside-duo-chess", kind: "Game", tryThis: "Move a white pawn. The board enforces the rules and a model comments on the move." },
  { slug: "rustic-bakery-boards", kind: "Image maker", tryThis: "Press Try the sample, then Make my board. It takes about 20 seconds." },
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
