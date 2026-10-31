// One runner per job kind. Each takes the job context from lib/execute.mjs and returns the facts and files of its check.
import { runAndroidEmu } from "./android_emu.mjs";
import { runDesktopMac, runDesktopWindows } from "./desktop.mjs";
import { runGlassesSim } from "./glasses_sim.mjs";
import { runIosSim } from "./ios_sim.mjs";

export const RUNNERS = {
  ios_sim: runIosSim,
  android_emu: runAndroidEmu,
  desktop_mac: runDesktopMac,
  desktop_windows: runDesktopWindows,
  glasses_sim: runGlassesSim,
};
