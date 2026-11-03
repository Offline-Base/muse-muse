/** The device stage's data: recorded runs per product, owner clips that name a device, and the files behind them. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEVICE_RUNS, ranOnLabel, stageDevices } from "@/lib/devices/runs";

describe("stageDevices", () => {
  it("is empty for a product with nothing recorded on a device, so its page has no stage", () => {
    assert.deepEqual(stageDevices("no-such-product"), []);
    assert.deepEqual(stageDevices("no-such-product", [{ url: "/c.mp4", posterUrl: null, caption: "A clip", addedAt: "2026-11-01T00:00:00Z" }]), []);
  });

  it("puts computers before phones and adds an owner's clip that names its device", () => {
    const runs = stageDevices("dinner-split-helper", [{ url: "/q.mp4", posterUrl: null, caption: "Filmed on my Pixel", addedAt: "2026-11-03T10:00:00Z", device: "android" }]);
    assert.deepEqual(runs.map((r) => r.device), ["mac", "windows", "android", "android", "iphone"]);
    const owner = runs.find((r) => r.video === "/q.mp4")!;
    assert.equal(owner.place, "Recorded by its owner");
    assert.equal(owner.ranOn, "2026-11-03");
  });

  it("labels the simulator as simulated and the lab boxes and Device Farm phone as real", () => {
    const runs = DEVICE_RUNS["dinner-split-helper"]!;
    assert.deepEqual(runs.filter((r) => r.simulated).map((r) => r.device), ["iphone"]);
    assert.ok(runs.find((r) => r.place.startsWith("AWS Device Farm") && r.name === "Samsung Galaxy S25" && !r.simulated));
  });
});

describe("the recorded runs", () => {
  it("has every clip and poster in public/, and says where each run is written up", () => {
    for (const [slug, runs] of Object.entries(DEVICE_RUNS)) {
      for (const r of runs) {
        for (const file of [r.video, r.poster]) {
          assert.ok(file.startsWith(`/devices/${slug}/`), file);
          assert.ok(existsSync(path.join(process.cwd(), "public", file)), file);
        }
        assert.match(r.source, /BUILD_LOG/);
        assert.match(r.ranOn, /^\d{4}-\d{2}-\d{2}$/);
        assert.doesNotMatch(`${r.name} ${r.place} ${r.detail}`, /—/);
        // The gateway never serves muse-spark-1.3 (lib/gateway/handler.ts), so a run can't credit it.
        assert.doesNotMatch(r.detail, /Muse Spark 1\.3(?! Contributor)/, `${slug} ${r.device}`);
      }
    }
  });

  it("names the day short", () => {
    assert.equal(ranOnLabel("2026-11-02"), "Nov 2");
    assert.equal(ranOnLabel("not a date"), "");
  });
});
