import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refineSpot } from "@/components/build/derive";

const live = (latestBuildId: string | null) => ({ status: "live", latestBuildId });

describe("refineSpot", () => {
  it("shows the composer on the product's current build", () => {
    const history = [{ id: "g", status: "live" }];
    assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: true, product: live("g"), history }), {
      show: true,
    });
  });

  it("keeps refining possible after a refinement fails and the live version stays", () => {
    // f is a failed refinement, g is still the live build.
    const history = [
      { id: "f", status: "failed" },
      { id: "g", status: "live" },
    ];
    const product = live("g");
    assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: true, product, history }), { show: true });
    assert.deepEqual(refineSpot({ buildId: "f", terminal: true, canRefine: true, product, history }), { show: true });
  });

  it("points older builds at the current one", () => {
    const history = [
      { id: "f", status: "failed" },
      { id: "g", status: "live" },
      { id: "e", status: "live" },
    ];
    assert.deepEqual(refineSpot({ buildId: "e", terminal: true, canRefine: true, product: live("g"), history }), {
      show: false,
      elsewhere: { buildId: "g", running: false },
    });
  });

  it("points at a running build instead of offering a second change", () => {
    const history = [
      { id: "r", status: "building" },
      { id: "g", status: "live" },
    ];
    assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: true, product: live("g"), history }), {
      show: false,
      elsewhere: { buildId: "r", running: true },
    });
  });

  it("offers nothing while this build runs, to non-owners, or when the product isn't live", () => {
    const history = [{ id: "g", status: "building" }];
    const none = { show: false, elsewhere: null };
    assert.deepEqual(refineSpot({ buildId: "g", terminal: false, canRefine: true, product: live("g"), history }), none);
    assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: false, product: live("g"), history }), none);
    for (const status of ["failed", "disabled", "building"]) {
      const product = { status, latestBuildId: "g" };
      assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: true, product, history }), none);
    }
    assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: true, product: null, history }), none);
  });

  it("accepts a partial product", () => {
    const history = [{ id: "g", status: "partial" }];
    const product = { status: "partial", latestBuildId: "g" };
    assert.deepEqual(refineSpot({ buildId: "g", terminal: true, canRefine: true, product, history }), { show: true });
  });
});
