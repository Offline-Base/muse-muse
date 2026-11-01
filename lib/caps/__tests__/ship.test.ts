/**
 * A cap's step after deploy (docs/CAPABILITIES.md, section 20): the pure list the workflow reads, the registry behind
 * it, and runCapsShip, which runs only enabled caps the brief has and never throws.
 *   npx tsx --test lib/caps/__tests__/ship.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Brief } from "@/lib/brief/schema";
import { CAP_IDS } from "@/lib/caps/ids";
import { CAPS_SHIPPING, capsShipping } from "@/lib/caps/ship";
import { CAP_SHIP, runCapsShip, type CapShip } from "@/lib/caps/ship-run";
import { env } from "@/lib/env";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const WITH = { ...BRIEF, extension: { does: "Saves pages", permissions: ["activeTab"] } } as Brief;
const input = (brief: Brief) => ({ buildId: "b1", productId: "p1", sandboxName: "sb", liveUrl: "https://x.vercel.app", brief });

describe("caps with a step after deploy", () => {
  it("are listed once, purely, and each has its step", () => {
    assert.deepEqual([...CAPS_SHIPPING], ["extension"]);
    assert.deepEqual(Object.keys(CAP_SHIP), [...CAPS_SHIPPING]);
    assert.ok(CAPS_SHIPPING.every((id) => (CAP_IDS as readonly string[]).includes(id)));
  });

  it("are off with every flag off, so the workflow runs no extra step", () => {
    delete process.env.NATIVE_EXTENSION;
    assert.equal(capsShipping(env.enabledCaps), false);
    assert.equal(capsShipping([]), false);
    assert.equal(capsShipping(["runtime", "games"]), false);
    assert.equal(capsShipping(["extension"]), true);
  });

  it("run only for an enabled cap the brief has, and a failure is one line, never a throw", async () => {
    const seen: string[] = [];
    const ships: Record<string, CapShip> = {
      extension: async (i) => {
        seen.push(i.productId);
        return "packaged";
      },
    };
    assert.deepEqual(await runCapsShip(input(WITH), ["extension"], ships), ["packaged"]);
    assert.deepEqual(await runCapsShip(input(WITH), [], ships), [], "not enabled");
    assert.deepEqual(await runCapsShip(input(BRIEF), ["extension"], ships), [], "no block");
    assert.deepEqual(seen, ["p1"]);
    const broken = await runCapsShip(input(WITH), ["extension"], { extension: async () => { throw new Error("sandbox gone"); } });
    assert.deepEqual(broken, ["The extension step after deploy didn't finish. The web product is live as usual."]);
    assert.deepEqual(await runCapsShip(input(WITH), ["extension"], { extension: async () => null }), []);
  });
});
