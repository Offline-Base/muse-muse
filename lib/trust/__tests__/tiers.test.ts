/**
 * Sign-in tiers (TRUST_SIGNED_IN_CAPS): a guest gets no builder caps, and the brief writer's instructions change only
 * when a builder is passed in.
 *
 *   npx tsx --test lib/trust/__tests__/tiers.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GUEST_EMAIL } from "@/lib/auth";
import { CAP_IDS, CAP_NEEDS_BUILDER } from "@/lib/caps/ids";
import { briefInstructions } from "@/lib/prompts/brief";
import { catalogSummary } from "@/lib/prompts/catalog";
import { briefTierFor, builderTier, capsForBuilder, GUEST_WRITER_RULE, tierMayUseBuilderCaps } from "@/lib/trust/tiers";

beforeEach(() => {
  for (const k of ["TRUST_SIGNED_IN_CAPS", "DATABASE_URL"]) delete process.env[k];
});

describe("builderTier", () => {
  it("tells the guest, admins, builders and the banned apart", () => {
    assert.equal(builderTier({ email: GUEST_EMAIL }), "guest");
    assert.equal(builderTier({ email: GUEST_EMAIL, isAdmin: true }), "guest", "the guest is never an admin");
    assert.equal(builderTier({ email: "a@example.com", isAdmin: true }), "admin");
    assert.equal(builderTier({ email: "b@example.com" }), "builder");
    assert.equal(builderTier({ email: "b@example.com", bannedAt: new Date() }), "banned");
    assert.deepEqual((["admin", "builder", "guest", "banned"] as const).map(tierMayUseBuilderCaps), [true, true, false, false]);
  });
});

describe("capsForBuilder", () => {
  const all = [...CAP_IDS];
  const stateless = all.filter((c) => !CAP_NEEDS_BUILDER[c]);

  it("gives a guest and a banned builder no builder caps with the flag on", () => {
    assert.deepEqual(capsForBuilder("guest", all, true), stateless);
    assert.deepEqual(capsForBuilder("banned", all, true), stateless);
    assert.deepEqual(stateless, ["live", "media", "extension", "games"]);
  });

  it("gives signed-in builders and admins everything enabled, and everyone everything with the flag off", () => {
    assert.deepEqual(capsForBuilder("builder", all, true), all);
    assert.deepEqual(capsForBuilder("admin", all, true), all);
    assert.deepEqual(capsForBuilder("guest", all, false), all);
    assert.deepEqual(capsForBuilder("guest", [], true), []);
  });

  it("reads env.enabledCaps by default, which is empty while no cap is ready", () => {
    assert.deepEqual(capsForBuilder("guest"), []);
  });
});

describe("the brief writer", () => {
  it("is today's with no builder passed, and with an empty one", () => {
    assert.equal(briefInstructions({}), briefInstructions());
    assert.equal(catalogSummary([]), catalogSummary());
  });

  it("gets the guest rule as one more line of Writing the brief, and nothing else changes", () => {
    const today = briefInstructions();
    const guest = briefInstructions({ caps: [], builderRule: GUEST_WRITER_RULE });
    assert.ok(guest.includes(`\n- ${GUEST_WRITER_RULE}`));
    assert.equal(guest.replace(`\n- ${GUEST_WRITER_RULE}`, ""), today);
    assert.match(GUEST_WRITER_RULE, /can't save data, connect accounts, run jobs, run code or use GPUs/);
    assert.ok(!/—/.test(GUEST_WRITER_RULE), "no em dashes");
  });

  it("briefTierFor reads nothing with the flag off", async () => {
    // DATABASE_URL is unset, so any read would throw.
    assert.equal(await briefTierFor("00000000-0000-4000-8000-000000000001"), undefined);
  });
});
