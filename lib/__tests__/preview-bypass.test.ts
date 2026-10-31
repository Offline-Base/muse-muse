/**
 * A preview with a database of its own is its own platform (README.md, Preview database): env.platformUrl is its
 * branch URL, else its deployment URL, since its builds and gateway tokens live only in that database. Whether it has
 * one is lib/db/url.ts's answer (previewHasOwnDatabase), so a preview with no database, or with production's, keeps
 * PLATFORM_URL as before. env.previewBypassSecret, which the build firewall adds as x-vercel-protection-bypass
 * (lib/sandbox/policy.ts), is read on previews only. Every value here is made up.
 *
 *   npx tsx --test lib/__tests__/preview-bypass.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PRODUCTION_DATABASE_VARS } from "@/lib/db/url";
import { env } from "@/lib/env";

const PROD = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PREVIEW = "postgresql://prev_owner:fake-preview-secret@ep-preview-111111-pooler.us-east-2.aws.neon.tech/preview?sslmode=require";
const PRODUCTION_SITE = "https://muse-muse.vercel.app";
const BRANCH_HOST = "muse-muse-git-tg-cap-int-team.vercel.app";
const DEPLOYMENT_HOST = "muse-muse-abc123-team.vercel.app";

const NAMES = [
  "VERCEL_ENV",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "PREVIEW_DATABASE_URL",
  ...PRODUCTION_DATABASE_VARS,
  "PLATFORM_URL",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;
type Name = (typeof NAMES)[number];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

function set(values: Partial<Record<Name, string>>) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("env.previewBypassSecret", () => {
  it("is read on previews only, never on production or local runs", () => {
    set({ VERCEL_ENV: "preview", VERCEL_AUTOMATION_BYPASS_SECRET: " bypass-secret-for-tests " });
    assert.equal(env.previewBypassSecret, "bypass-secret-for-tests");
    set({ VERCEL_ENV: " Preview ", VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret-for-tests" });
    assert.equal(env.previewBypassSecret, "bypass-secret-for-tests", "a custom environment runs as preview too");
    for (const VERCEL_ENV of ["production", "development", undefined]) {
      set({ ...(VERCEL_ENV ? { VERCEL_ENV } : {}), VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret-for-tests" });
      assert.equal(env.previewBypassSecret, null, String(VERCEL_ENV));
    }
  });

  it("is null on a preview without Protection Bypass for Automation", () => {
    for (const VERCEL_AUTOMATION_BYPASS_SECRET of [undefined, "", "   "]) {
      set({ VERCEL_ENV: "preview", ...(VERCEL_AUTOMATION_BYPASS_SECRET === undefined ? {} : { VERCEL_AUTOMATION_BYPASS_SECRET }) });
      assert.equal(env.previewBypassSecret, null);
    }
  });
});

describe("env.platformUrl on a preview", () => {
  const vercel = { PLATFORM_URL: PRODUCTION_SITE, VERCEL_URL: DEPLOYMENT_HOST, VERCEL_BRANCH_URL: BRANCH_HOST, DATABASE_URL: PROD };

  it("is the preview's branch URL when it has its own database, and the gateway follows", () => {
    set({ ...vercel, VERCEL_ENV: "preview", PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.platformUrl, `https://${BRANCH_HOST}`);
    assert.equal(env.gatewayUrl, `https://${BRANCH_HOST}/api/gateway`);
  });

  it("falls back to the deployment URL when there's no branch URL, and to PLATFORM_URL with neither", () => {
    set({ ...vercel, VERCEL_ENV: "preview", PREVIEW_DATABASE_URL: PREVIEW, VERCEL_BRANCH_URL: "" });
    assert.equal(env.platformUrl, `https://${DEPLOYMENT_HOST}`);
    set({ PLATFORM_URL: PRODUCTION_SITE, DATABASE_URL: PROD, VERCEL_ENV: "preview", PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.platformUrl, PRODUCTION_SITE);
  });

  it("keeps PLATFORM_URL on a preview with no database of its own", () => {
    set({ ...vercel, VERCEL_ENV: "preview" });
    assert.equal(env.platformUrl, PRODUCTION_SITE, "PREVIEW_DATABASE_URL unset");
    set({ ...vercel, VERCEL_ENV: "preview", PREVIEW_DATABASE_URL: PROD });
    assert.equal(env.platformUrl, PRODUCTION_SITE, "PREVIEW_DATABASE_URL is production's database, so lib/db/url.ts refuses it");
    set({ ...vercel, VERCEL_ENV: "preview", DATABASE_URL: "pglite:.data/pglite", PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.platformUrl, PRODUCTION_SITE, "pglite is a local run, not the preview's own database");
  });

  it("is unchanged on production and local runs, even with PREVIEW_DATABASE_URL set", () => {
    set({ ...vercel, VERCEL_ENV: "production", PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.platformUrl, PRODUCTION_SITE);
    set({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "muse-muse.vercel.app", VERCEL_BRANCH_URL: BRANCH_HOST, DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.platformUrl, PRODUCTION_SITE);
    set({ PREVIEW_DATABASE_URL: PREVIEW, VERCEL_BRANCH_URL: BRANCH_HOST, DATABASE_URL: PROD });
    assert.equal(env.platformUrl, "http://localhost:3000");
  });

  it("still never publishes on a preview, though its own address is public", () => {
    set({ ...vercel, VERCEL_ENV: "preview", PREVIEW_DATABASE_URL: PREVIEW });
    assert.match(env.publishOffReason ?? "", /^it's a Vercel preview, /);
  });
});
