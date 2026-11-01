/**
 * A preview with a database of its own is its own platform (README.md, Preview database): env.platformUrl is its
 * branch URL, else its deployment URL, since its builds and gateway tokens live only in that database. Whether it has
 * one is lib/db/url.ts's answer (previewHasOwnDatabase), so a preview with no database, or with production's, keeps
 * PLATFORM_URL as before. env.previewBypass, the secret the build firewall adds as x-vercel-protection-bypass
 * (lib/sandbox/policy.ts), comes only with that preview's own host, so it never goes to another site. Every value here
 * is made up.
 *
 *   npx tsx --test lib/__tests__/preview-bypass.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PRODUCTION_DATABASE_VARS } from "@/lib/db/url";
import { env } from "@/lib/env";
import { builderNetworkPolicy, publicHost } from "@/lib/sandbox/policy";

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

describe("env.previewBypass", () => {
  const SECRET = "bypass-secret-for-tests";
  const own = { PLATFORM_URL: PRODUCTION_SITE, VERCEL_URL: DEPLOYMENT_HOST, VERCEL_BRANCH_URL: BRANCH_HOST, DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW };

  it("is the secret with the preview's own host, on a preview that is its own platform", () => {
    set({ ...own, VERCEL_ENV: "preview", VERCEL_AUTOMATION_BYPASS_SECRET: ` ${SECRET} ` });
    assert.deepEqual(env.previewBypass, { host: BRANCH_HOST, secret: SECRET });
    assert.equal(publicHost(env.platformUrl), env.previewBypass?.host, "the host is platformUrl's");
    set({ ...own, VERCEL_ENV: " Preview ", VERCEL_AUTOMATION_BYPASS_SECRET: SECRET });
    assert.deepEqual(env.previewBypass, { host: BRANCH_HOST, secret: SECRET }, "a custom environment runs as preview too");
    set({ ...own, VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "", VERCEL_AUTOMATION_BYPASS_SECRET: SECRET });
    assert.deepEqual(env.previewBypass, { host: DEPLOYMENT_HOST, secret: SECRET }, "the deployment URL without a branch URL");
  });

  it("is null on production and local runs", () => {
    for (const VERCEL_ENV of ["production", "development", undefined]) {
      set({ ...own, ...(VERCEL_ENV ? { VERCEL_ENV } : {}), VERCEL_AUTOMATION_BYPASS_SECRET: SECRET });
      assert.equal(env.previewBypass, null, String(VERCEL_ENV));
    }
  });

  it("is null on a preview whose platformUrl is another site's, so the secret never goes there", () => {
    const cases: Array<[string, Partial<Record<Name, string>>]> = [
      ["no database of its own", { ...own, PREVIEW_DATABASE_URL: "" }],
      ["production's database", { ...own, PREVIEW_DATABASE_URL: PROD }],
      ["pglite", { ...own, DATABASE_URL: "pglite:.data/pglite" }],
      ["no branch or deployment URL", { PLATFORM_URL: PRODUCTION_SITE, DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }],
    ];
    for (const [why, values] of cases) {
      set({ ...values, VERCEL_ENV: "preview", VERCEL_AUTOMATION_BYPASS_SECRET: SECRET });
      assert.equal(env.previewBypass, null, why);
      assert.equal(env.platformUrl, PRODUCTION_SITE, why);
    }
  });

  it("is null on a preview without Protection Bypass for Automation", () => {
    for (const VERCEL_AUTOMATION_BYPASS_SECRET of [undefined, "", "   "]) {
      set({ ...own, VERCEL_ENV: "preview", ...(VERCEL_AUTOMATION_BYPASS_SECRET === undefined ? {} : { VERCEL_AUTOMATION_BYPASS_SECRET }) });
      assert.equal(env.previewBypass, null);
    }
  });

  it("reaches the firewall for the preview's own host only, not for a Prove it --site elsewhere", () => {
    set({ ...own, VERCEL_ENV: "preview", VERCEL_AUTOMATION_BYPASS_SECRET: SECRET });
    const rulesFor = (platformHost: string) => {
      const policy = builderNetworkPolicy({ modelApiKey: "k", placeholderKey: "p", platformHost, platformBypass: env.previewBypass });
      return { rules: (policy as { allow: Record<string, unknown[]> }).allow[platformHost], text: JSON.stringify(policy) };
    };
    const ownHost = publicHost(env.platformUrl)!;
    assert.ok(rulesFor(ownHost).text.includes(SECRET));
    for (const other of ["muse-muse.vercel.app", "some-other-site.example"]) {
      assert.deepEqual(rulesFor(other).rules, [], other);
      assert.ok(!rulesFor(other).text.includes(SECRET), other);
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
