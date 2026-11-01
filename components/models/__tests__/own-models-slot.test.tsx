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

describe("TrainOnMyData", () => {
  it("says what it reads and that the rows stay private, and offers deleting them", async () => {
    const { TrainOnMyData } = await import("@/components/product/TrainOnMyData");
    const html = renderToStaticMarkup(createElement(TrainOnMyData, { slug: "corner" })).replaceAll("&#x27;", "'");
    assert.match(html, /Never from what anyone else saved/);
    assert.match(html, /never from a collection that can hold personal details/);
    assert.match(html, /don't show on the Lab pages/);
    assert.match(html, /Delete what training kept/);
    assert.ok(!html.includes("—"));
  });
});

describe("OwnModelsSlot", () => {
  it("imports no lib/train or database code up front: only lazily, with a flag on", async () => {
    const { build } = await import("esbuild");
    const entry = new URL("../OwnModelsSlot.tsx", import.meta.url).pathname;
    const root = new URL("../../..", import.meta.url).pathname;
    const out = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", absWorkingDir: root, logLevel: "silent" });
    // Walk the graph from the slot through static imports only.
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const i of out.metafile.inputs[file]?.imports ?? []) if (i.kind !== "dynamic-import" && !i.external) walk(i.path);
    };
    walk(Object.keys(out.metafile.inputs).find((f) => f.endsWith("components/models/OwnModelsSlot.tsx"))!);
    const statics = [...seen];
    assert.ok(statics.some((f) => f.endsWith("lib/caps/gpu/words.ts")));
    assert.deepEqual(statics.filter((f) => f.includes("lib/train/") || f.endsWith("lib/db/client.ts") || f.endsWith("lib/caps/gpu/general.ts")), []);
  });

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
