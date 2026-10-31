import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_FRAME_SANDBOX, enabledFrameBrief, liveFrameAllow, liveFrameSandbox } from "@/lib/product-frame";

test("a glasses product's iframe may use the camera and microphone", () => {
  assert.equal(liveFrameAllow({ targets: [{ id: "web", why: "Always" }, { id: "glasses", why: "Hands free" }] }), "clipboard-write; fullscreen; camera; microphone");
  assert.equal(liveFrameAllow({ targets: ["web", "glasses"] }), "clipboard-write; fullscreen; camera; microphone");
});

test("a stored brief's targets are { id, why }, and those count too", () => {
  const stored = (id: string) => ({ targets: [{ id: "web", why: "Every product runs on the web." }, { id, why: "You asked for it." }] });
  assert.equal(liveFrameAllow(stored("glasses")), "clipboard-write; fullscreen; camera; microphone");
  assert.equal(liveFrameAllow(stored("vr")), "clipboard-write; fullscreen; xr-spatial-tracking");
  assert.equal(liveFrameAllow(stored("phone")), "clipboard-write; fullscreen");
});

test("a VR product's iframe may use spatial tracking and pointer lock, and only a VR product's", () => {
  assert.equal(liveFrameAllow({ targets: ["web", "vr"] }), "clipboard-write; fullscreen; xr-spatial-tracking");
  assert.equal(liveFrameSandbox({ targets: [{ id: "vr" }] }), `${LIVE_FRAME_SANDBOX} allow-pointer-lock`);
  for (const brief of [null, undefined, {}, { targets: ["web", "glasses"] }, { targets: "vr" }]) assert.equal(liveFrameSandbox(brief), LIVE_FRAME_SANDBOX);
  assert.equal(LIVE_FRAME_SANDBOX, "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads");
});

test("every other product keeps today's limits", () => {
  const today = "clipboard-write; fullscreen";
  for (const brief of [null, undefined, {}, { name: "A brief from before targets" }, { targets: ["web"] }, { targets: ["web", "phone"] }, { targets: [{ id: "web", why: "Always" }] }, { targets: "glasses" }]) {
    assert.equal(liveFrameAllow(brief), today);
    assert.equal(liveFrameSandbox(brief), LIVE_FRAME_SANDBOX);
  }
});

test("a target whose flag is off gives the frame nothing", () => {
  const stored = { targets: [{ id: "web", why: "Always." }, { id: "vr", why: "Asked." }, { id: "glasses", why: "Asked." }] };
  const off = enabledFrameBrief(stored, []);
  assert.equal(liveFrameAllow(off), "clipboard-write; fullscreen");
  assert.equal(liveFrameSandbox(off), LIVE_FRAME_SANDBOX);
  const glassesOnly = enabledFrameBrief(stored, ["glasses"]);
  assert.equal(liveFrameAllow(glassesOnly), "clipboard-write; fullscreen; camera; microphone");
  assert.equal(liveFrameSandbox(glassesOnly), LIVE_FRAME_SANDBOX);
  const both = enabledFrameBrief(stored, ["vr", "glasses"]);
  assert.equal(liveFrameAllow(both), "clipboard-write; fullscreen; camera; microphone; xr-spatial-tracking");
  assert.equal(liveFrameSandbox(both), `${LIVE_FRAME_SANDBOX} allow-pointer-lock`);
  assert.equal(liveFrameAllow(enabledFrameBrief(null, ["vr"])), "clipboard-write; fullscreen");
});
