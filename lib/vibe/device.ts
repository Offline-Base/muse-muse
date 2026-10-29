/**
 * The device picker (docs/VIBE_TUNING.md, Feature 2 "The picker"): which of a model's GGUF builds fits a computer, about
 * how fast it runs there, how long the download takes and which app to start with. Pure functions over what the browser
 * can tell about itself (read by components/vibe/signals.ts, in the browser) and what the person confirms, so nothing
 * about the device ever goes to the server, and the tests run the design's whole table.
 *
 * Sizes are in GB as the Hub and the makers print them: 10^9 bytes for a file, and memory as it is sold. So a budget runs
 * a few percent under what the hardware holds. That is on purpose: a promise that the model runs costs the most when it
 * turns out wrong (docs/VIBE_TUNING.md, Risks 7).
 */
import type { LocalFile, QuantLevel } from "@/lib/train/local-files";

// ---------------------------------------------------------------------------------------------------------------
// Devices

/** The kinds of computer the picker tells apart. Phones, tablets and Chromebooks can't run a 30B model at all. */
export type DeviceKind = "mac" | "mac-intel" | "windows" | "linux" | "chromebook" | "phone" | "tablet";

export const DEVICE_KINDS: ReadonlyArray<{ kind: DeviceKind; label: string }> = [
  { kind: "mac", label: "Mac with Apple silicon" },
  { kind: "mac-intel", label: "Mac with an Intel chip" },
  { kind: "windows", label: "Windows PC" },
  { kind: "linux", label: "Linux PC" },
  { kind: "chromebook", label: "Chromebook" },
  { kind: "phone", label: "Phone" },
  { kind: "tablet", label: "Tablet or iPad" },
];

/** Windows and Linux use the same rows: a graphics card's memory first, then the processor with enough RAM. */
export function isPc(kind: DeviceKind | null): kind is "windows" | "linux" {
  return kind === "windows" || kind === "linux";
}

/** The kinds the model can't run on, whatever their memory. */
export function cantRunHere(kind: DeviceKind | null): boolean {
  return kind === "phone" || kind === "tablet" || kind === "chromebook";
}

export type GpuVendor = "nvidia" | "amd" | "intel";

export const GPU_VENDORS: ReadonlyArray<{ vendor: GpuVendor; label: string }> = [
  { vendor: "nvidia", label: "NVIDIA" },
  { vendor: "amd", label: "AMD" },
  { vendor: "intel", label: "Intel Arc" },
];

/** Memory sizes a chip or a graphics card comes with, and its memory bandwidth at those sizes (a few bins differ). */
export interface MemoryBin {
  memoryGb: readonly number[];
  bandwidthGBs: number;
}

const bin = (memoryGb: number[], bandwidthGBs: number): MemoryBin => ({ memoryGb, bandwidthGBs });

/** An Apple silicon chip, by the name the browser's renderer string gives it ("Apple M4 Max" is "M4 Max"). */
export interface AppleChip {
  name: string;
  bins: readonly MemoryBin[];
}

/**
 * Apple's specs for every M chip: the unified memory it ships with and its bandwidth. The M3 Max and M4 Max with 36 GB
 * (or 96 GB on the M3 Max) are the smaller-GPU bins. The M5 Pro and M5 Max rows are inferred [I]: 614 GB/s fits Meta's
 * 26.6 tokens a second on an M5 Max.
 */
export const APPLE_CHIPS: readonly AppleChip[] = [
  { name: "M1", bins: [bin([8, 16], 68)] },
  { name: "M1 Pro", bins: [bin([16, 32], 200)] },
  { name: "M1 Max", bins: [bin([32, 64], 400)] },
  { name: "M1 Ultra", bins: [bin([64, 128], 800)] },
  { name: "M2", bins: [bin([8, 16, 24], 100)] },
  { name: "M2 Pro", bins: [bin([16, 32], 200)] },
  { name: "M2 Max", bins: [bin([32, 64, 96], 400)] },
  { name: "M2 Ultra", bins: [bin([64, 128, 192], 800)] },
  { name: "M3", bins: [bin([8, 16, 24], 100)] },
  { name: "M3 Pro", bins: [bin([18, 36], 150)] },
  { name: "M3 Max", bins: [bin([36, 96], 300), bin([48, 64, 128], 400)] },
  { name: "M3 Ultra", bins: [bin([96, 256, 512], 819)] },
  { name: "M4", bins: [bin([16, 24, 32], 120)] },
  { name: "M4 Pro", bins: [bin([24, 48, 64], 273)] },
  { name: "M4 Max", bins: [bin([36], 410), bin([48, 64, 128], 546)] },
  { name: "M5", bins: [bin([16, 24, 32], 153)] },
  { name: "M5 Pro", bins: [bin([24, 48, 64], 307)] },
  { name: "M5 Max", bins: [bin([36], 460), bin([48, 64, 128], 614)] },
];

export function appleChip(name: string | null | undefined): AppleChip | null {
  return APPLE_CHIPS.find((c) => c.name === name) ?? null;
}

/** Every unified memory size a Mac with Apple silicon has come with. */
export const MAC_MEMORY_SIZES: readonly number[] = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];
/** RAM sizes PCs commonly have. */
export const PC_MEMORY_SIZES: readonly number[] = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
/** Dedicated graphics memory sizes, as Task Manager shows them (an AMD Ryzen AI Max gives its GPU 64 or 96 GB). */
export const VRAM_SIZES: readonly number[] = [4, 6, 8, 10, 11, 12, 16, 20, 24, 32, 48, 64, 96];

/** A graphics card: its maker's name, the memory sizes it came in and its bandwidth for each. */
export interface GpuModel {
  vendor: GpuVendor;
  /** The maker's name, such as "GeForce RTX 4090 Laptop GPU". */
  name: string;
  /** What gpuKey reads from a renderer string that names it, such as "rtx 4090 laptop". */
  key: string;
  bins: readonly MemoryBin[];
  /** A chip with no memory of its own (AMD's Ryzen AI Max): it uses what the BIOS gives it, so always ask. */
  shared?: boolean;
}

const card = (vendor: GpuVendor, name: string, key: string, bins: MemoryBin[], shared?: boolean): GpuModel =>
  shared ? { vendor, name, key, bins, shared } : { vendor, name, key, bins };
const nv = (name: string, key: string, vram: number[], bw: number) => card("nvidia", name, key, [bin(vram, bw)]);
const amd = (name: string, key: string, vram: number[], bw: number) => card("amd", name, key, [bin(vram, bw)]);
const arc = (name: string, key: string, vram: number[], bw: number) => card("intel", name, key, [bin(vram, bw)]);

/**
 * The cards the browser can name, from their makers' specs [I: not measured here]. Laptop GPUs share a desktop name
 * but not its memory, so they are rows of their own ("RTX 4090 Laptop GPU" has 16 GB, the desktop card 24 GB). The
 * picker only pre-fills a card's memory from this table: the person always confirms it.
 */
export const GPU_MODELS: readonly GpuModel[] = [
  nv("GeForce RTX 5090", "rtx 5090", [32], 1792),
  nv("GeForce RTX 5080", "rtx 5080", [16], 960),
  nv("GeForce RTX 5070 Ti", "rtx 5070 ti", [16], 896),
  nv("GeForce RTX 5070", "rtx 5070", [12], 672),
  nv("GeForce RTX 5060 Ti", "rtx 5060 ti", [16, 8], 448),
  nv("GeForce RTX 5060", "rtx 5060", [8], 448),
  nv("GeForce RTX 5050", "rtx 5050", [8], 320),
  nv("GeForce RTX 4090", "rtx 4090", [24], 1008),
  nv("GeForce RTX 4080 SUPER", "rtx 4080 super", [16], 736),
  nv("GeForce RTX 4080", "rtx 4080", [16], 717),
  nv("GeForce RTX 4070 Ti SUPER", "rtx 4070 ti super", [16], 672),
  nv("GeForce RTX 4070 Ti", "rtx 4070 ti", [12], 504),
  nv("GeForce RTX 4070 SUPER", "rtx 4070 super", [12], 504),
  nv("GeForce RTX 4070", "rtx 4070", [12], 504),
  nv("GeForce RTX 4060 Ti", "rtx 4060 ti", [16, 8], 288),
  nv("GeForce RTX 4060", "rtx 4060", [8], 272),
  nv("GeForce RTX 3090 Ti", "rtx 3090 ti", [24], 1008),
  nv("GeForce RTX 3090", "rtx 3090", [24], 936),
  nv("GeForce RTX 3080 Ti", "rtx 3080 ti", [12], 912),
  card("nvidia", "GeForce RTX 3080", "rtx 3080", [bin([10], 760), bin([12], 912)]),
  nv("GeForce RTX 3070 Ti", "rtx 3070 ti", [8], 608),
  nv("GeForce RTX 3070", "rtx 3070", [8], 448),
  nv("GeForce RTX 3060 Ti", "rtx 3060 ti", [8], 448),
  card("nvidia", "GeForce RTX 3060", "rtx 3060", [bin([12], 360), bin([8], 240)]),
  nv("GeForce RTX 3050", "rtx 3050", [8, 6], 224),
  nv("GeForce RTX 2080 Ti", "rtx 2080 ti", [11], 616),
  nv("GeForce RTX 2080 SUPER", "rtx 2080 super", [8], 496),
  nv("GeForce RTX 2080", "rtx 2080", [8], 448),
  nv("GeForce RTX 2070 SUPER", "rtx 2070 super", [8], 448),
  nv("GeForce RTX 2070", "rtx 2070", [8], 448),
  nv("GeForce RTX 2060", "rtx 2060", [6, 12], 336),
  nv("GeForce GTX 1080 Ti", "gtx 1080 ti", [11], 484),
  nv("GeForce RTX 5090 Laptop GPU", "rtx 5090 laptop", [24], 896),
  nv("GeForce RTX 5080 Laptop GPU", "rtx 5080 laptop", [16], 896),
  nv("GeForce RTX 5070 Ti Laptop GPU", "rtx 5070 ti laptop", [12], 672),
  nv("GeForce RTX 5070 Laptop GPU", "rtx 5070 laptop", [8], 384),
  nv("GeForce RTX 5060 Laptop GPU", "rtx 5060 laptop", [8], 384),
  nv("GeForce RTX 4090 Laptop GPU", "rtx 4090 laptop", [16], 576),
  nv("GeForce RTX 4080 Laptop GPU", "rtx 4080 laptop", [12], 432),
  nv("GeForce RTX 4070 Laptop GPU", "rtx 4070 laptop", [8], 256),
  nv("GeForce RTX 4060 Laptop GPU", "rtx 4060 laptop", [8], 256),
  nv("GeForce RTX 4050 Laptop GPU", "rtx 4050 laptop", [6], 192),
  nv("GeForce RTX 3080 Ti Laptop GPU", "rtx 3080 ti laptop", [16], 512),
  nv("GeForce RTX 3080 Laptop GPU", "rtx 3080 laptop", [16, 8], 448),
  nv("GeForce RTX 3070 Laptop GPU", "rtx 3070 laptop", [8], 448),
  nv("GeForce RTX 3060 Laptop GPU", "rtx 3060 laptop", [6], 336),
  nv("RTX PRO 6000 Blackwell", "rtx pro 6000", [96], 1792),
  nv("RTX 6000 Ada Generation", "rtx 6000 ada", [48], 960),
  nv("RTX 5000 Ada Generation", "rtx 5000 ada", [32], 576),
  nv("RTX 4500 Ada Generation", "rtx 4500 ada", [24], 432),
  nv("RTX 4000 Ada Generation", "rtx 4000 ada", [20], 360),
  nv("RTX A6000", "rtx a6000", [48], 768),
  nv("RTX A5000", "rtx a5000", [24], 768),
  nv("RTX A4000", "rtx a4000", [16], 448),
  nv("TITAN RTX", "titan rtx", [24], 672),
  amd("Radeon RX 9070 XT", "rx 9070 xt", [16], 640),
  amd("Radeon RX 9070", "rx 9070", [16], 640),
  amd("Radeon RX 9060 XT", "rx 9060 xt", [16, 8], 320),
  amd("Radeon RX 7900 XTX", "rx 7900 xtx", [24], 960),
  amd("Radeon RX 7900 XT", "rx 7900 xt", [20], 800),
  amd("Radeon RX 7900 GRE", "rx 7900 gre", [16], 576),
  amd("Radeon RX 7800 XT", "rx 7800 xt", [16], 624),
  amd("Radeon RX 7700 XT", "rx 7700 xt", [12], 432),
  amd("Radeon RX 7600 XT", "rx 7600 xt", [16], 288),
  amd("Radeon RX 7600", "rx 7600", [8], 288),
  amd("Radeon RX 6950 XT", "rx 6950 xt", [16], 576),
  amd("Radeon RX 6900 XT", "rx 6900 xt", [16], 512),
  amd("Radeon RX 6800 XT", "rx 6800 xt", [16], 512),
  amd("Radeon RX 6800", "rx 6800", [16], 512),
  amd("Radeon RX 6750 XT", "rx 6750 xt", [12], 432),
  amd("Radeon RX 6700 XT", "rx 6700 xt", [12], 384),
  amd("Radeon RX 6600", "rx 6600", [8], 224),
  amd("Radeon PRO W7900", "pro w7900", [48], 864),
  amd("Radeon PRO W7800", "pro w7800", [32], 576),
  card("amd", "Radeon 8060S (Ryzen AI Max)", "8060s", [bin([], 256)], true),
  card("intel", "Arc A770", "arc a770", [bin([16], 560), bin([8], 512)]),
  arc("Arc A750", "arc a750", [8], 512),
  arc("Arc B580", "arc b580", [12], 456),
  arc("Arc B570", "arc b570", [10], 380),
  arc("Arc Pro B60", "arc pro b60", [24], 456),
];

export function gpuModel(name: string | null | undefined): GpuModel | null {
  return GPU_MODELS.find((m) => m.name === name) ?? null;
}

/** A card's memory sizes, largest first: the one most sold is usually the larger. Empty for a shared-memory chip. */
export function gpuVramSizes(model: GpuModel | null): number[] {
  if (!model) return [];
  return [...new Set(model.bins.flatMap((b) => b.memoryGb))].sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------------------------------------------
// What the browser says about itself

/** navigator.userAgentData with its high entropy values, as Chrome and Edge give them. Safari and Firefox have none. */
export interface UaData {
  platform: string;
  mobile: boolean;
  /** "arm" or "x86". */
  architecture?: string;
  bitness?: string;
  platformVersion?: string;
  model?: string;
  formFactors?: string[];
  brands?: ReadonlyArray<{ brand: string; version: string }>;
}

/**
 * Everything the picker reads, in the browser only (components/vibe/signals.ts). It never leaves the page: no request
 * carries it, and the server only serves the file list.
 */
export interface BrowserSignals {
  userAgent: string;
  /** navigator.platform, such as "MacIntel" (frozen on Macs, whatever the chip). */
  platform: string;
  maxTouchPoints: number;
  /** navigator.deviceMemory: 2, 4, 8, 16 or 32 from Chrome 147 (at most 8 before), on Chrome and Edge only. */
  deviceMemory: number | null;
  uaData: UaData | null;
  /** WebGL's unmasked renderer, such as "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)". */
  webglRenderer: string | null;
  /** Whether WebGL offers ASTC textures, which only Apple's own GPUs have on a Mac: Apple silicon in Safari. */
  webglAstc: boolean | null;
  /** WebGPU's adapter vendor, such as "apple". */
  webgpuVendor: string | null;
}

/** What a WebGL renderer string names. `silicon` is true when it names an Apple M chip, even one the table lacks. */
export type Renderer =
  | { kind: "apple"; chip: string | null; silicon: boolean }
  | { kind: "gpu"; vendor: GpuVendor | "other"; name: string; model: GpuModel | null; integrated: boolean }
  | { kind: "software" }
  | { kind: "unknown" };

/** A renderer string reduced to lowercase words, without trademarks, device ids or punctuation. */
function rendererWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(tm\)|\(r\)|[™®]/g, " ")
    .replace(/\(0x[0-9a-f]+\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The GPU_MODELS key a renderer string names, such as "rtx 4090 laptop", or null when it names no card we know. */
export function gpuKey(renderer: string): string | null {
  const t = rendererWords(renderer);
  const laptop = /\b(laptop|mobile|max q)\b/.test(t);
  let m = t.match(/\brtx pro (\d{4})\b/);
  if (m) return `rtx pro ${m[1]}`;
  m = t.match(/\brtx (\d{4}) ada\b/);
  if (m) return `rtx ${m[1]} ada`;
  m = t.match(/\brtx a(\d{4})\b/);
  if (m) return `rtx a${m[1]}`;
  if (/\btitan rtx\b/.test(t)) return "titan rtx";
  m = t.match(/\b(rtx|gtx) (\d{4})( ti super| ti| super)?\b/);
  if (m) return `${m[1]} ${m[2]}${m[3] ?? ""}${laptop ? " laptop" : ""}`;
  m = t.match(/\brx (\d{4})(m?)(?: (xtx|xt|gre))?\b/);
  if (m) return `rx ${m[1]}${m[2]}${m[3] ? ` ${m[3]}` : ""}`;
  m = t.match(/\bpro (w\d{4})\b/);
  if (m) return `pro ${m[1]}`;
  m = t.match(/\b(8060s|8050s)\b/);
  if (m) return m[1];
  m = t.match(/\barc (pro )?([ab]\d{3})\b/);
  if (m) return `arc ${m[1] ?? ""}${m[2]}`;
  return null;
}

/**
 * Reads a WebGL renderer string: an Apple chip ("Apple M4 Max" in Chrome, "Apple M1, or similar" in Firefox, only
 * "Apple GPU" in Safari), a graphics card from the table (minding "Laptop GPU" names), built-in graphics, or a
 * software renderer, which says nothing about the hardware.
 */
export function parseRenderer(renderer: string | null | undefined): Renderer {
  const s = String(renderer ?? "").trim();
  if (!s) return { kind: "unknown" };
  if (/swiftshader|llvmpipe|softpipe|basic render|software/i.test(s)) return { kind: "software" };
  const apple = s.match(/\bApple (M\d+)(?: (Pro|Max|Ultra))?\b/);
  if (apple) {
    const name = apple[2] ? `${apple[1]} ${apple[2]}` : apple[1];
    return { kind: "apple", chip: appleChip(name) ? name : null, silicon: true };
  }
  if (/\bApple GPU\b/i.test(s)) return { kind: "apple", chip: null, silicon: false };
  const vendor: GpuVendor | "other" = /nvidia|geforce|quadro|\brtx\b|\bgtx\b/i.test(s)
    ? "nvidia"
    : /\bamd\b|radeon|\bati\b/i.test(s)
      ? "amd"
      : /intel/i.test(s)
        ? "intel"
        : "other";
  const key = gpuKey(s);
  const model = key ? (GPU_MODELS.find((g) => g.key === key) ?? null) : null;
  const words = rendererWords(s);
  // Built-in graphics: Intel UHD, Iris and its Arc iGPUs, AMD's "Radeon Graphics" and 3-digit M parts (780M), Qualcomm.
  const integrated =
    !key &&
    (/adreno|qualcomm/.test(words) ||
      (vendor === "intel" && /\b(uhd|iris|hd graphics|arc graphics|arc 1[34]0v|graphics)\b/.test(words)) ||
      (vendor === "amd" && (/\b\d{3}m\b/.test(words) || /\bradeon graphics\b/.test(words))));
  return { kind: "gpu", vendor, name: model?.name ?? cleanGpuName(s), model, integrated };
}

/** A renderer string's GPU name for display, without the ANGLE wrapper, device ids and graphics API. */
function cleanGpuName(s: string): string {
  const inner = s.match(/^ANGLE \((.*)\)$/)?.[1] ?? s;
  const parts = inner.split(",").map((p) => p.trim());
  // ANGLE puts the vendor first and the device second: "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0, D3D11)".
  const device = parts.length > 1 ? parts[1] : parts[0];
  return device
    .replace(/ANGLE Metal Renderer:\s*/i, "")
    .replace(/\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s*Direct3D\S*.*$/i, "")
    .replace(/\/PCIe\/SSE2/i, "")
    .replace(/\s+or similar$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The Chromium major version, from userAgentData's brands or the user agent, or null outside Chromium. */
export function chromiumMajor(s: Pick<BrowserSignals, "userAgent" | "uaData">): number | null {
  const brand = s.uaData?.brands?.find((b) => b.brand === "Chromium");
  const raw = brand ? brand.version : (String(s.userAgent ?? "").match(/\bChrom(?:e|ium)\/(\d+)/)?.[1] ?? "");
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * What navigator.deviceMemory can mean in real sizes: more than `above` GB and at most `atMost` (null: no top). Chrome
 * rounds to a power of two with ties to the lower one and clamps it, so from Chrome 147 a 24 GB machine reads 16 and
 * anything over 24 GB reads 32. Before 147 the top was 8, so 8 meant 8 GB or more.
 */
export interface MemoryReading {
  reads: number;
  above: number;
  atMost: number | null;
}

export function memoryReading(deviceMemory: number | null | undefined, chromium: number | null): MemoryReading | null {
  const v = Number(deviceMemory);
  if (deviceMemory === null || deviceMemory === undefined || !Number.isFinite(v) || v <= 0) return null;
  const old = chromium !== null && chromium < 147;
  const top = old ? 8 : 32;
  const bottom = old ? 0.25 : 2;
  return { reads: v, above: v <= bottom ? 0 : v * 0.75, atMost: v >= top ? null : v * 1.5 };
}

/** The sizes a reading allows, as words: "32 GB or more", "16 to 24 GB". */
export function memoryReadingText(r: MemoryReading, unit = ""): string {
  // `unit` follows "GB" itself ("32 GB of RAM or more"), so it reads as one amount.
  const low = [...MAC_MEMORY_SIZES, ...PC_MEMORY_SIZES].filter((n) => n > r.above).sort((a, b) => a - b)[0];
  if (r.atMost === null) return `${low ?? r.reads} GB${unit} or more`;
  if (r.above === 0) return `${r.atMost} GB${unit} or less`;
  return low !== undefined && low < r.atMost ? `${low} to ${r.atMost} GB${unit}` : `about ${r.atMost} GB${unit}`;
}

/** What the picker pre-fills, each part "from your browser" until the person changes it. */
export interface Detected {
  kind: DeviceKind | null;
  /** A Mac whose browser couldn't say Apple silicon or Intel: the picker asks. */
  macUnsure: boolean;
  /** The Apple chip, such as "M4 Max", when the renderer names one the table has. */
  chip: string | null;
  /** An x86 browser on an Apple silicon Mac: it runs under Rosetta, so apps installed from it may be Intel builds too. */
  rosetta: boolean;
  /** A PC's graphics as WebGL names them. A laptop may show its built-in graphics here and still have a card. */
  gpu: Extract<Renderer, { kind: "gpu" }> | null;
  memory: MemoryReading | null;
}

/**
 * The browser's signals read into a first guess. Phones and tablets come first, since an iPad reads as a Mac with touch
 * and Android as Linux. A Mac's chip comes from the renderer (Chrome, Edge, Firefox), from Chrome's own architecture,
 * or from ASTC textures (Safari); an Intel Mac's renderer names an Intel, AMD or NVIDIA GPU. Otherwise the picker asks.
 */
export function detectDevice(s: BrowserSignals): Detected {
  const ua = String(s.userAgent ?? "");
  const platform = String(s.uaData?.platform ?? "").toLowerCase();
  const renderer = parseRenderer(s.webglRenderer);
  const touch = (s.maxTouchPoints ?? 0) > 1;
  const out: Detected = {
    kind: null,
    macUnsure: false,
    chip: null,
    rosetta: false,
    gpu: null,
    memory: memoryReading(s.deviceMemory, chromiumMajor(s)),
  };
  if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua)) || s.uaData?.mobile) out.kind = "phone";
  else if (/iPad|Android/.test(ua) || platform === "android" || platform === "ios" || (/Macintosh/.test(ua) && touch)) {
    out.kind = "tablet";
  } else if (/CrOS/.test(ua) || platform === "chrome os" || platform === "chromeos") out.kind = "chromebook";
  else if (/Macintosh|Mac OS X/.test(ua) || platform === "macos") {
    const silicon = (renderer.kind === "apple" && renderer.silicon) || s.uaData?.architecture === "arm" || s.webglAstc === true;
    if (renderer.kind === "apple") out.chip = renderer.chip;
    if (silicon) out.kind = "mac";
    else if (renderer.kind === "gpu") out.kind = "mac-intel";
    else out.macUnsure = true;
    out.rosetta = out.kind === "mac" && s.uaData?.architecture === "x86";
  } else if (/Windows/.test(ua) || platform === "windows") out.kind = "windows";
  else if (/Linux|X11/.test(ua) || platform === "linux") out.kind = "linux";
  if (isPc(out.kind) && renderer.kind === "gpu") out.gpu = renderer;
  return out;
}

/**
 * The memory sizes to offer, as the person confirms memory (always: the browser only hints). A Mac's are its chip's
 * (an M4 Max comes with 36, 48, 64 or 128 GB), a PC's the common RAM sizes, each narrowed to what deviceMemory allows.
 * When narrowing leaves nothing (Brave varies the reading on purpose), every size is offered.
 */
export function memoryChoices(kind: DeviceKind | null, chip: string | null, reading: MemoryReading | null): number[] {
  const known = kind === "mac" ? appleChip(chip) : null;
  const all = known
    ? [...new Set(known.bins.flatMap((b) => b.memoryGb))].sort((a, b) => a - b)
    : kind === "mac" || kind === "mac-intel"
      ? [...MAC_MEMORY_SIZES]
      : [...PC_MEMORY_SIZES];
  if (!reading) return all;
  const fits = all.filter((n) => n > reading.above && (reading.atMost === null || n <= reading.atMost));
  return fits.length ? fits : all;
}

// ---------------------------------------------------------------------------------------------------------------
// The verdict

/** What the person confirmed, or the picker pre-filled. pickBuild needs the memory, and a PC's card memory, confirmed. */
export interface DeviceProfile {
  kind: DeviceKind | null;
  /** An Apple silicon Mac's chip, by its APPLE_CHIPS name. Null when unknown: the speed is then a wider range. */
  chip: string | null;
  /** Unified memory on a Mac, RAM on a PC, in GB. Null until the person confirms it. */
  memoryGb: number | null;
  /** A PC's graphics card, by its GPU_MODELS name when known, or null for none (built-in graphics count as none). */
  gpu: { vendor: GpuVendor; model: string | null; vramGb: number | null } | null;
}

/** KV cache at 8K context: the model has only 2 KV heads, and 39 of its 52 layers use a 2,048-token window [I]. */
export const KV_CACHE_GB = 0.2;
/** Compute buffers: the high end of 0.5 to 1 GB, so the budget edges hold (a 36 GB Mac against Q6_K). */
export const BUFFERS_GB = 1;
/** A download needs the file plus this much free on the disk. */
export const DISK_SPARE_GB = 5;
/** A Mac left with less than this for macOS and its apps runs the model only with other apps closed. */
export const MAC_ROOM_GB = 10;
/** What a PC keeps for Windows or Linux and its apps when the model runs from RAM. */
export const PC_ROOM_GB = 8;
/** Tokens a second are about this share of memory bandwidth over the file's size, close to Meta's three measured. */
export const BANDWIDTH_SHARE = 0.72;
/** The least card memory that runs the smallest build split with the processor. */
export const SPLIT_MIN_VRAM_GB = 12;
/** The least RAM for the processor to run a build, alone or with part of it on a 12 GB card. */
export const PC_MIN_RAM_GB = 32;
/** Part on a 12 GB card, part on the processor: about 8 to 20 tokens a second for Q3_K_M [I]. */
export const SPLIT_SPEED = { low: 8, high: 20, bytes: 13.68e9 } as const;
/** The processor alone: about 1.5 (a 4-core laptop, measured [R]) to 3.5 tokens a second for Q4_K_M. */
export const CPU_SPEED = { low: 1.5, high: 3.5, bytes: 16.94e9 } as const;

const gb = (bytes: number) => bytes / 1e9;

/** About how much memory a build takes to run at 8K context: the file, the KV cache and the buffers. */
export function needGb(file: Pick<LocalFile, "bytes">): number {
  return gb(file.bytes) + KV_CACHE_GB + BUFFERS_GB;
}

/** What a Mac lets its GPU use: about 2/3 of its memory up to 36 GB, and 3/4 above [R]. */
export function macBudgetGb(memoryGb: number): number {
  return memoryGb <= 36 ? (memoryGb * 2) / 3 : (memoryGb * 3) / 4;
}

/** Tokens a second from memory bandwidth: about 0.72 times the bandwidth over the file's size. */
export function bandwidthSpeed(bandwidthGBs: number, bytes: number): number {
  return (BANDWIDTH_SHARE * bandwidthGBs) / gb(bytes);
}

export type Fit = "well" | "tight" | "slow" | "no";

export interface Verdict {
  fit: Fit;
  /** "Runs well", "Runs if you close other apps", "Runs slowly" or "Won't run here". */
  title: string;
  /** Why, in a plain sentence or two. */
  why: string;
  /** The build to download, or null when none runs here. */
  file: LocalFile | null;
  /** All on the graphics (a Mac's GPU or a card), split with the processor, or the processor alone. */
  where: "gpu" | "split" | "cpu" | null;
  /** About how much memory the build takes, in GB. */
  needGb: number | null;
  /** About how many tokens a second, as a range. Null when it won't run, or nothing tells us the speed. */
  speed: { low: number; high: number } | null;
  /** Meta's own measurement on this device, with its 17 GB build, when there is one. */
  measured: string | null;
  /** AMD and Intel cards use LM Studio's Vulkan engine, which is less tested with this model [I]. */
  lessTested: boolean;
  /** Try it live is the better way: the model won't run here, or runs only on the processor. */
  tryLive: boolean;
}

/**
 * Meta's three measured speeds, with its own 16.76 GB K-quant build (the M chips on ExecuTorch, the RTX on llama.cpp).
 * The two Max chips are taken to be their larger-GPU bins, which their speeds fit: a 36 GB M4 Max has 410 GB/s, not 546.
 */
const MEASURED: ReadonlyArray<{ mac: boolean; device: string; label: string; tps: number; bandwidthGBs?: number }> = [
  { mac: true, device: "M4 Max", label: "an M4 Max", tps: 23.7, bandwidthGBs: 546 },
  { mac: true, device: "M5 Max", label: "an M5 Max", tps: 26.6, bandwidthGBs: 614 },
  { mac: false, device: "GeForce RTX 5090", label: "an RTX 5090", tps: 74.9 },
];

function measuredText(p: DeviceProfile, level: QuantLevel): string | null {
  if (level !== "Q4_K_M") return null;
  const m = MEASURED.find((x) => (x.mac ? p.kind === "mac" && p.chip === x.device : isPc(p.kind) && p.gpu?.model === x.device));
  if (!m) return null;
  if (m.bandwidthGBs && macBandwidth(p.chip, p.memoryGb ?? 0)?.[1] !== m.bandwidthGBs) return null;
  return `Meta measured ${m.tps} tokens a second on ${m.label}, with its own 17 GB build.`;
}

/** The lowest and highest bandwidth a Mac's chip can have at this memory size, or across every chip that has it. */
function macBandwidth(chip: string | null, memoryGb: number): [number, number] | null {
  const known = appleChip(chip);
  const chips = known ? [known] : APPLE_CHIPS;
  let bws = chips.flatMap((c) => c.bins.filter((b) => b.memoryGb.includes(memoryGb)).map((b) => b.bandwidthGBs));
  if (!bws.length && known) bws = known.bins.map((b) => b.bandwidthGBs);
  return bws.length ? [Math.min(...bws), Math.max(...bws)] : null;
}

/** A card's bandwidth at its memory size, or the range across the vendor's cards with that much memory. */
function gpuBandwidth(gpu: NonNullable<DeviceProfile["gpu"]>, vramGb: number): [number, number] | null {
  const known = gpuModel(gpu.model);
  const models = known ? [known] : GPU_MODELS.filter((m) => m.vendor === gpu.vendor);
  let bws = models.flatMap((m) => m.bins.filter((b) => m.shared || b.memoryGb.includes(vramGb)).map((b) => b.bandwidthGBs));
  if (!bws.length && known) bws = known.bins.map((b) => b.bandwidthGBs);
  return bws.length ? [Math.min(...bws), Math.max(...bws)] : null;
}

const range = (bw: [number, number] | null, bytes: number) =>
  bw ? { low: bandwidthSpeed(bw[0], bytes), high: bandwidthSpeed(bw[1], bytes) } : null;

/** A fixed range measured at one build's size, scaled to another's: speed goes as one over the size. */
const scaled = (r: { low: number; high: number; bytes: number }, bytes: number) => ({
  low: (r.low * r.bytes) / bytes,
  high: (r.high * r.bytes) / bytes,
});

const about = (n: number) => `about ${Math.round(n)} GB`;

/** Whether the profile says enough for a verdict: memory confirmed (an Intel Mac's too), and a PC's card memory. */
export function profileReady(p: DeviceProfile): boolean {
  if (!p.kind) return false;
  if (cantRunHere(p.kind)) return true;
  if (p.memoryGb === null) return false;
  return !(isPc(p.kind) && p.gpu && p.gpu.vramGb === null);
}

function noVerdict(title: string, why: string): Verdict {
  return { fit: "no", title, why, file: null, where: null, needGb: null, speed: null, measured: null, lessTested: false, tryLive: true };
}

const NOT_HERE = noVerdict("Won't run here", "Phones, tablets and Chromebooks can't run a 30B model.");

/** The least RAM that runs a build on the processor alone, with room left for the system and its apps. */
function cpuRamGb(file: LocalFile): number | null {
  return PC_MEMORY_SIZES.find((n) => n >= PC_MIN_RAM_GB && needGb(file) + PC_ROOM_GB <= n) ?? null;
}

/**
 * Why a build doesn't run on a Mac or a PC, with the least it would take. `what` names it: "the smallest build" for
 * the computer's verdict, "the Q6_K build" when one build is rated.
 */
function tooSmall(p: DeviceProfile, file: LocalFile, what: string): Verdict {
  const need = needGb(file);
  const min = buildMinimum(file);
  if (p.kind === "mac-intel") {
    const ram = cpuRamGb(file);
    return noVerdict(
      "Won't run here",
      `On an Intel Mac only Ollama runs it, on the processor, and ${what} needs ${ram ? `${ram} GB of memory or more` : "more memory than a Mac has"} there.`,
    );
  }
  if (p.kind === "mac") {
    const budget = macBudgetGb(p.memoryGb ?? 0);
    const takes = min.macGb ? ` It takes a Mac with ${min.macGb} GB or more.` : "";
    return noVerdict("Won't run here", `A ${p.memoryGb} GB Mac can give its GPU ${about(budget)}, and ${what} needs ${about(need)}.${takes}`);
  }
  const cardText = min.vramGb ? `a graphics card with ${min.vramGb} GB of its own memory` : "a bigger graphics card";
  const ram = cpuRamGb(file);
  const ramText = ram ? `, or ${ram} GB of RAM to run on the processor` : "";
  return noVerdict("Won't run here", `${what[0].toUpperCase()}${what.slice(1)} needs ${cardText}${ramText}.`);
}

/**
 * How one build runs on a profile that is ready (profileReady), or null when it isn't. `smallest` is the smallest build
 * there is: the split between a 12 GB card and the processor covers only that one.
 */
export function rateBuild(p: DeviceProfile, file: LocalFile, smallest: LocalFile | null = file): Verdict | null {
  if (!profileReady(p) || !p.kind) return null;
  if (cantRunHere(p.kind)) return NOT_HERE;
  const memory = p.memoryGb ?? 0;
  const need = needGb(file);
  const base = { file, needGb: need, measured: measuredText(p, file.level), lessTested: false, tryLive: false };
  // An Intel Mac has no GPU these apps use: LM Studio and Jan need Apple silicon, and Ollama runs on the processor.
  if (p.kind === "mac-intel") {
    if (need + PC_ROOM_GB > memory || memory < PC_MIN_RAM_GB) return tooSmall(p, file, `the ${file.level} build`);
    return {
      ...base,
      fit: "slow",
      title: "Runs slowly",
      why: `On an Intel Mac only Ollama runs it, on the processor: LM Studio and Jan need Apple silicon. The ${file.level} build uses ${about(need)} of its ${memory} GB. Use Try it live for long work.`,
      where: "cpu",
      speed: scaled(CPU_SPEED, file.bytes),
      tryLive: true,
    };
  }
  if (p.kind === "mac") {
    const budget = macBudgetGb(memory);
    if (need > budget) return tooSmall(p, file, `the ${file.level} build`);
    const tight = memory - need < MAC_ROOM_GB;
    return {
      ...base,
      fit: tight ? "tight" : "well",
      title: tight ? "Runs if you close other apps" : "Runs well",
      why: tight
        ? `The ${file.level} build uses ${about(need)} of the ${Math.round(budget)} GB a ${memory} GB Mac can give its GPU. That leaves little room for other apps, so close them before you start it.`
        : `The ${file.level} build uses ${about(need)}, and a ${memory} GB Mac can give its GPU ${about(budget)}.`,
      where: "gpu",
      speed: range(macBandwidth(p.chip, memory), file.bytes),
    };
  }
  const vram = p.gpu?.vramGb ?? 0;
  const lessTested = Boolean(p.gpu && p.gpu.vendor !== "nvidia");
  if (p.gpu && need <= vram) {
    return {
      ...base,
      lessTested,
      fit: "well",
      title: "Runs well",
      why: `The ${file.level} build uses ${about(need)}, which fits in your graphics card's ${vram} GB.${lessTested ? " AMD and Intel cards run it through LM Studio's Vulkan engine, which is less tested with this model." : ""}`,
      where: "gpu",
      speed: range(gpuBandwidth(p.gpu, vram), file.bytes),
    };
  }
  const isSmallest = !smallest || smallest.level === file.level;
  if (p.gpu && vram >= SPLIT_MIN_VRAM_GB && memory >= PC_MIN_RAM_GB && isSmallest && need - vram + PC_ROOM_GB <= memory) {
    return {
      ...base,
      lessTested,
      fit: "slow",
      title: "Runs slowly",
      why: `The ${file.level} build uses ${about(need)}, so ${about(need - vram)} of it runs on the processor, which is much slower than the graphics card.`,
      where: "split",
      speed: scaled(SPLIT_SPEED, file.bytes),
    };
  }
  if (memory >= PC_MIN_RAM_GB && need + PC_ROOM_GB <= memory) {
    return {
      ...base,
      fit: "slow",
      title: "Runs slowly",
      why: `With no graphics card big enough, the ${file.level} build runs on the processor. Use Try it live for long work.`,
      where: "cpu",
      speed: scaled(CPU_SPEED, file.bytes),
      tryLive: true,
    };
  }
  return tooSmall(p, file, `the ${file.level} build`);
}

/** Every build rated for a ready profile, smallest first like the files, or null when the profile isn't ready. */
export function rateBuilds(p: DeviceProfile, files: readonly LocalFile[]): Verdict[] | null {
  if (!profileReady(p)) return null;
  const smallest = files[0] ?? null;
  return files.map((f) => rateBuild(p, f, smallest)!);
}

/**
 * The verdict for a computer (docs/VIBE_TUNING.md, Feature 2, the table): the largest build that fits on the GPU, else
 * the smallest split with the processor (a card of 12 GB or more and 32 GB of RAM), else Q4_K_M on the processor alone
 * (32 GB of RAM), else none. Null until the profile is ready: memory always needs a yes from the person.
 */
export function pickBuild(p: DeviceProfile, files: readonly LocalFile[]): Verdict | null {
  if (!profileReady(p)) return null;
  if (cantRunHere(p.kind)) return NOT_HERE;
  const rated = rateBuilds(p, files) ?? [];
  const gpu = rated.filter((v) => v.where === "gpu");
  if (gpu.length) return gpu[gpu.length - 1];
  const split = rated.find((v) => v.where === "split");
  if (split) return split;
  const cpu = rated.filter((v) => v.where === "cpu");
  if (cpu.length) return cpu.find((v) => v.file?.level === "Q4_K_M") ?? cpu[0];
  return files[0] ? tooSmall(p, files[0], "the smallest build") : noVerdict("Won't run here", "This model has no local builds yet.");
}

/** The least each kind of computer needs to run the smallest build: on a Mac, on a card, and from RAM. */
export interface MinimumSpec {
  macGb: number | null;
  vramGb: number | null;
  ramGb: number | null;
}

export function minimumSpec(files: readonly LocalFile[]): MinimumSpec {
  const smallest = files[0];
  if (!smallest) return { macGb: null, vramGb: null, ramGb: null };
  const cpu = files.find((f) => f.level === "Q4_K_M") ?? smallest;
  return { ...buildMinimum(smallest), ramGb: cpuRamGb(cpu) };
}

/** The least a Mac and a card need for one build, for the table of builds. */
export function buildMinimum(file: Pick<LocalFile, "bytes">): { macGb: number | null; vramGb: number | null } {
  const need = needGb(file);
  return { macGb: MAC_MEMORY_SIZES.find((n) => macBudgetGb(n) >= need) ?? null, vramGb: VRAM_SIZES.find((n) => n >= need) ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
// Words for the page

/** "16.9 GB". */
export function gbText(bytes: number): string {
  return `${gb(bytes).toFixed(1)} GB`;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six"];

/** "three builds from 13.7 GB to 22.9 GB", or "one build of 16.9 GB". */
export function buildsText(files: ReadonlyArray<Pick<LocalFile, "bytes">>): string {
  const sizes = files.map((f) => f.bytes);
  if (sizes.length === 1) return `one build of ${gbText(sizes[0])}`;
  return `${COUNT_WORDS[sizes.length] ?? sizes.length} builds from ${gbText(Math.min(...sizes))} to ${gbText(Math.max(...sizes))}`;
}

/** A speed as the page says it: one decimal under 10, whole above. */
function speedNumber(n: number): string {
  return n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
}

/** "about 17 to 23 tokens a second", or "about 23 tokens a second" when the range is one number. */
export function speedText(speed: { low: number; high: number }): string {
  const low = speedNumber(speed.low);
  const high = speedNumber(speed.high);
  return low === high ? `about ${low} tokens a second` : `about ${low} to ${high} tokens a second`;
}

export const DOWNLOAD_SPEEDS: readonly number[] = [10, 25, 50, 100, 300, 1000];
export const DEFAULT_DOWNLOAD_MBPS = 50;
/** A download longer than this is worth starting when the computer can stay on and plugged in. */
export const LONG_DOWNLOAD_MINUTES = 60;

export function mbpsText(mbps: number): string {
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

export function downloadMinutes(bytes: number, mbps: number): number {
  return (bytes * 8) / (mbps * 1e6) / 60;
}

function durationText(minutes: number): string {
  if (minutes < 1.5) return "a minute";
  if (minutes < 10) return `${Math.round(minutes)} minutes`;
  if (minutes < 57.5) return `${Math.round(minutes / 5) * 5} minutes`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** "17 GB: about 45 minutes at 50 Mbps". */
export function downloadText(bytes: number, mbps: number): string {
  return `${Math.round(gb(bytes))} GB: about ${durationText(downloadMinutes(bytes, mbps))} at ${mbpsText(mbps)}`;
}

/** The free disk a build needs: its file plus DISK_SPARE_GB, rounded up. */
export function diskNeedGb(file: Pick<LocalFile, "bytes">): number {
  return Math.ceil(gb(file.bytes) + DISK_SPARE_GB);
}

// ---------------------------------------------------------------------------------------------------------------
// The app, pre-picked (docs/VIBE_TUNING.md, Feature 5)

export type AppId = "lmstudio" | "llama-app" | "llamacpp" | "ollama" | "jan";

export const APP_NAMES: Record<AppId, string> = {
  lmstudio: "LM Studio",
  "llama-app": "Llama app",
  llamacpp: "llama.cpp",
  ollama: "Ollama",
  jan: "Jan",
};

/**
 * The apps to offer first and on the "Other ways" tab. A Mac with Apple silicon gets LM Studio, then the Llama app,
 * which goes to Other ways for an adapter that needs tuned.jinja, since it can't take one; Windows gets LM Studio;
 * Linux gets Ollama or llama.cpp (llama.cpp first for an adapter that needs tuned.jinja, which it takes on its command
 * line); an Intel Mac only Ollama, slowly. Phones, tablets and Chromebooks get none.
 */
export function pickApps(kind: DeviceKind | null, needsTunedTemplate: boolean): { first: AppId[]; other: AppId[] } {
  switch (kind) {
    case "mac":
      return needsTunedTemplate
        ? { first: ["lmstudio"], other: ["llamacpp", "ollama", "jan", "llama-app"] }
        : { first: ["lmstudio", "llama-app"], other: ["llamacpp", "ollama", "jan"] };
    case "windows":
      return { first: ["lmstudio"], other: ["llamacpp", "ollama", "jan"] };
    case "linux":
      return { first: needsTunedTemplate ? ["llamacpp", "ollama"] : ["ollama", "llamacpp"], other: ["lmstudio", "jan"] };
    case "mac-intel":
      return { first: ["ollama"], other: [] };
    default:
      return { first: [], other: [] };
  }
}
