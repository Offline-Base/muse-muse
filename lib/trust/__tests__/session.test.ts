/**
 * A ban ends a builder's existing sessions (TRUST_REPORTS, docs/CAPABILITIES.md, section 7): getSessionUser and
 * requireUser read users.banned_at for a real session's account, so a 14-day cookie from before the ban stops working.
 * Nothing is read with the flag off. Cookies and the database are faked.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/trust/__tests__/session.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
let cookie: string | undefined;
let bannedAt: Date | null = null;
let reads = 0;

const fakeDb = () => ({
  select: () => ({
    from: (table: unknown) => {
      assert.equal(table, realSchema.users);
      return {
        where: () => ({
          limit: async () => {
            reads += 1;
            return [{ bannedAt }];
          },
        }),
      };
    },
  }),
});

describe("a ban and existing sessions", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let auth: typeof import("@/lib/auth");
  const saved = { ...process.env };
  const builder = { id: "11111111-1111-4111-8111-111111111111", email: "maker@example.com", isAdmin: false };

  before(async () => {
    process.env.SESSION_SECRET = "test-session-secret";
    delete process.env.OPEN_ACCESS;
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({ get: (name: string) => (name === "mm_session" && cookie ? { value: cookie } : undefined) }),
        headers: async () => new Headers({ host: "muse-muse.example" }),
      },
    });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: fakeDb, schema: realSchema } });
    auth = await import("@/lib/auth");
  });
  after(() => {
    process.env = saved;
  });
  beforeEach(() => {
    cookie = auth.encodeSession(builder);
    bannedAt = null;
    reads = 0;
    delete process.env.TRUST_REPORTS;
  });

  it("with TRUST_REPORTS off, reads nothing and keeps the session, even for a banned account", async () => {
    bannedAt = new Date();
    assert.equal((await auth.getSessionUser())?.id, builder.id);
    assert.equal(reads, 0);
  });

  it("with TRUST_REPORTS on, keeps an account that isn't banned", async () => {
    process.env.TRUST_REPORTS = "1";
    assert.equal((await auth.requireUser()).id, builder.id);
    assert.equal(reads, 1);
  });

  it("with TRUST_REPORTS on, treats a banned account's session as signed out", async () => {
    process.env.TRUST_REPORTS = "1";
    bannedAt = new Date();
    assert.equal(await auth.getSessionUser(), null);
    await assert.rejects(auth.requireUser(), (err: unknown) => err instanceof auth.AuthError && err.status === 401);
  });
});
