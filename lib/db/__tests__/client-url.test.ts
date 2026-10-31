/**
 * db() opens the database lib/db/url.ts picks: on a preview without PREVIEW_DATABASE_URL it throws before any client
 * exists, and with it the Neon client gets the preview's URL, never DATABASE_URL. In production it opens DATABASE_URL,
 * as before. db() keeps its client, so each case loads a fresh copy of lib/db/client.ts. The Neon driver and Drizzle
 * are faked, so nothing connects. Every URL here is made up.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/db/__tests__/client-url.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

const PROD = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const PREVIEW = "postgresql://prev_owner:fake-preview-secret@ep-preview-111111-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const NAMES = ["VERCEL_ENV", "DATABASE_URL", "PREVIEW_DATABASE_URL"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
const opened: string[] = [];

describe("db() per environment", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(() => {
    mock.module("@neondatabase/serverless", {
      namedExports: {
        neon: (url: string) => {
          opened.push(url);
          return () => Promise.resolve([]);
        },
      },
    });
    mock.module("drizzle-orm/neon-http", { namedExports: { drizzle: () => ({ fake: true }) } });
  });

  after(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it("throws without PREVIEW_DATABASE_URL and opens nothing, then opens the preview database once it is set", async () => {
    const { db } = await import("@/lib/db/client");
    const { PREVIEW_DATABASE_UNSET, PREVIEW_DATABASE_IS_PRODUCTION } = await import("@/lib/db/url");
    process.env.VERCEL_ENV = "preview";
    process.env.DATABASE_URL = PROD;
    delete process.env.PREVIEW_DATABASE_URL;
    assert.throws(() => db(), { message: PREVIEW_DATABASE_UNSET });
    process.env.PREVIEW_DATABASE_URL = PROD;
    assert.throws(() => db(), { message: PREVIEW_DATABASE_IS_PRODUCTION });
    assert.deepEqual(opened, []);

    process.env.PREVIEW_DATABASE_URL = PREVIEW;
    assert.deepEqual(db(), { fake: true });
    assert.deepEqual(opened, [PREVIEW]);
  });

  it("opens DATABASE_URL in production, and ignores PREVIEW_DATABASE_URL there", async () => {
    // A query makes a fresh copy of the module, without the client the case above kept.
    const { db } = (await import(`${"../client.ts"}?production`)) as typeof import("@/lib/db/client");
    opened.length = 0;
    process.env.VERCEL_ENV = "production";
    process.env.DATABASE_URL = PROD;
    process.env.PREVIEW_DATABASE_URL = PREVIEW;
    assert.deepEqual(db(), { fake: true });
    assert.deepEqual(opened, [PROD]);
  });
});
