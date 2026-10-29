/**
 * The adb path's pure logic (lib/devices/adb.ts): the port rule (never 5037), QDC's tunnel command read and rebuilt
 * with a known_hosts file of the runner's own, the raw host:version exchange and the version check, the environment
 * adb gets, `adb devices`, getprop, /proc/meminfo and df parsed into the phone's facts (no serial anywhere), the runs a
 * phone gets by its RAM, and the shell lines that start, poll, stop and clean up the kit on the phone.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/adb.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as adb from "../adb";
import { SMOKE, subjectById } from "../subjects";
import { KIT_DEFAULTS, KIT_SMOKE, type Subject } from "../types";

const SERIAL = "FAKESERIAL0042";

/** What `getprop`, /proc/meminfo and df printed on tonight's SM8850 phone, as far as the session recorded them. */
const SM8850_FACTS = [
  "[ro.build.version.release]: [16]",
  "[ro.build.version.sdk]: [36]",
  "[ro.product.manufacturer]: [QUALCOMM]",
  "[ro.product.model]: [Canoe QRD]",
  "[ro.soc.manufacturer]: [QTI]",
  "[ro.soc.model]: [SM8850]",
  "[ro.product.cpu.abi]: [arm64-v8a]",
  `[ro.serialno]: [${SERIAL}]`,
  "@@mm@@",
  "MemTotal:       23760480 kB",
  "MemFree:         9000000 kB",
  "MemAvailable:   19600000 kB",
  "@@mm@@",
  "Filesystem     1024-blocks      Used Available Capacity Mounted on",
  "/dev/block/dm-50 470000000 420000000  45088768      91% /data",
  "@@mm@@",
  "curl",
  "sha256sum",
  "",
].join("\n");

describe("the adb server and the tunnel", () => {
  it("never uses the owner's port 5037", () => {
    assert.equal(adb.checkLocalPort(5038), 5038);
    assert.throws(() => adb.checkLocalPort(5037), /owner's own adb server/);
    assert.throws(() => adb.checkLocalPort(80), /1024 to 65535/);
    assert.throws(() => adb.checkLocalPort(5038.5), /1024 to 65535/);
    assert.throws(() => adb.adbEnv(5037, {}), /owner's/);
  });

  it("reads QDC's tunnel command and builds its own, on 127.0.0.1, with its own known_hosts", () => {
    const pasted = "ssh -i ~/.ssh/qdc_ed25519 -L 5037:sa48213.sa.svc.cluster.local:5037 -N sshtunnel@ssh.qdc.qualcomm.com";
    assert.deepEqual(adb.parseTunnelCommand(pasted), { sessionId: "48213", localPort: 5037, remotePort: 5037, key: "~/.ssh/qdc_ed25519" });
    assert.equal(adb.parseTunnelCommand("ssh -L 127.0.0.1:6000:saAbC-9.sa.svc.cluster.local:5037 -N sshtunnel@ssh.qdc.qualcomm.com").sessionId, "AbC-9");
    assert.throws(() => adb.parseTunnelCommand("ssh -L 5038:example.com:5037 user@ssh.qdc.qualcomm.com"), /tunnel command/);
    assert.throws(() => adb.parseTunnelCommand("ssh -L 5038:sa1.sa.svc.cluster.local:5037 -N sshtunnel@evil.example"), /doesn't go to/);

    const args = adb.tunnelArgs({ key: "/Users/o/.ssh/qdc", port: 5038, sessionId: "48213", knownHosts: "/cache/adb/known_hosts" });
    assert.equal(args[args.length - 1], "sshtunnel@ssh.qdc.qualcomm.com");
    assert.deepEqual(args.slice(args.indexOf("-L"), args.indexOf("-L") + 2), ["-L", "127.0.0.1:5038:sa48213.sa.svc.cluster.local:5037"]);
    assert.ok(args.includes("UserKnownHostsFile=/cache/adb/known_hosts"));
    assert.ok(args.includes("GlobalKnownHostsFile=/dev/null"));
    assert.ok(args.includes("ExitOnForwardFailure=yes"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(!args.join(" ").includes(".ssh/known_hosts"), "the owner's known_hosts is never used");
    assert.throws(() => adb.tunnelArgs({ key: "k", port: 5037, sessionId: "1", knownHosts: "/k" }), /owner's/);
    assert.throws(() => adb.sessionHost("1; rm -rf /"), /session id/);
  });

  it("frames host:version and reads the server's answer", () => {
    assert.equal(adb.hostRequest("host:version").toString("latin1"), "000chost:version");
    assert.deepEqual(adb.parseVersionReply(Buffer.from("OKAY00040029")), { kind: "ok", version: 41 });
    assert.deepEqual(adb.parseVersionReply(Buffer.from("OKAY0004")), { kind: "short" });
    assert.deepEqual(adb.parseVersionReply(Buffer.from("OK")), { kind: "short" });
    assert.deepEqual(adb.parseVersionReply(Buffer.from("FAIL0014unknown host service")), { kind: "fail", message: "unknown host service" });
    assert.equal(adb.parseVersionReply(Buffer.from("SSH-2.0-OpenSSH_9.6\r\n")).kind, "bad");
  });

  it("reads this Mac's adb version and refuses a server that speaks another one", () => {
    const text = "Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\nInstalled as /opt/homebrew/bin/adb\nRunning on Darwin 25.5.0 (arm64)\n";
    assert.equal(adb.parseClientVersion(text), 41);
    assert.equal(adb.parseClientVersion("adb: not found"), null);
    assert.equal(adb.versionProblem(41, { kind: "ok", version: 41 }, 5038), null);
    assert.match(adb.versionProblem(41, { kind: "ok", version: 40 }, 5038) ?? "", /protocol 40 .* speaks 41: any adb command would kill that server/);
    assert.match(adb.versionProblem(41, { kind: "bad", text: "connect ECONNREFUSED 127.0.0.1:5038" }, 5038) ?? "", /No adb server answers on 127\.0\.0\.1:5038/);
    assert.match(adb.versionProblem(41, { kind: "bad", text: "SSH-2.0" }, 5038) ?? "", /isn't an adb server/);
    assert.match(adb.versionProblem(null, { kind: "ok", version: 41 }, 5038) ?? "", /didn't say its version/);
  });

  it("gives adb only the session's server, with a socket adb won't start a server for", () => {
    const env = adb.adbEnv(5038, { PATH: "/usr/bin", HOME: "/Users/o", ANDROID_SERIAL: SERIAL, ADB_SERVER_SOCKET: "tcp:5037", HF_TOKEN: "hf_test_value_123456", ANDROID_ADB_SERVER_ADDRESS: "10.0.0.1" });
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/o", ADB_SERVER_SOCKET: "tcp:127.0.0.1:5038", ANDROID_ADB_SERVER_PORT: "5038" });
  });

  it("picks the one usable phone, never naming its serial", () => {
    const devices = adb.parseDevices(`* daemon started successfully\nList of devices attached\n${SERIAL}\tdevice\n\n`);
    assert.deepEqual(devices, [{ serial: SERIAL, state: "device" }]);
    assert.deepEqual(adb.pickDevice(devices), { serial: SERIAL });
    const cases: Array<[adb.AdbDevice[], RegExp]> = [
      [[], /No phone is on this adb server/],
      [[{ serial: SERIAL, state: "unauthorized" }], /isn't ready: it is unauthorized/],
      [[{ serial: SERIAL, state: "device" }, { serial: "OTHER0001", state: "device" }], /2 phones .* --serial/],
    ];
    for (const [list, words] of cases) {
      const picked = adb.pickDevice(list);
      assert.ok("problem" in picked);
      assert.match(picked.problem, words);
      assert.ok(!picked.problem.includes(SERIAL), "the serial is never in a message");
    }
    assert.ok("problem" in adb.pickDevice(devices, "NOPE"));
    assert.deepEqual(adb.pickDevice([{ serial: SERIAL, state: "device" }, { serial: "OTHER0001", state: "device" }], "OTHER0001"), { serial: "OTHER0001" });
  });
});

describe("the phone", () => {
  it("reads its facts from getprop, meminfo and df, and keeps no serial", () => {
    const facts = adb.parseFacts(SM8850_FACTS);
    assert.deepEqual(facts, {
      manufacturer: "QUALCOMM",
      model: "Canoe QRD",
      android: "16",
      sdk: 36,
      socManufacturer: "QTI",
      socModel: "SM8850",
      abi: "arm64-v8a",
      memTotalKb: 23760480,
      memAvailableKb: 19600000,
      freeKb: 45088768,
      hasCurl: true,
      hasSha256: true,
    });
    assert.ok(!JSON.stringify(facts).includes(SERIAL));
    assert.equal(
      adb.factsLine(facts),
      "QUALCOMM Canoe QRD, Android 16 (SDK 36), SM8850 (QTI), 24 GB RAM (MemTotal 23760480 kB, 19600000 kB available), 43.0 GiB free, curl yes, sha256 yes",
    );
    const bare = adb.parseFacts("[ro.build.version.sdk]: [30]\n@@mm@@\nMemTotal: 7600000 kB\n@@mm@@\n\n@@mm@@\nno-curl\nno-sha256\n");
    assert.equal(bare.hasCurl, false);
    assert.equal(bare.hasSha256, false);
    assert.equal(bare.freeKb, null);
    assert.match(adb.factsCommand(), /df -kP \/data\/local\/tmp;/);
    assert.match(adb.factsCommand(), /toybox sha256sum/);
  });

  it("tries the GPU and NPU only on a Snapdragon phone with Android 14 or later", () => {
    assert.equal(adb.snapdragonPhone({ socManufacturer: "QTI", socModel: "SM8750", sdk: 35 }), true);
    assert.equal(adb.snapdragonPhone({ socManufacturer: "", socModel: "SM8650", sdk: 34 }), true);
    assert.equal(adb.snapdragonPhone({ socManufacturer: "QTI", socModel: "SM8550", sdk: 33 }), false);
    assert.equal(adb.snapdragonPhone({ socManufacturer: "Google", socModel: "Tensor G4", sdk: 36 }), false);
  });

  it("runs the smoke file first, then the files for the phone's RAM, each once", () => {
    const sm8850 = adb.parseFacts(SM8850_FACTS);
    const runs = adb.planAdbRuns({ requests: ["smoke", "pick"], ramKb: sm8850.memTotalKb, facts: sm8850 });
    assert.deepEqual(runs.map((r) => [r.subject.id, r.why]), [
      [SMOKE.id, "smoke"],
      ["meta-q4_k_m", "fits"],
      ["bartowski-q3_k_m", "smaller"],
    ]);
    assert.equal(runs[0].settings, KIT_SMOKE);
    assert.equal(runs[1].settings, KIT_DEFAULTS);
    assert.deepEqual(runs[1].backends, ["cpu", "gpu", "npu"]);

    const pixel = { socManufacturer: "Google", socModel: "Tensor G4", sdk: 36 };
    const twelve = adb.planAdbRuns({ requests: ["smoke", "pick", SMOKE], ramKb: 11_700_000, facts: pixel });
    assert.deepEqual(twelve.map((r) => [r.subject.id, r.why]), [[SMOKE.id, "smoke"], ["bartowski-iq2_xxs", "proof"]]);
    assert.deepEqual(twelve[1].backends, ["cpu"], "no GPU or NPU off Snapdragon");

    const named = adb.planAdbRuns({ requests: [subjectById("bartowski-q4_0") as Subject], ramKb: null, backends: ["gpu"] });
    assert.deepEqual(named.map((r) => [r.subject.id, r.why, r.backends]), [["bartowski-q4_0", "named", ["gpu"]]]);
    assert.deepEqual(adb.planAdbRuns({ requests: ["pick"], ramKb: null }), [], "unknown RAM picks nothing");
    assert.throws(() => adb.planAdbRuns({ requests: ["smoke"], ramKb: null, backends: [] }), /at least one backend/);
  });

  it("estimates a run from tonight's speeds and says how long it may take", () => {
    const [smoke, meta] = adb.planAdbRuns({ requests: ["smoke", subjectById("meta-q4_k_m") as Subject], ramKb: null });
    assert.equal(adb.adbExpectedMinutes(smoke), 6);
    assert.equal(adb.adbExpectedMinutes(meta), 45, "2 setup + 18.6 download at 15 MB/s + 0.1 check + 24 for three backends");
    assert.equal(adb.adbRunLimitSeconds(KIT_DEFAULTS), 3600 + 600 + 2400 + 300);
    const text = adb.adbPlanText([smoke], { ramKb: null, requests: ["smoke", "pick"] });
    assert.match(text, /1\. smoke-smollm2-135m-q4_0 \(0\.09 GB, smoke\) on cpu, gpu, npu/);
    assert.match(text, /24 GB: meta-q4_k_m \(fits, needs 17\.96 GB\), then bartowski-q3_k_m \(smaller, needs 15\.16 GB\)/);
    assert.match(text, /12 GB: bartowski-iq2_xxs \(proof/);
  });
});

describe("commands on the phone", () => {
  it("starts the kit so that a dropped session leaves it running", () => {
    const start = adb.startCommand(SMOKE.id);
    assert.equal(
      start,
      `cd /data/local/tmp/mm && rm -rf out/${SMOKE.id} /data/local/tmp/mm/run-${SMOKE.id}.exit /data/local/tmp/mm/run-${SMOKE.id}.pid ` +
        `/data/local/tmp/mm/run-${SMOKE.id}.stdout && (trap '' HUP; set -a; . ./plan/${SMOKE.id}.env; set +a; sh kit/run.sh </dev/null ` +
        `>/data/local/tmp/mm/run-${SMOKE.id}.stdout 2>&1 & echo $! >/data/local/tmp/mm/run-${SMOKE.id}.pid; wait $!; echo $? >/data/local/tmp/mm/run-${SMOKE.id}.exit)`,
    );
    assert.throws(() => adb.startCommand("x; reboot"), /subject id/);
    assert.throws(() => adb.startCommand(SMOKE.id, "/data/local/tmp/../mm"), /safe folder/);
    assert.throws(() => adb.startCommand(SMOKE.id, "relative/mm"), /safe folder/);
  });

  it("reads a poll, and pulls after every step, at the end and during a long step", () => {
    const poll = (exit: string, run: string, steps: string[], stdout: string[]) =>
      `${exit}${exit ? "\n" : ""}@@mm@@\n${run}@@mm@@\n${steps.map((s) => `${s}\n`).join("")}@@mm@@\n${stdout.map((s) => `${s}\n`).join("")}@@mm@@\n`;
    assert.equal(adb.parsePoll("error: closed\n"), null, "no marks: adb didn't get through");
    const empty = adb.parsePoll(poll("", "", [], []));
    assert.ok(empty);
    assert.equal(adb.shouldPull(null, empty, 0), false, "nothing to pull before run.txt");
    const first = adb.parsePoll(poll("", "kit=1\nsubject=x\n", [], ["22:15:00 kit 1"]));
    assert.ok(first);
    assert.equal(adb.shouldPull(null, first, 0), true, "run.txt appeared");
    const same = adb.parsePoll(poll("", "kit=1\nsubject=x\n", [], ["22:15:00 kit 1", "22:15:05 downloading"]));
    assert.ok(same);
    assert.equal(adb.shouldPull(first, same, 10), false);
    assert.equal(adb.shouldPull(first, same, adb.PULL_EVERY_SECONDS), true, "a long step is pulled now and then");
    const step = adb.parsePoll(poll("", "kit=1\n", ["name=check backend=- prompt=- start=1 seconds=5 limit=600 rc=0 end=ok why=-"], []));
    assert.ok(step);
    assert.equal(adb.shouldPull(same, step, 1), true, "a step ended");
    assert.equal(adb.kitEnded(step), false);
    const ended = adb.parsePoll(poll("0", "kit=1\nfinished=1761690000\nstatus=done\n", step.steps, []));
    assert.ok(ended);
    assert.equal(ended.exit, 0);
    assert.equal(adb.kitEnded(ended), true);
    assert.equal(adb.shouldPull(step, ended, 1), true);
    const orphan = adb.parsePoll(poll("", "kit=1\nfinished=1761690000\nstatus=cut\n", step.steps, []));
    assert.ok(orphan && adb.kitEnded(orphan), "run.txt's end counts when the waiting shell is gone");
  });

  it("stops the kit, deletes the model after its run, and cleans up", () => {
    assert.equal(adb.stopCommand(SMOKE.id, "TERM"), `kill -TERM $(cat /data/local/tmp/mm/run-${SMOKE.id}.pid) 2>/dev/null; echo stopped`);
    const model = "/data/local/tmp/mm/model/SmolLM2-135M-Instruct-Q4_0.gguf";
    assert.match(adb.afterRunCommand(SMOKE.id, model, false), new RegExp(`${model.replace(/\./g, "\\.")} ${model.replace(/\./g, "\\.")}\\.part$`));
    assert.ok(!adb.afterRunCommand(SMOKE.id, model, true).includes(model));
    assert.throws(() => adb.afterRunCommand(SMOKE.id, "/sdcard/x.gguf", false), /isn't in/);
    assert.equal(adb.cleanupCommand(false), "rm -rf /data/local/tmp/mm");
    assert.ok(!adb.cleanupCommand(true).includes("/model"));
    assert.match(adb.stageCommand(), /^rm -rf \/data\/local\/tmp\/mm\/kit .*; mkdir -p \/data\/local\/tmp\/mm\/model /);
    for (const tool of adb.ADB_TOOLS) assert.ok(adb.chmodCommand().includes(`/data/local/tmp/mm/${tool}`));
  });
});
