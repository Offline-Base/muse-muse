import assert from "node:assert/strict";
import { test } from "node:test";
import { liveFrameAllow } from "@/lib/product-frame";

test("a glasses product's iframe may use the camera and microphone", () => {
  assert.equal(liveFrameAllow({ targets: ["web", "glasses"] }), "clipboard-write; fullscreen; camera; microphone");
});

test("every other product keeps today's limits", () => {
  const today = "clipboard-write; fullscreen";
  for (const brief of [null, undefined, {}, { name: "A brief from before targets" }, { targets: ["web"] }, { targets: ["web", "vr"] }, { targets: "glasses" }]) {
    assert.equal(liveFrameAllow(brief), today);
  }
});
