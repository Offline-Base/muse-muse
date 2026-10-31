import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as c from "../lib/commands.mjs";

const SERIAL = c.EMULATOR_SERIAL;
const URL_WITH_QUOTE = "https://a.vercel.app/?q=it's&x=1";

describe("shQuote", () => {
  test("wraps and escapes", () => {
    assert.equal(c.shQuote("plain"), "'plain'");
    assert.equal(c.shQuote("it's"), `'it'\\''s'`);
    assert.equal(c.shQuote("$(reboot); `id`"), "'$(reboot); `id`'");
  });
});

describe("simulator commands", () => {
  test("launch uses the arguments the shell reads", () => {
    const argv = c.simctlLaunch("UDID", "ai.musemuse.lab", { url: "https://a.vercel.app", selftest: { token: "tok", platformUrl: "https://p.app" } });
    assert.deepEqual(argv, [
      "xcrun", "simctl", "launch", "--terminate-running-process", "UDID", "ai.musemuse.lab",
      "-museUrl", "https://a.vercel.app", "-museSelftest", "1", "-museToken", "tok", "-musePlatform", "https://p.app",
    ]);
  });
  test("launch leaves out what's missing", () => {
    const argv = c.simctlLaunch("U", "b.c", { url: "https://a.vercel.app", selftest: null });
    assert.ok(!argv.includes("-museToken") && !argv.includes("-musePlatform"));
  });
  test("the autopilot's launch arguments match the deep link's request", () => {
    const argv = c.simctlLaunchAutopilot("U", "b.c", { url: "https://a.vercel.app" });
    assert.deepEqual(argv.slice(-6), ["-museUrl", "https://a.vercel.app", "-museMock", "1", "-museRun", "autopilot"]);
  });
  test("recording is H.264, so every browser plays it", () => {
    assert.deepEqual(c.simctlRecordVideo("U", "/t/a.mp4"), ["xcrun", "simctl", "io", "U", "recordVideo", "--codec=h264", "--force", "/t/a.mp4"]);
  });
  test("boot, screenshot, install and grant", () => {
    assert.deepEqual(c.simctlBoot("U"), ["xcrun", "simctl", "bootstatus", "U", "-b"]);
    assert.deepEqual(c.simctlScreenshot("U", "o.png"), ["xcrun", "simctl", "io", "U", "screenshot", "--type=png", "o.png"]);
    assert.deepEqual(c.simctlInstall("U", "/a.app"), ["xcrun", "simctl", "install", "U", "/a.app"]);
    assert.deepEqual(c.simctlPrivacyGrant("U", "camera", "b.c"), ["xcrun", "simctl", "privacy", "U", "grant", "camera", "b.c"]);
  });
  test("findSimulator", () => {
    const json = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-4": [{ name: "Muse Lab iPhone", udid: "U1", isAvailable: true }, { name: "x", udid: "U2" }] } });
    assert.deepEqual(c.findSimulator(json, "Muse Lab iPhone"), { udid: "U1", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-4" });
    assert.equal(c.findSimulator(json, "none"), null);
  });
  test("newestIosRuntime compares versions as numbers", () => {
    const json = JSON.stringify({ runtimes: [
      { platform: "iOS", version: "18.10", identifier: "new" },
      { platform: "iOS", version: "18.4", identifier: "old" },
      { platform: "tvOS", version: "26.0", identifier: "tv" },
    ] });
    assert.deepEqual(c.newestIosRuntime(json), { identifier: "new", version: "18.10" });
    assert.equal(c.newestIosRuntime(JSON.stringify({ runtimes: [] })), null);
  });
  test("pickIphoneType", () => {
    const json = JSON.stringify({ devicetypes: [
      { name: "iPhone 9", identifier: "i9" },
      { name: "iPhone 16", identifier: "i16" },
      { name: "iPhone 16 Pro", identifier: "i16p" },
      { name: "iPad Air", identifier: "pad" },
    ] });
    assert.equal(c.pickIphoneType(json), "i16");
    assert.equal(c.pickIphoneType(json, "iPhone 16 Pro"), "i16p");
    assert.equal(c.pickIphoneType(JSON.stringify({ devicetypes: [] })), null);
  });
  test("simulatorAppRunning needs a pid", () => {
    const list = "PID\tStatus\tLabel\n123\t0\tUIKitApplication:ai.musemuse.lab[ab12][rb-legacy]\n-\t0\tUIKitApplication:other.app[ab13]\n";
    assert.equal(c.simulatorAppRunning(list, "ai.musemuse.lab"), true);
    assert.equal(c.simulatorAppRunning(list, "other.app"), false);
    assert.equal(c.simulatorAppRunning(list, "missing.app"), false);
  });
  test("iosVersionOf", () => {
    assert.equal(c.iosVersionOf("com.apple.CoreSimulator.SimRuntime.iOS-26-1"), "26.1");
    assert.equal(c.iosVersionOf("nope"), "");
  });
});

describe("emulator commands", () => {
  test("the emulator runs headless on the software GPU and never saves a snapshot", () => {
    const argv = c.emulatorStart("mm_pixel");
    for (const flag of ["-no-window", "-no-snapshot-save", "-no-audio"]) assert.ok(argv.includes(flag));
    assert.equal(argv[argv.indexOf("-gpu") + 1], "swiftshader_indirect");
    assert.equal(argv[argv.indexOf("-avd") + 1], "mm_pixel");
  });
  test("install grants permissions and replaces", () => {
    assert.deepEqual(c.adbInstall(SERIAL, "/a.apk"), ["adb", "-s", SERIAL, "install", "-r", "-g", "/a.apk"]);
  });
  test("a lab shell gets its URL in a deep link the device shell can't break out of", () => {
    const argv = c.adbAmStart(SERIAL, "ai.musemuse.lab/.MainActivity", { url: URL_WITH_QUOTE, selftest: { token: "tok" }, variant: "lab" });
    assert.equal(argv[3], "shell");
    assert.equal(argv.length, 5);
    assert.match(argv[4], /^am start -W -n 'ai\.musemuse\.lab\/\.MainActivity' -a android\.intent\.action\.VIEW -d 'musemuse-lab:\/\/check\?/);
    assert.ok(!argv[4].slice(argv[4].indexOf("-d ")).includes("it's"));
  });
  test("a product APK gets no link at all", () => {
    const argv = c.adbAmStart(SERIAL, "p.q/.Main", { url: "https://a.vercel.app", selftest: null, variant: "product" });
    assert.equal(argv[4], "am start -W -n 'p.q/.Main'");
  });
  test("labDeepLink carries the request", () => {
    const link = new URL(c.labDeepLink({ url: URL_WITH_QUOTE, selftest: { token: "tok", platformUrl: "https://p.app" } }));
    assert.equal(link.protocol, "musemuse-lab:");
    assert.equal(link.hostname, "check");
    assert.equal(link.searchParams.get("url"), URL_WITH_QUOTE);
    assert.equal(link.searchParams.get("selftest"), "1");
    assert.equal(link.searchParams.get("token"), "tok");
    assert.equal(link.searchParams.get("platform"), "https://p.app");
  });
  test("screenrecord has its time limit and its path quoted", () => {
    assert.equal(c.adbScreenrecord(SERIAL, "/sdcard/a b.mp4", 11.2)[4], "screenrecord --bit-rate 6000000 --time-limit 12 '/sdcard/a b.mp4'");
  });
  test("parseResolvedActivity", () => {
    assert.equal(c.parseResolvedActivity("priority=0 preferredOrder=0\nai.musemuse.lab/.MainActivity\n"), "ai.musemuse.lab/.MainActivity");
    assert.equal(c.parseResolvedActivity("No activity found"), null);
    assert.equal(c.parseResolvedActivity(""), null);
  });
  test("parseAmStart", () => {
    assert.deepEqual(c.parseAmStart("Starting: Intent\nStatus: ok\nTotalTime: 2100\nComplete\n"), { ok: true, totalMs: 2100 });
    assert.equal(c.parseAmStart("Error: Activity class does not exist.").ok, false);
    assert.equal(c.parseAmStart("Status: timeout\n").ok, false);
  });
  test("emulatorListed", () => {
    assert.equal(c.emulatorListed(`List of devices attached\n${SERIAL}\tdevice\n`), true);
    assert.equal(c.emulatorListed(`List of devices attached\n${SERIAL}\toffline\n`), false);
    assert.equal(c.emulatorListed("List of devices attached\n"), false);
  });
  test("selftestFromLogcat takes the last whole report", () => {
    const line = (o) => `10-31 10:00:00.000 1 2 I ReactNativeJS: MUSE_SELFTEST ${JSON.stringify(o)}`;
    const log = [line({ n: 1 }), line({ n: 2 }), "10-31 ReactNativeJS: MUSE_SELFTEST {\"cut"].join("\n");
    assert.deepEqual(c.selftestFromLogcat(log), { n: 2 });
    assert.equal(c.selftestFromLogcat("nothing"), null);
  });
  test("filterLogcat keeps what matters and stays small", () => {
    const log = "10-31 10:00:00.000 77 77 I Foo: mine\n10-31 10:00:00.000 88 88 I Bar: other\n10-31 FATAL EXCEPTION: main\nchromium: x";
    assert.equal(c.filterLogcat(log, { pid: "77" }), "10-31 10:00:00.000 77 77 I Foo: mine\n10-31 FATAL EXCEPTION: main\nchromium: x");
    assert.equal(c.filterLogcat("chromium: abcdef", { maxBytes: 3 }).length, 3);
  });
  test("logcatShowsCrash only names this package", () => {
    const log = "FATAL EXCEPTION: main\nProcess: p.q, PID: 12\njava.lang.Error";
    assert.equal(c.logcatShowsCrash(log, "p.q"), true);
    assert.equal(c.logcatShowsCrash(log, "other.app"), false);
    assert.equal(c.logcatShowsCrash("all fine", "p.q"), false);
  });
});

describe("desktop commands", () => {
  test("the selftest takes only its folder, so no input can steer the app", () => {
    assert.deepEqual(c.desktopSelftest("/a", { dir: "/d" }), ["/a", "--muse-selftest=/d"]);
  });
  test("signing a lab template again is ad hoc", () => {
    assert.deepEqual(c.codesignAdHoc("/A.app"), ["codesign", "--force", "--deep", "--sign", "-", "/A.app"]);
  });
  test("the Mac checks", () => {
    assert.deepEqual(c.codesignVerify("/A.app"), ["codesign", "--verify", "--deep", "--strict", "--verbose=2", "/A.app"]);
    assert.deepEqual(c.spctlAssess("/A.app"), ["spctl", "--assess", "--type", "execute", "-vv", "/A.app"]);
    assert.deepEqual(c.dittoExtract("/a.zip", "/d"), ["ditto", "-x", "-k", "/a.zip", "/d"]);
  });
  test("ffconcatFromFrames plays frames for as long as they were on screen", () => {
    const script = c.ffconcatFromFrames([{ file: "/b.jpg", t: 1000 }, { file: "/a.jpg", t: 0 }], 3000);
    assert.equal(script, "ffconcat version 1.0\nfile '/a.jpg'\nduration 1.000\nfile '/b.jpg'\nduration 2.000\nfile '/b.jpg'\n");
    assert.equal(c.ffconcatFromFrames([], 1000), null);
  });
  test("a frame's path can't break out of the concat script", () => {
    assert.match(c.ffconcatFromFrames([{ file: "/it's.jpg", t: 0 }], 1000), /file '\/it'\\''s\.jpg'/);
  });
});

describe("the glasses deep link", () => {
  test("it's what the shell parses", () => {
    const link = new URL(c.glassesDeepLink({ url: "https://a.vercel.app/?x=1&y=2" }));
    assert.equal(link.protocol, "musemuse:");
    assert.equal(link.hostname, "check");
    assert.equal(link.searchParams.get("url"), "https://a.vercel.app/?x=1&y=2");
    assert.equal(link.searchParams.get("mock"), "1");
    assert.equal(link.searchParams.get("run"), "autopilot");
  });
  test("the feed is H.265 tagged for Apple", () => {
    const argv = c.h265FeedArgs("ffmpeg", "in.jpg", "out.mp4");
    assert.equal(argv[argv.indexOf("-c:v") + 1], "libx265");
    assert.equal(argv[argv.indexOf("-tag:v") + 1], "hvc1");
  });
});
