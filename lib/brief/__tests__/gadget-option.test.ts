import assert from "node:assert/strict";
import { test } from "node:test";
import { NewBriefSchema, PRODUCT_MODELS } from "@/lib/brief/schema";
import { modelLabel } from "@/lib/format";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { catalogSummary } from "@/lib/prompts/catalog";
import { GADGET_ID } from "@/lib/gateway/gadget";
import manifestSchema from "@/template/musemuse.schema.json";

test("muse-gadget is an option the brief writer can pick, like a model", () => {
  assert.ok((PRODUCT_MODELS as readonly string[]).includes(GADGET_ID));
  const capability = NewBriefSchema.shape.capabilities.element.shape.model;
  assert.equal(capability.safeParse(GADGET_ID).success, true);
  assert.match(catalogSummary(), /- muse-gadget: a physical board/);
  assert.match(catalogSummary(), /must still work when no board is connected/);
  assert.equal(modelLabel(GADGET_ID), "Muse Gadget");
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
