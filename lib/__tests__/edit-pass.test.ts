/**
 * Who may refine under GUEST_EDITS (lib/edit-pass.ts). The shared guest account can't tell people apart, so only the
 * signed pass of the browser that made a build counts, and it never widens anything else.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/__tests__/edit-pass.test.ts
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { SessionUser } from "@/lib/auth";
import type { PassDeps } from "@/lib/edit-pass";

let pass: typeof import("@/lib/edit-pass");
let auth: typeof import("@/lib/auth");

before(async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  auth = await import("@/lib/auth");
  pass = await import("@/lib/edit-pass");
});

const GUEST: SessionUser = { id: "guest", email: "guest@musemuse.invalid", isAdmin: false, openAccess: true };
const MAKER: SessionUser = { id: "maker", email: "maker@example.com", isAdmin: false };
const ADMIN: SessionUser = { id: "admin", email: "admin@example.com", isAdmin: true };
const BUILD_A = "aaaaaaaa-0000-4000-8000-000000000001";
const BUILD_B = "bbbbbbbb-0000-4000-8000-000000000002";
const PRODUCT_A = { id: "product-a", ownerId: GUEST.id };
const PRODUCT_B = { id: "product-b", ownerId: GUEST.id };

/** A browser with this cookie, against builds where BUILD_A made product A and BUILD_B made product B. */
function browser(cookie?: string, on = true) {
  const reads = { cookie: 0, db: 0 };
  const deps: PassDeps & { cookie?: string; reads: typeof reads } = {
    cookie,
    reads,
    on: () => on,
    readCookie: async () => {
      reads.cookie++;
      return deps.cookie;
    },
    writeCookie: async (value) => {
      deps.cookie = value;
    },
    productsOfBuilds: async (_user, ids) => {
      reads.db++;
      return ids.flatMap((id) => (id === BUILD_A ? [PRODUCT_A.id] : id === BUILD_B ? [PRODUCT_B.id] : []));
    },
  };
  return deps;
}

describe("edit pass", () => {
  it("lets only the browser that made a build change that product", async () => {
    const maker = browser();
    await pass.grantEditPass(GUEST, BUILD_A, maker);
    assert.equal(await pass.canEditProduct(GUEST, PRODUCT_A, maker), true);
    assert.equal(await pass.canEditProduct(GUEST, PRODUCT_B, maker), false, "not their other product");
    assert.equal(await pass.canEditProduct(GUEST, PRODUCT_A, browser()), false, "another guest, no pass");
  });

  it("with the flag off, hands out nothing, honors nothing and reads nothing", async () => {
    const off = browser(pass.encodeEditPass([BUILD_A]), false);
    assert.equal(await pass.canEditProduct(GUEST, PRODUCT_A, off), false);
    assert.deepEqual(off.reads, { cookie: 0, db: 0 });
    const fresh = browser(undefined, false);
    await pass.grantEditPass(GUEST, BUILD_A, fresh);
    assert.equal(fresh.cookie, undefined);
  });

  it("refuses a forged, altered, expired or session cookie", async () => {
    const good = pass.encodeEditPass([BUILD_A]);
    const [payload, mac] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, ids: [BUILD_B], exp: Date.now() + 1000 })).toString("base64url");
    assert.deepEqual(pass.decodeEditPass(`${forged}.${mac}`), []);
    assert.deepEqual(pass.decodeEditPass(`${payload}.x`), []);
    assert.deepEqual(pass.decodeEditPass(pass.encodeEditPass([BUILD_A], Date.now() - 91 * 86_400_000)), []);
    assert.deepEqual(pass.decodeEditPass(auth.encodeSession(MAKER)), []);
    assert.equal(auth.decodeSession(good), null, "and a pass is never a session");
  });

  it("gives a signed-in person nothing, and no pass, for a guest's product", async () => {
    const held = browser(pass.encodeEditPass([BUILD_A]));
    assert.equal(await pass.canEditProduct(MAKER, PRODUCT_A, held), false);
    assert.equal(held.reads.cookie, 0);
    const fresh = browser();
    await pass.grantEditPass(MAKER, BUILD_A, fresh);
    await pass.grantEditPass(ADMIN, BUILD_A, fresh);
    assert.equal(fresh.cookie, undefined);
  });

  it("keeps owners and admins as they were, and never widens canActAsOwner", async () => {
    assert.equal(await pass.canEditProduct(MAKER, { id: "p", ownerId: MAKER.id }, browser()), true);
    assert.equal(await pass.canEditProduct(ADMIN, PRODUCT_A, browser()), true);
    const maker = browser();
    await pass.grantEditPass(GUEST, BUILD_A, maker);
    assert.equal(auth.canActAsOwner(GUEST, GUEST.id), false);
    assert.equal(pass.editsByPassOnly(GUEST, GUEST.id, true), true);
    assert.equal(pass.editsByPassOnly(MAKER, MAKER.id, true), false);
  });

  it("keeps a bounded list, newest first", async () => {
    const b = browser();
    const ids = Array.from({ length: pass.PASS_MAX_BUILDS + 5 }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const id of ids) await pass.grantEditPass(GUEST, id, b);
    const held = pass.decodeEditPass(b.cookie);
    assert.equal(held.length, pass.PASS_MAX_BUILDS);
    assert.equal(held[0], ids.at(-1));
    assert.ok(b.cookie!.length < 4000);
  });
});

describe("canSteerBuild, under STEER_CHAT", () => {
  const steering = (cookie?: string) => Object.assign(browser(cookie, false), { steerOn: () => true });
  const buildA = { id: BUILD_A, userId: GUEST.id, productId: PRODUCT_A.id, ownerId: GUEST.id };

  it("lets a guest steer only what their own browser's pass names", async () => {
    const mine = steering(pass.encodeEditPass([BUILD_A]));
    assert.equal(await pass.canSteerBuild(GUEST, buildA, mine), true);
    assert.equal(await pass.canSteerBuild(GUEST, { ...buildA, id: BUILD_B, productId: PRODUCT_B.id }, mine), false);
    assert.equal(await pass.canSteerBuild(GUEST, buildA, steering()), false);
    assert.equal(await pass.canSteerBuild(GUEST, buildA, steering("forged.pass")), false);
  });

  it("counts a refinement's new build through its product, and hands out the pass with GUEST_EDITS off", async () => {
    const deps = steering();
    await pass.grantEditPass(GUEST, BUILD_A, deps);
    assert.deepEqual(pass.decodeEditPass(deps.cookie), [BUILD_A]);
    assert.equal(await pass.canSteerBuild(GUEST, { ...buildA, id: "cccccccc-0000-4000-8000-000000000003" }, deps), true);
    assert.equal(await pass.canEditProduct(GUEST, PRODUCT_A, deps), false);
  });

  it("gives a guest nothing with the flag off, and never a pass holder another account's build", async () => {
    const cookie = pass.encodeEditPass([BUILD_A]);
    assert.equal(await pass.canSteerBuild(GUEST, buildA, browser(cookie, true)), false);
    assert.equal(await pass.canSteerBuild(GUEST, { ...buildA, userId: MAKER.id, ownerId: MAKER.id }, steering(cookie)), false);
    assert.equal(await pass.canSteerBuild(MAKER, buildA, steering(cookie)), false);
  });

  it("keeps owners and admins as they were", async () => {
    const maker = { ...buildA, userId: MAKER.id, ownerId: MAKER.id };
    assert.equal(await pass.canSteerBuild(MAKER, maker, browser()), true);
    assert.equal(await pass.canSteerBuild(ADMIN, maker, browser()), true);
    assert.equal(await pass.canSteerBuild(null, maker, steering()), false);
  });
});
