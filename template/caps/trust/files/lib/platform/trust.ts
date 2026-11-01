// Platform file (Muse Muse trust). Don't edit: the platform puts it back before every check.
//
// What this product promises its users, from the two files the platform wrote for it: musemuse.trust.json (the age
// gate, the restricted territories, the Report link) and musemuse.privacy.json (which models get which inputs and what
// it keeps). proxy.ts, the Footer and the pages in app/(musemuse)/ all read them from here.
import privacy from "@/musemuse.privacy.json";
import trust from "@/musemuse.trust.json";

export interface TrustConfig {
  v: 1;
  product: { name: string; slug: string };
  termsVersion: string;
  updated: string;
  ageGate: boolean;
  legalPages: boolean;
  /** ISO country codes and region codes like "UA-43". Empty blocks nothing. */
  geo: string[];
  /** The platform's report page for this product, or null when reports are off. */
  reportUrl: string | null;
}

export interface PrivacyModel {
  id: string;
  label: string;
  does: string;
  gets: string[];
}

export interface ProductPrivacy {
  v: 1;
  models: PrivacyModel[];
  /** What it keeps and where, one sentence each. */
  keeps: string[];
  /** Outside services besides Meta, one sentence each (connected tools through Composio). */
  services: string[];
  /** True when big files go to temporary storage, deleted after 24 hours. */
  uploads: boolean;
}

export const TRUST = trust as unknown as TrustConfig;
export const PRIVACY = privacy as unknown as ProductPrivacy;

/** The cookie the age gate sets: the terms version the visitor confirmed 18+ for. */
export const AGE_COOKIE = "mm_age";

/** Paths the age gate never covers: the gate itself and the pages it links to. */
export const UNGATED_PATHS = ["/age", "/privacy", "/terms"];

/** True when Vercel's country headers put this request in a restricted territory on the list. */
export function geoBlocked(countries: readonly string[], get: (name: string) => string | null): boolean {
  if (!countries.length) return false;
  const country = (get("x-vercel-ip-country") ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return false;
  const region = (get("x-vercel-ip-country-region") ?? "").trim().toUpperCase();
  return countries.includes(country) || (/^[A-Z0-9]{1,3}$/.test(region) && countries.includes(`${country}-${region}`));
}

/**
 * A path inside this product to go back to after the age gate, or "/". Never another site: a backslash or a control
 * character is refused outright (browsers drop a tab or newline, so "/<tab>/evil.example" would become "//evil.example"),
 * and what's left must resolve to this same site.
 */
export function safeNext(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!raw || !raw.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  const base = "https://same-site.invalid";
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  return `${url.pathname}${url.search}${url.hash}`.slice(0, 500);
}
