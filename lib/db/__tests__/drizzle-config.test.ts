/**
 * drizzle.config.ts (drizzle-kit's db:generate and db:push) takes its database from lib/db/url.ts, so with a preview's
 * variables in the environment it never gets production's DATABASE_URL. A preview without a database of its own gets
 * an address that can't resolve rather than "", which the Neon driver would fill from production's PG* variables. The
 * config is read when it loads, so each case sets the variables and loads a fresh copy. Every URL here is made up.
 *
 *   npx tsx --test lib/db/__tests__/drizzle-config.test.ts
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";

const PROD = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const NAMES = ["VERCEL_ENV", "DATABASE_URL", "PREVIEW_DATABASE_URL"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
const CONFIG = "../../../drizzle.config.ts";
let loads = 0;

type Config = { dbCredentials?: { url?: string }; out?: string };

/** drizzle.config.ts as drizzle-kit would load it with only these variables set. */
async function load(values: Partial<Record<(typeof NAMES)[number], string>>) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, values);
  // A query makes a fresh copy of the module, so the config is read again with these variables.
  const mod = (await import(`${CONFIG}?case=${++loads}`)) as { default: Config; NO_PREVIEW_DATABASE: string };
  return { config: mod.default, none: mod.NO_PREVIEW_DATABASE };
}

after(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

it("gives drizzle-kit an address that can't resolve on a preview without its own database, not production's", async () => {
  for (const PREVIEW_DATABASE_URL of [undefined, PROD]) {
    const { config, none } = await load({ VERCEL_ENV: "preview", DATABASE_URL: PROD, ...(PREVIEW_DATABASE_URL ? { PREVIEW_DATABASE_URL } : {}) });
    assert.equal(config.out, "./drizzle");
    assert.equal(config.dbCredentials?.url, none);
    assert.equal(new URL(none).hostname.endsWith(".invalid"), true);
  }
});
