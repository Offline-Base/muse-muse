// window.MuseNative v1: the contract between a product page and the shell around it.
//
// This file is plain TypeScript with no imports, so products can copy it. native/bridge/protocol.ts is a byte-for-byte
// mirror for the template. native/shell-mobile/src/bridge/__tests__/protocol.test.ts fails if the two drift.

export const MUSE_NATIVE_VERSION = 1 as const;

export type MusePlatform = "ios" | "android" | "mac" | "windows" | "linux";

export interface MuseCapabilities {
  haptics: boolean;
  share: boolean;
  camera: boolean;
  notifications: boolean;
  glasses: boolean;
  /** The shell can draw a live view from the glasses above the page. Pixels never reach the page. */
  frames: boolean;
}

export type HapticKind = "light" | "medium" | "heavy" | "selection" | "success" | "warning" | "error";

export interface ShareInput {
  title?: string;
  text?: string;
  /** http or https only. */
  url?: string;
}

export interface ShareResult {
  shared: boolean;
}

export interface TakePhotoInput {
  /** Defaults to "camera". */
  source?: "camera" | "library";
  /** The longest side in pixels. Defaults to 1600. */
  maxSize?: number;
}

export interface PhotoResult {
  /** data:image/jpeg;base64,... */
  dataUrl: string;
  width: number;
  height: number;
}

export interface NotifyInput {
  title: string;
  body?: string;
  /** 0 or missing shows it right away. */
  delaySeconds?: number;
}

export interface HelloResult {
  version: typeof MUSE_NATIVE_VERSION;
  platform: MusePlatform;
  capabilities: MuseCapabilities;
}

// ---------------------------------------------------------------------------------------------------------------
// Glasses

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

export type GlassesErrorCode =
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

export interface GlassesStatus {
  state: GlassesState;
  mode: "real" | "mock";
  device: { name: string; battery: number | null; worn: boolean | null } | null;
  error: { code: GlassesErrorCode; message: string } | null;
}

export interface GlassesPhoto {
  dataUrl: string;
  width: number;
  height: number;
}

export interface GlassesRecording {
  /** data:audio/wav;base64,... 16 kHz mono. */
  wavDataUrl: string;
  seconds: number;
  source: "glasses" | "phone";
}

export interface MuseGlasses {
  status(): Promise<GlassesStatus>;
  /** Returns the function that stops listening. */
  onStatus(cb: (status: GlassesStatus) => void): () => void;
  /** Meta AI hand-off on first use, then the camera permission and a device session. */
  connect(): Promise<GlassesStatus>;
  capturePhoto(options?: { maxSize?: number }): Promise<GlassesPhoto>;
  /** A live view strip the shell draws above the page. */
  preview(options: { show: boolean }): Promise<void>;
  startRecording(options: { maxSeconds: number }): Promise<void>;
  stopRecording(): Promise<GlassesRecording>;
  /** Plays in the glasses when they are the audio output. */
  speak(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// What a product sees

export interface MuseNativeV1 {
  version: typeof MUSE_NATIVE_VERSION;
  platform: MusePlatform;
  capabilities: MuseCapabilities;
  hello(): Promise<HelloResult>;
  haptic(kind?: HapticKind): Promise<void>;
  share(input: ShareInput): Promise<ShareResult>;
  takePhoto(input?: TakePhotoInput): Promise<PhotoResult>;
  notify(input: NotifyInput): Promise<void>;
  glasses?: MuseGlasses;
}

// ---------------------------------------------------------------------------------------------------------------
// On the wire. The page posts a BridgeRequest as a JSON string, and the shell answers with a BridgeReply.

export const BRIDGE_METHODS = [
  "hello",
  "haptic",
  "share",
  "takePhoto",
  "notify",
  "glasses.status",
  "glasses.connect",
  "glasses.capturePhoto",
  "glasses.preview",
  "glasses.startRecording",
  "glasses.stopRecording",
  "glasses.speak",
  "selftest.report",
  "autopilot.checkpoint",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** How long the shell waits for each method. share and takePhoto wait on a person, so they get five minutes. */
export const METHOD_TIMEOUT_MS: Record<BridgeMethod, number> = {
  hello: 5_000,
  haptic: 5_000,
  share: 300_000,
  takePhoto: 300_000,
  notify: 60_000,
  "glasses.status": 5_000,
  "glasses.connect": 120_000,
  "glasses.capturePhoto": 20_000,
  "glasses.preview": 10_000,
  "glasses.startRecording": 10_000,
  "glasses.stopRecording": 15_000,
  "glasses.speak": 60_000,
  "selftest.report": 5_000,
  "autopilot.checkpoint": 5_000,
};

export type BridgeErrorCode =
  | "unsupported"
  | "bad_request"
  | "denied"
  | "canceled"
  | "busy"
  | "rate_limited"
  | "timeout"
  | "failed"
  | GlassesErrorCode;

export interface BridgeRequest {
  v: typeof MUSE_NATIVE_VERSION;
  /** Letters, digits, _ and -. Unique among the requests still waiting for an answer. */
  id: string;
  method: BridgeMethod;
  params?: unknown;
  /** Chosen by the shell when it opens the WebView, and known only to the page's top frame. */
  nonce: string;
}

export type BridgeReply =
  | { v: typeof MUSE_NATIVE_VERSION; id: string; ok: true; result: unknown }
  | { v: typeof MUSE_NATIVE_VERSION; id: string; ok: false; error: { code: BridgeErrorCode; message: string } };

export interface BridgeEvent {
  v: typeof MUSE_NATIVE_VERSION;
  event: "glasses.status";
  data: GlassesStatus;
}
