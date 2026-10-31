// @ts-check
// What this build is, from app.config.ts, and what it was asked to open.

import Constants from "expo-constants";
import { Platform, Settings } from "react-native";

import { launchArgsToRequest } from "./launch";

const LAUNCH_ARGS = ["museUrl", "museSlug", "museSelftest", "museToken", "musePlatform", "museMock", "museRun"];

/** @returns {{ variant: import("./launch").AppVariant; glasses: boolean; platformUrl: string; productUrl: string | null; resolveStub: boolean; shellVersion: string }} */
export function readSettings() {
  const config = Constants.expoConfig;
  const extra = config?.extra ?? {};
  return {
    variant: extra.variant === "lab" ? "lab" : "production",
    glasses: extra.glasses === true,
    platformUrl: typeof extra.platformUrl === "string" ? extra.platformUrl : "https://muse-muse.vercel.app",
    productUrl: typeof extra.productUrl === "string" ? extra.productUrl : null,
    resolveStub: extra.resolveStub === true,
    shellVersion: config?.version ?? "0.0.0",
  };
}

/**
 * iOS puts launch arguments in NSUserDefaults, so `simctl launch <id> -museUrl https://...` reads back through Settings.
 * Android has no such thing and uses a deep link instead. Settings also remembers values, but launch arguments only
 * live in the argument domain, so they don't carry over to the next launch.
 */
export function readLaunchArgs() {
  if (Platform.OS !== "ios") return null;
  /** @type {Record<string, unknown>} */
  const args = {};
  for (const key of LAUNCH_ARGS) {
    const value = Settings.get(key);
    if (value !== undefined && value !== null) args[key] = value;
  }
  return launchArgsToRequest(args);
}

/** @returns {import("./bridge/protocol").MusePlatform} */
export function currentPlatform() {
  return Platform.OS === "android" ? "android" : "ios";
}
