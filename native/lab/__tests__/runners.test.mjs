// The runners against a scripted exec: the real machines don't exist yet, so these check the order of the commands, the
// facts they read back and the verdict that comes out. The exec answers by matching a command's words.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import vm from "node:vm";
import { runAndroidEmu } from "../jobs/android_emu.mjs";
import { PROBE_FILE, probeFromReport, probePage } from "../jobs/android_probe.mjs";
import { contentTypeOf, shotSchedule } from "../jobs/common.mjs";
import { findExe, listFrames, listStills, pointAppAt, runDesktopMac, runDesktopWindows } from "../jobs/desktop.mjs";
import { MOCK_FEED, MOCK_PHOTO, runGlassesSim } from "../jobs/glasses_sim.mjs";
import { runIosSim } from "../jobs/ios_sim.mjs";
import { findAppBundle } from "../jobs/simulator.mjs";
import { LabError } from "../lib/errors.mjs";
import { validateJob } from "../lib/validate.mjs";
import { makeJob, SELFTEST_TOKEN, SHA } from "./helpers.mjs";

const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const ORIGIN = "https://demo-product.vercel.app";
const GOOD_REPORT = { v: 1, ok: true, finalUrl: `${ORIGIN}/`, httpStatus: 200, loadMs: 1800, textLength: 300, handshake: true, errors: [], crashed: false, loadError: null };
const UDID = "UDID-1";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-4";

/** A context like lib/execute.mjs makes, with time that only moves when the runner sleeps. */
function makeCtx(kind, { lane = "mac", job: jobOverrides, answer = () => undefined, deviceList, platformReport = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mm-run-"));
  roots.push(root);
  const dir = path.join(root, "job");
  mkdirSync(dir, { recursive: true });
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const checked = validateJob(makeJob(kind, jobOverrides), { lane, platformOrigin: "https://muse-muse.vercel.app" });
  assert.equal(checked.ok, true, checked.error);
  let clock = 1_000_000;
  const commands = [];
  const lines = [];
  const started = [];
  const container = path.join(root, "container");
  mkdirSync(path.join(container, "Documents"), { recursive: true });

  const reply = (over = {}) => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...over });
  const defaults = (argv, opts) => {
    const text = argv.join(" ");
    if (text.includes("list -j devices")) return reply({ stdout: JSON.stringify({ devices: deviceList ?? { [RUNTIME]: [{ name: "Muse Lab iPhone", udid: UDID, isAvailable: true }] } }) });
    if (text.includes("get_app_container")) return reply({ stdout: `${container}\n`, code: text.endsWith(" app") ? 1 : 0 });
    if (text.includes("spawn") && text.includes("launchctl")) return reply({ stdout: `123\t0\tUIKitApplication:${checked.job.input.app.bundleId}[ab][rb]\n` });
    if (argv.includes("-frames:v") || text.includes("rawvideo")) {
      const out = argv.at(-1);
      if (out !== "-") writeFileSync(out, "jpeg");
      return reply({ stdout: Buffer.alloc(128 * 8, 0).map((_, i) => (i * 13) % 256) });
    }
    if (argv[0].includes("ffprobe")) return reply({ stdout: JSON.stringify({ streams: [{ width: 1080, height: 2400 }], format: { duration: "10" } }) });
    if (text.includes("screenshot")) {
      writeFileSync(argv.at(-1), "png");
      return reply();
    }
    if (argv.includes("screencap")) {
      writeFileSync(opts.stdoutFile, "png");
      return reply();
    }
    return reply();
  };

  const ctx = {
    job: checked.job,
    input: checked.job.input,
    config: {
      dataDir,
      lane,
      ios: { simulator: "Muse Lab iPhone", deviceType: null, glassesSimulator: "Muse Lab iPhone" },
      android: { avd: "mm_pixel", deviceLabel: "Pixel 7" },
    },
    dir,
    signal: new AbortController().signal,
    log: {},
    logLine: (line) => lines.push(line),
    now: () => clock,
    redact: (text) => text,
    sleep: async (ms) => {
      clock += ms;
    },
    exec: async (argv, opts = {}) => {
      commands.push(argv);
      clock += 10;
      return answer(argv, opts, reply) ?? defaults(argv, opts);
    },
    startProc: (argv, opts = {}) => {
      started.push({ argv, opts });
      const file = argv.at(-1);
      return {
        exited: false,
        output: () => "Recording started\n",
        stop: async () => {
          if (argv.includes("recordVideo")) writeFileSync(file, "mp4");
          return 0;
        },
        kill: () => {},
      };
    },
    compose: async ({ outDir, caption }) => {
      const clip = path.join(outDir, "clip.mp4");
      const poster = path.join(outDir, "poster.jpg");
      writeFileSync(clip, "clip");
      writeFileSync(poster, "poster");
      ctx.composedCaption = caption;
      return { clip, poster, seconds: 10, captionBurned: true };
    },
    ffmpeg: { path: "ffmpeg", drawtext: false },
    fetchSelftest: async () => platformReport,
    setPhase: () => {},
    throwIfAborted: () => {},
    download: async (spec) => {
      const file = path.join(root, `download-${path.basename(new URL(spec.url).pathname)}`);
      writeFileSync(file, "bytes");
      return file;
    },
  };
  const ran = (word) => commands.filter((argv) => argv.join(" ").includes(word));
  const order = (...words) => {
    const at = words.map((word) => commands.findIndex((argv) => argv.join(" ").includes(word)));
    for (const [i, position] of at.entries()) assert.ok(position >= 0, `${words[i]} never ran`);
    for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `${words[i - 1]} came after ${words[i]}`);
  };
  return { ctx, commands, lines, started, container, ran, order, root, dataDir };
}

describe("ios_sim", () => {
  const extract = (h) => (argv, _opts, reply) => {
    if (argv[0] === "tar") {
      mkdirSync(path.join(argv.at(-1), "Muse Lab.app"), { recursive: true });
      return reply();
    }
    if (argv.includes("launch")) {
      writeFileSync(path.join(h().container, "Documents", "selftest.json"), JSON.stringify({ ...GOOD_REPORT, at: new Date(2_000_000).toISOString() }));
      return reply({ stdout: "ai.musemuse.lab: 123\n" });
    }
    return undefined;
  };

  test("boots, installs, records, launches and passes on a good report", async () => {
    let h;
    h = makeCtx("ios_sim", { answer: extract(() => h) });
    const result = await runIosSim(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    h.order("bootstatus", "install", "privacy", "launch");
    const launch = h.ran("launch")[0];
    assert.equal(launch[launch.indexOf("-museUrl") + 1], `${ORIGIN}/`);
    assert.equal(launch[launch.indexOf("-museToken") + 1], SELFTEST_TOKEN);
    assert.ok(h.started[0].argv.includes("recordVideo"));
    assert.equal(h.ctx.composedCaption, "On an iPhone simulator (iOS 18.4)");
    assert.deepEqual(result.files.map((f) => f.role).sort(), ["clip", "poster", "shot", "shot"]);
    assert.equal(result.captionBurned, true);
  });

  test("a shell already installed isn't installed again", async () => {
    let h;
    h = makeCtx("ios_sim", {
      answer: (argv, opts, reply) => {
        if (argv.join(" ").endsWith(" app")) return reply({ stdout: "/x\n" });
        return extract(() => h)(argv, opts, reply);
      },
    });
    writeFileSync(path.join(h.dataDir, "installed-shells.json"), JSON.stringify({ [`${UDID}:ai.musemuse.lab`]: SHA }));
    await runIosSim(h.ctx);
    assert.equal(h.ran("simctl install").length, 0);
  });

  test("a stale report from the last job can't pass this one", async () => {
    const h = makeCtx("ios_sim", {
      answer: (argv, _opts, reply) => (argv[0] === "tar" ? (mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true }), reply()) : undefined),
    });
    writeFileSync(path.join(h.container, "Documents", "selftest.json"), JSON.stringify(GOOD_REPORT));
    const result = await runIosSim(h.ctx);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.checks.some((c) => c.id === "health_report" && c.ok === false));
  });

  test("a report file from before this launch can't pass it, even one written after the cleanup", async () => {
    let h;
    h = makeCtx("ios_sim", {
      answer: (argv, _opts, reply) => {
        if (argv[0] === "tar") {
          mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true });
          return reply();
        }
        if (argv.includes("launch")) {
          writeFileSync(path.join(h.container, "Documents", "selftest.json"), JSON.stringify({ ...GOOD_REPORT, at: new Date(1000).toISOString() }));
          return reply({ stdout: "ai.musemuse.lab: 123\n" });
        }
        return undefined;
      },
    });
    const result = await runIosSim(h.ctx);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.checks.some((c) => c.id === "health_report" && c.ok === false));
  });

  test("the system log is the backup for the report", async () => {
    const h = makeCtx("ios_sim", {
      answer: (argv, _opts, reply) => {
        if (argv[0] === "tar") {
          mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true });
          return reply();
        }
        if (argv.includes("log")) return reply({ stdout: `2026-10-31 Df Muse[1:2] MUSE_SELFTEST ${JSON.stringify({ ...GOOD_REPORT, at: new Date(2_000_000).toISOString() })}\n` });
        return undefined;
      },
    });
    assert.equal((await runIosSim(h.ctx)).evaluation.passed, true);
  });

  test("a log line from an earlier job doesn't count", async () => {
    const h = makeCtx("ios_sim", {
      answer: (argv, _o, reply) => {
        if (argv[0] === "tar") return mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true }), reply();
        if (argv.includes("log")) return reply({ stdout: `MUSE_SELFTEST ${JSON.stringify({ ...GOOD_REPORT, at: new Date(1000).toISOString() })}\n` });
        return undefined;
      },
    });
    assert.equal((await runIosSim(h.ctx)).evaluation.passed, false);
  });

  const unpackOnly = (argv, _o, reply) => (argv[0] === "tar" ? (mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true }), reply()) : undefined);
  const datedAfterLaunch = { ...GOOD_REPORT, at: new Date(2_000_000).toISOString() };

  test("what the shell posted to the platform is the last backup, for a release build with no log line", async () => {
    const h = makeCtx("ios_sim", { platformReport: datedAfterLaunch, answer: unpackOnly });
    assert.equal((await runIosSim(h.ctx)).evaluation.passed, true);
  });

  test("the platform's copy from an earlier attempt can't pass a retry", async () => {
    // A retry keeps the job id and the selftest token, so the platform can still hold what attempt 1 posted.
    for (const stale of [{ ...GOOD_REPORT, at: new Date(1000).toISOString() }, GOOD_REPORT]) {
      const h = makeCtx("ios_sim", { platformReport: stale, answer: unpackOnly });
      const result = await runIosSim(h.ctx);
      assert.equal(result.evaluation.passed, false);
      assert.ok(result.evaluation.checks.some((c) => c.id === "health_report" && c.ok === false));
    }
  });

  /** A shell whose report reaches the platform `reportAfterMs` after launch, as a slow page or the watchdog would. */
  function slowReport(reportAfterMs) {
    const h = makeCtx("ios_sim", { answer: unpackOnly });
    let launchedAt = null;
    const exec = h.ctx.exec;
    h.ctx.exec = async (argv, opts) => {
      if (argv.includes("launch")) launchedAt = h.ctx.now();
      return exec(argv, opts);
    };
    h.ctx.fetchSelftest = async () => {
      if (launchedAt === null || h.ctx.now() < launchedAt + reportAfterMs) return null;
      return { ...GOOD_REPORT, at: new Date(launchedAt + reportAfterMs).toISOString() };
    };
    h.lastReportAt = () => new Date(launchedAt + reportAfterMs).toISOString();
    return h;
  }

  test("a page that takes 35 s to load still gets to report", async () => {
    const h = slowReport(43_000);
    assert.equal((await runIosSim(h.ctx)).evaluation.passed, true);
  });

  test("the lab waits for the shell's 60 s watchdog, and gives up not long after", async () => {
    assert.equal((await runIosSim(slowReport(60_000).ctx)).evaluation.passed, true);
    const h = slowReport(90_000);
    const result = await runIosSim(h.ctx);
    assert.ok(result.evaluation.checks.some((c) => c.id === "no_timeout" && c.ok === false));
    assert.ok(h.ctx.now() - 1_000_000 < 90_000, "it stopped waiting before then");
  });

  test("a slow page gets its screenshots and the end of its recording after it reports", async () => {
    // Oct 31, on the real Mac: the report came 39 s after launch, the old schedule took its shots at 5 s and 9.5 s, and a
    // loaded page failed as blank.
    const h = slowReport(39_000);
    const shots = [];
    let stoppedAt = null;
    const exec = h.ctx.exec;
    h.ctx.exec = async (argv, opts) => {
      if (argv.includes("screenshot")) shots.push(h.ctx.now());
      return exec(argv, opts);
    };
    const startProc = h.ctx.startProc;
    h.ctx.startProc = (argv, opts) => {
      const proc = startProc(argv, opts);
      return { ...proc, stop: async () => ((stoppedAt = h.ctx.now()), proc.stop()) };
    };
    const compose = h.ctx.compose;
    let kept = null;
    h.ctx.compose = async (args) => ((kept = args.keepLastSeconds), compose(args));
    const launchAt = () => Date.parse(h.lastReportAt());
    const result = await runIosSim(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    assert.equal(shots.length, 2);
    for (const at of shots) assert.ok(at >= launchAt(), "a screenshot came before the report");
    assert.ok(stoppedAt >= shots.at(-1), "the recording stopped before the last screenshot");
    assert.equal(kept, 10, "the clip is the end of the recording, not its first seconds");
  });

  test("a launch that takes 16 s doesn't eat into the shell's 60 s watchdog", async () => {
    const h = makeCtx("ios_sim", { answer: unpackOnly });
    let opened = null;
    const exec = h.ctx.exec;
    h.ctx.exec = async (argv, opts) => {
      const reply = await exec(argv, opts);
      if (argv.includes("launch")) {
        await h.ctx.sleep(16_000);
        opened = h.ctx.now();
      }
      return reply;
    };
    h.ctx.fetchSelftest = async () => (opened !== null && h.ctx.now() >= opened + 60_000 ? { ...GOOD_REPORT, at: new Date(opened + 60_000).toISOString() } : null);
    assert.equal((await runIosSim(h.ctx)).evaluation.passed, true);
  });

  test("the wait for a report leaves the job time to finish", async () => {
    const h = makeCtx("ios_sim", { answer: unpackOnly, job: { input: { limitSeconds: 90 } } });
    const start = h.ctx.now();
    await runIosSim(h.ctx);
    assert.ok(h.ctx.now() - start < 40_000, String(h.ctx.now() - start));
  });

  test("the system log isn't read when the platform already has the report", async () => {
    const h = makeCtx("ios_sim", { platformReport: datedAfterLaunch, answer: unpackOnly });
    await runIosSim(h.ctx);
    assert.equal(h.ran(" log ").length, 0);
  });

  test("a slow launch gets 120 s, and a failed one says why in the job's log", async () => {
    const h = makeCtx("ios_sim", {
      answer: (argv, opts, reply) => {
        if (argv[0] === "tar") return mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true }), reply();
        if (argv.includes("launch")) {
          assert.equal(opts.timeoutMs, 120_000);
          return reply({ code: null, timedOut: true, stderr: "stuck" });
        }
        return undefined;
      },
    });
    await runIosSim(h.ctx);
    assert.match(h.lines.join("\n"), /simctl launch timed out: stuck/);
  });

  test("a job's device name goes in the caption and doesn't pick the simulator", async () => {
    let h;
    h = makeCtx("ios_sim", {
      job: { input: { device: { name: "iPhone 16" } } },
      deviceList: {
        [RUNTIME]: [
          { name: "iPhone 16", udid: "OTHER", isAvailable: true },
          { name: "Muse Lab iPhone", udid: UDID, isAvailable: true },
        ],
      },
      answer: extract(() => h),
    });
    const result = await runIosSim(h.ctx);
    assert.equal(h.ran("OTHER").length, 0);
    assert.ok(h.ran(`bootstatus ${UDID}`).length > 0);
    assert.equal(h.ran("simctl create").length, 0);
    assert.equal(result.device.name, "iPhone 16");
  });

  test("makes the simulator when it's missing", async () => {
    let h;
    const types = { devicetypes: [{ name: "iPhone 16", identifier: "type.iPhone-16" }] };
    const runtimes = { runtimes: [{ platform: "iOS", version: "18.4", identifier: RUNTIME }] };
    h = makeCtx("ios_sim", {
      deviceList: {},
      answer: (argv, opts, reply) => {
        const text = argv.join(" ");
        if (text.includes("list -j runtimes")) return reply({ stdout: JSON.stringify(runtimes) });
        if (text.includes("list -j devicetypes")) return reply({ stdout: JSON.stringify(types) });
        if (argv.includes("create")) return reply({ stdout: `${UDID}\n` });
        return extract(() => h)(argv, opts, reply);
      },
    });
    await runIosSim(h.ctx);
    assert.deepEqual(h.ran("simctl create")[0].slice(3), ["Muse Lab iPhone", "type.iPhone-16", RUNTIME]);
  });

  test("a simulator that won't boot is a lab problem, not the product's", async () => {
    const h = makeCtx("ios_sim", { answer: (argv, _o, reply) => (argv.includes("bootstatus") ? reply({ code: 1, stderr: "nope" }) : undefined) });
    await assert.rejects(runIosSim(h.ctx), (err) => err instanceof LabError && err.code === "simulator_failed");
    assert.match(h.lines.join("\n"), /nope/);
  });

  test("an app that won't launch fails the check", async () => {
    const h = makeCtx("ios_sim", {
      answer: (argv, _o, reply) => {
        if (argv[0] === "tar") return mkdirSync(path.join(argv.at(-1), "A.app"), { recursive: true }), reply();
        if (argv.includes("launch")) return reply({ code: 1, stderr: "no" });
        return undefined;
      },
    });
    const result = await runIosSim(h.ctx);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.checks.some((c) => c.id === "launched" && c.ok === false));
  });
});

describe("android_emu", () => {
  const ACTIVITY = "ai.musemuse.lab/.MainActivity";
  const android = ({ booted = true, report = GOOD_REPORT, am = "Status: ok\nTotalTime: 900\n", pid = "4242", crash = "" } = {}) => (argv, opts, reply) => {
    const text = argv.join(" ");
    if (argv[0] === "adb" && argv[1] === "devices") return reply({ stdout: `List of devices attached\n${booted ? "emulator-5554\tdevice\n" : ""}` });
    if (text.includes("sys.boot_completed")) return reply({ stdout: "1\n" });
    if (text.includes("ro.build.version.release")) return reply({ stdout: "15\n" });
    if (text.includes("resolve-activity")) return reply({ stdout: `priority=0\n${ACTIVITY}\n` });
    if (text.includes("am start")) return reply({ stdout: am });
    if (text.includes("-b crash")) return reply({ stdout: crash });
    if (text.includes("logcat -d")) return reply({ stdout: report ? `I ReactNativeJS: MUSE_SELFTEST ${JSON.stringify(report)}\nchromium: x\n` : "" });
    if (text.includes("pidof") && text.includes("screenrecord")) return reply({ stdout: "" });
    if (text.includes("pidof")) return reply({ stdout: pid });
    if (argv.includes("pull")) {
      writeFileSync(argv.at(-1), "mp4");
      return reply();
    }
    return undefined;
  };

  test("installs, records, opens by deep link and passes", async () => {
    const h = makeCtx("android_emu", { answer: android() });
    const result = await runAndroidEmu(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    h.order("uninstall", "install -r -g", "logcat -c", "am start", "screencap", "pkill -INT screenrecord", "pull");
    assert.equal(h.ran("uninstall").length, 2, "before the install and after the check");
    assert.equal(h.ran("pm clear").length, 0, "it would take back what install -g granted");
    assert.match(h.ran("am start")[0].join(" "), /musemuse-lab:\/\/check\?/);
    assert.ok(h.started.some((s) => s.argv.join(" ").includes("screenrecord")));
    assert.equal(h.ctx.composedCaption, "On an Android emulator (Pixel 7, Android 15)");
    assert.ok(result.files.some((f) => f.name === "logcat.txt"));
    assert.equal(result.facts.loadMs, GOOD_REPORT.loadMs);
  });

  test("what adb installs has a name ending in .apk", async () => {
    // Oct 31, on the real Mac: adb refused the download cache's file, which is named by its checksum, so every job failed.
    const h = makeCtx("android_emu", { answer: android() });
    h.ctx.download = async () => {
      const file = path.join(h.root, "087c17bc");
      writeFileSync(file, "the apk");
      return file;
    };
    await runAndroidEmu(h.ctx);
    const apk = h.ran("install -r -g")[0].at(-1);
    assert.match(apk, /\.apk$/);
    assert.equal(readFileSync(apk, "utf8"), "the apk");
  });

  test("the local adb is left alone until screenrecord has finished its file", async () => {
    // Oct 31, on the real Mac: stopping the local adb right after pkill ended the session, the device killed screenrecord
    // before it wrote the moov atom, and no clip could be made.
    const base = android();
    let stoppedAt = null;
    let pulledAt = null;
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => {
        const text = argv.join(" ");
        if (text.includes("pkill -INT screenrecord")) stoppedAt = h.ctx.now();
        if (text.includes("pidof") && text.includes("screenrecord")) return reply({ stdout: h.ctx.now() < stoppedAt + 2500 ? "777\n" : "" });
        if (argv.includes("pull")) pulledAt = h.ctx.now();
        return base(argv, opts, reply);
      },
    });
    let localStoppedAt = null;
    const startProc = h.ctx.startProc;
    h.ctx.startProc = (argv, opts) => {
      const proc = startProc(argv, opts);
      if (!argv.join(" ").includes("screenrecord")) return proc;
      return { ...proc, stop: async (ms) => ((localStoppedAt = h.ctx.now()), proc.stop(ms)) };
    };
    const result = await runAndroidEmu(h.ctx);
    assert.ok(localStoppedAt >= stoppedAt + 2500, `the local adb was stopped ${localStoppedAt - stoppedAt} ms after the stop, before screenrecord had gone`);
    assert.ok(pulledAt >= stoppedAt + 2500, `pulled ${pulledAt - stoppedAt} ms after the stop`);
    assert.ok(result.files.some((f) => f.role === "clip"));
    assert.ok(!h.lines.join("\n").includes("still running"));
  });

  test("a slow page gets its screenshots and the end of its recording after it reports", async () => {
    const base = android({ report: null });
    let launchedAt = null;
    const shots = [];
    let stopAt = null;
    let kept = null;
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => {
        const text = argv.join(" ");
        if (text.includes("am start")) launchedAt = h.ctx.now();
        if (text.includes("screencap")) shots.push(h.ctx.now());
        if (text.includes("pkill -INT screenrecord")) stopAt = h.ctx.now();
        if (text.includes("logcat -d") && !text.includes("-b crash") && launchedAt !== null && h.ctx.now() >= launchedAt + 39_000) {
          return reply({ stdout: `I ReactNativeJS: MUSE_SELFTEST ${JSON.stringify(GOOD_REPORT)}\n` });
        }
        return base(argv, opts, reply);
      },
    });
    const compose = h.ctx.compose;
    h.ctx.compose = async (args) => ((kept = args.keepLastSeconds), compose(args));
    const result = await runAndroidEmu(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    assert.equal(shots.length, 2);
    for (const at of shots) assert.ok(at >= launchedAt + 39_000, "a screenshot came before the report");
    assert.ok(stopAt >= shots.at(-1), "the recording stopped before the last screenshot");
    const limit = h.started.find((s) => s.argv.join(" ").includes("screenrecord")).argv;
    assert.match(limit.join(" "), /--time-limit 170\b/, "it has to outlast the wait, within screenrecord's 180 s");
    assert.equal(kept, 10);
  });

  test("a product APK with a slow page gets time to draw, and a blank one still fails", async () => {
    const flat = Buffer.alloc(128 * 8, 255);
    const drawAfter = (ms) => {
      let launchedAt = null;
      const base = android({ report: null });
      const h = makeCtx("android_emu", {
        job: { input: { app: { kind: "apk", variant: "product", version: "1", url: "https://a.public.blob.vercel-storage.com/p.apk", sha256: SHA, packageName: "ai.musemuse.p123" }, selftest: null } },
        answer: (argv, opts, reply) => {
          const text = argv.join(" ");
          if (text.includes("am start")) launchedAt = h.ctx.now();
          if (text.includes("rawvideo") && h.ctx.now() < launchedAt + ms) return reply({ stdout: flat });
          return base(argv, opts, reply);
        },
      });
      return h;
    };
    const slow = await runAndroidEmu(drawAfter(25_000).ctx);
    assert.equal(slow.evaluation.passed, true, JSON.stringify(slow.evaluation.reasons));
    const blank = await runAndroidEmu(drawAfter(900_000).ctx);
    assert.ok(blank.evaluation.checks.some((c) => c.id === "not_blank" && c.ok === false));
  });

  test("starts the emulator detached when it's down, so it outlives the job", async () => {
    let up = false;
    const base = android();
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => {
        if (argv[0] === "adb" && argv[1] === "devices") {
          const out = up ? "emulator-5554\tdevice\n" : "";
          up = true;
          return reply({ stdout: `List of devices attached\n${out}` });
        }
        return base(argv, opts, reply);
      },
    });
    await runAndroidEmu(h.ctx);
    const emulator = h.started.find((s) => s.argv[0] === "emulator");
    assert.equal(emulator.opts.detach, true);
    assert.ok(emulator.opts.logFile.endsWith("emulator.log"));
    assert.ok(emulator.argv.includes("mm_pixel"));
  });

  test("an emulator that never boots is a lab problem", async () => {
    const base = android();
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => (argv.join(" ").includes("sys.boot_completed") ? reply({ stdout: "" }) : base(argv, opts, reply)),
    });
    await assert.rejects(runAndroidEmu(h.ctx), (err) => err.code === "emulator_failed");
  });

  test("a crash in the crash buffer fails the check", async () => {
    const h = makeCtx("android_emu", { answer: android({ crash: "FATAL EXCEPTION: main\nProcess: ai.musemuse.lab, PID: 1\n" }) });
    const result = await runAndroidEmu(h.ctx);
    assert.ok(result.evaluation.checks.some((c) => c.id === "no_crash" && c.ok === false));
  });

  test("a process that's gone fails the check", async () => {
    const h = makeCtx("android_emu", { answer: android({ pid: "" }) });
    assert.ok((await runAndroidEmu(h.ctx)).evaluation.checks.some((c) => c.id === "no_crash" && c.ok === false));
  });

  describe("the bridge timing probe", () => {
    /** Plays the shell: loads the page from the deep link, runs its head script, then posts the report it would post. */
    const shell = ({ shimAfterMs }) => async (deepLink) => {
      const link = new URL(deepLink);
      const page = await (await fetch(link.searchParams.get("url"))).text();
      const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
      const window = {};
      const document = { title: "" };
      if (shimAfterMs === 0) window.MuseNative = {};
      else setTimeout(() => (window.MuseNative = {}), shimAfterMs);
      vm.runInNewContext(script, { window, document, setTimeout, Date, JSON });
      await new Promise((resolve) => setTimeout(resolve, shimAfterMs + 40));
      await fetch(`${link.searchParams.get("platform")}/api/native/selftest`, {
        method: "POST",
        body: JSON.stringify({ ...GOOD_REPORT, title: document.title }),
      });
    };
    /** The fake adb's am start, which runs `play` for the probe's launch only. */
    const withProbe = (play, base = android()) => (argv, opts, reply) => {
      const text = argv.join(" ");
      const url = /'(musemuse-lab:[^']+)'/.exec(text)?.[1];
      if (text.includes("am start") && url && new URL(url).searchParams.get("url").includes("10.0.2.2")) {
        // The page's own URL names the emulator's view of this machine, and the test runs on the machine itself.
        const here = url.replaceAll("10.0.2.2", "127.0.0.1");
        return play(here).then(() => reply({ stdout: "Status: ok\nTotalTime: 900\n" }));
      }
      return base(argv, opts, reply);
    };
    const note = (result) => result.evaluation.checks.find((c) => c.id === "bridge_timing");

    test("reports a late shim on the first run, as a note, then asks no more", async () => {
      const h = makeCtx("android_emu", { answer: withProbe(shell({ shimAfterMs: 20 })) });
      const result = await runAndroidEmu(h.ctx);
      assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
      assert.equal(note(result).ok, null);
      assert.match(note(result).detail, /wasn't there when the page's first script ran\. It showed up \d+ ms later\./);
      h.order("install -r -g", "10.0.2.2", "force-stop", "screencap");
      const probeLaunch = h.ran("am start")[0].join(" ");
      assert.match(probeLaunch, /selftest=1/);
      assert.ok(!probeLaunch.includes("muse-muse.vercel.app"), "its report stays on this machine");
      assert.ok(!probeLaunch.includes("token"));
      const saved = JSON.parse(readFileSync(path.join(h.ctx.config.dataDir, PROBE_FILE), "utf8"));
      assert.equal(saved.inHead, false);
      assert.equal(saved.detail, note(result).detail);

      const again = await runAndroidEmu(h.ctx);
      assert.equal(note(again), undefined);
      assert.equal(h.ran("10.0.2.2").length, 1);
    });

    test("reports a bridge that was there in time", async () => {
      const result = await runAndroidEmu(makeCtx("android_emu", { answer: withProbe(shell({ shimAfterMs: 0 })) }).ctx);
      assert.match(note(result).detail, /was there when the page's first script ran/);
    });

    test("falls back on the device log when the post is lost", async () => {
      const title = `${probePage().match(/<title>(.*?){}<\/title>/)[1]}${JSON.stringify({ inHead: false, seenMs: 12 })}`;
      const report = { ...GOOD_REPORT, title };
      const result = await runAndroidEmu(makeCtx("android_emu", { answer: android({ report }) }).ctx);
      assert.match(note(result).detail, /It showed up 12 ms later/);
    });

    test("no answer is a note that doesn't fail the job, and it tries again next time", async () => {
      const h = makeCtx("android_emu", { answer: android() });
      const result = await runAndroidEmu(h.ctx);
      assert.equal(result.evaluation.passed, true);
      assert.match(note(result).detail, /got no answer/);
      assert.equal(existsSync(path.join(h.ctx.config.dataDir, PROBE_FILE)), false);
      assert.ok(note(await runAndroidEmu(h.ctx)));
    });

    test("a lab shell that can't start for the probe doesn't change the job", async () => {
      const h = makeCtx("android_emu", { answer: withProbe(async () => { throw new Error("adb went away"); }) });
      const result = await runAndroidEmu(h.ctx);
      assert.equal(result.evaluation.passed, true);
      assert.match(note(result).detail, /got no answer/);
      assert.ok(h.lines.some((line) => line.includes("adb went away")));
    });

    test("leaves a product APK alone", async () => {
      const app = { kind: "apk", variant: "product", version: "1", url: "https://a.public.blob.vercel-storage.com/p.apk", sha256: SHA, packageName: "ai.musemuse.p123" };
      const h = makeCtx("android_emu", { answer: android({ report: null }), job: { input: { app, selftest: null } } });
      assert.equal(note(await runAndroidEmu(h.ctx)), undefined);
      assert.equal(h.ran("10.0.2.2").length, 0);
    });

    test("waits for the next job when this one is short of time", async () => {
      const h = makeCtx("android_emu", { answer: android(), job: { input: { limitSeconds: 200 } } });
      assert.equal(note(await runAndroidEmu(h.ctx)), undefined);
      assert.equal(h.ran("10.0.2.2").length, 0);
    });

    test("the page's head script is the first thing that runs, and it parses", () => {
      const page = probePage();
      assert.ok(page.indexOf("<script>") < page.indexOf("</head>"));
      assert.equal((page.match(/<script/g) ?? []).length, 1);
      assert.doesNotThrow(() => new Function(/<script>([\s\S]*?)<\/script>/.exec(page)[1]));
      assert.ok(!page.includes("\u2014"), "no em dashes");
    });

    test("reads only what the page's script wrote", () => {
      assert.equal(probeFromReport({ title: "A product" }), null);
      assert.equal(probeFromReport({}), null);
      assert.equal(probeFromReport(null), null);
    });
  });

  test("a package left by an aborted job doesn't stop the install", async () => {
    const base = android();
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => (argv.includes("uninstall") ? reply({ code: 1, stderr: "DELETE_FAILED_INTERNAL_ERROR" }) : base(argv, opts, reply)),
    });
    assert.equal((await runAndroidEmu(h.ctx)).evaluation.passed, true);
  });

  test("the platform's copy only counts if it's from this launch", async () => {
    const fresh = { ...GOOD_REPORT, at: new Date(2_000_000).toISOString() };
    const passed = makeCtx("android_emu", { answer: android({ report: null }), platformReport: fresh });
    assert.equal((await runAndroidEmu(passed.ctx)).evaluation.passed, true);
    const stale = makeCtx("android_emu", { answer: android({ report: null }), platformReport: { ...GOOD_REPORT, at: new Date(1000).toISOString() } });
    assert.ok((await runAndroidEmu(stale.ctx)).evaluation.checks.some((c) => c.id === "no_timeout" && c.ok === false));
  });

  test("a product APK gets no link and no report wait", async () => {
    const app = { kind: "apk", variant: "product", version: "1", url: "https://a.public.blob.vercel-storage.com/p.apk", sha256: SHA, packageName: "ai.musemuse.p123" };
    const h = makeCtx("android_emu", { answer: android({ report: null }), job: { input: { app, selftest: null } } });
    const result = await runAndroidEmu(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    assert.ok(!h.ran("am start")[0].join(" ").includes("musemuse-lab"));
    assert.equal(result.facts.loadMs, 900, "the launch time stands in");
  });

  test("an APK that won't install is a lab error with its own code", async () => {
    const base = android();
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => (argv.includes("install") ? reply({ code: 1, stderr: "INSTALL_FAILED" }) : base(argv, opts, reply)),
    });
    await assert.rejects(runAndroidEmu(h.ctx), (err) => err.code === "install_failed");
  });

  test("a recording that didn't come out is a warning", async () => {
    const base = android();
    const h = makeCtx("android_emu", {
      answer: (argv, opts, reply) => (argv.includes("pull") ? reply({ code: 1 }) : base(argv, opts, reply)),
    });
    const result = await runAndroidEmu(h.ctx);
    assert.equal(result.evaluation.passed, true);
    assert.ok(result.warnings.some((w) => /no clip/.test(w)));
  });
});

describe("desktop", () => {
  // Writes what native/shell-desktop/src/selftest.js writes, including frames and stills as counts in the report.
  function fakeApp({ report = { ...GOOD_REPORT, frames: 2, stills: 2, consoleErrors: [] }, frames = true, code = 0, timedOut = false, spawnError } = {}) {
    return (selftestDirOf) => (argv, reply) => {
      const dir = selftestDirOf(argv);
      if (report) {
        writeFileSync(path.join(dir, "selftest.json"), JSON.stringify(report));
        mkdirSync(path.join(dir, "stills"), { recursive: true });
        writeFileSync(path.join(dir, "stills", "01.png"), "png");
        writeFileSync(path.join(dir, "stills", "02.png"), "png");
      }
      if (frames) {
        mkdirSync(path.join(dir, "frames"), { recursive: true });
        writeFileSync(path.join(dir, "frames", "00001.jpg"), "f");
        writeFileSync(path.join(dir, "frames", "00002.jpg"), "f");
      }
      return reply({ code, timedOut, spawnError });
    };
  }
  const selftestDir = (argv) => argv.find((a) => a.startsWith("--muse-selftest=")).slice("--muse-selftest=".length);

  const mac = (app, { verifyCode = 0 } = {}) => (argv, _o, reply) => {
    if (argv[0] === "ditto") {
      mkdirSync(path.join(argv.at(-1), "Demo.app", "Contents", "MacOS"), { recursive: true });
      return reply();
    }
    if (argv[0] === "plutil") return reply({ stdout: "Demo\n" });
    if (argv[0] === "codesign") return reply({ code: verifyCode, stderr: "x" });
    if (argv[0] === "spctl") return reply({ code: 3, stderr: "rejected" });
    if (argv[0] === "sw_vers") return reply({ stdout: "15.5\n" });
    if (argv.some((a) => a.startsWith("--muse-selftest="))) return app(selftestDir)(argv, reply);
    if (argv.includes("concat")) {
      writeFileSync(argv.at(-1), "mp4");
      return reply();
    }
    return undefined;
  };

  test("a Mac app passes even though Gatekeeper rejects it", async () => {
    const h = makeCtx("desktop_mac", { answer: mac(fakeApp()) });
    const result = await runDesktopMac(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    assert.equal(result.facts.gatekeeperAccepted, false);
    h.order("ditto", "codesign", "spctl", "--muse-selftest");
    const app = h.ran("--muse-selftest")[0];
    assert.ok(app[0].endsWith("Demo.app/Contents/MacOS/Demo"));
    assert.equal(app.length, 2, "a product app opens its own site");
    assert.equal(h.ran("--sign -").length, 0, "a product app isn't signed again");
    assert.equal(h.ctx.composedCaption, "On a Mac in the AWS device lab (macOS 15.5)");
    assert.ok(result.files.some((f) => f.role === "clip"));
  });

  test("a bad signature fails it", async () => {
    const h = makeCtx("desktop_mac", { answer: mac(fakeApp(), { verifyCode: 1 }) });
    assert.ok((await runDesktopMac(h.ctx)).evaluation.reasons.includes("The app's signature didn't verify."));
  });

  test("a crash with no report fails it", async () => {
    const h = makeCtx("desktop_mac", { answer: mac(fakeApp({ report: null, frames: false, code: 139 })) });
    const result = await runDesktopMac(h.ctx);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.checks.some((c) => c.id === "no_crash" && c.ok === false));
    assert.ok(result.warnings.some((w) => /no clip/.test(w)));
  });

  test("an app that hangs fails it", async () => {
    const h = makeCtx("desktop_mac", { answer: mac(fakeApp({ report: null, frames: false, code: -1, timedOut: true })) });
    assert.ok((await runDesktopMac(h.ctx)).evaluation.checks.some((c) => c.id === "no_timeout" && c.ok === false));
  });

  test("a zip with no app is a lab problem", async () => {
    const h = makeCtx("desktop_mac", { answer: (argv, _o, reply) => (argv[0] === "ditto" ? reply() : undefined) });
    await assert.rejects(runDesktopMac(h.ctx), (err) => err.code === "install_failed");
  });

  test("a Windows app runs visibly, with no signature checks", async () => {
    const app = fakeApp();
    const h = makeCtx("desktop_windows", {
      lane: "windows",
      answer: (argv, opts, reply) => {
        if (argv[0] === "tar") {
          writeFileSync(path.join(argv.at(-1), "Demo.exe"), "x");
          writeFileSync(path.join(argv.at(-1), "Uninstall Demo.exe"), "x");
          return reply();
        }
        if (argv.some((a) => a.startsWith("--muse-selftest="))) {
          assert.equal(opts.windowsHide, false);
          return app(selftestDir)(argv, reply);
        }
        if (argv.includes("concat")) {
          writeFileSync(argv.at(-1), "mp4");
          return reply();
        }
        return undefined;
      },
    });
    const result = await runDesktopWindows(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    assert.equal(h.ran("codesign").length, 0);
    assert.ok(h.ran("--muse-selftest")[0][0].endsWith("Demo.exe"));
    assert.match(h.ctx.composedCaption, /^On Windows in the AWS device lab/);
  });

  test("the shell's exit 1 with a report isn't a crash: its own blank test knows nothing of canvas pages", async () => {
    const report = { ...GOOD_REPORT, ok: false, problems: ["The page looks blank."], textLength: 0, frames: 2, stills: 2 };
    const h = makeCtx("desktop_mac", { answer: mac(fakeApp({ report, code: 1 })) });
    const result = await runDesktopMac(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
  });

  test("a lab template is pointed at the job's URL, then signed again before it's checked", async () => {
    const app = { kind: "mac_zip", variant: "lab", version: "1", url: "https://a.public.blob.vercel-storage.com/m.zip", sha256: SHA };
    const base = mac(fakeApp());
    let configFile;
    const h = makeCtx("desktop_mac", {
      job: { input: { app } },
      answer: (argv, opts, reply) => {
        if (argv[0] === "ditto") {
          const resources = path.join(argv.at(-1), "Demo.app", "Contents", "Resources");
          mkdirSync(resources, { recursive: true });
          configFile = path.join(resources, "muse-product.json");
          writeFileSync(configFile, JSON.stringify({ name: "Template", url: "https://muse-muse.vercel.app/", shellVersion: "1.0.0" }));
        }
        return base(argv, opts, reply);
      },
    });
    const result = await runDesktopMac(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    h.order("--sign -", "--verify", "--muse-selftest");
    assert.ok(!h.ran("--muse-selftest")[0].some((a) => a.includes("vercel.app")), "the URL isn't an argument");
    assert.equal(h.ctx.input.target.url, `${ORIGIN}/`);
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).url, `${ORIGIN}/`);
  });

  test("pointAppAt keeps the rest of the settings, and needs the file to exist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-point-"));
    roots.push(dir);
    const file = path.join(dir, "muse-product.json");
    writeFileSync(file, JSON.stringify({ name: "Template", url: "https://old.example/", shellVersion: "1.0.0" }));
    await pointAppAt(file, "https://new.vercel.app/", "Demo");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { name: "Demo", url: "https://new.vercel.app/", shellVersion: "1.0.0" });
    await pointAppAt(file, "https://new.vercel.app/", "");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "Demo");
    await assert.rejects(pointAppAt(path.join(dir, "none.json"), "https://x.vercel.app/", "D"), (err) => err.code === "install_failed");
  });

  test("listFrames times frames by when they were written, since the names are only a count", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-frames-"));
    roots.push(dir);
    mkdirSync(path.join(dir, "frames"));
    for (const [name, seconds] of [["00001.jpg", 1000], ["00002.jpg", 1000.5], ["00003.jpg", 1004]]) {
      const file = path.join(dir, "frames", name);
      writeFileSync(file, "f");
      utimesSync(file, seconds, seconds);
    }
    writeFileSync(path.join(dir, "frames", "notes.txt"), "x");
    const frames = await listFrames(dir);
    assert.deepEqual(frames.map((f) => [path.basename(f.file), f.t]), [["00001.jpg", 0], ["00002.jpg", 500], ["00003.jpg", 4000]]);
    assert.deepEqual(await listFrames(path.join(dir, "none")), []);
  });

  test("listStills reads the folder in order", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-stills-"));
    roots.push(dir);
    mkdirSync(path.join(dir, "stills"));
    for (const name of ["02.png", "01.png", "x.txt"]) writeFileSync(path.join(dir, "stills", name), "s");
    assert.deepEqual((await listStills(dir)).map((p) => path.basename(p)), ["01.png", "02.png"]);
    assert.deepEqual(await listStills(path.join(dir, "none")), []);
  });

  test("findExe skips helpers, and takes a name when it's given", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-exe-"));
    roots.push(dir);
    for (const name of ["Uninstall Demo.exe", "elevate.exe", "Demo.exe"]) writeFileSync(path.join(dir, name), "x");
    assert.equal(path.basename(await findExe(dir)), "Demo.exe");
    assert.equal(path.basename(await findExe(dir, "ELEVATE.exe")), "elevate.exe");
    assert.equal(await findExe(dir, "other.exe"), null);
  });

  test("findAppBundle looks one folder down", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-app-"));
    roots.push(dir);
    mkdirSync(path.join(dir, "__MACOSX", "Fake.app"), { recursive: true });
    mkdirSync(path.join(dir, "build", "Real.app"), { recursive: true });
    assert.equal(path.basename(await findAppBundle(dir)), "Real.app");
  });
});

describe("glasses_sim", () => {
  const launchedAt = (ctx) => new Date(ctx.now()).toISOString();
  const lines = (ctx, steps) => steps.map(([step, detail]) => JSON.stringify({ step, ok: step !== "timeout" && step !== "error", detail, at: launchedAt(ctx) })).join("\n");
  const FULL = [["start"], ["connect", "mock"], ["primary"], ["result", "A red mug"]];

  function glasses(getH, { steps = FULL } = {}) {
    return (argv, _o, reply) => {
      const text = argv.join(" ");
      if (argv[0] === "tar") {
        mkdirSync(path.join(argv.at(-1), "Glasses.app"), { recursive: true });
        return reply();
      }
      const write = () => {
        const h = getH();
        writeFileSync(path.join(h.container, "Documents", "autopilot.jsonl"), lines(h.ctx, steps));
      };
      if (text.includes("-museRun")) write();
      return undefined;
    };
  }

  test("drives the autopilot by launch arguments and is informational", async () => {
    let h;
    h = makeCtx("glasses_sim", { answer: glasses(() => h) });
    const result = await runGlassesSim(h.ctx);
    assert.equal(result.evaluation.informational, true);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    h.order("privacy", "launch");
    assert.equal(h.ran("openurl").length, 0, "the system stops a link at a dialog nobody can answer");
    const launch = h.ran("launch")[0];
    assert.equal(launch[launch.indexOf("-museRun") + 1], "autopilot");
    assert.equal(launch[launch.indexOf("-museMock") + 1], "1");
    assert.equal(launch[launch.indexOf("-museUrl") + 1], `${ORIGIN}/`);
    assert.match(h.ctx.composedCaption, /simulated Meta glasses/);
  });

  test("makes the H.265 feed from the photo when the job has no feed", async () => {
    let h;
    h = makeCtx("glasses_sim", { answer: glasses(() => h) });
    await runGlassesSim(h.ctx);
    const feed = h.ran("libx265")[0];
    assert.equal(path.basename(feed.at(-1)), MOCK_FEED);
    assert.ok(existsSync(path.join(h.container, "Documents", MOCK_PHOTO)), "the photo is where the shell looks");
  });

  /** The first checkpoint lands this long after the launch, as it does when the page has loaded. */
  function slowLoad(loadMs) {
    let h;
    let launchedAt = null;
    h = makeCtx("glasses_sim", {
      answer: (argv, _o, reply) => {
        if (argv[0] === "tar") {
          mkdirSync(path.join(argv.at(-1), "Glasses.app"), { recursive: true });
          return reply();
        }
        if (argv.join(" ").includes("-museRun")) launchedAt = h.ctx.now();
        return undefined;
      },
    });
    const sleep = h.ctx.sleep;
    h.ctx.sleep = async (ms) => {
      await sleep(ms);
      if (launchedAt === null || h.ctx.now() < launchedAt + loadMs) return;
      const at = (offset) => new Date(launchedAt + loadMs + offset).toISOString();
      const steps = [["start"], ["connect", "mock"], ["primary"], ["result", "A red mug"]];
      const text = steps.map(([step, detail], i) => JSON.stringify({ step, ok: true, detail, at: at(i) })).join("\n");
      writeFileSync(path.join(h.container, "Documents", "autopilot.jsonl"), text);
    };
    return h;
  }

  test("a page that takes 45 s to load still passes", async () => {
    const result = await runGlassesSim(slowLoad(45_000).ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
    assert.ok(result.evaluation.loadMs <= 46_000, String(result.evaluation.loadMs));
  });

  test("a launch that hits its limit says so in the job's log", async () => {
    // Oct 31, on the real Mac: simctl launch ran past its old 45 s and the reason was thrown away.
    const h = makeCtx("glasses_sim", {
      answer: (argv, opts, reply) => {
        if (argv[0] === "tar") return mkdirSync(path.join(argv.at(-1), "Glasses.app"), { recursive: true }), reply();
        if (argv.includes("launch")) {
          assert.equal(opts.timeoutMs, 120_000);
          return reply({ code: null, timedOut: true, stderr: "stuck" });
        }
        return undefined;
      },
    });
    const result = await runGlassesSim(h.ctx);
    assert.ok(result.evaluation.checks.some((c) => c.id === "launched" && c.ok === false));
    assert.match(h.lines.join("\n"), /simctl launch timed out: stuck/);
  });

  test("a launch that takes 50 s doesn't count against the page's 60 s", async () => {
    const h = slowLoad(30_000);
    const exec = h.ctx.exec;
    h.ctx.exec = async (argv, opts) => {
      const reply = await exec(argv, opts);
      if (argv.includes("launch")) await h.ctx.sleep(50_000);
      return reply;
    };
    const result = await runGlassesSim(h.ctx);
    assert.equal(result.evaluation.passed, true, JSON.stringify(result.evaluation.reasons));
  });

  test("the clip keeps the end of the run, where the result is", async () => {
    let h;
    h = makeCtx("glasses_sim", { answer: glasses(() => h) });
    let kept = null;
    const compose = h.ctx.compose;
    h.ctx.compose = async (args) => ((kept = args.keepLastSeconds), compose(args));
    await runGlassesSim(h.ctx);
    assert.equal(kept, 25);
  });

  test("a new install settles for 5 s before the first launch", async () => {
    let h;
    h = makeCtx("glasses_sim", { answer: glasses(() => h) });
    const pauses = [];
    const sleep = h.ctx.sleep;
    const exec = h.ctx.exec;
    let installed = false;
    let launched = false;
    h.ctx.exec = async (argv, opts) => {
      if (argv.includes("install")) installed = true;
      if (argv.includes("launch")) launched = true;
      return exec(argv, opts);
    };
    h.ctx.sleep = async (ms) => {
      if (installed && !launched) pauses.push(ms);
      return sleep(ms);
    };
    await runGlassesSim(h.ctx);
    assert.ok(pauses.includes(5000), JSON.stringify(pauses));
  });

  test("an autopilot that times out fails with its reason", async () => {
    let h;
    h = makeCtx("glasses_sim", { answer: glasses(() => h, { steps: [["start"], ["timeout", "timeout: glasses are connecting"]] }) });
    const result = await runGlassesSim(h.ctx);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.reasons.some((r) => r.includes("glasses are connecting")));
  });

  test("an autopilot that never ends stops at the limit and fails", async () => {
    let h;
    h = makeCtx("glasses_sim", { answer: glasses(() => h, { steps: [["start"]] }) });
    const result = await runGlassesSim(h.ctx);
    assert.equal(result.evaluation.passed, false);
    assert.ok(result.evaluation.checks.some((c) => c.id === "no_timeout" && c.ok === false));
  });
});

describe("the small pieces", () => {
  test("shotSchedule spreads shots out and ends just before the recording does", () => {
    assert.deepEqual(shotSchedule(2, 10), [5000, 9500]);
    assert.deepEqual(shotSchedule(1, 10), [9500]);
  });
  test("contentTypeOf", () => {
    assert.equal(contentTypeOf("a.mp4"), "video/mp4");
    assert.equal(contentTypeOf("a.JPG"), "image/jpeg");
    assert.equal(contentTypeOf("a.bin"), "application/octet-stream");
  });
});
