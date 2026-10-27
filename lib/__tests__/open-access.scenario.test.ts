/**
 * Drives getSessionUser, requireUser and requireAdmin with cookies, headers and the database faked: what a visitor
 * without a session gets under each OPEN_ACCESS mode and host, that a real session still wins, that the account row is
 * written once per server instance without touching its password or admin flag, and that cross-site requests are
 * refused. Needs --experimental-test-module-mocks (skips without it).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const ADMIN = "owner@example.com";
let cookie: string | undefined;
let requestHeaders = new Headers();
/** Each upsert: the email inserted and the columns it would overwrite on conflict. */
const upserts: Array<{ email: string; set: unknown; target: unknown }> = [];
let failInserts = 0;

const fakeDb = () => ({
  insert: (table: unknown) => {
    assert.equal(table, realSchema.users);
    return {
      values: (row: { email: string }) => ({
        onConflictDoUpdate: (conflict: { target: unknown; set: unknown }) => ({
          returning: async () => {
            if (failInserts > 0) {
              failInserts--;
              throw new Error("database down");
            }
            upserts.push({ email: row.email, set: conflict.set, target: conflict.target });
            return [{ id: `id:${row.email}`, email: row.email }];
          },
        }),
      }),
    };
  },
});

const canMock = typeof (mock as { module?: unknown }).module === "function";
let auth: typeof import("@/lib/auth");
const saved = { ...process.env };

function setEnv(mode: string | undefined, vercel?: string) {
  if (mode === undefined) delete process.env.OPEN_ACCESS;
  else process.env.OPEN_ACCESS = mode;
  if (vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercel;
}

const isAuthError = (status: number) => (err: unknown) =>
  err instanceof auth.AuthError && err.status === status;

describe("open access", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    process.env.SESSION_SECRET = "test-session-secret";
    process.env.ADMIN_EMAILS = ADMIN;
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({ get: (name: string) => (name === "mm_session" && cookie ? { value: cookie } : undefined) }),
        headers: async () => requestHeaders,
      },
    });
    mock.module(new URL("../db/client.ts", import.meta.url).href, {
      namedExports: { db: fakeDb, schema: realSchema },
    });
    auth = await import("@/lib/auth");
  });

  after(() => {
    process.env = saved;
  });

  beforeEach(() => {
    cookie = undefined;
    requestHeaders = new Headers({ host: "muse-muse-abc.vercel.app" });
    upserts.length = 0;
    failInserts = 0;
  });

  it("still requires sign-in when OPEN_ACCESS is unset", async () => {
    setEnv(undefined, "preview");
    assert.equal(await auth.getSessionUser(), null);
    await assert.rejects(auth.requireUser(), isAuthError(401));
    assert.deepEqual(upserts, []);
  });

  it("makes a preview visitor the admin account, writing its row once and only touching the email", async () => {
    setEnv("admin", "preview");
    const first = await auth.getSessionUser();
    assert.deepEqual(first, { id: `id:${ADMIN}`, email: ADMIN, isAdmin: true, openAccess: true });
    assert.deepEqual(await auth.requireAdmin(), first);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].email, ADMIN);
    assert.equal(upserts[0].target, realSchema.users.email);
    // On conflict only the email is "updated" (to itself), so an existing password and admin flag are kept.
    assert.deepEqual(upserts[0].set, { email: ADMIN });
  });

  it("keeps sign-in on in production even when OPEN_ACCESS says admin", async () => {
    setEnv("admin", "production");
    requestHeaders = new Headers({ host: "muse-muse.vercel.app" });
    assert.equal(await auth.getSessionUser(), null);
    await assert.rejects(auth.requireUser(), isAuthError(401));
    assert.deepEqual(upserts, []);
  });

  it("gives admin to a local run on localhost but not over the network or a tunnel", async () => {
    setEnv("admin", undefined);
    requestHeaders = new Headers({ host: "localhost:3000", "x-forwarded-host": "localhost:3000" });
    assert.equal((await auth.requireAdmin()).email, ADMIN);
    requestHeaders = new Headers({ host: "192.168.1.20:3000" });
    assert.equal(await auth.getSessionUser(), null);
    requestHeaders = new Headers({ host: "localhost:3000", "x-forwarded-host": "quiet-fox.trycloudflare.com" });
    assert.equal(await auth.getSessionUser(), null);
  });

  it("gives guest mode the shared non-admin account, in production too", async () => {
    setEnv("guest", "production");
    requestHeaders = new Headers({ host: "muse-muse.vercel.app" });
    const user = await auth.requireUser();
    assert.deepEqual(user, { id: `id:${auth.GUEST_EMAIL}`, email: auth.GUEST_EMAIL, isAdmin: false, openAccess: true });
    await assert.rejects(auth.requireAdmin(), isAuthError(403));
  });

  it("lets a real session win over open access", async () => {
    setEnv("admin", "preview");
    cookie = auth.encodeSession({ id: "u-tester", email: "tester@example.com", isAdmin: false });
    assert.deepEqual(await auth.requireUser(), { id: "u-tester", email: "tester@example.com", isAdmin: false });
  });

  it("refuses cross-site requests in admin mode, for requireUser and requireAdmin", async () => {
    setEnv("admin", "preview");
    requestHeaders = new Headers({
      host: "muse-muse-abc.vercel.app",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    await assert.rejects(auth.requireUser(), isAuthError(403));
    await assert.rejects(auth.requireAdmin(), isAuthError(403));
    requestHeaders = new Headers({
      host: "muse-muse-abc.vercel.app",
      origin: "https://muse-muse-abc.vercel.app",
      "sec-fetch-site": "same-origin",
    });
    assert.equal((await auth.requireAdmin()).email, ADMIN);
  });

  it("refuses cross-site requests in guest mode", async () => {
    setEnv("guest");
    requestHeaders = new Headers({ host: "mm.example", origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    await assert.rejects(auth.requireUser(), isAuthError(403));
    requestHeaders = new Headers({ host: "mm.example", origin: "https://mm.example", "sec-fetch-site": "same-origin" });
    assert.equal((await auth.requireUser()).email, auth.GUEST_EMAIL);
  });

  it("retries the account row after the database fails", async () => {
    setEnv("admin", "preview");
    process.env.ADMIN_EMAILS = "retry@example.com";
    const logged = mock.method(console, "error", () => {});
    try {
      failInserts = 1;
      await assert.rejects(auth.getSessionUser(), /database down/);
      assert.equal(logged.mock.callCount(), 1);
      assert.equal((await auth.getSessionUser())?.email, "retry@example.com");
      assert.deepEqual(
        upserts.map((u) => u.email),
        ["retry@example.com"],
      );
    } finally {
      logged.mock.restore();
      process.env.ADMIN_EMAILS = ADMIN;
    }
  });
});
