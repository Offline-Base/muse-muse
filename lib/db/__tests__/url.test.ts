/**
 * Which database each environment uses (lib/db/url.ts), row by row of the table in README.md, Preview database: a
 * preview gets PREVIEW_DATABASE_URL or no database, never production's, and production, development and pglite runs
 * are unchanged. Also env.databaseUrl and safeQuery, which ask the same helper. Every URL here is made up.
 *
 *   npx tsx --test lib/db/__tests__/url.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DATABASE_UNSET,
  PREVIEW_DATABASE_IS_PRODUCTION,
  PREVIEW_DATABASE_UNSET,
  databaseChoice,
  databaseUrl,
  localDbDir,
  previewHasOwnDatabase,
  sameDatabase,
} from "@/lib/db/url";
import { env } from "@/lib/env";

const PROD = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PROD_UNPOOLED = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PREVIEW = "postgresql://prev_owner:fake-preview-secret@ep-preview-111111-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("databaseChoice", () => {
  it("production uses DATABASE_URL and ignores PREVIEW_DATABASE_URL", () => {
    assert.deepEqual(databaseChoice({ VERCEL_ENV: "production", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), {
      url: PROD,
      from: "DATABASE_URL",
    });
    assert.equal(databaseUrl({ VERCEL_ENV: "production", DATABASE_URL: PROD }), PROD);
  });

  it("development and local runs (VERCEL_ENV unset) use DATABASE_URL, as before", () => {
    assert.equal(databaseUrl({ VERCEL_ENV: "development", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), PROD);
    assert.equal(databaseUrl({ DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), PROD);
  });

  it("without DATABASE_URL, production and local runs have no database, with the old message", () => {
    for (const e of [{ VERCEL_ENV: "production" }, {}, { DATABASE_URL: "" }, { VERCEL_ENV: "development", PREVIEW_DATABASE_URL: PREVIEW }]) {
      assert.deepEqual(databaseChoice(e), { url: null, why: "unset", message: DATABASE_UNSET });
    }
    assert.equal(DATABASE_UNSET, "DATABASE_URL is not set. See .env.example.");
  });

  it("pglite:<folder> stays that folder, whatever VERCEL_ENV says", () => {
    for (const VERCEL_ENV of [undefined, "development", "production", "preview"]) {
      assert.deepEqual(databaseChoice({ VERCEL_ENV, DATABASE_URL: "pglite:.data/pglite", PREVIEW_DATABASE_URL: PREVIEW }), {
        url: "pglite:.data/pglite",
        from: "DATABASE_URL",
      });
    }
    assert.equal(localDbDir("pglite:.data/room"), ".data/room");
    assert.equal(localDbDir("pglite:"), ".data/pglite");
    assert.equal(localDbDir(PROD), null);
  });

  it("a preview with PREVIEW_DATABASE_URL uses it, not DATABASE_URL", () => {
    assert.deepEqual(databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), {
      url: PREVIEW,
      from: "PREVIEW_DATABASE_URL",
    });
    assert.equal(databaseUrl({ VERCEL_ENV: "preview", PREVIEW_DATABASE_URL: ` ${PREVIEW}\n` }), PREVIEW, "trimmed");
    assert.equal(databaseUrl({ VERCEL_ENV: " Preview ", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), PREVIEW);
  });

  it("a preview without PREVIEW_DATABASE_URL has no database, and never falls back to DATABASE_URL", () => {
    for (const PREVIEW_DATABASE_URL of [undefined, "", "   "]) {
      assert.deepEqual(databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: PROD, POSTGRES_URL: PROD, PREVIEW_DATABASE_URL }), {
        url: null,
        why: "preview_unset",
        message: PREVIEW_DATABASE_UNSET,
      });
    }
  });

  it("a preview whose PREVIEW_DATABASE_URL is production's database has none", () => {
    const refused = { url: null, why: "preview_is_production", message: PREVIEW_DATABASE_IS_PRODUCTION };
    assert.deepEqual(databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PROD }), refused, "equal");
    assert.deepEqual(databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PROD_UNPOOLED }), refused, "unpooled");
    assert.deepEqual(
      databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: PREVIEW.replace("ep-preview-111111", "ep-other"), POSTGRES_URL_NON_POOLING: PROD_UNPOOLED, PREVIEW_DATABASE_URL: PROD }),
      refused,
      "the integration's other variables count as production too",
    );
    assert.deepEqual(
      databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: PREVIEW.replace("ep-preview-111111", "ep-other"), POSTGRES_URL_NO_SSL: PROD_UNPOOLED, PREVIEW_DATABASE_URL: PROD }),
      refused,
      "POSTGRES_URL_NO_SSL too",
    );
    assert.deepEqual(databaseChoice({ VERCEL_ENV: "preview", DATABASE_URL: "not a url", PREVIEW_DATABASE_URL: " not a url " }), refused, "unparsed");
  });

  it("messages name the fix and carry no em dash", () => {
    for (const message of [DATABASE_UNSET, PREVIEW_DATABASE_UNSET, PREVIEW_DATABASE_IS_PRODUCTION]) assert.ok(!message.includes(String.fromCharCode(0x2014)), message);
    assert.match(PREVIEW_DATABASE_UNSET, /PREVIEW_DATABASE_URL is not set/);
    assert.match(PREVIEW_DATABASE_IS_PRODUCTION, /Neon branch "preview"/);
  });
});

describe("previewHasOwnDatabase", () => {
  it("is true only on a preview that uses PREVIEW_DATABASE_URL", () => {
    assert.equal(previewHasOwnDatabase({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), true);
    assert.equal(previewHasOwnDatabase({ VERCEL_ENV: " Preview ", PREVIEW_DATABASE_URL: ` ${PREVIEW} ` }), true);
  });

  it("is false on a preview with no database, or with production's", () => {
    assert.equal(previewHasOwnDatabase({ VERCEL_ENV: "preview", DATABASE_URL: PROD }), false);
    assert.equal(previewHasOwnDatabase({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: "  " }), false);
    assert.equal(previewHasOwnDatabase({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PROD_UNPOOLED }), false);
  });

  it("is false on production, development, local runs and pglite, whatever PREVIEW_DATABASE_URL says", () => {
    for (const VERCEL_ENV of ["production", "development", undefined]) {
      assert.equal(previewHasOwnDatabase({ VERCEL_ENV, DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }), false, String(VERCEL_ENV));
    }
    assert.equal(previewHasOwnDatabase({ VERCEL_ENV: "preview", DATABASE_URL: "pglite:.data/pglite", PREVIEW_DATABASE_URL: PREVIEW }), false);
  });
});

describe("sameDatabase", () => {
  it("ignores the pooler, the user, the password and the options", () => {
    assert.ok(sameDatabase(PROD, PROD_UNPOOLED));
    assert.ok(sameDatabase(PROD, "postgres://someone:other@EP-PROD-000000-POOLER.us-east-2.aws.neon.tech:5432/neondb"));
  });

  it("knows a Neon database by its endpoint id, whatever the rest of the host or the port says", () => {
    assert.ok(sameDatabase(PROD, "postgresql://prod_owner:x@ep-prod-000000-pooler.c-2.us-east-2.aws.neon.tech/neondb"), "another host form");
    assert.ok(sameDatabase(PROD, PROD.replace(".neon.tech/", ".neon.tech:6543/")), "another port");
    assert.ok(sameDatabase(PROD, "postgresql://prod_owner:x@db-proxy.example.com/neondb?options=endpoint%3Dep-prod-000000"), "options=endpoint=");
    assert.ok(!sameDatabase(PREVIEW, "postgresql://prev_owner:x@db-proxy.example.com/neondb?options=endpoint%3Dep-prod-000000"));
  });

  it("tells apart another endpoint, another database, and elsewhere another host or port", () => {
    assert.ok(!sameDatabase(PROD, PREVIEW));
    assert.ok(!sameDatabase(PROD, PROD.replace("/neondb?", "/preview?")), "another database on the same endpoint");
    const elsewhere = "postgresql://app:x@db.example.com/app";
    assert.ok(sameDatabase(elsewhere, "postgresql://other:y@DB.example.com:5432/app?sslmode=require"));
    assert.ok(!sameDatabase(elsewhere, "postgresql://app:x@db.example.com:6543/app"));
    assert.ok(!sameDatabase(elsewhere, "postgresql://app:x@db2.example.com/app"));
  });
});

describe("env.databaseUrl and safeQuery", () => {
  const NAMES = ["VERCEL_ENV", "DATABASE_URL", "PREVIEW_DATABASE_URL"] as const;
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });
  function set(values: Partial<Record<(typeof NAMES)[number], string>>) {
    for (const n of NAMES) delete process.env[n];
    Object.assign(process.env, values);
  }

  it("env.databaseUrl gives the preview database on a preview, and DATABASE_URL elsewhere", () => {
    set({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.databaseUrl, PREVIEW);
    set({ VERCEL_ENV: "production", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW });
    assert.equal(env.databaseUrl, PROD);
    set({ DATABASE_URL: "pglite:.data/pglite" });
    assert.equal(env.databaseUrl, "pglite:.data/pglite");
  });

  it("env.databaseUrl throws on a preview without its own database, as it does without DATABASE_URL", () => {
    set({ VERCEL_ENV: "preview", DATABASE_URL: PROD });
    assert.throws(() => env.databaseUrl, { message: PREVIEW_DATABASE_UNSET });
    set({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PROD });
    assert.throws(() => env.databaseUrl, { message: PREVIEW_DATABASE_IS_PRODUCTION });
    set({});
    assert.throws(() => env.databaseUrl, { message: DATABASE_UNSET });
  });

  it("safeQuery answers not_configured on a preview without its own database, and runs nothing", async () => {
    const { safeQuery } = await import("@/lib/queries");
    let ran = 0;
    const read = async () => ++ran;
    set({ VERCEL_ENV: "preview", DATABASE_URL: PROD });
    assert.deepEqual(await safeQuery(read), { ok: false, reason: "not_configured", message: "The database isn't connected yet." });
    set({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PROD });
    assert.equal((await safeQuery(read)).ok, false);
    assert.equal(ran, 0);
    set({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW });
    assert.deepEqual(await safeQuery(read), { ok: true, data: 1 });
    set({ VERCEL_ENV: "production", DATABASE_URL: PROD });
    assert.deepEqual(await safeQuery(read), { ok: true, data: 2 });
    set({});
    assert.equal((await safeQuery(read)).ok, false);
  });
});
