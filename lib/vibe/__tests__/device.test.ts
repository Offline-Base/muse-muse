import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalFile } from "@/lib/train/local-files";
import {
  APPLE_CHIPS,
  GPU_MODELS,
  buildsText,
  detectDevice,
  diskNeedGb,
  downloadText,
  gbText,
  gpuVramSizes,
  macBudgetGb,
  memoryChoices,
  memoryReading,
  memoryReadingText,
  minimumSpec,
  needGb,
  parseRenderer,
  pickApps,
  pickBuild,
  profileReady,
  rateBuild,
  rateBuilds,
  speedText,
  type BrowserSignals,
  type DeviceProfile,
  type Verdict,
} from "@/lib/vibe/device";

// Run 2's three builds, the sizes docs/VIBE_TUNING.md (Feature 2) gives for the tuned files.
const Q3: LocalFile = { level: "Q3_K_M", name: "muse-glimmer-30b-brief-writer-Q3_K_M.gguf", bytes: 13_682_811_872, sha256: "a".repeat(64) };
const Q4: LocalFile = { level: "Q4_K_M", name: "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", bytes: 16_937_492_960, sha256: "b".repeat(64) };
const Q6: LocalFile = { level: "Q6_K", name: "muse-glimmer-30b-brief-writer-Q6_K.gguf", bytes: 22_868_102_624, sha256: "c".repeat(64) };
const FILES = [Q3, Q4, Q6];

const mac = (memoryGb: number | null, chip: string | null = null): DeviceProfile => ({ kind: "mac", chip, memoryGb, gpu: null });
const pc = (memoryGb: number, gpu: DeviceProfile["gpu"] = null, kind: "windows" | "linux" = "windows"): DeviceProfile => ({
  kind,
  chip: null,
  memoryGb,
  gpu,
});
const nvidia = (vramGb: number | null, model: string | null = null) => ({ vendor: "nvidia" as const, model, vramGb });

function pick(p: DeviceProfile, files: LocalFile[] = FILES): Verdict {
  const v = pickBuild(p, files);
  assert.ok(v, "the profile is ready");
  return v;
}

/** The speed range rounded as the page shows it. */
const speed = (v: Verdict) => (v.speed ? speedText(v.speed) : null);

describe("pickBuild: the design's table, row by row", () => {
  for (const kind of ["phone", "tablet", "chromebook"] as const) {
    it(`a ${kind} won't run it here, whatever its memory, and gets Try it live`, () => {
      const v = pick({ kind, chip: null, memoryGb: null, gpu: null });
      assert.equal(v.fit, "no");
      assert.equal(v.title, "Won't run here");
      assert.equal(v.file, null);
      assert.equal(v.tryLive, true);
      assert.equal(v.why, "Phones, tablets and Chromebooks can't run a 30B model.");
    });
  }

  it("a Mac with an Intel chip runs it only slowly, with Ollama on the processor, and only with 32 GB or more", () => {
    const intel = (memoryGb: number | null): DeviceProfile => ({ kind: "mac-intel", chip: null, memoryGb, gpu: null });
    assert.equal(pickBuild(intel(null), FILES), null, "its memory needs a yes too");
    const v = pick(intel(64));
    assert.deepEqual([v.fit, v.title, v.file?.level, v.where], ["slow", "Runs slowly", "Q4_K_M", "cpu"], "Q4_K_M on the processor, as on a PC");
    assert.match(v.why, /only Ollama runs it, on the processor: LM Studio and Jan need Apple silicon/);
    assert.equal(v.tryLive, true);
    assert.equal(pick(intel(32)).file?.level, "Q4_K_M");
    // The review's case: a 16 GB Intel Mac would have been walked through a 17 GB download that can't load.
    for (const gb of [8, 16, 24]) {
      const no = pick(intel(gb));
      assert.deepEqual([no.fit, no.title, no.file], ["no", "Won't run here", null], `${gb} GB`);
      assert.match(no.why, /On an Intel Mac only Ollama runs it, on the processor, and the smallest build needs 32 GB of memory or more there\./);
    }
  });

  for (const gb of [8, 16, 18]) {
    it(`a Mac with Apple silicon and ${gb} GB won't run it`, () => {
      const v = pick(mac(gb, "M3"));
      assert.equal(v.fit, "no");
      assert.equal(v.file, null);
      assert.equal(v.tryLive, true);
      assert.match(v.why, /the smallest build needs about 15 GB\. It takes a Mac with 24 GB or more\./);
    });
  }

  it("a 24 GB Mac runs Q3_K_M with other apps closed, about 6 (M4) to 14 (M4 Pro) tokens a second", () => {
    const m4 = pick(mac(24, "M4"));
    assert.equal(m4.file?.level, "Q3_K_M");
    assert.equal(m4.fit, "tight");
    assert.equal(m4.title, "Runs if you close other apps");
    assert.match(m4.why, /uses about 15 GB of the 16 GB a 24 GB Mac can give its GPU/);
    assert.equal(speed(m4), "about 6.3 tokens a second");
    assert.equal(speed(pick(mac(24, "M4 Pro"))), "about 14 tokens a second");
    assert.equal(m4.tryLive, false);
  });

  it("a 32 or 36 GB Mac runs Q4_K_M well, about 5 (M4) to 17 (an M-series Max)", () => {
    for (const [gb, chip] of [
      [32, "M4"],
      [32, "M1 Max"],
      [36, "M3 Pro"],
      [36, "M4 Max"],
    ] as const) {
      const v = pick(mac(gb, chip));
      assert.equal(v.file?.level, "Q4_K_M", `${chip} ${gb} GB`);
      assert.equal(v.fit, "well");
      assert.equal(v.where, "gpu");
    }
    assert.equal(speed(pick(mac(32, "M4"))), "about 5.1 tokens a second");
    assert.equal(speed(pick(mac(32, "M1 Max"))), "about 17 tokens a second");
    // A 32 GB Mac whose chip nobody named spans every chip sold with 32 GB.
    assert.equal(speed(pick(mac(32))), "about 5.1 to 17 tokens a second");
  });

  it("names Meta's measured 23.7 tokens a second on an M4 Max's larger GPU, for the Q4_K_M build only", () => {
    const q4 = rateBuild(mac(64, "M4 Max"), Q4, Q3);
    assert.equal(q4?.measured, "Meta measured 23.7 tokens a second on an M4 Max, with its own 17 GB build.");
    assert.equal(speed(q4!), "about 23 tokens a second", "the bandwidth estimate lands next to Meta's own number");
    assert.equal(pick(mac(64, "M4 Max")).measured, null, "a 64 GB M4 Max gets Q6_K, which Meta didn't measure");
    // A 36 GB M4 Max is the smaller-GPU bin (410 GB/s): about 17, and Meta's number isn't its own.
    assert.equal(pick(mac(36, "M4 Max")).measured, null);
    assert.equal(speed(pick(mac(36, "M4 Max"))), "about 17 tokens a second");
    assert.equal(pick(mac(36, "M3 Pro")).measured, null);
    // A board's small Q4_K_M on a drive is no Glimmer build, so it never claims Meta's Glimmer speed.
    const llama: LocalFile = { level: "Q4_K_M", name: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", bytes: 532_000_000, sha256: "d".repeat(64) };
    assert.equal(pickBuild(mac(36, "M4 Max"), [llama])?.measured, null);
  });

  it("a Mac with 48 GB or more runs Q6_K well, about 9 (M4 Pro) to 25 (an Ultra)", () => {
    for (const gb of [48, 64, 96, 128, 192]) assert.equal(pick(mac(gb)).file?.level, "Q6_K", `${gb} GB`);
    assert.equal(speed(pick(mac(48, "M4 Pro"))), "about 8.6 tokens a second");
    assert.equal(speed(pick(mac(64, "M2 Ultra"))), "about 25 tokens a second");
  });

  it("a PC with a 32 GB NVIDIA card runs Q6_K, about 56 on an RTX 5090", () => {
    const v = pick(pc(64, nvidia(32, "GeForce RTX 5090")));
    assert.equal(v.file?.level, "Q6_K");
    assert.equal(v.fit, "well");
    assert.equal(speed(v), "about 56 tokens a second");
  });

  it("a PC with a 24 GB NVIDIA card runs Q4_K_M, about 40 on a 3090 or 4090", () => {
    assert.equal(pick(pc(32, nvidia(24, "GeForce RTX 3090"))).file?.level, "Q4_K_M");
    assert.equal(speed(pick(pc(32, nvidia(24, "GeForce RTX 3090")))), "about 40 tokens a second");
    assert.equal(speed(pick(pc(32, nvidia(24, "GeForce RTX 4090")))), "about 43 tokens a second");
  });

  it("an RTX 5090 shows Meta's 74.9 tokens a second when the person picks Q4_K_M", () => {
    const v = rateBuild(pc(64, nvidia(32, "GeForce RTX 5090")), Q4, Q3);
    assert.equal(v?.measured, "Meta measured 74.9 tokens a second on an RTX 5090, with its own 17 GB build.");
  });

  it("a PC with a 16 GB NVIDIA card runs Q3_K_M well, about 15 (4060 Ti) to 50 (5080)", () => {
    const v = pick(pc(16, nvidia(16, "GeForce RTX 4060 Ti")));
    assert.equal(v.file?.level, "Q3_K_M");
    assert.equal(v.fit, "well");
    assert.equal(speed(v), "about 15 tokens a second");
    assert.equal(speed(pick(pc(16, nvidia(16, "GeForce RTX 5080")))), "about 51 tokens a second");
  });

  it("a 12 GB NVIDIA card with 32 GB of RAM runs Q3_K_M slowly, part on the processor, about 8 to 20", () => {
    const v = pick(pc(32, nvidia(12, "GeForce RTX 3060")));
    assert.equal(v.file?.level, "Q3_K_M");
    assert.equal(v.fit, "slow");
    assert.equal(v.where, "split");
    assert.equal(v.title, "Runs slowly");
    assert.equal(speed(v), "about 8 to 20 tokens a second");
    assert.match(v.why, /about 3 GB of it runs on the processor/);
  });

  it("a PC with a small or no card and 32 GB of RAM runs Q4_K_M on the processor, about 1.5 to 3.5, and offers Try it live", () => {
    for (const p of [pc(32), pc(64, nvidia(8, "GeForce RTX 3070")), pc(32, nvidia(11, "GeForce RTX 2080 Ti"))]) {
      const v = pick(p);
      assert.equal(v.file?.level, "Q4_K_M");
      assert.equal(v.where, "cpu");
      assert.equal(v.fit, "slow");
      assert.equal(speed(v), "about 1.5 to 3.5 tokens a second");
      assert.equal(v.tryLive, true);
      assert.match(v.why, /Use Try it live for long work/);
    }
  });

  it("a PC under 32 GB of RAM with no 16 GB card won't run it, and says what it takes", () => {
    for (const p of [pc(16), pc(24, nvidia(12, "GeForce RTX 3060")), pc(16, nvidia(8))]) {
      const v = pick(p);
      assert.equal(v.fit, "no");
      assert.equal(v.file, null);
      assert.equal(v.tryLive, true);
      assert.equal(v.why, "The smallest build needs a graphics card with 16 GB of its own memory, or 32 GB of RAM to run on the processor.");
    }
  });

  it("AMD and Intel cards use the NVIDIA rows by memory, marked less tested", () => {
    const amd = pick(pc(32, { vendor: "amd", model: "Radeon RX 7900 XTX", vramGb: 24 }));
    assert.equal(amd.file?.level, "Q4_K_M");
    assert.equal(amd.lessTested, true);
    assert.match(amd.why, /LM Studio's Vulkan engine, which is less tested/);
    const arc = pick(pc(32, { vendor: "intel", model: "Arc A770", vramGb: 16 }));
    assert.equal(arc.file?.level, "Q3_K_M");
    assert.equal(arc.lessTested, true);
    assert.equal(pick(pc(32, nvidia(24))).lessTested, false);
  });

  it("Linux uses the PC rows", () => {
    assert.deepEqual(pick(pc(32, nvidia(24), "linux")), pick(pc(32, nvidia(24), "windows")));
    assert.equal(pick(pc(32, null, "linux")).where, "cpu");
  });
});

describe("pickBuild: budgets and edges", () => {
  it("a Mac's GPU gets about 2/3 of memory up to 36 GB and 3/4 above", () => {
    assert.equal(macBudgetGb(24), 16);
    assert.equal(macBudgetGb(36), 24);
    assert.equal(macBudgetGb(48), 36);
  });

  it("each build needs its file, the 8K KV cache and the buffers: about 15, 18 and 24 GB", () => {
    assert.equal(Math.round(needGb(Q3)), 15);
    assert.equal(Math.round(needGb(Q4)), 18);
    assert.equal(Math.round(needGb(Q6)), 24);
  });

  it("a 36 GB Mac is just short of Q6_K, so it gets Q4_K_M", () => {
    assert.ok(needGb(Q6) > macBudgetGb(36));
    const q6 = rateBuild(mac(36, "M4 Max"), Q6, Q3);
    assert.equal(q6?.fit, "no");
    assert.match(q6?.why ?? "", /the Q6_K build needs about 24 GB\. It takes a Mac with 48 GB or more\./);
    assert.equal(pick(mac(36, "M4 Max")).file?.level, "Q4_K_M");
  });

  it("16 GB of card memory just holds Q3_K_M, and 24 GB just misses Q6_K", () => {
    assert.ok(needGb(Q3) <= 16);
    assert.equal(rateBuild(pc(16, nvidia(16)), Q3, Q3)?.fit, "well");
    assert.equal(rateBuild(pc(16, nvidia(16)), Q4, Q3)?.fit, "no");
    assert.ok(needGb(Q6) > 24);
    assert.equal(rateBuild(pc(16, nvidia(24)), Q6, Q3)?.fit, "no");
  });

  it("the split covers only the smallest build; a bigger one on a 12 GB card falls to the processor", () => {
    const rated = rateBuilds(pc(32, nvidia(12)), FILES);
    assert.deepEqual(
      rated?.map((v) => [v.file?.level ?? null, v.where]),
      [
        ["Q3_K_M", "split"],
        ["Q4_K_M", "cpu"],
        [null, null],
      ],
    );
  });

  it("picks among the builds that passed their checks: without Q3_K_M a 24 GB Mac can't run it", () => {
    const v = pick(mac(24, "M4"), [Q4, Q6]);
    assert.equal(v.fit, "no");
    assert.match(v.why, /the smallest build needs about 18 GB\. It takes a Mac with 32 GB or more\./);
    // A 16 GB card with 32 GB of RAM then splits the smallest build there is.
    const split = pick(pc(32, nvidia(16)), [Q4, Q6]);
    assert.equal(split.file?.level, "Q4_K_M");
    assert.equal(split.where, "split");
  });

  it("with no builds at all it says so", () => {
    const v = pick(mac(64), []);
    assert.equal(v.fit, "no");
    assert.match(v.why, /no local builds/);
  });

  it("waits for a yes on memory, and on a card's memory", () => {
    assert.equal(pickBuild(mac(null, "M4 Max"), FILES), null);
    assert.equal(pickBuild({ kind: null, chip: null, memoryGb: 32, gpu: null }, FILES), null);
    assert.equal(pickBuild(pc(32, nvidia(null, "GeForce RTX 4090")), FILES), null);
    assert.equal(profileReady(pc(32, null)), true);
    assert.equal(profileReady({ kind: "phone", chip: null, memoryGb: null, gpu: null }), true);
  });
});

/** The signals of a browser, filled from a base. */
function signals(over: Partial<BrowserSignals>): BrowserSignals {
  return {
    userAgent: "",
    platform: "",
    maxTouchPoints: 0,
    deviceMemory: null,
    uaData: null,
    webglRenderer: null,
    webglAstc: null,
    webgpuVendor: null,
    ...over,
  };
}

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const chrome156 = (platform: string, architecture: string) => ({
  platform,
  mobile: false,
  architecture,
  bitness: "64",
  brands: [{ brand: "Chromium", version: "156" }],
});

describe("reading the browser's signals", () => {
  it("reads real WebGL renderer strings: Apple chips, NVIDIA and AMD cards with their Laptop GPU rows, built-in graphics", () => {
    const cases: Array<[string, string]> = [
      ["ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)", "apple M4 Max"],
      ["ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)", "apple M1 Pro"],
      ["Apple M2, or similar", "apple M2"],
      ["Apple GPU", "apple ?"],
      ["ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia GeForce RTX 4090"],
      ["ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia GeForce RTX 4070 Laptop GPU"],
      ["ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU (0x00002757) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia GeForce RTX 4090 Laptop GPU"],
      ["ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER (0x00002705) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia GeForce RTX 4070 Ti SUPER"],
      ["NVIDIA GeForce RTX 3090/PCIe/SSE2", "nvidia GeForce RTX 3090"],
      ["ANGLE (NVIDIA, Vulkan 1.3.277 (NVIDIA NVIDIA GeForce RTX 4080 SUPER (0x00002702)), NVIDIA)", "nvidia GeForce RTX 4080 SUPER"],
      ["ANGLE (NVIDIA, NVIDIA RTX 6000 Ada Generation (0x000026B1) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia RTX 6000 Ada Generation"],
      ["ANGLE (AMD, AMD Radeon RX 7900 XTX (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd Radeon RX 7900 XTX"],
      ["ANGLE (AMD, AMD Radeon(TM) 8060S Graphics (0x00001586) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd Radeon 8060S (Ryzen AI Max)"],
      ["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel Arc A770"],
      ["AMD Radeon RX 6800M (navi22, LLVM 15.0.7, DRM 3.49, 6.2.0)", "amd card"],
      ["ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd built in"],
      ["ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd built in"],
      ["ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel built in"],
      ["ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) (0x000064A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel built in"],
      ["ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU, D3D11)", "other built in"],
      ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "software"],
    ];
    for (const [renderer, want] of cases) {
      const r = parseRenderer(renderer);
      const got =
        r.kind === "apple"
          ? `apple ${r.chip ?? "?"}`
          : r.kind === "gpu"
            ? `${r.vendor} ${r.model ? r.model.name : r.integrated ? "built in" : "card"}`
            : r.kind;
      assert.equal(got, want, renderer);
    }
  });

  it("a laptop GPU gets its own memory, not its desktop namesake's", () => {
    const laptop = parseRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU (0x00002757) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    const desktop = parseRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    assert.ok(laptop.kind === "gpu" && desktop.kind === "gpu");
    assert.deepEqual(gpuVramSizes(laptop.model), [16]);
    assert.deepEqual(gpuVramSizes(desktop.model), [24]);
    const twoSizes = parseRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    assert.ok(twoSizes.kind === "gpu");
    assert.deepEqual(gpuVramSizes(twoSizes.model), [12, 8], "the person picks which one theirs has");
  });

  it("the Mac this was measured on: headless Chrome 156, Apple M4 Max with 36 GB, deviceMemory 32", () => {
    // probe/out/result-0.json in the local-run research notes.
    const d = detectDevice(
      signals({
        userAgent: MAC_UA,
        platform: "MacIntel",
        deviceMemory: 32,
        uaData: chrome156("macOS", "arm"),
        webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)",
        webgpuVendor: "apple",
      }),
    );
    assert.equal(d.kind, "mac");
    assert.equal(d.chip, "M4 Max");
    assert.equal(d.rosetta, false);
    assert.deepEqual(d.memory, { reads: 32, above: 24, atMost: null });
    assert.deepEqual(memoryChoices(d.kind, d.chip, d.memory), [36, 48, 64, 128]);
  });

  it("Rosetta: an x86 browser whose GPU is an Apple M chip", () => {
    const d = detectDevice(
      signals({ userAgent: MAC_UA, uaData: chrome156("macOS", "x86"), webglRenderer: "ANGLE (Apple, Apple M1, OpenGL 4.1)" }),
    );
    assert.equal(d.kind, "mac");
    assert.equal(d.chip, "M1");
    assert.equal(d.rosetta, true);
  });

  it("Safari on Apple silicon says only \"Apple GPU\", so ASTC textures tell; without them it asks", () => {
    const silicon = detectDevice(signals({ userAgent: SAFARI_UA, webglRenderer: "Apple GPU", webglAstc: true }));
    assert.equal(silicon.kind, "mac");
    assert.equal(silicon.chip, null);
    assert.equal(silicon.memory, null, "Safari has no deviceMemory");
    const unsure = detectDevice(signals({ userAgent: SAFARI_UA, webglRenderer: "Apple GPU", webglAstc: false }));
    assert.equal(unsure.kind, null);
    assert.equal(unsure.macUnsure, true);
  });

  it("an Intel Mac's renderer names its Intel or AMD GPU", () => {
    const d = detectDevice(
      signals({
        userAgent: MAC_UA,
        uaData: chrome156("macOS", "x86"),
        webglRenderer: "ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version)",
      }),
    );
    assert.equal(d.kind, "mac-intel");
    assert.equal(d.rosetta, false);
  });

  it("an iPad reads as a Mac with touch, and phones are phones", () => {
    assert.equal(detectDevice(signals({ userAgent: SAFARI_UA, maxTouchPoints: 5, webglRenderer: "Apple GPU", webglAstc: true })).kind, "tablet");
    assert.equal(
      detectDevice(signals({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" })).kind,
      "phone",
    );
    const android = "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
    assert.equal(detectDevice(signals({ userAgent: android, uaData: { platform: "Android", mobile: true } })).kind, "phone");
    const tablet = "Mozilla/5.0 (Linux; Android 16; SM-X920) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
    assert.equal(detectDevice(signals({ userAgent: tablet, uaData: { platform: "Android", mobile: false } })).kind, "tablet");
    assert.equal(
      detectDevice(signals({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16300.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36" })).kind,
      "chromebook",
    );
  });

  it("a Windows PC brings its card, or its built-in graphics, and Linux is a PC", () => {
    const rtx = detectDevice(
      signals({
        userAgent: WIN_UA,
        uaData: chrome156("Windows", "x86"),
        deviceMemory: 32,
        webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      }),
    );
    assert.equal(rtx.kind, "windows");
    assert.equal(rtx.gpu?.model?.name, "GeForce RTX 4090");
    const igpu = detectDevice(
      signals({ userAgent: WIN_UA, webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)" }),
    );
    assert.equal(igpu.gpu?.integrated, true);
    assert.equal(detectDevice(signals({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36" })).kind, "linux");
  });

  it("deviceMemory's buckets: from Chrome 147, 32 means over 24 GB and 16 means 24 or less; before, 8 was the top", () => {
    assert.deepEqual(memoryReading(32, 156), { reads: 32, above: 24, atMost: null });
    assert.deepEqual(memoryReading(16, 156), { reads: 16, above: 12, atMost: 24 });
    assert.deepEqual(memoryReading(8, 156), { reads: 8, above: 6, atMost: 12 });
    assert.deepEqual(memoryReading(2, 156), { reads: 2, above: 0, atMost: 3 });
    assert.deepEqual(memoryReading(8, 146), { reads: 8, above: 6, atMost: null });
    assert.equal(memoryReading(null, 156), null);
    assert.equal(memoryReading(0, 156), null);
    assert.equal(memoryReadingText(memoryReading(32, 156)!), "32 GB or more");
    assert.equal(memoryReadingText(memoryReading(16, 156)!), "16 to 24 GB");
    assert.equal(memoryReadingText(memoryReading(8, 146)!), "8 GB or more");
  });

  it("memory choices are the chip's sizes within the reading: a 24 GB Mac reads 16", () => {
    assert.deepEqual(memoryChoices("mac", "M4", memoryReading(16, 156)), [16, 24]);
    assert.deepEqual(memoryChoices("mac", "M4", memoryReading(32, 156)), [32]);
    assert.deepEqual(memoryChoices("mac", "M3 Pro", null), [18, 36]);
    assert.deepEqual(memoryChoices("windows", null, memoryReading(32, 156)), [32, 48, 64, 96, 128, 192, 256]);
    // A reading no size fits (Brave varies it on purpose) offers them all.
    assert.deepEqual(memoryChoices("mac", "M4 Max", memoryReading(2, 156)), [36, 48, 64, 128]);
  });

  it("every chip and card in the tables has sizes and a bandwidth, and every card key is its own", () => {
    for (const c of APPLE_CHIPS) assert.ok(c.bins.every((b) => b.memoryGb.length && b.bandwidthGBs > 0), c.name);
    for (const m of GPU_MODELS) assert.ok(m.bins.every((b) => (m.shared || b.memoryGb.length) && b.bandwidthGBs > 0), m.name);
    assert.equal(new Set(GPU_MODELS.map((m) => m.key)).size, GPU_MODELS.length);
  });
});

describe("words for the page", () => {
  it("download time: 17 GB is about 45 minutes at 50 Mbps", () => {
    assert.equal(downloadText(Q4.bytes, 50), "17 GB: about 45 minutes at 50 Mbps");
    assert.equal(downloadText(Q4.bytes, 1000), "17 GB: about 2 minutes at 1 Gbps");
    assert.equal(downloadText(Q6.bytes, 25), "23 GB: about 2 hours at 25 Mbps");
    assert.equal(downloadText(Q3.bytes, 10), "14 GB: about 3 hours at 10 Mbps");
  });

  it("sizes, disk and speeds", () => {
    assert.equal(gbText(Q4.bytes), "16.9 GB");
    assert.equal(diskNeedGb(Q4), 22);
    assert.equal(speedText({ low: 17.4, high: 23.2 }), "about 17 to 23 tokens a second");
    assert.equal(speedText({ low: 1.5, high: 3.5 }), "about 1.5 to 3.5 tokens a second");
    assert.equal(speedText({ low: 40.2, high: 39.8 }), "about 40 tokens a second");
    assert.equal(buildsText(FILES), "three builds from 13.7 GB to 22.9 GB");
    assert.equal(buildsText([Q4]), "one build of 16.9 GB");
  });

  it("the minimum spec: a 24 GB Mac, a 16 GB card or 32 GB of RAM; more when Q3_K_M is missing", () => {
    assert.deepEqual(minimumSpec(FILES), { macGb: 24, vramGb: 16, ramGb: 32 });
    assert.deepEqual(minimumSpec([Q4, Q6]), { macGb: 32, vramGb: 20, ramGb: 32 });
    assert.deepEqual(minimumSpec([]), { macGb: null, vramGb: null, ramGb: null });
  });
});

describe("the app, pre-picked", () => {
  it("LM Studio first on a Mac (then the Llama app) and on Windows; Ollama or llama.cpp on Linux", () => {
    assert.deepEqual(pickApps("mac", false), { first: ["lmstudio", "llama-app"], other: ["llamacpp", "ollama", "jan"] });
    assert.deepEqual(pickApps("windows", false), { first: ["lmstudio"], other: ["llamacpp", "ollama", "jan"] });
    assert.deepEqual(pickApps("linux", false).first, ["ollama", "llamacpp"]);
    assert.deepEqual(pickApps("linux", true).first, ["llamacpp", "ollama"], "llama.cpp takes tuned.jinja on its command line");
  });

  it("a Mac sends the Llama app to Other ways for a model that needs tuned.jinja, which it can't take", () => {
    assert.deepEqual(pickApps("mac", true), { first: ["lmstudio"], other: ["llamacpp", "ollama", "jan", "llama-app"] });
  });

  it("an Intel Mac only gets Ollama, slowly, on its own tab; phones, tablets and Chromebooks get none", () => {
    assert.deepEqual(pickApps("mac-intel", false), { first: ["ollama"], other: [] });
    for (const kind of ["phone", "tablet", "chromebook", null] as const) assert.deepEqual(pickApps(kind, false), { first: [], other: [] });
  });
});
