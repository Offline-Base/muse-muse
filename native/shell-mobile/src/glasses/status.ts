// Turns the wearables module's error codes into the short messages a product can show.

import type { GlassesErrorCode, GlassesStatus } from "../bridge/protocol";

export interface GlassesProblem {
  code: GlassesErrorCode;
  message: string;
}

const UPDATE_GLASSES = "Your glasses need an update. Open the Meta AI app to update them.";
const TOO_HOT = "Your glasses are too warm. Let them cool down, then try again.";
const LOW_BATTERY = "Your glasses' battery is too low. Charge them, then try again.";
const SESSION_ENDED = "The connection to your glasses ended. Please connect again.";
const NO_DEVICE = "We can't find your glasses. Check they're on, open and paired in the Meta AI app.";

const SESSION_ERRORS: Record<string, GlassesProblem> = {
  noEligibleDevice: { code: "no_eligible_device", message: NO_DEVICE },
  deviceDisconnected: { code: "session_ended", message: SESSION_ENDED },
  sessionEndedByDevice: { code: "session_ended", message: SESSION_ENDED },
  sessionAlreadyStopped: { code: "session_ended", message: SESSION_ENDED },
  capabilityDenied: { code: "permission_denied", message: "Camera access for your glasses is off. Allow it in Meta AI." },
  thermalCritical: { code: "thermal", message: TOO_HOT },
  thermalEmergency: { code: "thermal", message: TOO_HOT },
  peakPowerShutdown: { code: "battery_low", message: LOW_BATTERY },
  batteryCritical: { code: "battery_low", message: LOW_BATTERY },
  datAppOnTheGlassesUpdateRequired: { code: "glasses_app_update_required", message: UPDATE_GLASSES },
  insufficientSDKVersion: { code: "glasses_app_update_required", message: UPDATE_GLASSES },
};

const STREAM_ERRORS: Record<string, GlassesProblem> = {
  deviceNotFound: { code: "no_eligible_device", message: NO_DEVICE },
  deviceNotConnected: { code: "no_eligible_device", message: NO_DEVICE },
  permissionDenied: { code: "permission_denied", message: "Camera access for your glasses is off. Allow it in Meta AI." },
  hingesClosed: { code: "hinges_closed", message: "Open your glasses, then try again." },
  thermalCritical: { code: "thermal", message: TOO_HOT },
  thermalHot: { code: "thermal", message: TOO_HOT },
  thermalEmergency: { code: "thermal", message: TOO_HOT },
  peakPowerShutdown: { code: "battery_low", message: LOW_BATTERY },
  peakPowerLimit: { code: "battery_low", message: LOW_BATTERY },
  batteryCritical: { code: "battery_low", message: LOW_BATTERY },
  batteryLow: { code: "battery_low", message: LOW_BATTERY },
  photoCaptureFailed: { code: "capture_failed", message: "That photo didn't work. Please try again." },
  timeout: { code: "timeout", message: "Your glasses took too long to answer. Please try again." },
};

const GENERIC: GlassesProblem = { code: "session_ended", message: SESSION_ENDED };

export function problemFromSessionError(code: string): GlassesProblem {
  return SESSION_ERRORS[code] ?? GENERIC;
}

export function problemFromStreamError(type: string): GlassesProblem {
  return STREAM_ERRORS[type] ?? { code: "capture_failed", message: "Your glasses stopped sending video. Please try again." };
}

/** The toolkit's localized wording, for errors that reach here with no code. */
const WORDED_ERRORS: Array<[RegExp, GlassesProblem]> = [
  [/Meta AI .*not installed/i, { code: "meta_ai_missing", message: "Install the Meta AI app, then try again." }],
  [/no wearable devices|powered off or disconnected|no eligible/i, { code: "no_eligible_device", message: NO_DEVICE }],
  [/needs? an update/i, { code: "glasses_app_update_required", message: UPDATE_GLASSES }],
  [/battery critically low/i, { code: "battery_low", message: LOW_BATTERY }],
];

/** Native errors carry the module's code in their message or code field, or else the toolkit's own wording. */
export function problemFromThrown(error: unknown): GlassesProblem {
  const text = error instanceof Error ? `${(error as Error & { code?: string }).code ?? ""} ${error.message}` : String(error);
  if (/metaAINotInstalled|META_AI/i.test(text)) {
    return { code: "meta_ai_missing", message: "Install the Meta AI app, then try again." };
  }
  for (const key of Object.keys(SESSION_ERRORS)) if (text.includes(key)) return SESSION_ERRORS[key];
  for (const key of Object.keys(STREAM_ERRORS)) if (text.includes(key)) return STREAM_ERRORS[key];
  for (const [pattern, problem] of WORDED_ERRORS) if (pattern.test(text)) return problem;
  return GENERIC;
}

export function initialStatus(mode: GlassesStatus["mode"]): GlassesStatus {
  return { state: "not-registered", mode, device: null, error: null };
}

/** Battery is 0 to 100, or null on iOS and -1 on Android when unknown. */
export function deviceSummary(device: { name?: string; batteryLevel?: number | null; donState?: string } | null | undefined) {
  if (!device) return null;
  const battery = typeof device.batteryLevel === "number" && device.batteryLevel >= 0 ? device.batteryLevel : null;
  const worn = device.donState === "donned" ? true : device.donState === "doffed" ? false : null;
  return { name: device.name || "Meta glasses", battery, worn };
}
