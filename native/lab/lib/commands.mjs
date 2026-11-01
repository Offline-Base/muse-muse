// Command builders for every tool the runners call. Each returns an argv array for spawn, never a shell string, and
// never runs anything. The one place a real shell is involved is `adb shell`, which joins its arguments and hands them
// to sh on the device, so those go through shQuote.

/** Single-quotes one word for a POSIX shell. */
export function shQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------------------------------------------
// iOS Simulator
// ---------------------------------------------------------------------------------------------------------------

const simctl = (...args) => ["xcrun", "simctl", ...args];

export const simctlList = () => simctl("list", "-j", "devices", "available");
export const simctlRuntimes = () => simctl("list", "-j", "runtimes", "available");
export const simctlDeviceTypes = () => simctl("list", "-j", "devicetypes");
export const simctlCreate = (name, deviceType, runtime) => simctl("create", name, deviceType, runtime);
export const simctlBoot = (udid) => simctl("bootstatus", udid, "-b");
export const simctlInstall = (udid, appPath) => simctl("install", udid, appPath);
export const simctlTerminate = (udid, bundleId) => simctl("terminate", udid, bundleId);
export const simctlContainer = (udid, bundleId, group = "data") => simctl("get_app_container", udid, bundleId, group);
export const simctlPrivacyGrant = (udid, service, bundleId) => simctl("privacy", udid, "grant", service, bundleId);
export const simctlRecordVideo = (udid, out) => simctl("io", udid, "recordVideo", "--codec=h264", "--force", out);
export const simctlScreenshot = (udid, out) => simctl("io", udid, "screenshot", "--type=png", out);
export const simctlRunning = (udid) => simctl("spawn", udid, "launchctl", "list");
export const simctlStatusBarClear = (udid) => simctl("status_bar", udid, "clear");
export const simctlStatusBar = (udid) =>
  simctl(
    "status_bar",
    udid,
    "override",
    "--time",
    "10:00",
    "--dataNetwork",
    "wifi",
    "--wifiMode",
    "active",
    "--wifiBars",
    "3",
    "--cellularMode",
    "active",
    "--cellularBars",
    "4",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
  );

/**
 * Launches the shell with its launch arguments, which iOS puts in NSUserDefaults for the app to read (a cold launch
 * with a deep link isn't supported on an Expo build). The names are the ones launchArgsToRequest reads in
 * native/shell-mobile/src/launch.ts.
 */
export function simctlLaunch(udid, bundleId, { url, selftest }) {
  const args = ["launch", "--terminate-running-process", udid, bundleId, "-museUrl", url, "-museSelftest", "1"];
  if (selftest?.token) args.push("-museToken", selftest.token);
  if (selftest?.platformUrl) args.push("-musePlatform", selftest.platformUrl);
  return simctl(...args);
}

/** Starts the glasses shell's autopilot with Meta's mock glasses. A deep link would stop at a system dialog. */
export function simctlLaunchAutopilot(udid, bundleId, { url }) {
  return simctl("launch", "--terminate-running-process", udid, bundleId, "-museUrl", url, "-museMock", "1", "-museRun", "autopilot");
}

/** The system log's lines from the shell's health report, for when the report file isn't there. */
export const simctlLogShow = (udid, minutes = 3) =>
  simctl("spawn", udid, "log", "show", "--last", `${minutes}m`, "--info", "--style", "compact", "--predicate", 'eventMessage CONTAINS "MUSE_SELFTEST"');


/** Is `bundleId` running on the simulator, per `launchctl list` there? */
export function simulatorAppRunning(listing, bundleId) {
  for (const line of String(listing).split("\n")) {
    if (!line.includes(`UIKitApplication:${bundleId}[`)) continue;
    return /^\d+/.test(line.trim());
  }
  return false;
}

/** The udid of the booted or shutdown device with this name, from `simctl list -j devices available`. */
export function findSimulator(listJson, name) {
  const devices = JSON.parse(listJson).devices ?? {};
  for (const [runtime, list] of Object.entries(devices)) {
    for (const device of list) {
      if (device.name === name && device.isAvailable !== false) return { udid: device.udid, runtime };
    }
  }
  return null;
}

/** The newest iOS runtime, from `simctl list -j runtimes available`. */
export function newestIosRuntime(runtimesJson) {
  const runtimes = (JSON.parse(runtimesJson).runtimes ?? []).filter((r) => r.platform === "iOS" || /^iOS /.test(r.name ?? ""));
  runtimes.sort((a, b) => compareVersions(a.version, b.version));
  const newest = runtimes.at(-1);
  return newest ? { identifier: newest.identifier, version: newest.version } : null;
}

/** The newest runtime of one iOS major version from `simctl list -j runtimes`, or null. */
export function iosRuntimeOfMajor(runtimesJson, major) {
  const prefix = `${major}.`;
  const runtimes = (JSON.parse(runtimesJson).runtimes ?? []).filter(
    (r) => (r.platform === "iOS" || /^iOS /.test(r.name ?? "")) && String(r.version).startsWith(prefix),
  );
  runtimes.sort((a, b) => compareVersions(a.version, b.version));
  const newest = runtimes.at(-1);
  return newest ? { identifier: newest.identifier, version: newest.version } : null;
}

/** The newest plain iPhone from `simctl list -j devicetypes`, like "iPhone 16". Prefers `preferred` if it's there. */
export function pickIphoneType(typesJson, preferred = null) {
  const types = JSON.parse(typesJson).devicetypes ?? [];
  const named = types.find((t) => t.name === preferred);
  if (named) return named.identifier;
  const plain = types
    .map((t) => ({ id: t.identifier, n: /^iPhone (\d+)$/.exec(t.name ?? "")?.[1] }))
    .filter((t) => t.n)
    .sort((a, b) => Number(a.n) - Number(b.n));
  return plain.at(-1)?.id ?? null;
}

function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map(Number);
  const pb = String(b ?? "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** "18.4" from a simctl runtime key or identifier like com.apple.CoreSimulator.SimRuntime.iOS-18-4. */
export function iosVersionOf(runtime) {
  const match = /iOS[- ](\d+)[-.](\d+)/.exec(String(runtime));
  return match ? `${match[1]}.${match[2]}` : "";
}

// ---------------------------------------------------------------------------------------------------------------
// Android emulator
// ---------------------------------------------------------------------------------------------------------------

export const EMULATOR_PORT = 5554;
export const EMULATOR_SERIAL = `emulator-${EMULATOR_PORT}`;

const adb = (serial, ...args) => ["adb", "-s", serial, ...args];
const adbShell = (serial, words) => adb(serial, "shell", words.join(" "));

/** Headless, software GPU, and it never writes a snapshot, so every boot starts clean. */
export const emulatorStart = (avd) => [
  "emulator",
  "-avd",
  avd,
  "-port",
  String(EMULATOR_PORT),
  "-no-window",
  "-gpu",
  "swiftshader_indirect",
  "-no-audio",
  "-no-boot-anim",
  "-no-snapshot-save",
  "-netdelay",
  "none",
  "-netspeed",
  "full",
];

export const adbDevices = () => ["adb", "devices"];
export const adbBootCompleted = (serial) => adbShell(serial, ["getprop", "sys.boot_completed"]);
export const adbInstall = (serial, apk) => adb(serial, "install", "-r", "-g", apk);
export const adbUninstall = (serial, pkg) => adb(serial, "uninstall", pkg);
export const adbForceStop = (serial, pkg) => adbShell(serial, ["am", "force-stop", shQuote(pkg)]);
export const adbPidof = (serial, pkg) => adbShell(serial, ["pidof", shQuote(pkg)]);
export const adbLogcatClear = (serial) => adb(serial, "logcat", "-c");
export const adbLogcatDump = (serial) => adb(serial, "logcat", "-d", "-v", "threadtime");
export const adbLogcatCrash = (serial) => adb(serial, "logcat", "-d", "-b", "crash", "-v", "threadtime");
export const adbScreencap = (serial) => adb(serial, "exec-out", "screencap", "-p");
export const adbPull = (serial, remote, local) => adb(serial, "pull", remote, local);
export const adbRemove = (serial, remote) => adbShell(serial, ["rm", "-f", shQuote(remote)]);
export const adbStopRecording = (serial) => adbShell(serial, ["pkill", "-INT", "screenrecord"]);
export const adbPush = (serial, local, remote) => adb(serial, "push", local, remote);
export const adbForward = (serial, port) => adb(serial, "forward", `tcp:${port}`, `tcp:${port}`);
export const adbForwardRemove = (serial, port) => adb(serial, "forward", "--remove", `tcp:${port}`);
/** A fixed command for the model runs below: only the lab's own constants go in these. */
export const adbRaw = (serial, line) => adb(serial, "shell", line);
export const adbProp = (serial, name) => adbShell(serial, ["getprop", shQuote(name)]);
export const adbResolveActivity = (serial, pkg) =>
  adbShell(serial, ["cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", shQuote(pkg)]);
export const adbScreenrecord = (serial, remote, seconds) =>
  adbShell(serial, ["screenrecord", "--bit-rate", "6000000", "--time-limit", String(Math.ceil(seconds)), shQuote(remote)]);

/** Settings that make the emulator steady for checks: awake, unlocked and with no animations. */
export function adbPrepareCommands(serial) {
  return [
    adbShell(serial, ["svc", "power", "stayon", "true"]),
    adbShell(serial, ["input", "keyevent", "82"]),
    adbShell(serial, ["settings", "put", "global", "window_animation_scale", "0"]),
    adbShell(serial, ["settings", "put", "global", "transition_animation_scale", "0"]),
    adbShell(serial, ["settings", "put", "global", "animator_duration_scale", "0"]),
  ];
}

/**
 * The deep link that starts a lab shell's health check. parseDeepLink in native/shell-mobile/src/launch.ts reads it. The
 * lab variant is a release build, so a cold launch with a link works on Android.
 */
export function labDeepLink({ url, selftest }) {
  const params = new URLSearchParams({ url, selftest: "1" });
  if (selftest?.token) params.set("token", selftest.token);
  if (selftest?.platformUrl) params.set("platform", selftest.platformUrl);
  return `musemuse-lab://check?${params.toString()}`;
}

/**
 * Starts the app and waits for its first frame. A lab shell gets its URL in a deep link. A product APK opens its own
 * product and ignores links.
 */
export function adbAmStart(serial, component, { url, selftest, variant }) {
  const words = ["am", "start", "-W", "-n", shQuote(component)];
  if (variant === "lab") words.push("-a", "android.intent.action.VIEW", "-d", shQuote(labDeepLink({ url, selftest })));
  return adbShell(serial, words);
}

/** The launcher activity from `cmd package resolve-activity --brief`: its last line, "pkg/.MainActivity". */
export function parseResolvedActivity(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  return /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(last) ? last : null;
}

/** `am start -W` output: did it start, and how long did it take? */
export function parseAmStart(output) {
  const text = String(output);
  const total = /TotalTime:\s*(\d+)/.exec(text);
  const failed = /^Error:|Error type|Exception/m.test(text) || /Status:[ \t]*(?!ok\b)\S/.test(text);
  return { ok: !failed, totalMs: total ? Number(total[1]) : null };
}

/** True once `adb devices` lists the emulator as ready. */
export function emulatorListed(output, serial = EMULATOR_SERIAL) {
  return String(output)
    .split(/\r?\n/)
    .some((line) => {
      const [name, state] = line.trim().split(/\s+/);
      return name === serial && state === "device";
    });
}

/** The last health report the shell logged: one line with MUSE_SELFTEST and then JSON. */
export function selftestFromLogcat(text) {
  let report = null;
  for (const line of String(text).split(/\r?\n/)) {
    const at = line.indexOf("MUSE_SELFTEST ");
    if (at < 0) continue;
    try {
      report = JSON.parse(line.slice(at + "MUSE_SELFTEST ".length));
    } catch {
      // A logcat line can be cut off. An earlier full report still counts.
    }
  }
  return report;
}

/** Log lines worth keeping for a job: its process, crashes, and the web view and JS tags. */
export function filterLogcat(text, { pid = null, pkg = "", maxBytes = 64_000 } = {}) {
  const pidMatch = pid ? new RegExp(`^\\S+\\s+\\S+\\s+${pid}\\s`) : null;
  const kept = String(text)
    .split(/\r?\n/)
    .filter(
      (line) =>
        (pidMatch && pidMatch.test(line)) ||
        (pkg && line.includes(pkg)) ||
        /FATAL EXCEPTION|ReactNativeJS|chromium|cr_/.test(line),
    )
    .join("\n");
  return kept.length > maxBytes ? kept.slice(-maxBytes) : kept;
}

/** Did this package die? A crash line naming it in the crash buffer, or a fatal exception in the main log. */
export function logcatShowsCrash(text, pkg) {
  return String(text)
    .split(/\r?\n/)
    .some((line, i, all) => {
      if (!/FATAL EXCEPTION/.test(line)) return false;
      return all.slice(i, i + 4).some((near) => near.includes(pkg));
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------------------------------------------

/** The selftest run of a packaged app. It opens the URL in its muse-product.json, and takes no other input. */
export function desktopSelftest(exe, { dir }) {
  return [exe, `--muse-selftest=${dir}`];
}

export const dittoExtract = (zip, dest) => ["ditto", "-x", "-k", zip, dest];
export const tarExtract = (zip, dest) => ["tar", "-xf", zip, "-C", dest];
export const tarGzExtract = (tarball, dest) => ["tar", "-xzf", tarball, "-C", dest];
export const codesignVerify = (app) => ["codesign", "--verify", "--deep", "--strict", "--verbose=2", app];
/** Signs a lab template again after its muse-product.json changes, which breaks its resource seal. */
export const codesignAdHoc = (app) => ["codesign", "--force", "--deep", "--sign", "-", app];
export const spctlAssess = (app) => ["spctl", "--assess", "--type", "execute", "-vv", app];
export const plutilRaw = (plist, key) => ["plutil", "-extract", key, "raw", "-o", "-", plist];
export const swVersion = () => ["sw_vers", "-productVersion"];
/** The way the Windows box stops itself. The instance's shutdown behavior is stop, so this stops billing. */
export const windowsShutdown = () => ["shutdown", "/s", "/t", "30", "/c", "Muse Muse lab idle"];

// ---------------------------------------------------------------------------------------------------------------
// Glasses
// ---------------------------------------------------------------------------------------------------------------

/** An H.265 video of a still photo, the form Meta's mock camera feed takes. */
export function h265FeedArgs(ffmpeg, photo, out, seconds = 12) {
  return [
    ffmpeg,
    "-hide_banner",
    "-y",
    "-loop",
    "1",
    "-i",
    photo,
    "-t",
    String(seconds),
    "-r",
    "15",
    "-vf",
    "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,format=yuv420p",
    "-c:v",
    "libx265",
    "-preset",
    "fast",
    "-tag:v",
    "hvc1",
    "-an",
    out,
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// ffmpeg helpers for the runners
// ---------------------------------------------------------------------------------------------------------------

/** A screenshot as a JPEG small enough for the build room, under 1 MB. */
export function shotToJpegArgs(ffmpeg, png, jpg) {
  return [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", png, "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", "-frames:v", "1", jpg];
}

/** A small grayscale copy of a screenshot on stdout, for pixels.mjs. */
export function grayArgs(ffmpeg, png, width) {
  return [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    png,
    "-vf",
    `scale=${width}:-2,format=gray`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ];
}

/**
 * The ffconcat script that plays frames at the times they were captured. Frames from a page arrive only when it paints,
 * so the rate isn't constant. `endMs` is how long the last one holds until.
 *
 * @param {{ file: string, t: number }[]} frames
 * @param {number} endMs
 */
export function ffconcatFromFrames(frames, endMs) {
  const sorted = [...frames].filter((f) => typeof f.file === "string" && Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return null;
  const lines = ["ffconcat version 1.0"];
  sorted.forEach((frame, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1].t : Math.max(endMs, frame.t + 500);
    const seconds = Math.max(0.033, (next - frame.t) / 1000);
    lines.push(`file '${frame.file.replace(/'/g, `'\\''`)}'`, `duration ${seconds.toFixed(3)}`);
  });
  // The concat demuxer ignores the last duration unless the last file is named again.
  lines.push(`file '${sorted.at(-1).file.replace(/'/g, `'\\''`)}'`);
  return `${lines.join("\n")}\n`;
}

/** The selftest's frames as an MP4 the compositor can take. */
export function framesToMp4Args(ffmpeg, concatPath, out) {
  return [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-vf",
    "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    out,
  ];
}
