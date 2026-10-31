/**
 * The restricted-territory block (TRUST_GEO_BLOCK): the list, the header check products use, and the platform's
 * next.config rewrites run through Next's own config matcher.
 *
 *   npx tsx --test lib/trust/__tests__/geo.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { trustGeoRewrites, UNAVAILABLE_PATH } from "@/lib/trust/geo-config";
import { geoBlocked, META_RESTRICTED_TERRITORIES, parseGeoCountries, productGeoCountries } from "@/lib/trust/geo";

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

describe("TRUST_GEO_COUNTRIES", () => {
  it("reads codes and region codes in any case and separator, drops junk, and expands meta", () => {
    assert.deepEqual(parseGeoCountries(" cu, ir ua-43  xx1 USA"), ["CU", "IR", "UA-43"]);
    assert.deepEqual(parseGeoCountries(""), []);
    assert.deepEqual(parseGeoCountries(undefined), []);
    const meta = parseGeoCountries("meta");
    assert.deepEqual(meta, [...META_RESTRICTED_TERRITORIES]);
    for (const c of ["CN", "HK", "MO", "RU", "KP", "UA-43", "UA-14", "UA-09"]) assert.ok(meta.includes(c), c);
    assert.ok(!meta.includes("UA"), "Ukraine itself isn't blocked, only the three regions");
  });

  it("adds a model's own restriction only for a product that calls it, and only when there's a list", () => {
    assert.deepEqual(productGeoCountries(["CU"], ["muse-wonder-1.0"]), ["CU"]);
    assert.deepEqual(productGeoCountries(["CU"], ["muse-image-1.0"]), ["CU", "IN"]);
    assert.deepEqual(productGeoCountries([], ["muse-image-1.0"]), []);
  });
});

describe("geoBlocked (the products' check)", () => {
  const list = parseGeoCountries("meta");
  it("blocks a listed country and a listed region, and nothing else", () => {
    assert.equal(geoBlocked(list, headers({ "x-vercel-ip-country": "CU" })), true);
    assert.equal(geoBlocked(list, headers({ "x-vercel-ip-country": "ua", "x-vercel-ip-country-region": "43" })), true);
    assert.equal(geoBlocked(list, headers({ "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "30" })), false);
    assert.equal(geoBlocked(list, headers({ "x-vercel-ip-country": "UA" })), false);
    assert.equal(geoBlocked(list, headers({ "x-vercel-ip-country": "US" })), false);
  });
  it("lets a request with no country header through (a local run), and blocks nothing with an empty list", () => {
    assert.equal(geoBlocked(list, headers({})), false);
    assert.equal(geoBlocked(list, headers({ "x-vercel-ip-country": "not a code" })), false);
    assert.equal(geoBlocked([], headers({ "x-vercel-ip-country": "CU" })), false);
  });
});

describe("the platform's rewrites (next.config.ts)", () => {
  it("are empty with the flag off, or with no list", () => {
    assert.deepEqual(trustGeoRewrites({}), []);
    assert.deepEqual(trustGeoRewrites({ TRUST_GEO_COUNTRIES: "meta" }), []);
    assert.deepEqual(trustGeoRewrites({ TRUST_GEO_BLOCK: "1" }), []);
    assert.deepEqual(trustGeoRewrites({ TRUST_GEO_BLOCK: "1", TRUST_GEO_COUNTRIES: "nonsense" }), []);
  });

  const rules = trustGeoRewrites({ TRUST_GEO_BLOCK: "on", TRUST_GEO_COUNTRIES: "meta" });
  const nextConfig = { rewrites: async () => ({ beforeFiles: rules, afterFiles: [], fallback: [] }) };
  const visit = async (path: string, h: Record<string, string>) => {
    const res = await unstable_getResponseFromNextConfig({ url: `https://musemuse.example${path}`, nextConfig, headers: h });
    return res.headers.get("x-middleware-rewrite");
  };

  it("send a request from a listed country or region to the unavailable page, on any path", async () => {
    for (const path of ["/", "/gallery", "/p/bird-count", "/api/inspirations", "/sign-in?next=/builds"]) {
      assert.equal(new URL((await visit(path, { "x-vercel-ip-country": "IR" }))!).pathname, UNAVAILABLE_PATH, path);
    }
    assert.equal(new URL((await visit("/", { "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "14" }))!).pathname, UNAVAILABLE_PATH);
  });

  it("leave everyone else, and the gateway, cron and Next's assets, alone", async () => {
    assert.equal(await visit("/", { "x-vercel-ip-country": "US" }), null);
    assert.equal(await visit("/", { "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "30" }), null);
    assert.equal(await visit("/", {}), null);
    assert.equal(await visit("/api/gateway/v1/responses", { "x-vercel-ip-country": "IR" }), null);
    assert.equal(await visit("/api/cron/cleanup", { "x-vercel-ip-country": "IR" }), null);
    assert.equal(await visit("/_next/static/chunks/main.js", { "x-vercel-ip-country": "IR" }), null);
    assert.equal(await visit(UNAVAILABLE_PATH, { "x-vercel-ip-country": "IR" }), null, "no loop");
  });
});
