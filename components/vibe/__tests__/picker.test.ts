import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_PICKER,
  nextQuestion,
  pickerReady,
  prefill,
  profileOf,
  sentenceParts,
  withChip,
  withGpuModel,
  withGpuVendor,
  withKind,
  withMemory,
  withVram,
  type PickerState,
} from "@/components/vibe/picker";
import { detectDevice, memoryReading, type BrowserSignals } from "@/lib/vibe/device";

const base: BrowserSignals = {
  userAgent: "",
  platform: "",
  maxTouchPoints: 0,
  deviceMemory: null,
  uaData: null,
  webglRenderer: null,
  webglAstc: null,
  webgpuVendor: null,
};
const chrome = { mobile: false, brands: [{ brand: "Chromium", version: "156" }] };
const macM4Max = detectDevice({
  ...base,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  deviceMemory: 32,
  uaData: { ...chrome, platform: "macOS", architecture: "arm" },
  webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)",
});
const winRtx = detectDevice({
  ...base,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  deviceMemory: 32,
  uaData: { ...chrome, platform: "Windows", architecture: "x86" },
  webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)",
});
const winIgpu = detectDevice({
  ...base,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)",
});

describe("the picker's state", () => {
  it("pre-fills the computer and the chip from the browser, but never the memory", () => {
    const s = prefill(EMPTY_PICKER, macM4Max);
    assert.equal(s.kind, "mac");
    assert.equal(s.chip, "M4 Max");
    assert.deepEqual(s.from, { kind: "browser", chip: "browser", gpu: null });
    assert.equal(s.memoryGb, null, "memory always needs a yes from the person");
    assert.equal(pickerReady(s), false);
    assert.equal(nextQuestion(s), "memory");
  });

  it("a PC's card comes from the browser with its model, its memory still to confirm; built-in graphics read as none", () => {
    const rtx = prefill(EMPTY_PICKER, winRtx);
    assert.equal(rtx.gpuVendor, "nvidia");
    assert.equal(rtx.gpuModel, "GeForce RTX 4090");
    assert.equal(rtx.vramGb, null);
    assert.equal(nextQuestion(withMemory(rtx, 32)), "vram");
    assert.equal(pickerReady(withVram(withMemory(rtx, 32), 24)), true);
    const igpu = prefill(EMPTY_PICKER, winIgpu);
    assert.equal(igpu.gpuVendor, "none");
    assert.equal(pickerReady(withMemory(igpu, 32)), true);
  });

  it("an unknown card leaves the question open, so a PC isn't taken to have none", () => {
    const s = withMemory(withKind("windows"), 32);
    assert.equal(s.gpuVendor, null);
    assert.equal(pickerReady(s), false);
    assert.equal(nextQuestion(s), "gpu");
  });

  it("never overrides what the person said", () => {
    const told = withChip(withKind("mac"), "M2 Pro");
    const s = prefill(told, macM4Max);
    assert.equal(s.kind, "mac");
    assert.equal(s.chip, "M2 Pro");
    assert.deepEqual(s.from, { kind: "you", chip: "you", gpu: null });
    const pcTold = withGpuVendor(withKind("windows"), "amd");
    assert.equal(prefill(pcTold, winRtx).gpuVendor, "amd");
  });

  it("a new computer starts the rest over, and a new card clears its model and memory", () => {
    const mac = withMemory(withChip(withKind("mac"), "M4"), 24);
    const pc = withKind("linux");
    assert.equal(pc.chip, null);
    assert.equal(pc.memoryGb, null);
    assert.equal(mac.memoryGb, 24);
    const card = withVram(withGpuModel(withGpuVendor(pc, "nvidia"), "GeForce RTX 3060"), 12);
    assert.equal(withGpuVendor(card, "amd").gpuModel, null);
    assert.equal(withGpuVendor(card, "amd").vramGb, null);
    assert.equal(withGpuModel(card, "Not a card").gpuModel, null);
  });

  it("phones, tablets and Chromebooks need nothing more, and an Intel Mac its memory", () => {
    for (const kind of ["phone", "tablet", "chromebook"] as const) {
      assert.equal(pickerReady(withKind(kind)), true, kind);
      assert.equal(nextQuestion(withKind(kind)), null, kind);
    }
    // Ollama runs the model there from that memory, so a 16 GB Intel Mac hears no before a download.
    assert.equal(pickerReady(withKind("mac-intel")), false);
    assert.equal(nextQuestion(withKind("mac-intel")), "memory");
    assert.equal(pickerReady(withMemory(withKind("mac-intel"), 16)), true);
    assert.equal(nextQuestion(EMPTY_PICKER), "kind");
  });

  it("the profile has a card only on a PC, and no chip off a Mac", () => {
    const card: PickerState = { ...withMemory(withKind("windows"), 32), gpuVendor: "nvidia", gpuModel: "GeForce RTX 4090", vramGb: 24 };
    assert.deepEqual(profileOf(card).gpu, { vendor: "nvidia", model: "GeForce RTX 4090", vramGb: 24 });
    assert.equal(profileOf({ ...card, gpuVendor: "none" }).gpu, null);
    assert.equal(profileOf({ ...card, kind: "mac", chip: "M4" }).gpu, null);
    assert.equal(profileOf({ ...card, chip: "M4" }).chip, null);
  });
});

describe("the sentence", () => {
  it("tags each part from the browser or from the person, and asks for the memory to be confirmed", () => {
    const s = prefill(EMPTY_PICKER, macM4Max);
    assert.deepEqual(sentenceParts(s, macM4Max), [
      { field: "kind", text: "Mac with Apple silicon", from: "browser" },
      { field: "chip", text: "Apple M4 Max", from: "browser" },
      { field: "memory", text: "32 GB or more, to confirm", from: "browser" },
    ]);
    assert.deepEqual(sentenceParts(withMemory(s, 36), macM4Max)[2], { field: "memory", text: "36 GB", from: "you" });
  });

  it("on a PC: the RAM and the card with its memory", () => {
    const s = withVram(withMemory(prefill(EMPTY_PICKER, winRtx), 32), 24);
    assert.deepEqual(
      sentenceParts(s, winRtx).map((p) => `${p.text} (${p.from})`),
      ["Windows PC (browser)", "32 GB of RAM (you)", "GeForce RTX 4090 with 24 GB (browser)"],
    );
    assert.deepEqual(
      sentenceParts(withKind("linux"), null).map((p) => p.text),
      ["Linux PC", "memory to confirm", "graphics card?"],
    );
    // The browser's hint reads as one amount: "32 GB of RAM or more", not "32 GB or more of RAM".
    assert.equal(sentenceParts(prefill(EMPTY_PICKER, winRtx), winRtx)[1]!.text, "32 GB of RAM or more, to confirm");
    assert.deepEqual(sentenceParts(withKind("mac-intel"), null).map((p) => p.text), ["Mac with an Intel chip", "memory to confirm"]);
  });

  it("asks which computer before anything is known", () => {
    assert.deepEqual(sentenceParts(EMPTY_PICKER, { ...macM4Max, kind: null, memory: memoryReading(16, 156) }), [
      { field: "kind", text: "Which computer?", from: "ask" },
    ]);
  });
});
