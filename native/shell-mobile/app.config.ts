// Every build of the phone shell comes from this one file. APP_VARIANT picks production or lab, MUSE_GLASSES=1 adds
// the glasses SDK, and MUSE_PRODUCT_URL makes a per-product build that opens exactly one site.
//
// This file has no imports on purpose. The repo's root typecheck also reads it, and the shell's packages aren't
// installed at the root, so `import type { ExpoConfig } from "expo/config"` would break the main app's typecheck.

type Env = Record<string, string | undefined>;

const PROJECT_ID = "ee7dbfb2-f11f-4e19-9eb7-d5bc6212a5de";
const OWNER = "offline-base1";
// The EAS project's slug. It has to match the project above, so it isn't "muse-muse".
const SLUG = "muse-hackathon";
const PLATFORM_URL = "https://muse-muse.vercel.app";
const VERSION = "1.0.0";
const GLASSES_MODULE = "@chrisgocode/expo-meta-wearables-dat";
// Both plugins below write the iOS microphone text, and the later one wins, so they get the same words.
const MICROPHONE_TEXT = "Products you open can hear a question you ask.";

export type AppVariant = "production" | "lab";

export function variantFrom(env: Env): AppVariant {
  return env.APP_VARIANT === "lab" ? "lab" : "production";
}

function bundleId(variant: AppVariant, glasses: boolean): string {
  if (glasses) return "app.musemuse.glasses";
  return variant === "lab" ? "ai.musemuse.lab" : "ai.musemuse.app";
}

/**
 * The production shell also has to open in Expo Go on the owner's iPhone, which only runs updates made for its own SDK,
 * so it uses the SDK as its runtime version. A native change to it needs an SDK bump. Lab and glasses builds name
 * theirs, since no Expo Go runs them and glasses has different native code.
 */
function runtimeVersionFor(variant: AppVariant, glasses: boolean) {
  if (glasses) return "glasses-1";
  return variant === "lab" ? "lab-1" : { policy: "sdkVersion" as const };
}

export function buildConfig(env: Env) {
  const variant = variantFrom(env);
  const glasses = env.MUSE_GLASSES === "1";
  const mockGlasses = glasses && env.MUSE_GLASSES_MOCK === "1";
  const productUrl = env.MUSE_PRODUCT_URL || null;
  const id = bundleId(variant, glasses);
  const name = variant === "lab" ? (glasses ? "Muse Glasses Lab" : "Muse Lab") : glasses ? "Muse Glasses" : "Muse Muse";

  const plugins: Array<string | [string, Record<string, unknown>]> = [
    "expo-updates",
    "expo-notifications",
    ["expo-audio", { microphonePermission: MICROPHONE_TEXT }],
    [
      "expo-image-picker",
      {
        photosPermission: "Products you open can use a photo you choose.",
        cameraPermission: "Products you open can use a photo you take.",
        // Don't set this to false. The plugin would then strip RECORD_AUDIO from Android, and every product's mic fails.
        microphonePermission: MICROPHONE_TEXT,
      },
    ],
  ];
  // The lab opens http on the machine itself (localhost, or 10.0.2.2 from an emulator), which Android refuses by default.
  if (variant === "lab") plugins.push(["expo-build-properties", { android: { usesCleartextTraffic: true } }]);
  // The order matters. See the note in without-deterministic-uuids.js.
  if (glasses) plugins.push("./plugins/without-deterministic-uuids.js");
  if (glasses) plugins.push([GLASSES_MODULE, { urlScheme: "musemuse", crashReportingOptOut: true }]);
  if (mockGlasses) plugins.push("./plugins/with-mock-glasses-in-release.js");

  return {
    name,
    slug: SLUG,
    owner: OWNER,
    version: VERSION,
    orientation: "default" as const,
    scheme: variant === "lab" ? ["musemuse", "musemuse-lab"] : "musemuse",
    userInterfaceStyle: "automatic" as const,
    newArchEnabled: true,
    ios: {
      bundleIdentifier: id,
      supportsTablet: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        ...(glasses
          ? {
              UIBackgroundModes: ["processing", "bluetooth-central", "bluetooth-peripheral", "external-accessory", "audio"],
              NSLocalNetworkUsageDescription: "Used to reach your Meta glasses.",
              NSBonjourServices: ["_bonjour._tcp"],
              NSMicrophoneUsageDescription: MICROPHONE_TEXT,
              NSCameraUsageDescription: "Products you open can use a photo you take.",
            }
          : {}),
      },
    },
    android: {
      package: id,
      permissions: [
        "android.permission.CAMERA",
        // The WebView needs both for getUserMedia({ audio: true }).
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "android.permission.VIBRATE",
        "android.permission.POST_NOTIFICATIONS",
      ],
    },
    runtimeVersion: runtimeVersionFor(variant, glasses),
    updates: {
      url: `https://u.expo.dev/${PROJECT_ID}`,
      // A per-product app must keep the site it was packaged with, so no update can change it.
      enabled: !productUrl,
      checkAutomatically: "ON_LOAD" as const,
    },
    plugins,
    extra: {
      eas: { projectId: PROJECT_ID },
      variant,
      glasses,
      platformUrl: env.MUSE_PLATFORM_URL || PLATFORM_URL,
      productUrl,
      resolveStub: env.MUSE_RESOLVE_STUB === "1",
    },
  };
}

export default function appConfig() {
  return buildConfig(process.env);
}
