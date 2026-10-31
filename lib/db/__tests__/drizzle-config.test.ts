/**
 * drizzle.config.ts (drizzle-kit's db:generate and db:push) takes its database from lib/db/url.ts, so with a preview's
 * variables in the environment it gets no URL rather than production's DATABASE_URL. The config is read once per
 * process, so the variables are set before it loads. Every URL here is made up.
 *
 *   npx tsx --test lib/db/__tests__/drizzle-config.test.ts
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";

const PROD = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const NAMES = ["VERCEL_ENV", "DATABASE_URL", "PREVIEW_DATABASE_URL"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

after(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

it("gives drizzle-kit no database on a preview without PREVIEW_DATABASE_URL, not production's", async () => {
  process.env.VERCEL_ENV = "preview";
  process.env.DATABASE_URL = PROD;
  delete process.env.PREVIEW_DATABASE_URL;
  const config = (await import("../../../drizzle.config")).default as { dbCredentials?: { url?: string }; out?: string };
  assert.equal(config.out, "./drizzle");
  assert.equal(config.dbCredentials?.url, "");
});
