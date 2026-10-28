import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionUser } from "@/lib/auth";

// The fine-tuning pages' admin check (app/fine-tuning/viewer.ts), with the session and the users row faked.

const admin: SessionUser = { id: "u-1", email: "owner@example.com", isAdmin: true };
const listed = () => ["owner@example.com"];

async function viewer(
  user: SessionUser | null,
  row: { email: string; isAdmin: boolean } | null | Error,
): Promise<SessionUser | null> {
  const { pageViewer } = await import("@/app/fine-tuning/viewer");
  return pageViewer({
    currentUser: async () => user,
    loadUser: async () => {
      if (row instanceof Error) throw row;
      return row;
    },
    adminEmails: listed,
  });
}

describe("fine-tuning page viewer", () => {
  it("keeps admin while the users row still says admin", async () => {
    assert.equal((await viewer(admin, { email: admin.email, isAdmin: true }))?.isAdmin, true);
  });

  it("drops admin when the row was revoked, though the cookie still says admin", async () => {
    const seen = await viewer(admin, { email: admin.email, isAdmin: false });
    assert.equal(seen?.isAdmin, false);
    assert.equal(seen?.email, admin.email, "still signed in, so the page shows Admins only");
  });

  it("drops admin when the row is gone or the database can't confirm", async () => {
    assert.equal((await viewer(admin, null))?.isAdmin, false);
    assert.equal((await viewer(admin, new Error("db down")))?.isAdmin, false);
  });

  it("drops admin when the row's email no longer matches or isn't listed", async () => {
    assert.equal((await viewer(admin, { email: "other@example.com", isAdmin: true }))?.isAdmin, false);
    const unlisted = { ...admin, email: "former@example.com" };
    assert.equal((await viewer(unlisted, { email: unlisted.email, isAdmin: true }))?.isAdmin, false);
  });

  it("passes non-admins, signed-out visitors and the open-access account through unchanged", async () => {
    const member = { ...admin, isAdmin: false };
    assert.deepEqual(await viewer(member, new Error("not asked")), member);
    assert.equal(await viewer(null, new Error("not asked")), null);
    const open = { ...admin, openAccess: true };
    assert.deepEqual(await viewer(open, new Error("not asked")), open, "OPEN_ACCESS comes from env, not a cookie");
  });
});
