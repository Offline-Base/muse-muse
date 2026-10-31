// The shell's client for the platform's native routes.
//
//   GET <platform>/api/native/resolve/<slug> answers { slug, name, url } for a live product.
//   GET <platform>/api/native/catalog answers { products: [{ slug, name, tagline?, url? }] }.
//
// Another unit builds the routes. Until they are live, set MUSE_RESOLVE_STUB=1 at build time to use STUB_PRODUCTS.

import { isOpenableUrl, isValidSlug } from "./launch";

export interface ResolvedProduct {
  slug: string;
  name: string;
  url: string;
  origin: string;
}

export interface CatalogItem {
  slug: string;
  name: string;
  tagline: string | null;
}

export type ResolveErrorCode = "not_found" | "unavailable" | "bad_response";

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;

  constructor(code: ResolveErrorCode, message: string) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
  }
}

export interface ResolveClient {
  resolve(slug: string): Promise<ResolvedProduct>;
  catalog(): Promise<CatalogItem[]>;
}

interface ClientOptions {
  platformUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The platform vouches for the URL, but the app still only opens https, or http on the machine itself. */
function toResolved(body: unknown, slug: string): ResolvedProduct {
  if (!isRecord(body) || body.slug !== slug || typeof body.name !== "string" || !isOpenableUrl(body.url)) {
    throw new ResolveError("bad_response", "The product link came back wrong.");
  }
  return { slug, name: body.name, url: body.url, origin: new URL(body.url).origin };
}

function toCatalog(body: unknown): CatalogItem[] {
  if (!isRecord(body) || !Array.isArray(body.products)) {
    throw new ResolveError("bad_response", "The product list came back wrong.");
  }
  return body.products.flatMap((item: unknown) => {
    if (!isRecord(item) || !isValidSlug(item.slug) || typeof item.name !== "string") return [];
    return [{ slug: item.slug, name: item.name, tagline: typeof item.tagline === "string" ? item.tagline : null }];
  });
}

export function createResolveClient(options: ClientOptions): ResolveClient {
  const base = options.platformUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 404) throw new ResolveError("not_found", "We couldn't find that product.");
      if (!response.ok) throw new ResolveError("unavailable", "Muse Muse isn't answering right now.");
      return await response.json();
    } catch (error) {
      if (error instanceof ResolveError) throw error;
      throw new ResolveError("unavailable", "Muse Muse isn't answering right now.");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async resolve(slug) {
      if (!isValidSlug(slug)) throw new ResolveError("not_found", "We couldn't find that product.");
      return toResolved(await getJson(`/api/native/resolve/${encodeURIComponent(slug)}`), slug);
    },
    async catalog() {
      return toCatalog(await getJson("/api/native/catalog"));
    },
  };
}

/** Stand-ins for the platform's routes. Only used when a build sets MUSE_RESOLVE_STUB=1. */
export const STUB_PRODUCTS: ReadonlyArray<ResolvedProduct & { tagline: string }> = [
  {
    slug: "example",
    name: "Example product",
    tagline: "A stand-in until the platform's product routes are live.",
    url: "https://muse-muse.vercel.app/",
    origin: "https://muse-muse.vercel.app",
  },
];

export function createStubResolveClient(): ResolveClient {
  return {
    async resolve(slug) {
      const product = STUB_PRODUCTS.find((item) => item.slug === slug);
      if (!product) throw new ResolveError("not_found", "We couldn't find that product.");
      return { slug: product.slug, name: product.name, url: product.url, origin: product.origin };
    },
    async catalog() {
      return STUB_PRODUCTS.map(({ slug, name, tagline }) => ({ slug, name, tagline }));
    },
  };
}
