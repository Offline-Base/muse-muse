/**
 * The restricted-territory block (TRUST_GEO_BLOCK, docs/CAPABILITIES.md, section 7). Meta doesn't route by location, so
 * the platform and its products block requests from the territories in Meta's Geographic Use Policy themselves, by the
 * x-vercel-ip-country header Vercel's edge sets (and x-vercel-ip-country-region for regions). No imports, so lib/env.ts,
 * next.config.ts and the product overlay's copy can all use it.
 */

/** Vercel's headers: an ISO 3166-1 country, and the ISO 3166-2 region code without the country (Crimea is "43"). */
export const COUNTRY_HEADER = "x-vercel-ip-country";
export const REGION_HEADER = "x-vercel-ip-country-region";

/**
 * Section 3 of Meta's Geographic Use Policy, "Last updated: October 12, 2026", read on Oct 31, 2026
 * (https://dev.meta.ai/legal/geographic-use-policy). China includes Hong Kong and Macau. Crimea, Donetsk and Luhansk are
 * regions of Ukraine, so they are region codes (Sevastopol, UA-40, is in Crimea). The owner confirms this list
 * (decision 4); TRUST_GEO_COUNTRIES=meta stands for it.
 */
export const META_RESTRICTED_TERRITORIES: readonly string[] = [
  "AF", "BY", "KH", "CN", "HK", "MO", "CU", "ER", "ET", "HT", "IR", "IQ", "LY", "MM", "NI", "KP", "PK", "RU", "SO",
  "SY", "UA-43", "UA-40", "UA-14", "UA-09", "VE", "EH",
];

/**
 * Section 2.2 of the same policy: a model that may not be reached from a country. A product that calls the model is
 * also blocked there, on top of the list above.
 */
export const MODEL_RESTRICTED_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  "muse-image-1.0": ["IN"],
};

const CODE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

/**
 * TRUST_GEO_COUNTRIES as a list: ISO codes like "CU" and region codes like "UA-43", separated by commas or spaces, in any
 * case. "meta" adds Meta's list. Anything else is dropped. Empty blocks nothing.
 */
export function parseGeoCountries(raw: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const code = part.trim().toUpperCase();
    if (!code) continue;
    if (code === "META") META_RESTRICTED_TERRITORIES.forEach((c) => out.add(c));
    else if (CODE.test(code)) out.add(code);
  }
  return [...out];
}

/** The list a product blocks: the platform's, plus each model restriction for a model the product calls. */
export function productGeoCountries(countries: readonly string[], models: readonly string[]): string[] {
  if (!countries.length) return [];
  const out = new Set(countries);
  for (const m of models) for (const c of MODEL_RESTRICTED_COUNTRIES[m] ?? []) out.add(c);
  return [...out];
}

/** The territory a request comes from, as the list names it, or null when Vercel didn't say (a local run). */
export function requestTerritory(get: (name: string) => string | null | undefined): { country: string; region: string | null } | null {
  const country = (get(COUNTRY_HEADER) ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const region = (get(REGION_HEADER) ?? "").trim().toUpperCase();
  return { country, region: /^[A-Z0-9]{1,3}$/.test(region) ? region : null };
}

/** True when the request's country, or its country and region, is on the list. */
export function geoBlocked(countries: readonly string[], get: (name: string) => string | null | undefined): boolean {
  if (!countries.length) return false;
  const at = requestTerritory(get);
  if (!at) return false;
  return countries.includes(at.country) || (at.region !== null && countries.includes(`${at.country}-${at.region}`));
}
