/**
 * An edge brief's product token gets Muse Wonder, the model respondJsonOrEdge asks in the cloud first, even when the
 * brief's only model is another one (docs/BUILD_LOG.md, Nov 2, 9 PM: a sam-3.1 edge brief got 404 model_not_found).
 * Only with EDGE_ENABLED and EDGE_BUILDS on, and only for a brief with the edge target, so with the flags off every
 * token's list is today's.
 *
 *   npx tsx --test lib/edge/__tests__/models.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Brief } from "@/lib/brief/schema";
import { EDGE_TEXT_MODEL, edgeAllowedModels } from "@/lib/edge/models";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const FLAGS = ["EDGE_ENABLED", "EDGE_BUILDS"] as const;
const saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});
const on = () => {
  process.env.EDGE_ENABLED = "1";
  process.env.EDGE_BUILDS = "1";
};
/** BRIEF's only model is sam-3.1. */
const samEdge = (): Brief => ({ ...BRIEF, targets: [{ id: "web", why: "Always" }, { id: "edge", why: "Keep looking when the cloud is cut." }] });

describe("edgeAllowedModels", () => {
  it("is empty with the flags off, or with only one of them on, even for an edge brief", () => {
    for (const f of FLAGS) delete process.env[f];
    assert.deepEqual(edgeAllowedModels(samEdge()), []);
    process.env.EDGE_ENABLED = "1";
    assert.deepEqual(edgeAllowedModels(samEdge()), [], "EDGE_ENABLED alone");
    delete process.env.EDGE_ENABLED;
    process.env.EDGE_BUILDS = "1";
    assert.deepEqual(edgeAllowedModels(samEdge()), [], "EDGE_BUILDS alone");
  });

  it("is Muse Wonder for an edge brief with the flags on, and nothing for any other brief", () => {
    on();
    assert.equal(EDGE_TEXT_MODEL, "muse-wonder-1.0");
    assert.deepEqual(edgeAllowedModels(samEdge()), ["muse-wonder-1.0"]);
    for (const brief of [BRIEF, { ...BRIEF, targets: [{ id: "web" as const, why: "Always" }] }, null, undefined]) assert.deepEqual(edgeAllowedModels(brief), []);
  });
});

describe("allowedModelsFor an edge brief", () => {
  it("keeps today's list with the flags off", () => {
    for (const f of FLAGS) delete process.env[f];
    assert.deepEqual(allowedModelsFor(samEdge()), allowedModelsFor(BRIEF));
    assert.deepEqual(allowedModelsFor(samEdge()), ["sam-3.1"]);
  });

  it("adds Muse Wonder beside sam-3.1 with the flags on, once, and leaves a non-edge brief alone", () => {
    on();
    assert.deepEqual(allowedModelsFor(samEdge()), ["sam-3.1", "muse-wonder-1.0"]);
    const both: Brief = { ...samEdge(), capabilities: [...BRIEF.capabilities, { need: "Say what to check", model: "muse-wonder-1.0", why: "It writes" }] };
    assert.deepEqual(allowedModelsFor(both), ["sam-3.1", "muse-wonder-1.0"]);
    assert.deepEqual(allowedModelsFor(BRIEF), ["sam-3.1"]);
  });
});
