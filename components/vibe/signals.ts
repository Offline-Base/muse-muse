import type { BrowserSignals, UaData } from "@/lib/vibe/device";

/**
 * Reads what the browser can tell about its computer without asking (docs/VIBE_TUNING.md, Feature 2, "What the browser
 * can tell without asking"): the user agent and its high entropy values, deviceMemory, WebGL's renderer and its ASTC
 * support, and WebGPU's vendor. Browser only, after the page mounts. What it reads stays in the page: nothing here or
 * in the picker sends it anywhere, and lib/vibe/device.ts does the reading of it as pure functions.
 */

type NavigatorWithHints = Navigator & {
  deviceMemory?: number;
  userAgentData?: {
    platform: string;
    mobile: boolean;
    brands?: Array<{ brand: string; version: string }>;
    getHighEntropyValues?: (hints: string[]) => Promise<Partial<UaData> & { platform?: string }>;
  };
  gpu?: { requestAdapter: () => Promise<{ info?: { vendor?: string } } | null> };
};

/** WebGPU can take a moment to answer, and some browsers never do: the picker doesn't wait longer than this. */
const WEBGPU_WAIT_MS = 1500;

async function uaData(nav: NavigatorWithHints): Promise<UaData | null> {
  const ud = nav.userAgentData;
  if (!ud) return null;
  const low: UaData = { platform: ud.platform, mobile: ud.mobile, brands: ud.brands };
  try {
    const high = await ud.getHighEntropyValues?.(["architecture", "bitness", "model", "platformVersion", "formFactors"]);
    return { ...low, ...high, platform: high?.platform ?? low.platform, mobile: high?.mobile ?? low.mobile };
  } catch {
    return low;
  }
}

/** WebGL's renderer (the unmasked one where the browser offers it) and whether it has ASTC textures, then let go. */
function webgl(): { renderer: string | null; astc: boolean | null } {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { renderer: null, astc: null };
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "") || null;
    const astc = Boolean(gl.getExtension("WEBGL_compressed_texture_astc"));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { renderer, astc };
  } catch {
    return { renderer: null, astc: null };
  }
}

async function webgpuVendor(nav: NavigatorWithHints): Promise<string | null> {
  if (!nav.gpu) return null;
  try {
    const adapter = await Promise.race([
      nav.gpu.requestAdapter(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), WEBGPU_WAIT_MS)),
    ]);
    return adapter?.info?.vendor || null;
  } catch {
    return null;
  }
}

export async function readSignals(): Promise<BrowserSignals> {
  const nav = navigator as NavigatorWithHints;
  const gl = webgl();
  const [ud, vendor] = await Promise.all([uaData(nav), webgpuVendor(nav)]);
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    uaData: ud,
    webglRenderer: gl.renderer,
    webglAstc: gl.astc,
    webgpuVendor: vendor,
  };
}
