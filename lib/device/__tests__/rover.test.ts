/**
 * The rover's setup against a fake control plane and board (rover-fakes.ts): the kit packs from the repo's files, goes as
 * exec jobs no longer than the fleet takes, each job is polled until it ends, setup-rover.sh's report is read from its
 * marked line, and the board's token comes back only sealed, opens here, and is kept. Nothing here has reached a real
 * control plane or board.
 *
 *   npx tsx --test lib/device/__tests__/rover.test.ts
 */
import assert from "node:assert/strict";
import { getDiffieHellman } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  KIT_ENTRY,
  lastRoverReport,
  MAX_COMMAND_CHARS,
  openSealedToken,
  overrideFlags,
  packRoverKit,
  parseRoverReport,
  REPORT_MARKER,
  resetRover,
  roverBoard,
  RoverBusyError,
  RoverError,
  RoverKitError,
  RoverNotConfiguredError,
  roverSetupState,
  roverToken,
  roverTokenHeld,
  SETUP_TIMEOUT_S,
  setupCommands,
  setupRover,
  tokenCommand,
} from "@/lib/device/rover";
import { DRIVE_MS, rangesOf, roverCall, RoverInputError, wonderDrive, wonderLook } from "@/lib/device/rover-tools";
import { BOARD_TOKEN, FLEET_TOKEN, FLEET_URL, fakeFleet, kitFrom, REPORT, sealLikeTheBoard, type FakeFleet } from "./rover-fakes";

const BOARD = "ArduinoQ-01";
const asJobs = (commands: string[]) => commands.map((command, i) => ({ id: `jb_${i}`, command, timeoutS: 1, reads: 0 }));

/** A stand-in muse-device/ folder: a server big enough to need parts, and a rover folder with things to leave behind. */
async function fakeKit(serverBytes = 60_000): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rover-kit-"));
  // Varied text, so it doesn't gzip to nothing.
  let server = "#!/usr/bin/env python3\n";
  for (let i = 0; server.length < serverBytes; i++) server += `# line ${i} ${Math.sin(i).toString(36)} ${(i * 7919).toString(36)}\n`;
  await fs.writeFile(path.join(dir, "server.py"), server);
  await fs.writeFile(path.join(dir, "autostart.sh"), "#!/bin/bash\nexit 0\n");
  await fs.mkdir(path.join(dir, "rover", "app", "sketch"), { recursive: true });
  await fs.mkdir(path.join(dir, "rover", "__pycache__"));
  await fs.mkdir(path.join(dir, "rover", "host_check", "zephyr"), { recursive: true });
  await fs.writeFile(path.join(dir, KIT_ENTRY), "#!/bin/bash\necho hi\n");
  await fs.writeFile(path.join(dir, "rover", "app", "sketch", "sketch.ino"), "void setup() {}\n");
  await fs.writeFile(path.join(dir, "rover", "logo.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(dir, "rover", "__pycache__", "x.pyc"), "junk");
  await fs.writeFile(path.join(dir, "rover", ".env"), "SECRET=1");
  await fs.writeFile(path.join(dir, "rover", "host_check", "sketch_sim.cpp"), "int main() {}\n");
  await fs.writeFile(path.join(dir, "rover", "host_check", "zephyr", "kernel.h"), "#pragma once\n");
  return dir;
}

describe("the rover's setup", () => {
  let fleet: FakeFleet;
  let kitDir: string;
  let clock = 0;
  const deps = () => ({ doFetch: fleet.doFetch, kitDir, sleep: async (ms: number) => void (clock += ms), now: () => clock });

  beforeEach(async () => {
    resetRover();
    clock = 1_000_000;
    fleet = fakeFleet();
    kitDir = await fakeKit();
    process.env.BOARD_FLEET_URL = FLEET_URL;
    process.env.BOARD_FLEET_TOKEN = FLEET_TOKEN;
  });

  afterEach(() => {
    delete process.env.BOARD_FLEET_URL;
    delete process.env.BOARD_FLEET_TOKEN;
    delete process.env.ROVER_BOARD;
  });

  it("packs server.py, autostart.sh and the rover folder, and none of the leftovers", async () => {
    const { parts, install } = setupCommands(await packRoverKit({ kitDir }));
    const files = kitFrom(asJobs([...parts, install]));
    assert.deepEqual(files.map((f) => f.path), ["server.py", "autostart.sh", "rover/app/sketch/sketch.ino", "rover/logo.bin", KIT_ENTRY]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.equal(byPath[KIT_ENTRY]!.mode, 0o755);
    assert.equal(byPath["rover/app/sketch/sketch.ino"]!.mode, 0o644);
    assert.equal(byPath["rover/logo.bin"]!.text, undefined);
  });

  it("packs the real kit in this repo, when it's there, into parts that fit", async (t) => {
    const real = path.join(process.cwd(), "muse-device");
    const kit = await packRoverKit({ kitDir: real }).catch((err) => {
      if (err instanceof RoverKitError) return null;
      throw err;
    });
    if (!kit) return t.skip("muse-device/rover isn't in this checkout yet");
    const { parts, install } = setupCommands(kit);
    for (const command of [...parts, install]) assert.ok(command.length <= MAX_COMMAND_CHARS, `${command.length}`);
    const files = kitFrom(asJobs([...parts, install]));
    assert.ok(files.some((f) => f.path === KIT_ENTRY));
    assert.ok(!files.some((f) => f.path.startsWith("rover/host_check/")), "the host check stays behind");
    assert.equal(files.find((f) => f.path === "server.py")!.text, await fs.readFile(path.join(real, "server.py"), "utf8"));
  });

  it("won't send a kit without its installer", async () => {
    await fs.rm(path.join(kitDir, KIT_ENTRY));
    await assert.rejects(packRoverKit({ kitDir }), RoverKitError);
    await assert.rejects(setupRover(BOARD, {}, deps()), RoverKitError);
    assert.equal(fleet.jobs.length, 0);
  });

  it("splits a kit too large for one exec into parts that each fit, and checks it whole before running anything", async () => {
    const kit = await packRoverKit({ kitDir });
    const { parts, install } = setupCommands(kit, ["--pin", "pwma=D5"]);
    assert.ok(kit.base64.length > MAX_COMMAND_CHARS);
    assert.ok(parts.length >= 2);
    for (const command of [...parts, install]) assert.ok(command.length <= MAX_COMMAND_CHARS, `${command.length}`);
    assert.equal(parts.map((p) => p.match(/printf %s '([^']+)'/)![1]).join(""), kit.base64);
    parts.forEach((p, i) => assert.match(p, new RegExp(`part-${String(i + 1).padStart(3, "0")}$`)));
    // In a folder only root can write, which the board's user can read, since setup-rover.sh copies from it as that user.
    assert.match(parts[0]!, /install -d -m 755 \/run\/mm-rover-kit/);
    // The sha256 is checked before the unpacker or the installer runs, and the installer gets the setup's flags.
    const check = install.indexOf("sha256sum -c");
    assert.ok(check > 0 && check < install.indexOf("python3") && install.indexOf("python3") < install.indexOf(KIT_ENTRY));
    assert.ok(install.includes(kit.sha256));
    assert.match(install, /flock -n 9/);
    assert.match(install, new RegExp(`MUSE_ROVER_USER='arduino' bash "\\$d/kit/${KIT_ENTRY}" '--pin' 'pwma=D5' 9>&-$`));
  });

  it("sends a small kit as one exec", async () => {
    const small = await fakeKit(100);
    const { parts, install } = setupCommands(await packRoverKit({ kitDir: small }));
    assert.deepEqual(parts, []);
    assert.match(install, /<<'KIT'\n/);
    assert.ok(install.length <= MAX_COMMAND_CHARS);
  });

  it("sends each part, then the install, as exec jobs on the rover's node, polling each until it ends", async () => {
    const state = await setupRover(BOARD, { pins: { servo_pan: "D9" }, stopMm: 200 }, deps());
    assert.equal(state.state, "done");

    const kinds = fleet.jobs.map((job) => job.command.split("\n")[0]!.split(" ")[1]);
    assert.deepEqual(kinds, [...Array(kinds.length - 2).fill("mm-rover-kit"), "mm-rover-setup", "mm-rover-token"]);
    const setup = fleet.jobs.at(-2)!;
    assert.equal(setup.timeoutS, SETUP_TIMEOUT_S);
    assert.match(setup.command, /'--pin' 'servo_pan=D9' '--stop-mm' '200' 9>&-$/);
    // Every job was read until it said it ended, and only ever through the fleet's own address with its token.
    assert.ok(fleet.jobs.every((job) => job.reads === fleet.readsRunning + 1));
    const posts = fleet.requests.filter((r) => r.method === "POST");
    assert.ok(posts.every((r) => r.path === "/api/nodes/nd_rover/actions"));
    assert.ok(fleet.requests.every((r) => r.authorization === `Bearer ${FLEET_TOKEN}` && r.redirect === "error"));

    // The report is kept, and so is the token, read once after the setup.
    assert.deepEqual(lastRoverReport(BOARD)?.report, state.state === "done" ? state.report : null);
    assert.equal(roverTokenHeld(BOARD), true);
    const execs = fleet.jobs.length;
    assert.equal(await roverToken(BOARD, deps()), BOARD_TOKEN);
    assert.equal(fleet.jobs.length, execs);
  });

  it("never puts the token in a command, and the board never prints it", async () => {
    await setupRover(BOARD, {}, deps());
    for (const job of fleet.jobs) {
      assert.ok(!job.command.includes(BOARD_TOKEN));
      assert.ok(!fleet.board(job.command).output.includes(BOARD_TOKEN), job.command.split("\n")[0]);
    }
  });

  it("hands back a setup still running at its deadline, with its last step, for roverSetupState to follow", async () => {
    fleet.readsRunning = 3;
    const state = await setupRover(BOARD, {}, { ...deps(), sleep: async () => {} }, { until: clock });
    assert.equal(state.state, "running");
    assert.equal(state.state === "running" && state.step, "groups: ok");
    await assert.rejects(setupRover(BOARD, {}, deps()), RoverBusyError);

    const job = state.job!;
    let next = await roverSetupState(BOARD, job, deps());
    while (next.state === "running") next = await roverSetupState(BOARD, job, deps());
    assert.equal(next.state, "done");
    // Followed to its end, it no longer holds the rover.
    assert.equal((await setupRover(BOARD, {}, deps())).state, "done");
  });

  it("reads only jobs that are rover setups", async () => {
    await setupRover(BOARD, {}, deps());
    const part = fleet.jobs.find((job) => job.command.startsWith("# mm-rover-kit "))!;
    await assert.rejects(roverSetupState(BOARD, part.id, deps()), /isn't a rover setup/);
    await assert.rejects(roverSetupState(BOARD, "../nodes", deps()), RoverError);
  });

  it("stops at a part that fails, before anything runs", async () => {
    fleet.board = (command) => (command.includes("part 2 of") ? { output: "No space left on device\n", exit: 1 } : { output: "", exit: 0 });
    await assert.rejects(setupRover(BOARD, {}, deps()), /Part 2 of \d+ of the kit exited 1\.\nNo space left on device/);
    assert.ok(!fleet.jobs.some((job) => job.command.startsWith("# mm-rover-setup ")));
    // And the rover isn't held by the setup that failed.
    fleet.board = fakeFleet().board;
    assert.equal((await setupRover(BOARD, {}, deps())).state, "done");
  });

  it("says why a setup failed without a report, with its last lines and no links", async () => {
    fleet.board = (command) =>
      command.startsWith("# mm-rover-setup ")
        ? { output: "sha256sum: WARNING: 1 computed checksum did NOT match\nsee https://user:pw@mirror.example.com/core\n", exit: 1 }
        : { output: "", exit: 0 };
    const state = await setupRover(BOARD, {}, deps());
    assert.equal(state.state, "failed");
    const message = state.state === "failed" ? state.message : "";
    assert.match(message, /^The setup exited 1\./);
    assert.match(message, /did NOT match/);
    assert.doesNotMatch(message, /mirror\.example|user:pw/);
  });

  it("keeps a report that says what failed, and isn't ok when the setup didn't exit 0", async () => {
    const failed = { ok: false, steps: { tools: "ok", app: "arduino-app-cli couldn't start user:muse-rover: no space" }, self_test: null };
    fleet.board = (command) => (command.startsWith("# mm-rover-setup ") ? { output: `app:         no\n${REPORT_MARKER}${JSON.stringify(failed)}\n`, exit: 1 } : fakeFleet().board(command));
    const state = await setupRover(BOARD, {}, deps());
    assert.equal(state.state, "done");
    assert.deepEqual(state.state === "done" && state.report, {
      ok: false,
      checks: [
        { part: "setup", name: "tools", ok: true, detail: null },
        { part: "setup", name: "app", ok: false, detail: "arduino-app-cli couldn't start user:muse-rover: no space" },
      ],
      ranges: null,
    });
  });

  it("names a timeout, a board that went offline, and one that refused exec", async () => {
    for (const [done, expected] of [
      [{ output: "", exit: null, status: "timeout", error: "timeout" }, /ran out of time/],
      [{ output: "", exit: null, status: "offline", error: "node went offline" }, /went offline/],
      [{ output: "", exit: null, status: "failed", error: "capability disabled: exec" }, /refused the setup: capability disabled: exec/],
    ] as const) {
      resetRover();
      fleet = fakeFleet();
      fleet.board = (command) => (command.startsWith("# mm-rover-setup ") ? { ...done } : { output: "", exit: 0 });
      const state = await setupRover(BOARD, {}, deps());
      assert.equal(state.state, "failed");
      assert.match(state.state === "failed" ? state.message : "", expected);
    }
  });

  it("refuses a board that isn't online or isn't there, and a fleet token without exec", async () => {
    fleet.online = false;
    await assert.rejects(setupRover(BOARD, {}, deps()), /isn't online/);
    await assert.rejects(setupRover("jetson-99", {}, deps()), /no board named jetson-99/);
    await assert.rejects(setupRover("bad name; rm -rf /", {}, deps()), /isn't a board name/);
    fleet.status = 403;
    await assert.rejects(setupRover(BOARD, {}, deps()), /admin role/);
    assert.equal(fleet.jobs.length, 0);
  });

  it("refuses changes it can't make, before anything is sent", async () => {
    await assert.rejects(setupRover(BOARD, { pins: { pwma: "D4" } }, deps()), RoverInputError);
    assert.equal(fleet.requests.length, 0);
  });

  it("says the fleet isn't set up, without calling anything", async () => {
    delete process.env.BOARD_FLEET_TOKEN;
    await assert.rejects(setupRover(BOARD, {}, deps()), RoverNotConfiguredError);
    process.env.BOARD_FLEET_TOKEN = FLEET_TOKEN;
    process.env.BOARD_FLEET_URL = "http://fleet.example.com/admin";
    await assert.rejects(roverToken(BOARD, deps()), RoverNotConfiguredError);
    assert.equal(fleet.requests.length, 0);
  });

  it("takes the board from ROVER_BOARD, and only a board name", () => {
    assert.equal(roverBoard(), BOARD);
    process.env.ROVER_BOARD = "rover-2";
    assert.equal(roverBoard(), "rover-2");
    process.env.ROVER_BOARD = "rover 2/../x";
    assert.throws(() => roverBoard(), RoverError);
  });
});

describe("the rover's token", () => {
  let fleet: FakeFleet;
  let clock = 0;
  const deps = () => ({ doFetch: fleet.doFetch, sleep: async () => {}, now: () => clock });

  beforeEach(() => {
    resetRover();
    clock = 5_000_000;
    fleet = fakeFleet();
    process.env.BOARD_FLEET_URL = FLEET_URL;
    process.env.BOARD_FLEET_TOKEN = FLEET_TOKEN;
  });

  afterEach(() => {
    delete process.env.BOARD_FLEET_URL;
    delete process.env.BOARD_FLEET_TOKEN;
  });

  it("opens what the board sealed to this read's key, and nothing else does", () => {
    const sealer = getDiffieHellman("modp14");
    sealer.generateKeys();
    const command = tokenCommand(sealer);
    const sealed = sealLikeTheBoard(command, BOARD_TOKEN);
    assert.ok(!sealed.includes(BOARD_TOKEN));
    assert.equal(openSealedToken(sealed, sealer), BOARD_TOKEN);

    const other = getDiffieHellman("modp14");
    other.generateKeys();
    assert.throws(() => openSealedToken(sealed, other), /didn't open/);
    const line = JSON.parse(sealed.slice("MUSE_ROVER_SEALED ".length)) as { b: string; c: string; m: string };
    const flipped = `MUSE_ROVER_SEALED ${JSON.stringify({ ...line, c: (line.c[0] === "0" ? "1" : "0") + line.c.slice(1) })}`;
    assert.throws(() => openSealedToken(flipped, sealer), /didn't open/);
    assert.throws(() => openSealedToken(`MUSE_ROVER_SEALED ${JSON.stringify({ ...line, b: "1" })}`, sealer), /didn't open/);
    assert.throws(() => openSealedToken("Traceback: no token\n", sealer), /didn't send its token/);
  });

  it("reads once through the fleet, shares one read between callers, and keeps it", async () => {
    const [a, b] = await Promise.all([roverToken(BOARD, deps()), roverToken(BOARD, deps())]);
    assert.equal(a, BOARD_TOKEN);
    assert.equal(b, BOARD_TOKEN);
    assert.equal(await roverToken(BOARD, deps()), BOARD_TOKEN);
    assert.equal(fleet.jobs.length, 1);
    assert.match(fleet.jobs[0]!.command, /^# mm-rover-token\npython3 -I -c /);
  });

  it("doesn't read again soon after a read that failed", async () => {
    fleet.board = () => ({ output: "The tool server has not made its token yet.\n", exit: 1 });
    await assert.rejects(roverToken(BOARD, deps()), /has not made its token yet/);
    await assert.rejects(roverToken(BOARD, deps()), /has not made its token yet/);
    assert.equal(fleet.jobs.length, 1);
    clock += 61_000;
    fleet.board = fakeFleet().board;
    assert.equal(await roverToken(BOARD, deps()), BOARD_TOKEN);
    assert.equal(fleet.jobs.length, 2);
  });

  it("is kept per fleet address, so a new fleet reads it again", async () => {
    await roverToken(BOARD, deps());
    process.env.BOARD_FLEET_URL = "https://other-fleet.example.com/admin";
    assert.equal(roverTokenHeld(BOARD), false);
    await roverToken(BOARD, deps());
    assert.equal(fleet.jobs.length, 2);
  });
});

describe("setup-rover.sh's report", () => {
  const line = (value: unknown) => `${REPORT_MARKER}${JSON.stringify(value)}`;

  it("reads the last marked line: the setup's steps, then the self-test's checks, and the ranges it saw", () => {
    const output = ["tools:       ok", line({ ok: false, steps: {} }), "more", line(REPORT), "done"].join("\n");
    assert.deepEqual(parseRoverReport(output, 0), {
      ok: true,
      checks: [
        { part: "setup", name: "tools", ok: true, detail: null },
        { part: "setup", name: "config", ok: true, detail: null },
        { part: "setup", name: "packages", ok: true, detail: "skipped: already there" },
        { part: "setup", name: "app", ok: true, detail: null },
        { part: "setup", name: "server", ok: true, detail: null },
        { part: "setup", name: "self_test", ok: true, detail: null },
        { part: "test", name: "server", ok: true, detail: null },
        { part: "test", name: "sketch", ok: true, detail: null },
        { part: "test", name: "ranges", ok: true, detail: null },
        { part: "test", name: "left_wheel", ok: true, detail: "ok, 41 ticks" },
        { part: "test", name: "photo", ok: true, detail: "skipped: no camera is attached" },
      ],
      ranges: { front: 412, left: null, right: 233, clear: ["left"] },
    });
  });

  it("isn't ok when a step or check failed, the board or the test said so, or the setup didn't exit 0", () => {
    assert.equal(parseRoverReport(line({ ok: true, steps: { a: "ok", b: "couldn't add arduino to video" } }), 0)?.ok, false);
    assert.equal(parseRoverReport(line({ ok: false, steps: { a: "ok" } }), 0)?.ok, false);
    assert.equal(parseRoverReport(line({ ok: true, steps: { a: "ok" }, self_test: { ok: false, checks: {} } }), 0)?.ok, false);
    assert.equal(parseRoverReport(line({ ok: true, steps: { a: "ok" } }), 1)?.ok, false);
    assert.equal(parseRoverReport(line({ ok: true, steps: {} }), 0)?.ok, false);
    assert.equal(parseRoverReport(line({ ok: true, steps: { a: "ok" } }), 0)?.ok, true);
  });

  it("is null without a marked JSON object", () => {
    for (const output of ["", "all good", `${REPORT_MARKER}not json`, `${REPORT_MARKER}[1,2]`, ` ${REPORT_MARKER}{"ok":true}`]) {
      assert.equal(parseRoverReport(output), null, output);
    }
  });

  it("keeps only what's safe to show, and no more of it than fits", () => {
    const steps = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, `ok ${"x".repeat(1000)}`]));
    const report = parseRoverReport(
      line({ ok: true, steps: { ...steps, odd: 5, empty: "  " }, self_test: { ok: true, checks: { note: `see https://fleet.example.com/admin/device/x with ${BOARD_TOKEN}` } } }),
      0,
      BOARD_TOKEN,
    )!;
    assert.equal(report.checks.length, 40);
    assert.equal(report.checks[0]!.detail!.length, 300);
    assert.ok(!JSON.stringify(report).includes(BOARD_TOKEN));
    const few = parseRoverReport(line({ ok: true, steps: { a: "ok" }, self_test: { ok: true, checks: { note: `see https://fleet.example.com/x with ${BOARD_TOKEN}` } } }), 0, BOARD_TOKEN)!;
    assert.equal(few.checks[1]!.detail, "see [link] with [token]");
  });
});

describe("the rover's limits", () => {
  it("turns a direction from the pad into both wheels, fills in a short drive, and doesn't wait for it to end", () => {
    assert.deepEqual(roverCall({ action: "drive", direction: "forward" }), { tool: "rover_drive", args: { left: 153, right: 153, ms: DRIVE_MS.default, wait: false } });
    assert.deepEqual(roverCall({ action: "drive", direction: "back", speed: 100, ms: 2000 }).args, { left: -255, right: -255, ms: 2000, wait: false });
    assert.deepEqual(roverCall({ action: "drive", direction: "left", speed: 40 }).args, { left: -102, right: 102, ms: DRIVE_MS.default, wait: false });
    assert.deepEqual(roverCall({ action: "drive", direction: "right", speed: 40 }).args, { left: 102, right: -102, ms: DRIVE_MS.default, wait: false });
  });

  it("refuses a drive or a look past the limits, and anything that isn't one of the rover's tools", () => {
    for (const bad of [
      { action: "drive", direction: "up" },
      { action: "drive", direction: "forward", ms: 2001 },
      { action: "drive", direction: "forward", ms: 10 },
      { action: "drive", direction: "forward", ms: 300.5 },
      { action: "drive", direction: "forward", speed: 0 },
      { action: "drive", direction: "forward", speed: 101 },
      { action: "drive", direction: "forward", speed: "fast" },
      { action: "look" },
      { action: "look", pan: 91 },
      { action: "look", tilt: -100 },
      { action: "fly" },
      { action: "toString" },
      {},
    ]) {
      assert.throws(() => roverCall(bad), RoverInputError, JSON.stringify(bad));
    }
  });

  it("passes only what each tool takes", () => {
    assert.deepEqual(roverCall({ action: "look", pan: -30, tilt: 10, ms: 5 }), { tool: "rover_look", args: { pan: -30, tilt: 10 } });
    assert.deepEqual(roverCall({ action: "stop", direction: "forward" }), { tool: "rover_stop", args: {} });
    assert.deepEqual(roverCall({ action: "ranges" }), { tool: "rover_ranges", args: {} });
    assert.deepEqual(roverCall({ action: "status" }), { tool: "rover_status", args: {} });
    assert.deepEqual(roverCall({ action: "photo", width: 1920 }), { tool: "rover_photo", args: { width: 640, height: 480 } });
  });

  it("holds Wonder to a short, slower drive that waits, and fills in how long", () => {
    assert.deepEqual(wonderDrive({ left: 100, right: -100 }), { left: 100, right: -100, ms: 500, wait: true });
    assert.deepEqual(wonderDrive({ left: 160, right: 160, ms: 1000, wait: false }), { left: 160, right: 160, ms: 1000, wait: true });
    for (const bad of [{ left: 200, right: 100 }, { left: 100, right: -161 }, { left: 100, right: 100, ms: 1500 }, { left: 100 }, { left: "fast", right: 1 }]) {
      assert.throws(() => wonderDrive(bad), /drive pad/, JSON.stringify(bad));
    }
    assert.deepEqual(wonderLook({ pan: 45 }), { pan: 45 });
    assert.throws(() => wonderLook({}), RoverInputError);
  });

  it("reads the server's ranges, and not a drive's wheel speeds", () => {
    assert.deepEqual(rangesOf({ front_mm: 10, left_mm: null, right_mm: 20, sensors: { front: "ok", left: "missing", right: "ok" } }), { front: 10, left: null, right: 20, clear: [] });
    assert.equal(rangesOf({ left: 153, right: 153, ms: 400 }), null);
    assert.equal(rangesOf("front 10"), null);
  });

  it("turns a setup's changes into setup-rover.sh's flags, checking roles, pins, PWM and the stop distance", () => {
    assert.deepEqual(overrideFlags({ pins: { pwma: "D5", stby: "A0", servo_pan: "D9" }, stopMm: 120, invert: ["left", "left", "tilt"], reset: true }), [
      "--reset",
      "--pin",
      "pwma=D5",
      "--pin",
      "stby=A0",
      "--pin",
      "servo_pan=D9",
      "--stop-mm",
      "120",
      "--invert",
      "left",
      "--invert",
      "tilt",
    ]);
    assert.deepEqual(overrideFlags(undefined), []);
    assert.deepEqual(overrideFlags({}), []);
    for (const bad of [
      { pins: { motor: "D5" } },
      { pins: { pwma: "D14" } },
      { pins: { pwma: "D1" } },
      { pins: { pwma: 5 } },
      { pins: { pwma: "D4" } },
      { pins: { ain1: "D4", bin1: "D4" } },
      { pins: ["D5"] },
      { stopMm: 20 },
      { stopMm: 150.5 },
      { invert: ["wheel"] },
      { invert: "left" },
      { reset: "yes" },
      { speed: 3 },
      "D5",
    ]) {
      assert.throws(() => overrideFlags(bad), RoverInputError, JSON.stringify(bad));
    }
  });
});
