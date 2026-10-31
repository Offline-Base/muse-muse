import assert from "node:assert/strict";
import { test } from "node:test";
import { NewBriefSchema, NewBriefSchemaNoGadget, PRODUCT_MODELS } from "@/lib/brief/schema";
import { modelLabel } from "@/lib/format";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { catalogSummary } from "@/lib/prompts/catalog";
import { GADGET_ID } from "@/lib/gateway/gadget";
import manifestSchema from "@/template/musemuse.schema.json";

test("muse-gadget is an option the brief writer can pick, like a model, once GADGETS_ENABLED is on", () => {
  process.env.GADGETS_ENABLED = "1";
  assert.ok((PRODUCT_MODELS as readonly string[]).includes(GADGET_ID));
  const capability = NewBriefSchema.shape.capabilities.element.shape.model;
  assert.equal(capability.safeParse(GADGET_ID).success, true);
  assert.match(catalogSummary(), /- muse-gadget: a physical board/);
  assert.match(catalogSummary(), /must still work when no board is connected/);
  assert.equal(modelLabel(GADGET_ID), "Muse Gadget");
  delete process.env.GADGETS_ENABLED;
});

test("with GADGETS_ENABLED off, the brief writer isn't told about gadgets and can't pick one", () => {
  delete process.env.GADGETS_ENABLED;
  assert.doesNotMatch(catalogSummary(), /muse-gadget/);
  const capability = NewBriefSchemaNoGadget.shape.capabilities.element.shape.model;
  assert.equal(capability.safeParse(GADGET_ID).success, false);
  assert.equal(capability.safeParse("muse-wonder-1.0").success, true);
});

test("a brief that picks a gadget gives its tokens the gadget permission, and Glimmer still stays off the gateway", () => {
  const allowed = allowedModelsFor({
    capabilities: [
      { need: "take a photo", model: "muse-gadget", why: "it sees the shelf" },
      { need: "count the jars", model: "muse-wonder-1.0", why: "it reads the photo" },
      { need: "run offline", model: "muse-glimmer", why: "local" },
    ],
  });
  assert.deepEqual(allowed.sort(), ["muse-gadget", "muse-wonder-1.0"]);
});

test("the product manifest accepts muse-gadget", () => {
  const items = (manifestSchema as { properties: { models: { items: { properties: { id: { enum: string[] } } } } } }).properties.models.items.properties.id.enum;
  assert.ok(items.includes(GADGET_ID));
});
