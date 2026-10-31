import assert from "node:assert/strict";
import { test } from "node:test";
import { liveFrameAllow, liveFrameSandbox } from "@/lib/product-frame";

const brief = (...ids: string[]) => ({ targets: ids.map((id) => ({ id, why: "Because" })) });
const TODAY_ALLOW = "clipboard-write; fullscreen";
const TODAY_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

test("a glasses product's iframe may use the camera and microphone", () => {
  assert.equal(liveFrameAllow(brief("web", "glasses")), "clipboard-write; fullscreen; camera; microphone");
  assert.equal(liveFrameSandbox(brief("web", "glasses")), TODAY_SANDBOX);
});

test("a VR product's iframe may use WebXR and pointer lock", () => {
  assert.equal(liveFrameAllow(brief("web", "vr")), "clipboard-write; fullscreen; xr-spatial-tracking");
  assert.equal(liveFrameSandbox(brief("web", "vr")), `${TODAY_SANDBOX} allow-pointer-lock`);
});

test("every other product keeps today's limits", () => {
  for (const b of [null, undefined, {}, { name: "A brief from before targets" }, brief("web"), brief("web", "phone"), { targets: "glasses" }, { targets: ["glasses"] }, { targets: ["vr"] }]) {
    assert.equal(liveFrameAllow(b), TODAY_ALLOW);
    assert.equal(liveFrameSandbox(b), TODAY_SANDBOX);
  }
});
