/**
 * The trust adapter's own fallback, unfaked (identity.test.ts and caller.test.ts fake it): until tg-cap-int lands,
 * everyone but admins counts as not signed in, nobody is banned, and a reserved address is never more than a guest.
 *
 *   npx tsx --test lib/train/public/__tests__/trust.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as trust from "../trust";

describe("the trust fallback", () => {
  it("treats everyone but admins as not signed in, and nobody as banned, until tg-cap-int lands", async () => {
    assert.equal(trust.signedInCapsOn(), false);
    assert.equal(await trust.tierFor({ id: "u", email: "b@example.com", isAdmin: false }), "guest");
    assert.equal(await trust.tierFor({ id: "u", email: "a@example.com", isAdmin: true }), "admin");
    assert.equal(await trust.isBanned("u"), false);
    assert.equal(trust.mayTrainAsSelf("builder"), true);
    assert.equal(trust.mayTrainAsSelf("admin"), true);
    assert.equal(trust.mayTrainAsSelf("guest"), false);
    assert.equal(trust.mayTrainAsSelf("banned"), false);
  });

  it("never gives a visitor trainer's hidden row or the shared guest more than guest, even flagged admin", async () => {
    for (const email of ["t-0123456789abcdef0123456789abcdef@trainer.musemuse.invalid", "guest@musemuse.invalid"]) {
      assert.equal(await trust.tierFor({ id: "u", email, isAdmin: true }), "guest", email);
      assert.equal(await trust.tierFor({ id: "u", email, isAdmin: false }), "guest", email);
    }
  });
});
