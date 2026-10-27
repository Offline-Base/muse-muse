import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseManifest, safeNext } from "@/lib/format";

describe("safeNext", () => {
  it("keeps same-site paths with their query and hash", () => {
    assert.equal(safeNext("/b/abc?refine=1#refine"), "/b/abc?refine=1#refine");
    assert.equal(safeNext("/gallery"), "/gallery");
  });

  it("refuses other sites, however they are spelled", () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\\\\evil.example",
      "https://evil.example",
      "evil.example",
      "",
      null,
      undefined,
    ]) {
      assert.equal(safeNext(next), "/", JSON.stringify(next));
    }
  });

  it("refuses control characters anywhere", () => {
    assert.equal(safeNext("/b/abc\u0000"), "/");
    assert.equal(safeNext("/b/abc\u007f"), "/");
  });

  it("never sends people back to sign-in, even through dot segments", () => {
    assert.equal(safeNext("/sign-in?next=/x"), "/");
    assert.equal(safeNext("/./sign-in"), "/");
    assert.equal(safeNext("/b/../sign-in"), "/");
  });
});

const manifest = {
  name: "Feeder Count",
  slug: "feeder-count",
  tagline: "Counts birds.",
  inspiration: "A feeder video.",
  models: [{ id: "sam-3.1", usedFor: "Outlines" }],
  actions: [{ name: "count", description: "Counts", input: {}, output: {} }],
  fixtures: [{ path: "fixtures/a.mp4", description: "Clip" }],
  limits: ["Short clips only"],
  estimatedCostPerRunUsd: 0.02,
};

describe("parseManifest", () => {
  it("keeps a manifest with the Manifest shape", () => {
    assert.deepEqual(parseManifest(manifest), manifest);
    assert.deepEqual(parseManifest({ ...manifest, $schema: "./musemuse.schema.json" })?.name, "Feeder Count");
  });

  it("drops one that would crash a page", () => {
    for (const bad of [
      null,
      "manifest",
      [],
      { ...manifest, models: undefined },
      { ...manifest, models: "sam-3.1" },
      { ...manifest, models: [{ id: "sam-3.1", usedFor: { text: "x" } }] },
      { ...manifest, limits: "None" },
      { ...manifest, limits: [{ text: "x" }] },
      { ...manifest, inspiration: { summary: "x" } },
      { ...manifest, actions: {} },
      { ...manifest, actions: [{ name: "count", description: "Counts", input: {}, output: [] }] },
      { ...manifest, fixtures: undefined },
      { ...manifest, estimatedCostPerRunUsd: "0.02" },
      { ...manifest, estimatedCostPerRunUsd: -1 },
    ]) {
      assert.equal(parseManifest(bad), null, JSON.stringify(bad));
    }
  });
});
