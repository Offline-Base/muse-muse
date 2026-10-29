/**
 * The adb runner end to end (scripts/devices/adb.ts) with no phone: a fake adb server answers the raw host:version
 * check, a fake adb client runs "the phone" in a folder on this Mac, and the real kit (devices/kit/run.sh) runs there
 * with stand-in llama-bench and llama-completion that print tonight's real SM8850 output
 * (devices/qdc/tests/fixtures/sm8850-session) and a stand-in curl that "downloads" a tiny model. It checks the version
 * check before adb, the serial on every command and nowhere in the output, the push, the pulls after each step, a
 * session that ends mid-run, a mismatched or missing server, the result parsed and written, and the cleanup. The last
 * test talks to the fake server with this Mac's real adb client. Nothing reaches a real phone, QDC or the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/adb-run.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PhoneLink, parseAdbArgs, runAdb, runOnPhone, runProgram } from "../../../scripts/devices/adb";
import { parseClientVersion, planAdbRuns } from "../adb";
import { DEFAULT_SYSTEM } from "../subjects";
import type { Result, Subject } from "../types";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = path.join(REPO, "devices", "qdc", "tests", "fixtures", "sm8850-session");
const SERIAL = "FAKESERIAL0042";
const REAL_ADB = "/opt/homebrew/bin/adb";

/** A fake adb server: answers host:version with `version`, host:devices with one phone, and records every request. */
async function fakeServer(version: number): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const reply = (payload: string) => `OKAY${payload.length.toString(16).padStart(4, "0")}${payload}`;
  const server = net.createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.length < 4) return;
      const length = Number.parseInt(data.slice(0, 4), 16);
      if (data.length < 4 + length) return;
      const service = data.slice(4, 4 + length);
      requests.push(service);
      if (service === "host:version") socket.end(reply(version.toString(16).padStart(4, "0")));
      else if (service === "host:devices" || service === "host:devices-l") socket.end(reply(`${SERIAL}\tdevice\n`));
      else socket.end(`FAIL${(20).toString(16).padStart(4, "0")}unknown host service`);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** The fake adb: a Node script behind a sh wrapper that carries its config (adb's own env is stripped by the runner). */
const FAKE_ADB = String.raw`
import { appendFileSync, cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const cfg = JSON.parse(readFileSync(process.env.FAKE_ADB_CONFIG, "utf8"));
let argv = process.argv.slice(2);
appendFileSync(cfg.log, JSON.stringify({ argv, socket: process.env.ADB_SERVER_SOCKET ?? null, port: process.env.ANDROID_ADB_SERVER_PORT ?? null }) + "\n");
if (argv[0] === "version") {
  process.stdout.write("Android Debug Bridge version 1.0.41\nVersion 37.0.1-fake\nInstalled as fake\n");
  process.exit(0);
}
if (process.env.ADB_SERVER_SOCKET !== cfg.socket) {
  process.stderr.write("adb: failed to check server version: cannot connect to daemon\n");
  process.exit(1);
}
if (existsSync(cfg.dead)) {
  process.stderr.write("error: closed\n");
  process.exit(1);
}
if (argv[0] === "-s") {
  if (argv[1] !== cfg.serial) {
    process.stderr.write("adb: device not found\n");
    process.exit(1);
  }
  argv = argv.slice(2);
}
const copy = (src, dst) => {
  const into = existsSync(dst) && statSync(dst).isDirectory() ? path.join(dst, path.basename(src)) : dst;
  cpSync(src, into, { recursive: true });
};
switch (argv[0]) {
  case "devices":
    process.stdout.write("List of devices attached\n" + cfg.serial + "\tdevice\n\n");
    break;
  case "shell": {
    const command = argv.slice(1).join(" ").split("/proc/meminfo").join(cfg.phone + "/proc/meminfo");
    const run = spawnSync("/bin/sh", ["-c", command], { env: cfg.phoneEnv, stdio: "inherit", cwd: "/" });
    process.exit(run.status ?? 1);
  }
  case "push":
  case "pull":
    copy(argv[1], argv[2]);
    process.stdout.write(argv[1] + ": 1 file " + argv[0] + "ed.\n");
    break;
  default:
    process.stderr.write("fake adb: no " + argv[0] + "\n");
    process.exit(1);
}
`;

const FAKE_GETPROP = `#!/bin/sh
case "$1" in
  ro.build.version.release) echo 16 ;;
  ro.build.version.sdk) echo 36 ;;
  ro.product.manufacturer) echo QUALCOMM ;;
  ro.product.model) echo 'Canoe QRD' ;;
  ro.product.brand) echo qti ;;
  ro.product.device) echo canoe ;;
  ro.soc.manufacturer) echo QTI ;;
  ro.soc.model) echo SM8850 ;;
  ro.board.platform) echo canoe ;;
  ro.hardware) echo qcom ;;
  ro.product.cpu.abi) echo arm64-v8a ;;
  ro.serialno) echo ${SERIAL} ;;
  '') printf '[ro.build.version.release]: [16]\\n[ro.build.version.sdk]: [36]\\n[ro.product.manufacturer]: [QUALCOMM]\\n[ro.product.model]: [Canoe QRD]\\n[ro.soc.manufacturer]: [QTI]\\n[ro.soc.model]: [SM8850]\\n[ro.product.cpu.abi]: [arm64-v8a]\\n[ro.serialno]: [${SERIAL}]\\n' ;;
esac
`;

const FAKE_CURL = `#!/bin/sh
out=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac; done
cp "$FAKE_MODEL_SRC" "$out"
`;

/** llama-bench: tonight's real JSONL per device; the NPU never finishes (FAKE_NPU=hang) or fails. */
const FAKE_BENCH = `#!/bin/sh
F=$FAKE_FIXTURES
for a in "$@"; do
  case "$a" in --list-devices) printf 'Available devices:\\n  GPUOpenCL: QUALCOMM Adreno(TM) 840 (11601 MiB, 10577 MiB free)\\n  HTP0: Hexagon v81\\n'; exit 0 ;; esac
done
dev=
while [ $# -gt 0 ]; do case "$1" in -dev) dev=$2; shift 2 ;; *) shift ;; esac; done
sleep "\${FAKE_STEP_SECONDS:-0}"
case "$dev" in
  none) cat "$F/q3_k_m-bench-cpu.jsonl"; cat "$F/q3_k_m-bench-cpu.err" >&2; if [ "$FAKE_DIE_AFTER" = cpu ]; then touch "$FAKE_DEAD"; fi; exit 0 ;;
  GPUOpenCL) cat "$F/q3_k_m-bench-gpu.jsonl"; cat "$F/q3_k_m-bench-cpu.err" >&2; exit 0 ;;
  HTP*) cat "$F/q3_k_m-bench-npu.err" >&2; if [ "$FAKE_NPU" = hang ]; then exec sleep 600; fi; echo 'ggml-hex: failed to allocate the session' >&2; exit 1 ;;
esac
exit 2
`;

/** llama-completion: tonight's real smoke answers (Paris, 42, and a wrong "shade of blue") with their timings. */
const FAKE_COMPLETION = `#!/bin/sh
p=
while [ $# -gt 0 ]; do case "$1" in -f) p=$2; shift 2 ;; *) shift ;; esac; done
id=$(basename "$p" .txt)
sleep "\${FAKE_STEP_SECONDS:-0}"
cat "$FAKE_FIXTURES/smoke-answer-cpu-$id.out"
cat "$FAKE_FIXTURES/smoke-answer-cpu-$id.err" >&2
`;

interface Rig {
  tmp: string;
  repo: string;
  cache: string;
  phone: string;
  root: string;
  dead: string;
  log: string;
  adb: string;
  tiny: Subject;
  builds: { "android-arm64": string; "android-arm64-snapdragon": string };
  lines: string[];
}

function write(file: string, text: string, mode = 0o644): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
}

function makeRig(port: number, knobs: Record<string, string> = {}): Rig {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mm-adb-run-"));
  const phone = path.join(tmp, "phone");
  const root = path.join(phone, "data", "local", "tmp", "mm");
  mkdirSync(root, { recursive: true });
  for (const [name, text] of [["getprop", FAKE_GETPROP], ["curl", FAKE_CURL]] as const) write(path.join(phone, "bin", name), text, 0o755);
  write(path.join(phone, "proc", "meminfo"), "MemTotal:       23760480 kB\nMemFree:         9000000 kB\nMemAvailable:   19600000 kB\nCached:          6000000 kB\nSwapFree:              0 kB\n");
  write(path.join(phone, "proc", "cpuinfo"), Array.from({ length: 8 }, (_, i) => `processor\t: ${i}\n`).join(""));
  write(path.join(phone, "sys", "class", "thermal", "thermal_zone0", "temp"), "41000\n");

  const model = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 251));
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(path.join(tmp, "src", "tiny.gguf"), model);
  const tiny: Subject = {
    id: "test-tiny-q4_0",
    kind: "base",
    repo: "test-org/tiny-gguf",
    revision: "0".repeat(40),
    path: "tiny.gguf",
    bytes: 4096,
    sha256: createHash("sha256").update(readFileSync(path.join(tmp, "src", "tiny.gguf"))).digest("hex"),
    quant: "Q4_0",
    system: DEFAULT_SYSTEM,
    note: "A 4 KB stand-in file for the runner's tests.",
  };

  const plain = path.join(tmp, "builds", "plain", "llama-b11669");
  const snap = path.join(tmp, "builds", "snap", "llama-b11669");
  for (const dir of [plain, path.join(snap, "bin")]) {
    write(path.join(dir, "llama-bench"), FAKE_BENCH, 0o644);
    write(path.join(dir, "llama-completion"), FAKE_COMPLETION, 0o644);
  }
  write(path.join(plain, "libllama.so"), "not really a library");
  write(path.join(snap, "lib", "libggml-opencl.so"), "not really a library");

  const repo = path.join(tmp, "repo");
  cpSync(path.join(REPO, "devices", "kit"), path.join(repo, "devices", "kit"), { recursive: true });
  mkdirSync(path.join(repo, "devices", "qdc"), { recursive: true });
  writeFileSync(path.join(repo, "devices", "qdc", "targets.json"), "[]\n");

  const dead = path.join(tmp, "session-ended");
  const log = path.join(tmp, "adb.log");
  const config = path.join(tmp, "fake-adb.json");
  writeFileSync(
    config,
    JSON.stringify({
      log,
      dead,
      serial: SERIAL,
      phone,
      socket: `tcp:127.0.0.1:${port}`,
      phoneEnv: {
        PATH: `${path.join(phone, "bin")}:/usr/bin:/bin`,
        HOME: phone,
        MM_TEST_PROC: path.join(phone, "proc"),
        MM_TEST_SYS: path.join(phone, "sys"),
        FAKE_FIXTURES: FIXTURES,
        FAKE_MODEL_SRC: path.join(tmp, "src", "tiny.gguf"),
        FAKE_DEAD: dead,
        ...knobs,
      },
    }),
  );
  write(path.join(tmp, "fake-adb.mjs"), FAKE_ADB);
  const adb = path.join(tmp, "adb");
  write(adb, `#!/bin/sh\nFAKE_ADB_CONFIG='${config}' exec '${process.execPath}' '${path.join(tmp, "fake-adb.mjs")}' "$@"\n`, 0o755);
  return { tmp, repo, cache: path.join(tmp, "cache"), phone, root, dead, log, adb, tiny, builds: { "android-arm64": plain, "android-arm64-snapdragon": snap }, lines: [] };
}

function adbCalls(rig: Rig): Array<{ argv: string[]; socket: string | null; port: string | null }> {
  return existsSync(rig.log) ? readFileSync(rig.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

function deps(rig: Rig) {
  return {
    repoRoot: rig.repo,
    cache: rig.cache,
    env: { PATH: "/usr/bin:/bin", HOME: rig.tmp },
    root: rig.root,
    stageBuilds: async () => rig.builds,
    extraSubjects: [rig.tiny],
    say: (line: string) => rig.lines.push(line),
    now: () => new Date(),
  };
}

function resultsUnder(rig: Rig): Array<{ dir: string; result: Result }> {
  const base = path.join(rig.repo, "devices", "results");
  if (!existsSync(base)) return [];
  const out: Array<{ dir: string; result: Result }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name === "result.json") out.push({ dir, result: JSON.parse(readFileSync(p, "utf8")) as Result });
    }
  };
  walk(base);
  return out;
}

function everyFileText(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    text += name.isDirectory() ? everyFileText(p) : readFileSync(p, "latin1");
  }
  return text;
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

describe("the adb runner", () => {
  let server: Awaited<ReturnType<typeof fakeServer>>;
  const rigs: Rig[] = [];
  before(async () => {
    server = await fakeServer(41);
  });
  after(async () => {
    await server.close();
    for (const rig of rigs) if (!process.env.MM_KEEP_TEST_DIRS) rmSync(rig.tmp, { recursive: true, force: true });
  });

  it("runs the kit on the phone, pulls after every step, writes the result and cleans up", async () => {
    const rig = makeRig(server.port, { FAKE_NPU: "error", FAKE_STEP_SECONDS: "0.7" });
    rigs.push(rig);
    const before = server.requests.length;
    const args = parseAdbArgs(["run", "--yes", "--port", String(server.port), "--adb", rig.adb, "--subjects", rig.tiny.id, "--poll-seconds", "0.3"]);
    const code = await runAdb(args, deps(rig));
    assert.equal(code, 0, rig.lines.join("\n"));
    if (process.env.MM_KEEP_TEST_DIRS) console.log(`kept ${rig.tmp}`);

    const calls = adbCalls(rig);
    assert.deepEqual(calls[0].argv, ["version"]);
    assert.deepEqual(calls[1].argv, ["devices"]);
    for (const c of calls.slice(1)) {
      assert.equal(c.socket, `tcp:127.0.0.1:${server.port}`, "adb never gets a socket it would start a server for");
      assert.equal(c.port, String(server.port));
    }
    for (const c of calls.slice(2)) assert.deepEqual(c.argv.slice(0, 2), ["-s", SERIAL], "every command after devices names the phone");
    const versionChecks = server.requests.slice(before).filter((r) => r === "host:version").length;
    assert.ok(versionChecks >= calls.length - 1, `a host:version check before every adb command (${versionChecks} for ${calls.length - 1})`);
    const pulls = calls.filter((c) => c.argv[2] === "pull");
    assert.ok(pulls.length >= 6, `pulled after each step (${pulls.length} pulls)`);
    const pushes = calls.filter((c) => c.argv[2] === "push").map((c) => c.argv[4]);
    assert.ok(pushes.includes(`${rig.root}/kit`) && pushes.includes(`${rig.root}/llama-android`) && pushes.includes(`${rig.root}/llama-snapdragon`));
    assert.ok(pushes.includes(`${rig.root}/plan/${rig.tiny.id}.env`) && pushes.includes(`${rig.root}/plan/${rig.tiny.id}.system`));

    const [{ dir, result }] = resultsUnder(rig);
    assert.equal(path.relative(rig.repo, path.dirname(dir)), `devices/results/qdc/qdc-sm8850-24gb/${rig.tiny.id}`);
    assert.equal(result.cloud, "qdc");
    assert.equal(result.status, "done");
    assert.equal(result.device.cloudId, "SM8850/session");
    assert.equal(result.device.marketedRamGiB, 24);
    assert.equal(result.model.check, "ok");
    assert.equal(result.model.fetched, true, "the phone downloaded the model itself");
    const cpu = result.backends.find((b) => b.backend === "cpu");
    const gpu = result.backends.find((b) => b.backend === "gpu");
    const npu = result.backends.find((b) => b.backend === "npu");
    assert.equal(cpu?.genTps, 3.010551);
    assert.equal(cpu?.promptTps, 5.607882);
    assert.equal(gpu?.genTps, 2.092101);
    assert.equal(gpu?.promptTps, 5.81524);
    assert.equal(npu?.loaded, false);
    assert.equal(npu?.end, "error");
    assert.deepEqual(result.completions.filter((c) => c.backend === "npu").map((c) => [c.end, c.why]), [
      ["skipped", "noload"],
      ["skipped", "noload"],
      ["skipped", "noload"],
    ]);
    assert.deepEqual(result.completions.filter((c) => c.end === "ok").map((c) => [c.backend, c.promptId, c.right]), [
      ["cpu", "capital", true],
      ["cpu", "sum", true],
      ["cpu", "color", false],
      ["gpu", "capital", true],
      ["gpu", "sum", true],
      ["gpu", "color", false],
    ]);
    assert.equal(result.verdict.rating, "slow", "3.0 t/s with 2 of 3 right");
    assert.equal(result.verdict.backend, "cpu");
    assert.match(result.notes.join("\n"), /pulled the kit's folder \d+ times/);
    assert.match(rig.lines.join("\n"), /test-tiny-q4_0: slow, cpu 3\.0 t\/s, 2 of 3 right/);

    assert.ok(!everyFileText(dir).includes(SERIAL), "no serial in the result folder");
    assert.ok(!rig.lines.join("\n").includes(SERIAL), "no serial in the output");
    assert.ok(!existsSync(rig.root), "the phone's folder is removed, model and all");
  });

  it("keeps what it pulled when the session ends mid-run", async () => {
    // The CPU bench takes 1.5 s, so a pull lands after the check; the session ends as that bench finishes.
    const rig = makeRig(server.port, { FAKE_NPU: "error", FAKE_DIE_AFTER: "cpu", FAKE_STEP_SECONDS: "1.5" });
    rigs.push(rig);
    const args = parseAdbArgs(["run", "--yes", "--port", String(server.port), "--adb", rig.adb, "--subjects", rig.tiny.id, "--poll-seconds", "0.3", "--reconnect-minutes", "0.03"]);
    const code = await runAdb(args, deps(rig));
    assert.equal(code, 1, "a run with no clean end isn't a success");
    const [{ result }] = resultsUnder(rig);
    assert.equal(result.model.check, "ok");
    assert.match(result.notes.join("\n"), /The phone stopped answering before the kit finished/);
    assert.match(result.notes.join("\n"), /The kit stopped before it finished/);
    assert.match(rig.lines.join("\n"), /hasn't answered for/);
    // The kit goes on on the phone after the session ends; let it finish before the folder goes.
    await waitFor(() => /finished=/.test(existsSync(path.join(rig.root, "out", rig.tiny.id, "run.txt")) ? readFileSync(path.join(rig.root, "out", rig.tiny.id, "run.txt"), "utf8") : ""), 20_000);
  });

  it("stops a step the NPU never finishes at the kit's limit, and the verdict says so", async () => {
    const rig = makeRig(server.port, { FAKE_NPU: "hang" });
    rigs.push(rig);
    // Short limits so the hanging NPU bench is stopped by the kit's own watchdog in seconds.
    const tiny = { ...rig.tiny, id: "test-tiny-npu-q4_0" };
    const link = new PhoneLink(rig.adb, server.port, { PATH: "/usr/bin:/bin", HOME: rig.tmp });
    await link.ensureServer();
    await link.attach();
    for (const [from, to] of [
      [path.join(rig.repo, "devices", "kit"), `${rig.root}/kit`],
      [rig.builds["android-arm64"], `${rig.root}/llama-android`],
      [rig.builds["android-arm64-snapdragon"], `${rig.root}/llama-snapdragon`],
    ]) {
      assert.equal((await link.run(["push", from, to])).code, 0);
    }
    await link.shell(`mkdir -p ${rig.root}/plan ${rig.root}/model ${rig.root}/out; chmod 755 ${rig.root}/llama-android/llama-bench ${rig.root}/llama-android/llama-completion ${rig.root}/llama-snapdragon/bin/llama-bench ${rig.root}/llama-snapdragon/bin/llama-completion`);
    const [run] = planAdbRuns({ requests: [tiny], ramKb: 23_760_480 });
    run.settings = { ...run.settings, limitBench: 3, limitAnswer: 20, sampleSeconds: 1 };
    const outcome = await runOnPhone(
      {
        link,
        root: rig.root,
        workDir: path.join(rig.cache, "adb", "manual"),
        repoRoot: rig.repo,
        cloud: "qdc",
        facts: { manufacturer: "QUALCOMM", model: "Canoe QRD", android: "16", sdk: 36, socManufacturer: "QTI", socModel: "SM8850", abi: "arm64-v8a", memTotalKb: 23_760_480, memAvailableKb: 19_600_000, freeKb: 45_000_000, hasCurl: true, hasSha256: true },
        keepModel: false,
        pollSeconds: 0.3,
        reconnectMinutes: 1,
        reconnect: async () => false,
        interrupted: () => false,
        now: () => new Date(),
        say: (line) => rig.lines.push(line),
        fetchImpl: fetch,
      },
      run,
    );
    assert.ok(outcome.result, outcome.why ?? "");
    const npu = outcome.result.backends.find((b) => b.backend === "npu");
    assert.equal(npu?.end, "timeout");
    assert.equal(npu?.why, "limit");
    assert.equal(npu?.loaded, false);
    assert.equal(outcome.result.verdict.rating, "slow", "the CPU still decides");
    assert.match(outcome.result.verdict.reasons.join("\n"), /npu/);
  });

  it("refuses a server that speaks another protocol before adb ever talks to it", async () => {
    const other = await fakeServer(40);
    const rig = makeRig(other.port);
    rigs.push(rig);
    try {
      const code = await runAdb(parseAdbArgs(["run", "--yes", "--port", String(other.port), "--adb", rig.adb, "--subjects", rig.tiny.id]), deps(rig));
      assert.equal(code, 2);
      assert.match(rig.lines.join("\n"), /speaks protocol 40 and this Mac's adb speaks 41/);
      assert.deepEqual(adbCalls(rig).map((c) => c.argv), [["version"]], "only `adb version`, which talks to no server");
    } finally {
      await other.close();
    }
  });

  it("refuses a port where no server answers, without letting adb start one", async () => {
    const rig = makeRig(1);
    rigs.push(rig);
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const code = await runAdb(parseAdbArgs(["check", "--port", String(free), "--adb", rig.adb]), deps(rig));
    assert.equal(code, 2);
    assert.match(rig.lines.join("\n"), new RegExp(`No adb server answers on 127\\.0\\.0\\.1:${free}`));
    assert.deepEqual(adbCalls(rig).map((c) => c.argv), [["version"]]);
  });

  it("records a session phone's RAM as a QDC probe", async () => {
    const rig = makeRig(server.port);
    rigs.push(rig);
    const code = await runAdb(parseAdbArgs(["check", "--port", String(server.port), "--adb", rig.adb, "--record-probe", "sm8850"]), deps(rig));
    assert.equal(code, 0, rig.lines.join("\n"));
    const probes = JSON.parse(readFileSync(path.join(rig.repo, "devices", "qdc", "targets.json"), "utf8"));
    assert.equal(probes.length, 1);
    assert.deepEqual({ ...probes[0], probedAt: "-" }, { chipset: "SM8850", ramKb: 23760480, marketedRamGiB: 24, model: "Canoe QRD", android: "16", sdk: 36, socModel: "SM8850", probedAt: "-" });
    assert.match(rig.lines.join("\n"), /Phone: QUALCOMM Canoe QRD, Android 16 \(SDK 36\), SM8850 \(QTI\), 24 GB RAM/);
    assert.ok(!rig.lines.join("\n").includes(SERIAL));
  });

  it("speaks the protocol this Mac's real adb client speaks", { skip: existsSync(REAL_ADB) ? false : "no adb here" }, async () => {
    const version = parseClientVersion(spawnSync(REAL_ADB, ["version"], { encoding: "utf8" }).stdout);
    assert.ok(version, "adb version names its protocol");
    const real = await fakeServer(version);
    try {
      const env = { PATH: "/usr/bin:/bin", HOME: os.homedir(), ADB_SERVER_SOCKET: `tcp:127.0.0.1:${real.port}`, ANDROID_ADB_SERVER_PORT: String(real.port) };
      // Not spawnSync: the fake server answers from this process's event loop.
      const run = await runProgram(REAL_ADB, ["devices"], env, 30_000);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`List of devices attached\\n${SERIAL}\\tdevice`));
      assert.equal(real.requests[0], "host:version", "the real client checks the version first, as the runner does");
      assert.ok(real.requests.includes("host:devices") || real.requests.includes("host:devices-l"));
    } finally {
      await real.close();
    }
  });
});
