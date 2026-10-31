import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { connectorActions, newestPerRebuild, parseManifest, safeNext } from "@/lib/format";

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

  it("keeps the agent parts of a manifest, and a manifest without them reads as it always did", () => {
    const action = manifest.actions[0];
    const agent = { task: "Finds things", tools: [{ id: "web_search", usedFor: "Looking things up" }], connections: "none" };
    const withAgent = { ...manifest, agent, actions: [{ ...action, who: "owner", annotations: { readOnly: true, openWorld: false } }] };
    assert.deepEqual(parseManifest(withAgent), withAgent);
    assert.equal(parseManifest(manifest)?.agent, undefined);
  });

  it("drops an agent part with the wrong shape", () => {
    const action = manifest.actions[0];
    const agent = { task: "Finds things", tools: [], connections: "none" };
    for (const bad of [
      { ...manifest, agent: { ...agent, connections: "everyone" } },
      { ...manifest, agent: { ...agent, tools: [{ id: "x" }] } },
      { ...manifest, agent: { ...agent, task: 7 } },
      { ...manifest, agent: "yes" },
      { ...manifest, actions: [{ ...action, who: "root" }] },
      { ...manifest, actions: [{ ...action, annotations: { readOnly: "yes" } }] },
      { ...manifest, actions: [{ ...action, annotations: true }] },
    ]) {
      assert.equal(parseManifest(bad), null);
    }
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

describe("connectorActions", () => {
  const action = (name: string, who?: "anyone" | "owner") => ({ name, description: "d", input: {}, output: {}, ...(who ? { who } : {}) });

  it("leaves out owner actions, and keeps actions that don't say", () => {
    const actions = [action("find"), action("share", "anyone"), action("mail_me", "owner")];
    assert.deepEqual(connectorActions({ actions }).map((a) => a.name), ["find", "share"]);
  });

  it("is empty without a manifest", () => {
    assert.deepEqual(connectorActions(null), []);
    assert.deepEqual(connectorActions({ actions: [action("mail_me", "owner")] }), []);
  });

  it("is what the product page's connector line lists", () => {
    const page = readFileSync(path.join(process.cwd(), "app/p/[slug]/page.tsx"), "utf8");
    assert.match(page, /const exposedActions = connectorActions\(manifest\)/);
    assert.doesNotMatch(page, /manifest\.actions/);
  });
});

describe("newestPerRebuild", () => {
  it("keeps the first card of each rebuild and every card that isn't one", () => {
    const cards = [
      { slug: "scene-new", rebuildOf: "video-3" },
      { slug: "my-own", rebuildOf: null },
      { slug: "scene-old", rebuildOf: "video-3" },
      { slug: "lens", rebuildOf: "video-5" },
      { slug: "another-own", rebuildOf: null },
    ];
    assert.deepEqual(
      newestPerRebuild(cards).map((c) => c.slug),
      ["scene-new", "my-own", "lens", "another-own"],
    );
  });
});
