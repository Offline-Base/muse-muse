import type { ProductCardView } from "@/components/view-types";

export type ProductFilter = "all" | "video" | "rebuild";

export const PRODUCT_FILTERS: { id: ProductFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "With a demo" },
  { id: "rebuild", label: "Rebuilds" },
];

/** The products that match the search box and the filter menu. */
export function filterProducts<P extends Pick<ProductCardView, "name" | "tagline" | "muse" | "demoVideoUrl" | "rebuildOf">>(products: readonly P[], query: string, filter: ProductFilter): P[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return products.filter((p) => {
    if (filter === "video" && !p.demoVideoUrl) return false;
    if (filter === "rebuild" && !p.rebuildOf) return false;
    const text = `${p.name} ${p.tagline} ${p.muse ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export type CreationFilter = "all" | "videos" | "images";

export const CREATION_FILTERS: { id: CreationFilter; label: string; icon: "grid" | "video" | "image" }[] = [
  { id: "all", label: "All", icon: "grid" },
  { id: "images", label: "Images", icon: "image" },
  { id: "videos", label: "Videos", icon: "video" },
];

export interface Creation {
  key: string;
  kind: "video" | "image";
  src: string;
  poster: string | null;
  name: string;
  href: string;
}

/** Each product's demo and its poster as what it made. A product with neither has nothing to show here. */
export function creationsOf(products: readonly Pick<ProductCardView, "slug" | "name" | "demoVideoUrl" | "demoPosterUrl">[]): Creation[] {
  return products.flatMap((p) => {
    const href = `/p/${p.slug}`;
    const items: Creation[] = [];
    if (p.demoVideoUrl) items.push({ key: `${p.slug}:video`, kind: "video", src: p.demoVideoUrl, poster: p.demoPosterUrl, name: p.name, href });
    if (p.demoPosterUrl) items.push({ key: `${p.slug}:image`, kind: "image", src: p.demoPosterUrl, poster: null, name: p.name, href });
    return items;
  });
}

export function filterCreations(items: readonly Creation[], filter: CreationFilter): Creation[] {
  if (filter === "videos") return items.filter((item) => item.kind === "video");
  if (filter === "images") return items.filter((item) => item.kind === "image");
  // One tile per product under All: its video when it has one.
  const videos = new Set(items.filter((item) => item.kind === "video").map((item) => item.href));
  return items.filter((item) => item.kind === "video" || !videos.has(item.href));
}
