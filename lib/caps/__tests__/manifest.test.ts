/**
 * A product's musemuse.json may narrow its caps, never widen them (docs/CAPABILITIES.md, 2.3), and its schema has an
 * optional `caps` list of cap ids, with `required` and `additionalProperties` as they were.
 *
 *   npx tsx --test lib/caps/__tests__/manifest.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CAP_IDS } from "@/lib/caps/ids";
import { allowedCapIds, manifestCapIds, narrowCapMarkers } from "@/lib/caps/manifest";

const live = (...markers: string[]) => ({ scope: "live", allowedModels: ["muse-wonder-1.0", ...markers] });

describe("a manifest's caps list", () => {
  it("narrows a live token's caps and never widens them", () => {
    const token = live("cap:data", "cap:jobs");
    assert.deepEqual(allowedCapIds(token, null), ["data", "jobs"], "no manifest narrows nothing");
    assert.deepEqual(allowedCapIds(token, { name: "x" }), ["data", "jobs"], "a manifest with no caps list narrows nothing");
    assert.deepEqual(allowedCapIds(token, { caps: ["jobs"] }), ["jobs"]);
    assert.deepEqual(allowedCapIds(token, { caps: ["jobs", "files", "code"] }), ["jobs"], "listing more adds nothing");
    assert.deepEqual(allowedCapIds(token, { caps: [] }), []);
    assert.deepEqual(allowedCapIds(token, { caps: "data" }), [], "a caps value that isn't a list allows none");
    assert.deepEqual(allowedCapIds(live(), { caps: ["data"] }), [], "a token with no cap markers has no caps");
  });

  it("is skipped for a refinement's build token, whose stored manifest is the previous version's", () => {
    assert.deepEqual(allowedCapIds({ scope: "build", allowedModels: ["cap:data"] }, { caps: [] }), ["data"]);
  });

  it("drops only the cap markers the manifest leaves out, and keeps every other entry in order", () => {
    const allowed = ["muse-wonder-1.0", "agent", "tool:web_search", "cap:data", "cap:jobs"];
    assert.deepEqual(narrowCapMarkers(allowed, { caps: ["data", "files"] }), ["muse-wonder-1.0", "agent", "tool:web_search", "cap:data"]);
    assert.deepEqual(narrowCapMarkers(allowed, null), allowed);
    assert.deepEqual([...(manifestCapIds({ caps: ["data", "nope", 3] }) ?? [])], ["data"]);
  });
});

describe("template/musemuse.schema.json", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, "../../../template/musemuse.schema.json"), "utf8"));

  it("has an optional caps list of exactly the cap ids, and its required list and additionalProperties as they were", () => {
    assert.deepEqual(schema.properties.caps.items.enum, [...CAP_IDS]);
    assert.equal(schema.properties.caps.type, "array");
    assert.equal(schema.properties.caps.uniqueItems, true);
    assert.ok(!schema.required.includes("caps"));
    assert.deepEqual(schema.required, ["name", "slug", "tagline", "inspiration", "models", "actions", "fixtures", "limits", "estimatedCostPerRunUsd"]);
    assert.equal(schema.additionalProperties, false);
  });
});
