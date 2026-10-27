import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, describe, it } from "node:test";
import type { AuthStore, SessionUser, SignInConfig, UserRecord } from "@/lib/auth";

let auth: typeof import("@/lib/auth");

before(async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  auth = await import("@/lib/auth");
});

const SHARED = "shared-code";
const ADMIN_CODE = "admin-only-code";
const ADMIN = "owner@example.com";
const config: SignInConfig = { accessCode: SHARED, adminAccessCode: ADMIN_CODE, adminEmails: [ADMIN] };
const PASSWORD = "correct horse battery";

/** In-memory users table with the same claim rule as the database store. */
function memoryStore(seed: UserRecord[] = []) {
  const rows = new Map(seed.map((r) => [r.email, { ...r }]));
  let n = 0;
  const store: AuthStore & { rows: typeof rows; beforeClaim?: () => void } = {
    rows,
    async findByEmail(email) {
      const row = rows.get(email);
      return row ? { ...row } : null;
    },
    async claim(email, passwordHash) {
      store.beforeClaim?.();
      const row = rows.get(email);
      if (row?.passwordHash) return null;
      const next = row ? { ...row, passwordHash } : { id: `u${++n}`, email, isAdmin: false, passwordHash };
      rows.set(email, next);
      return { ...next };
    },
    async setAdmin(id, isAdmin) {
      for (const row of rows.values()) if (row.id === id) row.isAdmin = isAdmin;
    },
  };
  return store;
}

describe("passwords", () => {
  it("hashes with scrypt and a random salt, and verifies only the same password", async () => {
    const a = await auth.hashPassword(PASSWORD);
    const b = await auth.hashPassword(PASSWORD);
    assert.match(a, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(a, b);
    assert.equal(await auth.verifyPassword(PASSWORD, a), true);
    assert.equal(await auth.verifyPassword("correct horse battery!", a), false);
    assert.equal(await auth.verifyPassword(PASSWORD, "plain-text"), false);
    assert.equal(await auth.verifyPassword(PASSWORD, a.replace("$16384$", "$1073741824$")), false);
  });
});

describe("access codes", () => {
  it("tells the admin code from the shared one", () => {
    assert.equal(auth.codeKind(` ${SHARED} `, SHARED, ADMIN_CODE), "shared");
    assert.equal(auth.codeKind(ADMIN_CODE, SHARED, ADMIN_CODE), "admin");
    assert.equal(auth.codeKind("guess", SHARED, ADMIN_CODE), null);
  });

  it("never treats the shared code as the admin code", () => {
    assert.equal(auth.codeKind(SHARED, SHARED, SHARED), "shared");
    assert.equal(auth.codeKind(SHARED, SHARED, undefined), "shared");
    assert.equal(auth.codeKind("", SHARED, ""), null);
  });
});

describe("checkSignIn", () => {
  const signIn = (store: AuthStore, email: string, code: string, password = PASSWORD) =>
    auth.checkSignIn({ email, code, password }, store, config);

  it("claims a new email with the first password, then requires it", async () => {
    const store = memoryStore();
    const first = await signIn(store, " Tester@Example.com ", SHARED);
    assert.deepEqual(first, { id: "u1", email: "tester@example.com", isAdmin: false });
    assert.ok(store.rows.get("tester@example.com")?.passwordHash?.startsWith("scrypt$"));
    assert.deepEqual(await signIn(store, "tester@example.com", SHARED), first);
    assert.equal(await signIn(store, "tester@example.com", SHARED, "someone else's guess"), null);
  });

  it("claims an existing row that has no password yet", async () => {
    const store = memoryStore([{ id: "old", email: "old@example.com", isAdmin: false, passwordHash: null }]);
    assert.equal((await signIn(store, "old@example.com", SHARED))?.id, "old");
    assert.equal(await signIn(store, "old@example.com", SHARED, "a different password"), null);
  });

  it("refuses a wrong code before touching the store", async () => {
    const store = memoryStore();
    assert.equal(await signIn(store, "tester@example.com", "wrong"), null);
    assert.equal(store.rows.size, 0);
  });

  it("refuses short passwords and bad emails", async () => {
    const store = memoryStore();
    assert.equal(await signIn(store, "tester@example.com", SHARED, "short"), null);
    assert.equal(await signIn(store, "not-an-email", SHARED), null);
    assert.equal(store.rows.size, 0);
  });

  it("grants admin only for a listed email with the admin code", async () => {
    const store = memoryStore();
    assert.equal(await signIn(store, "tester@example.com", ADMIN_CODE).then((u) => u?.isAdmin), false);
    const admin = await signIn(store, ADMIN, ADMIN_CODE);
    assert.equal(admin?.isAdmin, true);
    assert.equal(store.rows.get(ADMIN)?.isAdmin, true);
    // The shared code gives the same person a plain session and leaves the row's admin flag for other devices.
    const plain = await signIn(store, ADMIN, SHARED);
    assert.equal(plain?.isAdmin, false);
    assert.equal(store.rows.get(ADMIN)?.isAdmin, true);
  });

  it("won't let the shared code claim an admin's address", async () => {
    const store = memoryStore();
    assert.equal(await signIn(store, ADMIN, SHARED, "squatter password"), null);
    assert.equal(store.rows.get(ADMIN), undefined);
  });

  it("never grants admin when the admin code equals the shared code", async () => {
    const store = memoryStore();
    const user = await auth.checkSignIn({ email: ADMIN, code: SHARED, password: PASSWORD }, store, {
      ...config,
      adminAccessCode: SHARED,
    });
    assert.equal(user, null);
  });

  it("drops a stale admin flag once the email leaves ADMIN_EMAILS", async () => {
    const hash = await auth.hashPassword(PASSWORD);
    const store = memoryStore([{ id: "x", email: "ex-admin@example.com", isAdmin: true, passwordHash: hash }]);
    const user = await signIn(store, "ex-admin@example.com", ADMIN_CODE);
    assert.equal(user?.isAdmin, false);
    assert.equal(store.rows.get("ex-admin@example.com")?.isAdmin, false);
  });

  it("makes the loser of a simultaneous claim match the winner's password", async () => {
    const store = memoryStore();
    const winnerHash = await auth.hashPassword("the winner's password");
    store.beforeClaim = () => {
      store.beforeClaim = undefined;
      store.rows.set("race@example.com", { id: "w", email: "race@example.com", isAdmin: false, passwordHash: winnerHash });
    };
    assert.equal(await signIn(store, "race@example.com", SHARED), null);
    assert.equal((await signIn(store, "race@example.com", SHARED, "the winner's password"))?.id, "w");
  });
});

describe("sessions", () => {
  const user: SessionUser = { id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", email: "a@example.com", isAdmin: true };

  it("round-trips a signed session", () => {
    assert.deepEqual(auth.decodeSession(auth.encodeSession(user)), user);
  });

  it("refuses sessions signed before the version field, even with a valid signature", () => {
    const payload = Buffer.from(
      JSON.stringify({ uid: user.id, email: user.email, adm: true, exp: Date.now() + 86_400_000 }),
    ).toString("base64url");
    const mac = createHmac("sha256", "test-session-secret").update(payload).digest("base64url");
    assert.equal(auth.decodeSession(`${payload}.${mac}`), null);
  });

  it("refuses a tampered session", () => {
    const [payload, mac] = auth.encodeSession({ ...user, isAdmin: false }).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), adm: true }),
    ).toString("base64url");
    assert.equal(auth.decodeSession(`${forged}.${mac}`), null);
  });
});

describe("isAdminNow", () => {
  const session: SessionUser = { id: "x", email: ADMIN, isAdmin: true };

  it("needs the session flag, the row flag and a listed email", () => {
    assert.equal(auth.isAdminNow(session, { email: ADMIN, isAdmin: true }, [ADMIN]), true);
    assert.equal(auth.isAdminNow({ ...session, isAdmin: false }, { email: ADMIN, isAdmin: true }, [ADMIN]), false);
    assert.equal(auth.isAdminNow(session, { email: ADMIN, isAdmin: false }, [ADMIN]), false);
    assert.equal(auth.isAdminNow(session, { email: ADMIN, isAdmin: true }, []), false);
    assert.equal(auth.isAdminNow(session, null, [ADMIN]), false);
  });
});
