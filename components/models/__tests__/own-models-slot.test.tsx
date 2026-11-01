/**
 * "Your own models" on /models (docs/CAPABILITIES.md, section 17): nothing with the flags off, and nothing but status words
 * with them on. No database, no live call.
 *
 *   npx tsx --test components/models/__tests__/own-models-slot.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnModelsList, OwnModelsSlot } from "@/components/models/OwnModelsSlot";
import type { OwnModelsView } from "@/lib/caps/gpu/own-rows";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.GPU_GLIMMER_SHARED;
  delete process.env.GPU_TRAIN_ON_DATA;
});
afterEach(() => {
  process.env = { ...saved };
});

const VIEW: OwnModelsView = {
  devices: [],
  rows: [
    { jobId: "aaaaaaaa-0000-4000-8000-000000000001", title: "Bakery helper", product: "Corner Bakery", kind: "Chat", verdict: "Tuned won 16 of 20 kept-aside prompts (8.5 vs 3.1).", passed: true, serving: false, sparkOpen: true },
    { jobId: "aaaaaaaa-0000-4000-8000-000000000002", title: "Ticket sorter", product: "Help Desk", kind: "Decision", verdict: "Not scored yet.", passed: false, serving: true, sparkOpen: false },
  ],
};

describe("OwnModelsSlot", () => {
  it("renders nothing with its flags off, and reads nothing", () => {
    assert.equal(OwnModelsSlot(), null);
  });

  it("renders nothing with no models", () => {
    assert.equal(renderToStaticMarkup(createElement(OwnModelsList, { view: { rows: [], devices: [] } })), "");
  });

  it("says status words, the Spark Open line and the usage points, with no address, token or id", () => {
    const html = renderToStaticMarkup(createElement(OwnModelsList, { view: VIEW })).replaceAll("&#x27;", "'");
    assert.match(html, /Your own models/);
    assert.match(html, /Bakery helper/);
    assert.match(html, /Passed\./);
    assert.match(html, /Hasn't passed\./);
    assert.match(html, /Open in a demo window now/);
    assert.match(html, /answers with Muse Wonder/);
    assert.match(html, /Built with Muse Spark Open/);
    assert.match(html, /For people 18 and over only\./);
    assert.ok(!/https?:|\/glimmer|Bearer|mm_live|aaaaaaaa/.test(html));
    assert.ok(!html.includes("—"));
  });
});
