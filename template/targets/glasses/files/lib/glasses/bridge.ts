/**
 * Platform file: don't edit. Version 1 of the bridge between a product page and the Muse Muse iPhone app, which injects
 * window.MuseNative before the page's own code runs. Use useGlasses from lib/glasses/client.ts rather than this directly.
 *
 * The shell's src/bridge/protocol.ts mirrors these interfaces, and tests/glasses.ts fakes them. Change all three together.
 */

export interface MuseNativeV1 {
  version: 1;
  platform: "ios" | "android";
  capabilities: { glasses: boolean; frames: boolean };
  glasses?: MuseGlasses;
}

export interface MuseGlasses {
  status(): Promise<GlassesStatus>;
  onStatus(cb: (s: GlassesStatus) => void): () => void;
  /** Meta AI hand-off on first use, camera permission, device session. */
  connect(): Promise<GlassesStatus>;
  /** JPEG, at most 1600 px. */
  capturePhoto(o?: { maxSize?: number }): Promise<{ dataUrl: string; width: number; height: number }>;
  /** Native live view strip above the page (EMWDATStreamView). */
  preview(o: { show: boolean }): Promise<void>;
  startRecording(o: { maxSeconds: number }): Promise<void>;
  /** 16 kHz mono WAV. */
  stopRecording(): Promise<{ wavDataUrl: string; seconds: number; source: "glasses" | "phone" }>;
  /** Plays in the glasses when they are the audio output. */
  speak(text: string): Promise<void>;
}

export type GlassesState =
  | "unavailable"
  | "needs-meta-ai"
  | "not-registered"
  | "registering"
  | "no-glasses"
  | "connecting"
  | "ready"
  | "paused"
  | "error";

export interface GlassesStatus {
  state: GlassesState;
  mode: "real" | "mock";
  device: { name: string; battery: number | null; worn: boolean | null } | null;
  error: {
    code:
      | "meta_ai_missing"
      | "permission_denied"
      | "no_eligible_device"
      | "glasses_app_update_required"
      | "hinges_closed"
      | "thermal"
      | "battery_low"
      | "capture_failed"
      | "session_ended"
      | "timeout";
    message: string;
  } | null;
}

/** The codes in GlassesStatus.error. A bridge method that fails rejects with an Error carrying one of them as `code`. */
export type GlassesErrorCode = NonNullable<GlassesStatus["error"]>["code"];

/** How long the page waits on a bridge method, in ms. Longer than the shell's own timeouts, so this only catches a bridge that never answers. */
export const BRIDGE_TIMEOUTS = { connect: 130_000, capture: 30_000, speak: 70_000, other: 30_000 } as const;

/**
 * The app's bridge, or null in a plain browser and on the server. No global Window type on purpose: other parts of a
 * product may describe window.MuseNative too, and two global declarations of it wouldn't compile.
 */
export function museNative(): MuseNativeV1 | null {
  if (typeof window === "undefined") return null;
  const native = (window as unknown as { MuseNative?: Partial<MuseNativeV1> }).MuseNative;
  return native?.version === 1 ? (native as MuseNativeV1) : null;
}

/** The glasses half of the bridge, or null when this app or browser can't reach glasses. */
export function glassesBridge(): MuseGlasses | null {
  const native = museNative();
  return native?.capabilities?.glasses && native.glasses ? native.glasses : null;
}
