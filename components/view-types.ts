import type { Brief, BuildStatus, Manifest, ProductStatus, Reference, RebuildFit } from "@/lib/types";

/**
 * Plain, serializable shapes that server pages pass to client components. Dates are ISO strings. Field names match
 * lib/db/schema.ts, so a GET /api/builds/[buildId] reply can be merged into them.
 */

export interface BuildView {
  id: string;
  kind: "build" | "refine";
  message: string | null;
  rebuildOf: string | null;
  productId: string | null;
  userId: string;
  inspirationId: string;
  status: BuildStatus;
  step: string | null;
  brief: Brief | null;
  buildModel: string | null;
  museSessionId: string | null;
  fixRounds: number;
  previewUrl: string | null;
  costUsd: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ProductView {
  id: string;
  /** Anyone may read its Code page. */
  sourcePublic?: boolean;
  slug: string;
  name: string;
  tagline: string;
  ownerId: string;
  inspirationId: string | null;
  rebuildOf: string | null;
  manifest: Manifest | null;
  latestBuildId: string | null;
  liveUrl: string | null;
  demoVideoUrl: string | null;
  /** Poster for the demo's <video>, made with it. */
  demoPosterUrl: string | null;
  transcriptUrl: string | null;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InspirationView {
  id: string;
  note: string | null;
  references: Reference[];
  createdAt: string;
}

/** One row in a build list: /builds, the build room's History menu, the product page. */
export interface BuildSummary {
  id: string;
  productId?: string | null;
  kind: "build" | "refine";
  status: BuildStatus;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
  fixRounds: number;
  message: string | null;
  /** Product name, or the brief's name before a product exists. */
  name: string | null;
  slug: string | null;
  note: string | null;
  rebuildOf: string | null;
}

/** A shipped product as a gallery or home-strip card. */
export interface ProductCardView {
  slug: string;
  name: string;
  tagline: string;
  status: ProductStatus;
  liveUrl: string | null;
  demoVideoUrl: string | null;
  demoPosterUrl: string | null;
  /** One line on what the user gave and asked for. */
  muse: string | null;
  models: string[];
  buildMs: number | null;
  costUsd: number | null;
  fixRounds: number | null;
  rebuildOf: string | null;
  /** The build that made the current version, for a "Watch the build" link. */
  latestBuildId?: string | null;
}

/** Rebuild catalog entry joined with its latest build and product. */
export interface RebuildCardView {
  id: string;
  title: string;
  url: string;
  era: string;
  demonstrates: string;
  fit: RebuildFit;
  models: string[];
  plan: string;
  latestBuild: {
    id: string;
    status: BuildStatus;
    startedAt: string;
    finishedAt: string | null;
    costUsd: number;
  } | null;
  product: {
    slug: string;
    name: string;
    status: ProductStatus;
    liveUrl: string | null;
    demoVideoUrl: string | null;
    demoPosterUrl: string | null;
  } | null;
  attempts: number;
  totalMs: number;
  totalCostUsd: number;
}

/** The catalog item a rebuild came from, for the build room and product page. */
export interface RebuildRef {
  id: string;
  title: string;
  url: string;
  fit: RebuildFit | null;
  /** The lesson's card on /learn, or null for a first demo, which has no Meta lesson. */
  learnHref: string | null;
  /** The Nov 2 audit's verdict and the product it judged, so a page can say how that product measured up. */
  verdict: { label: string; product: string } | null;
}
