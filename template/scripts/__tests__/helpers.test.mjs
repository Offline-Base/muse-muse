// Unit tests for the template's small Meta helpers. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { gatewayEnv } from "../../lib/meta/client";
import { glimmer } from "../../lib/meta/glimmer";
import { byteView, toDataUrl } from "../../lib/meta/media";
import { imagePart, videoPart } from "../../lib/meta/parts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["GATEWAY_URL", "PRODUCT_TOKEN", "GLIMMER_URL", "GLIMMER_API_KEY", "GLIMMER_MODEL"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("gatewayEnv joins /v1 with or without a trailing slash and needs both values", () => {
  process.env.PRODUCT_TOKEN = "tok";
  for (const url of ["https://p.example/api/gateway", "https://p.example/api/gateway/"]) {
    process.env.GATEWAY_URL = url;
    assert.deepEqual(gatewayEnv(), { baseURL: "https://p.example/api/gateway/v1", apiKey: "tok" });
  }
  process.env.GATEWAY_URL = "https://api.meta.ai";
  assert.equal(gatewayEnv().baseURL, "https://api.meta.ai/v1");
  delete process.env.PRODUCT_TOKEN;
  assert.throws(() => gatewayEnv(), /Missing PRODUCT_TOKEN on/);
  delete process.env.GATEWAY_URL;
  assert.throws(() => gatewayEnv(), /Missing GATEWAY_URL and PRODUCT_TOKEN/);
});

test("imagePart and videoPart take a URL string or object, and video takes a file id", () => {
  assert.deepEqual(imagePart("https://x/a.png"), { type: "input_image", detail: "auto", image_url: "https://x/a.png" });
  assert.deepEqual(imagePart({ url: "data:image/png;base64,AA==" }), { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AA==" });
  assert.deepEqual(videoPart("https://x/v.mp4"), { type: "input_video", video_url: "https://x/v.mp4" });
  assert.deepEqual(videoPart({ url: "https://x/v.mp4" }), { type: "input_video", video_url: "https://x/v.mp4" });
  assert.deepEqual(videoPart({ fileId: "file_1" }), { type: "input_video", file_id: "file_1" });
});

test("toDataUrl encodes only the bytes a view covers", () => {
  const whole = new Uint8Array([1, 2, 3, 4]);
  assert.equal(toDataUrl(whole.buffer, "image/png"), "data:image/png;base64,AQIDBA==");
  assert.equal(toDataUrl(whole.subarray(1, 3), "image/png"), `data:image/png;base64,${Buffer.from([2, 3]).toString("base64")}`);
  assert.equal(toDataUrl(new DataView(whole.buffer, 2), "application/pdf"), `data:application/pdf;base64,${Buffer.from([3, 4]).toString("base64")}`);
  assert.match(toDataUrl(whole, ""), /^data:application\/octet-stream;base64,/);
  assert.equal(byteView(whole), whole);
  assert.deepEqual([...byteView(new DataView(whole.buffer, 1, 2))], [2, 3]);
});

test("glimmer is null without GLIMMER_URL, and names the model to send", () => {
  delete process.env.GLIMMER_URL;
  assert.equal(glimmer(), null);
  process.env.GLIMMER_URL = " https://glimmer.example/v1/ ";
  assert.equal(glimmer()?.client.baseURL, "https://glimmer.example/v1");
  assert.equal(glimmer()?.model, "muse-glimmer");
  process.env.GLIMMER_MODEL = "glimmer-receipts-lora";
  assert.equal(glimmer()?.model, "glimmer-receipts-lora");
});
