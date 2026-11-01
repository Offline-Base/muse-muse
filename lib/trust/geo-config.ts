/**
 * The platform's restricted-territory block as next.config.ts rewrites (TRUST_GEO_BLOCK, docs/CAPABILITIES.md,
 * section 7). Vercel's edge matches them on x-vercel-ip-country before any of the app runs, so with the flag off there
 * is nothing at all: no rule, no proxy, no extra function call. The settings are read when the config loads, at build
 * time on Vercel, so a change needs a redeploy (as any env change there does). Relative imports only: next.config.ts
 * loads this before the app's path aliases exist.
 */
import { COUNTRY_HEADER, MODEL_RESTRICTED_COUNTRIES, parseGeoCountries, REGION_HEADER } from "./geo";

/** Where a blocked request goes: a route that answers 451 with a short page (app/api/trust/unavailable/route.ts). */
export const UNAVAILABLE_PATH = "/api/trust/unavailable";

/**
 * Not blocked: Next's own assets, the gateway and cron (other servers call them, from where they run, never a
 * person's browser) and the unavailable page itself.
 */
const SOURCE = "/:path((?!_next/|api/gateway/|api/cron/|api/trust/unavailable).*)";

/**
 * The platform's own routes that call a model with its own country rule (MODEL_RESTRICTED_COUNTRIES): the docs
 * playground's image endpoints call Muse Image for whoever is visiting. A request to them from one of the model's
 * countries goes to the unavailable route with ?model=, which answers in JSON. Not covered here, and listed for the
 * owner in docs/CAPABILITIES.md 7a: the playground's /responses with model muse-image-1.0 (the model is in the body,
 * which a rewrite can't see) and the fixture images a build makes for its builder.
 */
const MODEL_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "muse-image-1.0": ["/api/docs/v1/images/:path*"],
};

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
  if (!codes.length) return [];
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
  // With any list on, a model's own countries (Muse Image in India), as productGeoCountries adds them for products.
  for (const [model, sources] of Object.entries(MODEL_ROUTES)) {
    const countries = (MODEL_RESTRICTED_COUNTRIES[model] ?? []).filter((c) => !whole.includes(c));
    if (!countries.length) continue;
    for (const source of sources) {
      out.push({ source, destination: `${UNAVAILABLE_PATH}?model=${encodeURIComponent(model)}`, has: [{ type: "header", key: COUNTRY_HEADER, value: `(${countries.join("|")})` }] });
    }
  }
  return out;
}
