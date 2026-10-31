import assert from "node:assert/strict";
import { test } from "node:test";
import { cannedOutput, personalToolkitsOf, simulatedConnection } from "@/lib/tools/canned";
import { CATALOG } from "@/lib/tools/catalog";

const fn = { name: "SERPAPI_SCHOLAR_SEARCH", sample: { from: "sample" } };

test("falls back to the catalog's sample with no fixture", () => {
  assert.deepEqual(cannedOutput(fn, { query: "x" }, null), { from: "sample" });
  assert.deepEqual(cannedOutput(fn, { query: "x" }, {}), { from: "sample" });
  assert.deepEqual(cannedOutput(fn, { query: "x" }, { SERPAPI_SCHOLAR_SEARCH: [] }), { from: "sample" });
  assert.deepEqual(cannedOutput(fn, { query: "x" }, { OTHER: [1] }), { from: "sample" });
});

test("the same arguments give the same fixture, in any key order, and different arguments can differ", () => {
  const fixtures = { SERPAPI_SCHOLAR_SEARCH: [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] };
  const a = cannedOutput(fn, { query: "x", num: 3 }, fixtures);
  assert.deepEqual(cannedOutput(fn, { num: 3, query: "x" }, fixtures), a);
  const seen = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(cannedOutput(fn, { query: `q${i}` }, fixtures))));
  assert.ok(seen.size > 1);
});

test("every catalog sample stays on example.com, so a build can't look like a real source", () => {
  for (const tool of CATALOG.tools) {
    for (const f of tool.functions) {
      for (const match of JSON.stringify(f.sample).matchAll(/https?:\/\/[^"]+/g)) {
        assert.equal(new URL(match[0]).hostname, "example.com", `${f.name}: ${match[0]}`);
      }
    }
  }
});

test("connections show as a sample account, once per toolkit", () => {
  assert.deepEqual(simulatedConnection("gmail", "Gmail"), { toolkit: "gmail", label: "Gmail", connected: true, canConnect: false, simulated: true, account: "Gmail connected (sample account)" });
  assert.deepEqual(personalToolkitsOf([{ tier: "personal", toolkit: "gmail" }, { tier: "personal", toolkit: "gmail" }, { tier: "public", toolkit: "serpapi" }, { tier: "personal", toolkit: "slack" }]), ["gmail", "slack"]);
});
