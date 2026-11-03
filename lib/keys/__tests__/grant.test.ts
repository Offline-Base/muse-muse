/**
 * The server's per-build check (lib/keys/grant.ts): flag off reads nothing, and only a signed-in builder's build gets
 * the grant. The user rows and values are made up.
 *
 *   npx tsx --test lib/keys/__tests__/grant.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedKeysForBuild, type GrantDeps } from "@/lib/keys/grant";
import type { SharedPrincipalUser } from "@/lib/keys/shared";

const SOURCE = { BUILD_SHARED_KEYS: "1", BUILD_SHARED_HF_TOKEN: "hf_fakeGrantToken0123456789abcd" };
const USERS: Record<string, SharedPrincipalUser> = {
  builder: { email: "builder@example.com", isAdmin: false, bannedAt: null, hasPassword: true },
  guest: { email: "guest@musemuse.invalid", isAdmin: false, bannedAt: null, hasPassword: false },
};

function deps(source: Record<string, string>, reads: string[] = []): GrantDeps {
  return {
    loadUser: async (id) => {
      reads.push(id);
      return USERS[id] ?? null;
    },
    adminEmails: () => [],
    source: () => source,
  };
}

test("with the flag off nothing is read and there is no grant", async () => {
  const reads: string[] = [];
  const grant = await sharedKeysForBuild({ userId: "builder", kind: "build", rebuildOf: null }, deps({ ...SOURCE, BUILD_SHARED_KEYS: "" }, reads));
  assert.equal(grant, null);
  assert.deepEqual(reads, []);
});

test("a signed-in builder's build and change get it; the guest's never do", async () => {
  const build = await sharedKeysForBuild({ userId: "builder", kind: "build", rebuildOf: null }, deps(SOURCE));
  assert.deepEqual(build?.services, ["hf"]);
  assert.equal(build?.env.HF_TOKEN, SOURCE.BUILD_SHARED_HF_TOKEN);
  assert.ok(await sharedKeysForBuild({ userId: "builder", kind: "refine", rebuildOf: null }, deps(SOURCE)));
  assert.equal(await sharedKeysForBuild({ userId: "guest", kind: "build", rebuildOf: null }, deps(SOURCE)), null);
  assert.equal(await sharedKeysForBuild({ userId: "gone", kind: "refine", rebuildOf: null }, deps(SOURCE)), null);
  assert.equal(await sharedKeysForBuild({ userId: null, kind: "build", rebuildOf: null }, deps(SOURCE)), null);
});

test("with the flag on and nothing set up there is no grant, and no user is read", async () => {
  const reads: string[] = [];
  assert.equal(await sharedKeysForBuild({ userId: "builder", kind: "build", rebuildOf: null }, deps({ BUILD_SHARED_KEYS: "1" }, reads)), null);
  assert.deepEqual(reads, []);
});
