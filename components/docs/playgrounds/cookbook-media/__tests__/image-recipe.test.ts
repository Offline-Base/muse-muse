/**
 * The Muse Image recipe helpers: the bodies each step sends with the server keeping state (previous_response_id) or
 * the client carrying it (store: false and the replayed image_generation_call), the bare-list gotcha, the checks on a
 * real reply (fixtures/muse-image-turn1.json, a real turn with its image swapped for a 1 x 1 WebP and ids redacted),
 * chaining helpers, and the pixel compare for the editing recipe.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-media/__tests__/image-recipe.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  base64Format,
  chainOptions,
  descendants,
  imageCallOf,
  recipeCost,
  replayItem,
  replyChecks,
  runOrder,
  stepRequest,
  tokenCounts,
  type ImageStep,
} from "@/components/docs/playgrounds/cookbook-media/image-recipe";
import { aspectDiffers, compareSize, diffImages } from "@/components/docs/playgrounds/cookbook-media/image-diff";

const TURN1 = JSON.parse(readFileSync(new URL("./fixtures/muse-image-turn1.json", import.meta.url), "utf8"));
const REF = { dataUrl: "data:image/jpeg;base64,AAAA" };

describe("step requests", () => {
  it("starts a conversation with a plain string, as the recipe's turn 1", () => {
    const { path, body } = stepRequest({ prompt: "a watercolor fox", references: [], parent: null, mode: "server" });
    assert.equal(path, "responses");
    assert.deepEqual(body, { model: "muse-image-1.0", input: "a watercolor fox" });
  });

  it("continues with previous_response_id and sends only the change", () => {
    const { body } = stepRequest({ prompt: "add a red wool hat", references: [], parent: { responseId: "resp_1", item: null }, mode: "server" });
    assert.deepEqual(body, { model: "muse-image-1.0", input: "add a red wool hat", previous_response_id: "resp_1" });
  });

  it("wraps reference images in one user message with the instruction first", () => {
    const { body } = stepRequest({ prompt: "combine into one scene", references: [REF, REF], parent: { responseId: "resp_1", item: null }, mode: "server" });
    assert.deepEqual(body.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "combine into one scene" },
          { type: "input_image", image_url: REF.dataUrl },
          { type: "input_image", image_url: REF.dataUrl },
        ],
      },
    ]);
    assert.equal(body.previous_response_id, "resp_1");
  });

  it("can send the bare list the recipe warns about (Meta answers HTTP 400)", () => {
    const { body } = stepRequest({ prompt: "x", references: [REF], parent: null, mode: "server", bareList: true });
    assert.deepEqual(body.input, [
      { type: "input_text", text: "x" },
      { type: "input_image", image_url: REF.dataUrl },
    ]);
  });

  it("carries state on the client: store false, the prior image replayed before the message", () => {
    const item = imageCallOf(TURN1)!.item;
    const first = stepRequest({ prompt: "a fox", references: [], parent: null, mode: "client" });
    assert.deepEqual(first.body, { model: "muse-image-1.0", store: false, input: "a fox" });
    const next = stepRequest({ prompt: "add a hat", references: [REF], parent: { responseId: "resp_x", item }, mode: "client" });
    assert.equal(next.body.store, false);
    assert.equal(next.body.previous_response_id, undefined);
    assert.deepEqual(next.body.input, [
      { type: "image_generation_call", id: "ig_test_signed_handle", status: "completed", result: null },
      { role: "user", content: [{ type: "input_text", text: "add a hat" }, { type: "input_image", image_url: REF.dataUrl }] },
    ]);
    const whole = stepRequest({ prompt: "add a hat", references: [], parent: { responseId: null, item }, mode: "client", replay: "item" });
    assert.equal((whole.body.input as Array<{ result?: string }>)[0].result, item.result);
  });

  it("adds the image_generation tool only for settings that differ from the defaults", () => {
    const plain = stepRequest({ prompt: "p", references: [], parent: null, mode: "server", settings: { size: "auto" } });
    assert.equal(plain.body.tools, undefined);
    const tuned = stepRequest({ prompt: "p", references: [], parent: null, mode: "client", settings: { size: "1024x1536", reasoningStrength: "low", enableWebSearch: false } });
    assert.deepEqual(tuned.body.tools, [{ type: "image_generation", enable_web_search: false, reasoning_strength: "low", size: "1024x1536" }]);
  });

  it("replays by id with result null, or the whole item", () => {
    const item = { type: "image_generation_call", id: "ig_1", status: "completed", result: "UklGR" };
    assert.deepEqual(replayItem(item, "id"), { type: "image_generation_call", id: "ig_1", status: "completed", result: null });
    assert.deepEqual(replayItem(item, "item"), item);
  });
});

describe("reading a reply", () => {
  it("finds the image by type, not position, and checks the result", () => {
    const call = imageCallOf(TURN1)!;
    assert.equal(call.index, 2);
    const checks = replyChecks(TURN1);
    assert.deepEqual(checks.map((c) => c.ok), [true, true]);
    assert.match(checks[1].detail!, /output\[2\] of \[reasoning, message, image_generation_call\]/);
    assert.equal(base64Format(call.item.result as string), "WEBP");
    assert.equal(base64Format("iVBORw0KGgo"), "PNG");
    assert.equal(base64Format("/9j/4AAQ"), "JPEG");
  });

  it("fails the checks for a reply without an image", () => {
    const checks = replyChecks({ status: "incomplete", output: [{ type: "message" }] });
    assert.deepEqual(checks.map((c) => c.ok), [false, false]);
  });

  it("reads the token counts the recipe prints", () => {
    assert.deepEqual(tokenCounts(TURN1), { input: 10089, cached: 7936, output: 998, reasoning: 168, total: 11087 });
    assert.equal(tokenCounts({}), null);
  });
});

describe("chains", () => {
  const steps: ImageStep[] = [
    { id: "hero", label: "Hero", prompt: "", group: "anchor" },
    { id: "park", label: "Park", prompt: "", chainFrom: "hero", group: "anchor" },
    { id: "p1", label: "Panel 1", prompt: "", chainFrom: "park", group: "panel" },
    { id: "nochain", label: "Unchained", prompt: "", optional: true, group: "compare" },
    { id: "page", label: "Page", prompt: "", chainFrom: "p1", group: "page" },
  ];
  const chains = Object.fromEntries(steps.map((s) => [s.id, s.chainFrom ?? null]));

  it("runs every step but the optional ones, and prices them", () => {
    assert.deepEqual(runOrder(steps).map((s) => s.id), ["hero", "park", "p1", "page"]);
    assert.deepEqual(recipeCost(steps), { images: 4, usd: 0.04 });
  });

  it("finds what goes stale when a step reruns", () => {
    assert.deepEqual(descendants(steps, "park", chains), ["p1", "page"]);
    assert.deepEqual(descendants(steps, "page", chains), []);
  });

  it("only lets a step continue an earlier one", () => {
    assert.deepEqual(chainOptions(steps, "p1").map((s) => s.id), ["hero", "park"]);
    assert.deepEqual(chainOptions(steps, "hero"), []);
  });
});

describe("pixel compare", () => {
  const solid = (w: number, h: number, v: number) => Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : v));

  it("finds nothing between identical images", () => {
    const a = solid(8, 8, 120);
    const d = diffImages(a, a, 8, 8);
    assert.equal(d.changed, 0);
    assert.equal(d.bounds, null);
  });

  it("marks a changed square and bounds it", () => {
    const a = solid(20, 20, 40);
    const b = solid(20, 20, 40);
    for (let y = 5; y < 10; y++) for (let x = 12; x < 17; x++) for (let c = 0; c < 3; c++) b[(y * 20 + x) * 4 + c] = 240;
    const d = diffImages(a, b, 20, 20);
    assert.ok(d.changed >= 20 && d.changed <= 49, `changed ${d.changed}`);
    assert.ok(d.bounds && d.bounds.x1 >= 11 && d.bounds.x2 <= 17 && d.bounds.y1 >= 4 && d.bounds.y2 <= 10);
    assert.equal(d.heat[(7 * 20 + 14) * 4 + 3] > 0, true, "the middle of the change is marked");
    assert.equal(d.heat[3], 0, "an unchanged corner is clear");
  });

  it("ignores small re-render noise under the threshold", () => {
    const a = solid(10, 10, 100);
    const b = solid(10, 10, 110);
    assert.equal(diffImages(a, b, 10, 10).changed, 0);
  });

  it("sizes the compare from the source and notices a different shape", () => {
    assert.deepEqual(compareSize({ width: 1280, height: 853 }), { width: 480, height: 320 });
    assert.equal(aspectDiffers({ width: 1280, height: 853 }, { width: 1920, height: 1280 }), false);
    assert.equal(aspectDiffers({ width: 1280, height: 853 }, { width: 1024, height: 1024 }), true);
  });
});
