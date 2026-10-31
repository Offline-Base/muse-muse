/**
 * The platform's restricted-territory block as next.config.ts rewrites (TRUST_GEO_BLOCK, docs/CAPABILITIES.md,
 * section 7). Vercel's edge matches them on x-vercel-ip-country before any of the app runs, so with the flag off there
 * is nothing at all: no rule, no proxy, no extra function call. The settings are read when the config loads, at build
 * time on Vercel, so a change needs a redeploy (as any env change there does). Relative imports only: next.config.ts
 * loads this before the app's path aliases exist.
 */
import { COUNTRY_HEADER, parseGeoCountries, REGION_HEADER } from "./geo";

/** Where a blocked request goes: a route that answers 451 with a short page (app/api/trust/unavailable/route.ts). */
export const UNAVAILABLE_PATH = "/api/trust/unavailable";

/**
 * Not blocked: Next's own assets, the gateway and cron (other servers call them, from where they run, never a
 * person's browser) and the unavailable page itself.
 */
const SOURCE = "/:path((?!_next/|api/gateway/|api/cron/|api/trust/unavailable).*)";

interface HasHeader {
  type: "header";
  key: string;
  value: string;
}
export interface GeoRewrite {
  source: string;
  destination: string;
  has: HasHeader[];
}

/** One rule for every whole country, then one per country that has blocked regions. Empty with the flag off or no list. */
export function trustGeoRewrites(vars: Record<string, string | undefined>): GeoRewrite[] {
  const on = ["1", "true", "yes", "on"].includes((vars.TRUST_GEO_BLOCK ?? "").trim().toLowerCase());
  if (!on) return [];
  const codes = parseGeoCountries(vars.TRUST_GEO_COUNTRIES);
  const whole = codes.filter((c) => !c.includes("-"));
  const regions = new Map<string, string[]>();
  for (const c of codes.filter((x) => x.includes("-"))) {
    const [country, region] = c.split("-") as [string, string];
    if (whole.includes(country)) continue;
    regions.set(country, [...(regions.get(country) ?? []), region]);
  }
  const rule = (has: HasHeader[]): GeoRewrite => ({ source: SOURCE, destination: UNAVAILABLE_PATH, has });
  const out: GeoRewrite[] = [];
  if (whole.length) out.push(rule([{ type: "header", key: COUNTRY_HEADER, value: `(${whole.join("|")})` }]));
  for (const [country, list] of regions) {
    out.push(rule([{ type: "header", key: COUNTRY_HEADER, value: country }, { type: "header", key: REGION_HEADER, value: `(${list.join("|")})` }]));
  }
  return out;
}
