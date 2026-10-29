/**
 * Runs devices/kit/run.sh for real under /bin/sh and /bin/dash, with fake tools (fixtures/kit-fakes: llama-bench,
 * llama-completion, curl, and Android's getprop, logcat and dumpsys) and a PATH holding nothing but the tools the kit
 * may use, then checks its output folder line by line and reads it back with lib/devices/result.ts. Covered: a Mac and
 * an Android phone with canned output, every flag and the answers' order, a bench the watchdog stops and one that
 * ignores TERM until the KILL, a low-memory kill of a bench and of an answer, a SIGKILL with no log, a crash, a backend
 * that doesn't load or isn't there, the Android 14 rule, fewer Hexagon sessions than asked, a wrong sha256 or size, no
 * sha256 tool, no curl, the kit's own download and its failures, a RAM skip, the total limit, the caps, a TERM from
 * outside, cleanup on request, bad inputs, that no token reaches a tool, that no helper outlives the run, and that the
 * prompt files hold FIXED_PROMPTS exactly. Nothing here runs llama.cpp or reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/kit.test.ts
 *
 * MM_KIT_TEST_KEEP=1 keeps each run's folder (printed) to look at.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { keyValues, parseKitOutput } from "@/lib/devices/result";
import { DEFAULT_SYSTEM, FIXED_PROMPTS, kitEnvFor } from "@/lib/devices/subjects";
import { KIT_DEFAULTS, KIT_SMOKE, KIT_VERSION, type Backend, type Result, type Subject } from "@/lib/devices/types";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const KIT = path.join(REPO, "devices", "kit");
const FAKES = fileURLToPath(new URL("./fixtures/kit-fakes/", import.meta.url));
const SHELLS = ["/bin/sh", "/bin/dash"].filter((s) => existsSync(s));
const KEEP = process.env.MM_KIT_TEST_KEEP === "1";

/** The tools run.sh may call (docs/DEVICES.md "Rules for run.sh"), plus the sha256 tool; nothing else is on its PATH. */
const ALLOWED = [
  "cat", "cp", "mv", "rm", "mkdir", "ls", "touch", "date", "sleep", "env", "grep", "sed", "cut", "tr", "head", "tail",
  "sort", "wc", "uname", "df", "stat", "ps", "sysctl", "sw_vers",
];
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const which = (tool: string) => SYSTEM_DIRS.map((d) => path.join(d, tool)).find((p) => existsSync(p)) ?? null;
const SHA256SUM = which("sha256sum") ?? which("shasum");

const SECRETS = {
  HF_TOKEN: "fake-hf-token-for-the-kit-test",
  HUGGING_FACE_HUB_TOKEN: "fake-hub-token-for-the-kit-test",
  QDC_API_KEY: "qdc-fake-key-for-kit-test",
  AWS_ACCESS_KEY_ID: "fake-aws-key-id-for-the-kit-test",
  AWS_SECRET_ACCESS_KEY: "fakeSecretAccessKeyForKitTest0000000000",
  AWS_SESSION_TOKEN: "fakeSessionTokenForKitTest",
};

type Platform = "mac" | "android" | "linux";

interface World {
  dir: string;
  out: string;
  log: string;
  model: string;
  subject: Subject;
  env: Record<string, string>;
}

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) {
    if (KEEP) console.log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A folder for one kit run: a copy of devices/kit, the fake builds (plain/, flat, and snap/ with bin/ and lib/), the
 * model and system files, a fake /proc and /sys off a Mac, and the kit's environment from kitEnvFor. `bytes` gives the
 * subject a size other than the small model file's, for the RAM gate, which comes before the file check.
 */
function makeWorld(
  platform: Platform,
  opts: { backends?: Backend[]; hash?: boolean; curl?: boolean; smoke?: boolean; bytes?: number } = {},
): World {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-kit-"));
  worlds.push(dir);
  const at = (...p: string[]) => path.join(dir, ...p);
  for (const d of ["bin", "tools", "plain", "snap/bin", "snap/lib", "model", "log", "empty"]) mkdirSync(at(d), { recursive: true });
  cpSync(KIT, at("kit"), { recursive: true });
  const fake = (name: string, to: string) => {
    copyFileSync(path.join(FAKES, name), to);
    chmodSync(to, 0o755);
  };
  for (const tool of ["llama-bench", "llama-completion"]) {
    fake(tool, at("plain", tool));
    fake(tool, at("snap", "bin", tool));
  }
  writeFileSync(at("snap", "lib", "libggml-htp-v81.so"), "not a library\n");
  if (platform !== "mac") fake("uname", at("bin", "uname"));
  if (platform === "android") for (const tool of ["getprop", "logcat", "dumpsys"]) fake(tool, at("bin", tool));
  if (opts.curl) fake("curl", at("bin", "curl"));
  for (const tool of ALLOWED) {
    const real = which(tool);
    if (real && !existsSync(at("bin", tool))) symlinkSync(real, at("tools", tool));
  }
  if (opts.hash !== false && SHA256SUM) symlinkSync(SHA256SUM, at("tools", path.basename(SHA256SUM)));

  const content = "GGUF fake model bytes for the kit test\n";
  writeFileSync(at("model", "m.gguf"), content);
  writeFileSync(at("model.copy"), content);
  writeFileSync(at("system.txt"), DEFAULT_SYSTEM);
  const subject: Subject = {
    id: "test-q3_k_m",
    kind: opts.smoke ? "smoke" : "base",
    repo: "test-org/Test-30B-GGUF",
    revision: "0123456789abcdef0123456789abcdef01234567",
    path: "m.gguf",
    bytes: opts.bytes ?? Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    quant: "Q3_K_M",
    system: DEFAULT_SYSTEM,
    note: "The kit test's file.",
  };

  if (platform !== "mac") {
    mkdirSync(at("proc", "self"), { recursive: true });
    const meminfo = (avail: number) =>
      `MemTotal:       23760480 kB\nMemFree:         1200000 kB\nMemAvailable:   ${avail} kB\nBuffers:           10000 kB\n` +
      "Cached:         15000000 kB\nSwapTotal:       8388604 kB\nSwapFree:        8000000 kB\n";
    writeFileSync(at("proc", "meminfo.idle"), meminfo(19600000));
    writeFileSync(at("proc", "meminfo.busy"), meminfo(13232000));
    writeFileSync(at("proc", "meminfo"), meminfo(19600000));
    const cpus = Array.from({ length: 8 }, (_, i) => `processor\t: ${i}\nmodel name\t: Fake ARMv9 core\nBogoMIPS\t: 38.40\n`);
    writeFileSync(at("proc", "cpuinfo"), cpus.join("\n"));
    writeFileSync(at("proc", "self", "cpuset"), "/top-app\n");
    const zones: Record<string, string> = { thermal_zone0: "41000", thermal_zone1: "-1", thermal_zone2: "52500", thermal_zone3: "999999" };
    for (const [zone, temp] of Object.entries(zones)) {
      mkdirSync(at("sys", "class", "thermal", zone), { recursive: true });
      writeFileSync(at("sys", "class", "thermal", zone, "temp"), `${temp}\n`);
    }
  }

  const backends = opts.backends ?? (platform === "mac" ? ["gpu", "cpu"] : ["cpu", "gpu", "npu"]);
  const llama =
    platform === "mac" ? { cpu: at("plain"), gpu: at("plain") } : { cpu: at("plain"), gpu: at("snap"), npu: at("snap") };
  const kit = kitEnvFor(
    subject,
    { model: at("model", "m.gguf"), out: at("out"), system: at("system.txt"), llama },
    { backends, settings: opts.smoke ? KIT_SMOKE : KIT_DEFAULTS },
  );
  const env: Record<string, string> = {
    PATH: `${at("bin")}:${at("tools")}`,
    HOME: dir,
    FAKE_LOG: at("log"),
    FAKE_DEVICES: platform === "mac" ? "MTL0,BLAS" : "GPUOpenCL,HTP0",
    MM_SAMPLE_SECONDS: "1",
  };
  for (const [k, v] of Object.entries(kit)) if (v !== undefined && k !== "MM_SAMPLE_SECONDS") env[k] = v;
  if (platform !== "mac") {
    env.MM_TEST_PROC = at("proc");
    env.MM_TEST_SYS = at("sys");
  }
  return { dir, out: at("out"), log: at("log"), model: at("model", "m.gguf"), subject, env };
}

interface KitRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  pid: number;
}

function runKit(
  shell: string,
  world: World,
  extra: Record<string, string | undefined> = {},
  during?: (pid: number) => Promise<void>,
): Promise<KitRun> {
  const env: Record<string, string> = { ...world.env };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [path.join(world.dir, "kit", "run.sh")], {
      cwd: world.dir,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("error", reject);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, pid: child.pid ?? 0 });
    });
    if (during && child.pid) during(child.pid).catch(reject);
  });
}

const read = (file: string) => readFileSync(file, "utf8");
const kvFile = (file: string) => keyValues(read(file));
const keysOf = (file: string) => read(file).split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
const argsOf = (world: World, name: string) => read(path.join(world.log, `${name}.args`)).split("\n").filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEP_LINE =
  /^name=(fetch|check|list|bench|answer) backend=(cpu|gpu|npu|-) prompt=([a-z0-9_]+|-) start=(\d+) seconds=(\d+) limit=(\d+) rc=(\d+|-) end=(ok|error|timeout|killed|crashed|skipped) why=(\S+)$/;

/** steps.txt as "name backend prompt end why rc" strings, after checking that every line has the contract's shape. */
function steps(world: World): string[] {
  const lines = read(path.join(world.out, "steps.txt")).split("\n");
  assert.equal(lines.pop(), "", "steps.txt ends with a newline");
  return lines.map((line) => {
    const m = STEP_LINE.exec(line);
    assert.ok(m, `a steps.txt line has the contract's shape: ${line}`);
    return `${m[1]} ${m[2]} ${m[3]} ${m[8]} ${m[9]} rc=${m[7]}`;
  });
}

const answers = (backend: Backend, end = "ok", why = "-", rc = "0") =>
  FIXED_PROMPTS.map((p) => `answer ${backend} ${p.id} ${end} ${why} rc=${rc}`);
const skippedAnswers = (backend: Backend, why: string) => answers(backend, "skipped", why, "-");

function parse(world: World): Result {
  return parseKitOutput(world.out, { cloud: "local", runId: "kit-test", stamp: "20261028T221500Z", subject: world.subject });
}

const RUN_KEYS = [
  "kit", "subject", "platform", "backends", "prompts", "ctx", "bench_prompt", "bench_gen", "bench_reps", "answer_tokens",
  "npu_sessions", "threads", "limit_fetch", "limit_check", "limit_bench", "limit_answer", "limit_total", "started",
];

/** No process of this world's kit (its subshells carry the kit's path) or of its watchdog's sleeps is left. */
async function assertNothingLeft(world: World, sleeps: string[]): Promise<void> {
  let left: string[] = [];
  for (let i = 0; i < 30; i++) {
    const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n");
    left = ps.filter((l) => l.includes(world.dir) || sleeps.some((s) => l.trim().endsWith(` ${s}`) && /\bsleep \d+$/.test(l.trim())));
    if (left.length === 0) return;
    await sleep(100);
  }
  assert.deepEqual(left, [], "no helper outlives the run");
}

describe("the prompt files", () => {
  it("hold FIXED_PROMPTS' texts exactly, with no trailing newline, and nothing else", () => {
    const dir = path.join(KIT, "prompts");
    assert.deepEqual(readdirSync(dir).sort(), FIXED_PROMPTS.map((p) => `${p.id}.txt`).sort());
    for (const p of FIXED_PROMPTS) assert.equal(read(path.join(dir, `${p.id}.txt`)), p.text);
  });

});

const SHELLCHECK = ["/opt/homebrew/bin/shellcheck", "/usr/local/bin/shellcheck", ...SYSTEM_DIRS.map((d) => `${d}/shellcheck`)].find(
  (p) => existsSync(p),
);

describe("the kit's shell", () => {
  it("is POSIX sh that shellcheck accepts, with the fakes, when shellcheck is installed", { skip: SHELLCHECK ? false : "no shellcheck" }, () => {
    const files = [path.join(KIT, "run.sh"), ...readdirSync(FAKES).map((f) => path.join(FAKES, f))];
    const r = spawnSync(SHELLCHECK!, ["-s", "sh", ...files], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

for (const shell of SHELLS) {
  describe(`run.sh under ${shell}`, { concurrency: 6, timeout: 240_000 }, () => {
    it("parses as sh, and as bash --posix", () => {
      for (const [bin, args] of [[shell, ["-n"]], ["/bin/bash", ["--posix", "-n"]]] as const) {
        const r = spawnSync(bin, [...args, path.join(KIT, "run.sh")], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
      }
    });

    it("runs a Mac's two backends: every file, line by line, then the parser", async () => {
      const w = makeWorld("mac", { smoke: true });
      const r = await runKit(shell, w, { FAKE_TG_gpu: "60.5", FAKE_TG_cpu: "30.25", FAKE_HOLD: "2", ...SECRETS, LLAMA_ARG_THREADS: "3" });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");

      const run = kvFile(path.join(w.out, "run.txt"));
      assert.deepEqual(keysOf(path.join(w.out, "run.txt")), [
        ...RUN_KEYS, "layout_gpu", "layout_cpu", "finished", "seconds", "status",
      ]);
      assert.equal(run.kit, String(KIT_VERSION));
      assert.equal(run.subject, "test-q3_k_m");
      assert.equal(run.platform, "macos");
      assert.equal(run.backends, "gpu,cpu");
      assert.equal(run.prompts, "capital,sum,color");
      assert.deepEqual(
        [run.ctx, run.bench_prompt, run.bench_gen, run.bench_reps, run.answer_tokens, run.npu_sessions, run.threads],
        ["4096", "128", "16", "2", "64", "1", ""],
      );
      assert.deepEqual(
        [run.limit_fetch, run.limit_check, run.limit_bench, run.limit_answer, run.limit_total],
        ["600", "120", "180", "90", "900"],
      );
      assert.equal(run.layout_gpu, "flat");
      assert.equal(run.status, "done");
      assert.equal(Number(run.seconds), Number(run.finished) - Number(run.started));

      const dev = kvFile(path.join(w.out, "device.txt"));
      assert.deepEqual(keysOf(path.join(w.out, "device.txt")), [
        "platform", "kernel", "arch", "ram_kb", "cores", "disk_free_kb", "hw_model", "macos", "chip", "perf_cores", "memorystatus_level",
      ]);
      const memsize = Number(spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout.trim());
      assert.equal(dev.ram_kb, String(Math.floor(memsize / 1024)));
      assert.match(dev.disk_free_kb, /^\d+$/);
      assert.match(dev.chip, /\S/);

      const model = kvFile(path.join(w.out, "model.txt"));
      assert.deepEqual(keysOf(path.join(w.out, "model.txt")), [
        "path", "bytes_expected", "bytes", "sha256_expected", "sha256", "check", "tool", "seconds", "fetched", "fetch_seconds",
      ]);
      assert.deepEqual([model.bytes, model.sha256, model.check, model.fetched], [String(w.subject.bytes), w.subject.sha256, "ok", "0"]);

      assert.deepEqual(steps(w), [
        "check - - ok - rc=0",
        "list gpu - ok - rc=0",
        "bench gpu - ok - rc=0",
        "bench cpu - ok - rc=0",
        ...answers("gpu"),
        ...answers("cpu"),
      ]);
      assert.deepEqual(argsOf(w, "bench-gpu"), [
        "-m", w.model, "-p", "128", "-n", "16", "-r", "2", "-o", "jsonl", "-v", "-dev", "MTL0", "-ngl", "99",
      ]);
      assert.deepEqual(argsOf(w, "bench-cpu").slice(-4), ["-dev", "none", "-ngl", "0"]);
      assert.deepEqual(argsOf(w, "answer-gpu-sum"), [
        "-m", w.model, "--jinja", "-st", "-sysf", w.env.MM_SYSTEM_FILE, "-f", path.join(w.dir, "kit", "prompts", "sum.txt"),
        "-n", "64", "--temp", "0", "--seed", "42", "--no-display-prompt", "--simple-io", "--perf", "-sp", "-c", "4096",
        "-fit", "off", "-dev", "MTL0", "-ngl", "99",
      ]);
      assert.deepEqual(argsOf(w, "list-gpu"), ["--list-devices"]);

      // No secret and no LLAMA_ARG_ reaches a tool; the Mac build needs no library path.
      for (const name of readdirSync(w.log).filter((f) => f.endsWith(".env"))) {
        const text = read(path.join(w.log, name));
        for (const [key, value] of Object.entries(SECRETS)) {
          assert.ok(!text.includes(value) && !text.includes(`${key}=`), `${key} reaches ${name}`);
        }
        assert.ok(!/^LLAMA_ARG_|^LD_LIBRARY_PATH=|^ADSP_LIBRARY_PATH=/m.test(text), name);
      }

      // The bench log loses llama.cpp's per-tensor and Metal compile lines, and keeps the rest.
      const benchLog = read(path.join(w.out, "bench-gpu.log"));
      assert.ok(!/^(create_tensor|llama_graph_n_input_tensors|ggml_metal_library_compile)/m.test(benchLog));
      assert.match(benchLog, /^load_tensors: offloaded 53\/53 layers to GPU$/m);
      assert.equal(read(path.join(w.out, "bench-gpu.jsonl")).trim().split("\n").length, 2);

      // A Mac's memory lines: t=0 before the start, then rss_kb and level while it runs.
      const mem = read(path.join(w.out, "mem-bench-gpu.txt")).trim().split("\n");
      assert.match(mem[0], /^t=0 level=\d+$/);
      assert.ok(mem.slice(1).some((l) => /^t=\d+ rss_kb=\d+ level=\d+$/.test(l)), mem.join("\n"));
      assert.ok(!existsSync(path.join(w.out, "thermal-bench-gpu.txt")), "thermal files are Android's");

      // The kit's progress goes to stdout and kit.log alike, and it leaves no file of its own behind.
      assert.equal(read(path.join(w.out, "kit.log")), r.stdout);
      assert.deepEqual(readdirSync(w.out).filter((f) => f.startsWith(".")), []);

      const result = parse(w);
      assert.equal(result.status, "done");
      assert.equal(result.device.os, "macos");
      assert.equal(result.device.ramBytes, Math.floor(memsize / 1024) * 1024);
      assert.deepEqual(result.llama.builds, ["macos-arm64"]);
      assert.deepEqual(result.backends.map((b) => [b.backend, b.device, b.loaded, b.promptTps, b.genTps]), [
        ["gpu", "MTL0", true, 50.25, 60.5],
        ["cpu", "none", true, 50.25, 30.25],
      ]);
      assert.deepEqual(result.backends[0].buffersMiB, {
        "MTL0 model": 9000,
        "CPU_Mapped model": 120.75,
        "CPU KV": 50,
        "CPU compute": 30,
      });
      assert.equal(result.backends[0].offloaded, "53/53");
      assert.ok((result.backends[0].peakRssBytes ?? 0) > 0);
      assert.equal(result.completions.length, 6);
      assert.ok(result.completions.every((c) => c.right && c.finished && c.genTps === 504.4 && c.loadSeconds === 0.095));
      assert.deepEqual([result.verdict.rating, result.verdict.backend, result.verdict.answersRight], ["usable", "gpu", 3]);
    });

    it("runs an Android phone's three backends, fastest answers first, and leaves nothing running", async () => {
      const w = makeWorld("android");
      const r = await runKit(shell, w, {
        ...SECRETS,
        LLAMA_ARG_N_GPU_LAYERS: "7",
        MM_NPU_SESSIONS: "2",
        MM_LIMIT_BENCH: "917",
        MM_LIMIT_ANSWER: "419",
        FAKE_DEVICES: "GPUOpenCL,HTP0,HTP1",
        FAKE_HOLD: "2",
        FAKE_PP_cpu: "5.61",
        FAKE_TG_cpu: "3.01",
        FAKE_TG_gpu: "2.09",
        FAKE_TG_npu: "8.5",
        FAKE_ANSWERS_npu: "wrong",
        FAKE_ANSWERS_gpu: "glimmer",
      });
      assert.equal(r.code, 0, r.stderr);
      await assertNothingLeft(w, ["917", "419"]);

      assert.deepEqual(steps(w), [
        "check - - ok - rc=0",
        "bench cpu - ok - rc=0",
        "list gpu - ok - rc=0",
        "bench gpu - ok - rc=0",
        "list npu - ok - rc=0",
        "bench npu - ok - rc=0",
        ...answers("npu"),
        ...answers("cpu"),
        ...answers("gpu"),
      ]);
      const order = read(path.join(w.log, "order.txt")).trim().split("\n");
      assert.deepEqual(order, ["npu", "cpu", "gpu"].flatMap((b) => FIXED_PROMPTS.map((p) => `${b} ${p.id}`)));

      const run = kvFile(path.join(w.out, "run.txt"));
      assert.deepEqual([run.platform, run.layout_cpu, run.layout_gpu, run.layout_npu, run.npu_sessions], ["android", "flat", "bin-lib", "bin-lib", "2"]);

      assert.deepEqual(keysOf(path.join(w.out, "device.txt")), [
        "platform", "kernel", "arch", "ram_kb", "cores", "disk_free_kb", "manufacturer", "model", "brand", "device", "android",
        "sdk", "soc_manufacturer", "soc_model", "board", "hardware", "abi", "cpuset", "thermal_status", "battery_temp_dc",
      ]);
      const dev = kvFile(path.join(w.out, "device.txt"));
      assert.deepEqual(
        [dev.kernel, dev.arch, dev.ram_kb, dev.cores, dev.manufacturer, dev.model, dev.android, dev.sdk, dev.soc_model, dev.cpuset, dev.thermal_status, dev.battery_temp_dc],
        ["6.6.30-android15-fake", "aarch64", "23760480", "8", "QUALCOMM", "Fake Phone 24", "16", "36", "SM8850", "/top-app", "1", "312"],
      );
      // Never a serial number: the kit doesn't ask for one, and none is written.
      const asked = read(path.join(w.log, "getprop.asked"));
      assert.ok(!/serial/i.test(asked), asked);
      for (const name of readdirSync(w.out)) assert.ok(!read(path.join(w.out, name)).includes("FAKESERIAL"), name);

      // Each backend's build and environment.
      const env = (name: string) => read(path.join(w.log, `${name}.env`));
      const plain = w.env.MM_LLAMA_CPU;
      const lib = path.join(w.env.MM_LLAMA_GPU, "lib");
      assert.match(env("bench-cpu"), new RegExp(`^LD_LIBRARY_PATH=${plain}$`, "m"));
      assert.ok(!/^ADSP_LIBRARY_PATH=|^GGML_HEXAGON_DEVICES=/m.test(env("bench-cpu")));
      assert.match(env("bench-gpu"), new RegExp(`^LD_LIBRARY_PATH=${lib}$`, "m"));
      assert.match(env("bench-gpu"), new RegExp(`^ADSP_LIBRARY_PATH=${lib}$`, "m"));
      assert.ok(!/^GGML_HEXAGON_DEVICES=/m.test(env("bench-gpu")));
      assert.match(env("bench-npu"), /^GGML_HEXAGON_DEVICES=2$/m);
      assert.match(env("list-npu"), /^GGML_HEXAGON_DEVICES=2$/m);
      assert.match(env("answer-npu-sum"), /^GGML_HEXAGON_DEVICES=2$/m);
      for (const name of readdirSync(w.log).filter((f) => f.endsWith(".env"))) {
        const text = read(path.join(w.log, name));
        for (const value of Object.values(SECRETS)) assert.ok(!text.includes(value), `a secret reaches ${name}`);
        assert.ok(!/^LLAMA_ARG_/m.test(text), name);
      }
      assert.deepEqual(argsOf(w, "bench-cpu").slice(-4), ["-dev", "none", "-ngl", "0"]);
      assert.deepEqual(argsOf(w, "bench-gpu").slice(-4), ["-dev", "GPUOpenCL", "-ngl", "99"]);
      assert.deepEqual(argsOf(w, "bench-npu").slice(-6), ["-dev", "HTP0/HTP1", "-ngl", "99", "-ub", "1024"]);
      assert.deepEqual(argsOf(w, "answer-npu-color").slice(-6), ["-dev", "HTP0,HTP1", "-ngl", "99", "-ub", "1024"]);
      assert.deepEqual(argsOf(w, "answer-gpu-capital").slice(-4), ["-dev", "GPUOpenCL", "-ngl", "99"]);
      assert.equal(read(path.join(w.out, "list-npu.txt")).split("\n").filter((l) => /^ {2}HTP\d: /.test(l)).length, 2);

      // Android's memory lines: /proc/meminfo before the start, then the process's own numbers, and the heat.
      const mem = read(path.join(w.out, "mem-bench-cpu.txt")).trim().split("\n");
      assert.match(mem[0], /^t=0 free_kb=1200000 avail_kb=19600000 cached_kb=15000000 swap_free_kb=8000000 temp_mc=52500$/);
      assert.ok(
        mem.some((l) => /^t=\d+ free_kb=\d+ avail_kb=13232000 cached_kb=\d+ swap_free_kb=\d+ hwm_kb=5624832 rss_kb=4000000 anon_kb=1200000 file_kb=2800000 temp_mc=52500$/.test(l)),
        mem.join("\n"),
      );
      assert.deepEqual(kvFile(path.join(w.out, "thermal-bench-cpu.txt")), { before: "1", after: "1" });

      const result = parse(w);
      assert.equal(result.device.os, "android");
      assert.equal(result.device.apiLevel, 36);
      assert.equal(result.device.soc, "SM8850");
      assert.equal(result.device.marketedRamGiB, 24);
      assert.deepEqual(result.llama.builds, ["android-arm64", "android-arm64-snapdragon"]);
      const cpu = result.backends.find((b) => b.backend === "cpu")!;
      assert.deepEqual(
        [cpu.peakRssBytes, cpu.minAvailableBytes, cpu.availDropBytes, cpu.maxTempC],
        [5624832 * 1024, 13232000 * 1024, (19600000 - 13232000) * 1024, 52.5],
      );
      assert.equal(result.backends.find((b) => b.backend === "npu")!.device, "HTP0,HTP1");
      const gpuAnswers = result.completions.filter((c) => c.backend === "gpu");
      assert.deepEqual(gpuAnswers.map((c) => [c.answer, c.right, c.finished]), [
        ["Paris", true, true],
        ["42", true, true],
        ["", false, false],
      ]);
      assert.equal(result.verdict.rating, "slow");
      assert.equal(result.verdict.backend, "cpu");
      assert.deepEqual(result.verdict.reasons, [
        "npu: 0 of 3 answers right.",
        "cpu: 3.01 tokens a second with 3 of 3 answers right: slow (usable needs 4).",
        "It reads prompts at 5.61 tokens a second, so a 500-token prompt takes about 89 s before the first word.",
      ]);
    });

    it("stops a slow bench at its limit, and one that ignores TERM with the KILL 10 s later", async () => {
      const w = makeWorld("mac", { backends: ["cpu", "gpu"] });
      const t0 = Date.now();
      const r = await runKit(shell, w, { MM_LIMIT_BENCH: "2", FAKE_BENCH_cpu: "slow", FAKE_BENCH_gpu: "stubborn" });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "", "no Terminated notice from the shell");
      assert.ok(Date.now() - t0 < 40_000);
      assert.deepEqual(steps(w), [
        "check - - ok - rc=0",
        "bench cpu - timeout limit rc=143",
        "list gpu - ok - rc=0",
        "bench gpu - timeout limit rc=137",
        ...skippedAnswers("cpu", "noload"),
        ...skippedAnswers("gpu", "noload"),
      ]);
      const lines = read(path.join(w.out, "steps.txt")).split("\n");
      const seconds = (backend: string) => Number(/seconds=(\d+)/.exec(lines.find((l) => l.startsWith(`name=bench backend=${backend}`))!)![1]);
      assert.ok(seconds("cpu") >= 2 && seconds("cpu") <= 4, `cpu took ${seconds("cpu")} s`);
      assert.ok(seconds("gpu") >= 12 && seconds("gpu") <= 15, `gpu took ${seconds("gpu")} s`);
      assert.deepEqual(readdirSync(w.out).filter((f) => f.startsWith(".")), [], "no marker is left");
      for (const backend of ["cpu", "gpu"]) {
        const pid = Number(read(path.join(w.log, `bench-${backend}.pid`)));
        assert.throws(() => process.kill(pid, 0), `the ${backend} bench is gone`);
      }

      const result = parse(w);
      assert.deepEqual(result.backends.map((b) => [b.end, b.why, b.loaded, b.promptTps, b.genTps]), [
        ["timeout", "limit", true, 50.25, null],
        ["timeout", "limit", true, 50.25, null],
      ]);
      assert.equal(result.verdict.rating, "unusable");
      assert.match(result.verdict.reasons[0], /^cpu: the bench ran out of time after [234] s before measuring generation\.$/);
    });

    it("tells a low-memory kill from a load error and a missing backend, and gives no answers without a bench", async () => {
      const w = makeWorld("android");
      const r = await runKit(shell, w, { FAKE_BENCH_cpu: "lmk", FAKE_HOLD: "2", FAKE_BENCH_gpu: "error", FAKE_DEVICES: "GPUOpenCL" });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(steps(w), [
        "check - - ok - rc=0",
        "bench cpu - killed lmk rc=137",
        "list gpu - ok - rc=0",
        "bench gpu - error - rc=1",
        "list npu - ok - rc=0",
        "bench npu - skipped unavailable rc=-",
        ...skippedAnswers("cpu", "noload"),
        ...skippedAnswers("gpu", "noload"),
        ...skippedAnswers("npu", "noload"),
      ]);
      const pid = read(path.join(w.log, "bench-cpu.pid")).trim();
      const lmk = read(path.join(w.out, "lmk-bench-cpu.txt"));
      assert.match(lmk, new RegExp(`lowmemorykiller: Kill 'llama-bench' \\(${pid}\\)`));
      assert.match(lmk, new RegExp(`killinfo: \\[${pid},`));
      assert.ok(!lmk.includes("ActivityManager"), "only the lines naming the pid");
      assert.match(read(path.join(w.log, "logcat.args")), /^-d -b main,system,events$/m);

      const result = parse(w);
      const [cpu, gpu, npu] = result.backends;
      assert.deepEqual([cpu.end, cpu.why, cpu.loaded, cpu.promptTps], ["killed", "lmk", true, 50.25]);
      assert.equal(cpu.peakRssBytes, 5624832 * 1024);
      assert.deepEqual([gpu.end, gpu.loaded, gpu.error], ["error", false, "llama_model_load: error loading model: unable to allocate GPUOpenCL buffer"]);
      assert.deepEqual([npu.end, npu.why, npu.available], ["skipped", "unavailable", false]);
      assert.equal(result.verdict.rating, "unusable");
      assert.deepEqual(result.verdict.reasons, [
        "cpu: the bench was killed by the low-memory killer.",
        "gpu: it didn't load (llama_model_load: error loading model: unable to allocate GPUOpenCL buffer).",
        "npu: not run, its device isn't on this one.",
        "No backend ran with enough right answers and without a kill.",
      ]);
    });

    it("tells a low-memory kill of an answer, and a SIGKILL with no log on Linux, and a crash", async () => {
      const phone = makeWorld("android", { backends: ["cpu"] });
      const board = makeWorld("linux", { backends: ["cpu"] });
      const mac = makeWorld("mac", { backends: ["cpu"] });
      const [a, b, c] = await Promise.all([
        runKit(shell, phone, { FAKE_ANSWERS_cpu: "lmk", MM_PROMPTS: "capital,sum" }),
        runKit(shell, board, { FAKE_BENCH_cpu: "signal9" }),
        runKit(shell, mac, { FAKE_BENCH_cpu: "crash" }),
      ]);
      assert.deepEqual([a.code, b.code, c.code], [0, 0, 0]);

      assert.deepEqual(steps(phone), [
        "check - - ok - rc=0",
        "bench cpu - ok - rc=0",
        "answer cpu capital killed lmk rc=137",
        "answer cpu sum killed lmk rc=137",
      ]);
      assert.match(read(path.join(phone.out, "lmk-answer-cpu-sum.txt")), /lowmemorykiller: Kill 'llama-completion'/);
      const answerKill = parse(phone);
      assert.deepEqual(answerKill.verdict.reasons, [
        "cpu: an answer was killed by the low-memory killer.",
        "No backend ran with enough right answers and without a kill.",
      ]);

      assert.deepEqual(steps(board).slice(1, 2), ["bench cpu - killed signal9 rc=137"]);
      assert.ok(!existsSync(path.join(board.out, "lmk-bench-cpu.txt")));
      const dev = kvFile(path.join(board.out, "device.txt"));
      assert.deepEqual([dev.platform, dev.ram_kb, dev.cores, dev.cpu], ["linux", "23760480", "8", "Fake ARMv9 core"]);
      assert.deepEqual(keysOf(path.join(board.out, "device.txt")).slice(6), ["os_release", "cpu"]);
      assert.equal(kvFile(path.join(board.out, "model.txt")).check, "ok", "the size came from wc -c where stat -c failed");
      assert.equal(parse(board).verdict.reasons[0], "cpu: the bench was killed (SIGKILL, with no low-memory log).");

      assert.deepEqual(steps(mac).slice(1, 2), ["bench cpu - crashed signal14 rc=142"]);
      const crashed = parse(mac).verdict;
      assert.equal(crashed.rating, "failed");
      assert.deepEqual(crashed.reasons, [
        "It didn't load on any backend.",
        "cpu: the bench crashed (signal 14) before its first result.",
      ]);
    });

    it("skips gpu and npu below Android 14, a backend without a build, and runs the NPU on the sessions it lists", async () => {
      const old = makeWorld("android");
      const fewer = makeWorld("android", { backends: ["npu"] });
      const [a, b] = await Promise.all([
        runKit(shell, old, { FAKE_SDK: "33", MM_LLAMA_NPU: path.join(old.dir, "empty") }),
        runKit(shell, fewer, { MM_NPU_SESSIONS: "3", FAKE_DEVICES: "HTP0" }),
      ]);
      assert.deepEqual([a.code, b.code], [0, 0]);
      // The backends with nothing to rank get their skipped answers first, then the ranked ones answer.
      assert.deepEqual(steps(old), [
        "check - - ok - rc=0",
        "bench cpu - ok - rc=0",
        "bench gpu - skipped android_sdk rc=-",
        "bench npu - skipped nobuild rc=-",
        ...skippedAnswers("gpu", "noload"),
        ...skippedAnswers("npu", "noload"),
        ...answers("cpu"),
      ]);
      assert.equal(kvFile(path.join(old.out, "run.txt")).layout_npu, "missing");
      const parsedOld = parse(old);
      assert.deepEqual(parsedOld.backends.map((x) => x.available), [true, false, true]);
      assert.equal(parsedOld.verdict.reasons[0], "gpu: not run, the Snapdragon build needs Android 14.");

      assert.equal(kvFile(path.join(fewer.out, "run.txt")).npu_sessions_used, "1");
      assert.deepEqual(argsOf(fewer, "bench-npu").slice(-6), ["-dev", "HTP0", "-ngl", "99", "-ub", "1024"]);
      assert.match(read(path.join(fewer.log, "bench-npu.env")), /^GGML_HEXAGON_DEVICES=1$/m);
      assert.match(read(path.join(fewer.log, "list-npu.env")), /^GGML_HEXAGON_DEVICES=3$/m);
      assert.deepEqual(argsOf(fewer, "answer-npu-sum").slice(-6), ["-dev", "HTP0", "-ngl", "99", "-ub", "1024"]);
      const parsedFewer = parse(fewer);
      assert.equal(parsedFewer.backends[0].device, "HTP0");
      assert.ok(parsedFewer.notes.some((n) => n.includes("listed 1 of the 3 Hexagon sessions")));
    });

    it("fails on a wrong sha256 or size with exit 3, and goes on without a sha256 tool", async () => {
      const sha = makeWorld("mac", { backends: ["cpu"] });
      const size = makeWorld("mac", { backends: ["cpu"] });
      const noTool = makeWorld("mac", { backends: ["cpu"], hash: false });
      const [a, b, c] = await Promise.all([
        runKit(shell, sha, { MM_MODEL_SHA256: "f".repeat(64) }),
        runKit(shell, size, { MM_MODEL_BYTES: String(size.subject.bytes + 1) }),
        runKit(shell, noTool),
      ]);
      assert.deepEqual([a.code, b.code, c.code], [3, 3, 0]);

      assert.deepEqual(steps(sha), ["check - - error sha256 rc=0", "bench cpu - skipped model rc=-"]);
      const shaRun = kvFile(path.join(sha.out, "run.txt"));
      assert.deepEqual([shaRun.status, shaRun.why], ["failed", "model"]);
      const shaModel = kvFile(path.join(sha.out, "model.txt"));
      assert.deepEqual([shaModel.check, shaModel.sha256, shaModel.sha256_expected], ["sha256", sha.subject.sha256, "f".repeat(64)]);
      assert.ok(!existsSync(path.join(sha.log, "bench-cpu.args")), "nothing ran on a wrong file");
      assert.deepEqual(parse(sha).verdict, {
        rating: "failed", backend: null, genTps: null, promptTps: null, answersRight: 0, answersTotal: 0,
        reasons: ["The model file's sha256 doesn't match the pinned one."],
      });

      assert.deepEqual(steps(size), ["check - - error size rc=-", "bench cpu - skipped model rc=-"]);
      assert.equal(kvFile(path.join(size.out, "model.txt")).check, "size");
      assert.match(parse(size).verdict.reasons[0], /^The model file has \d+ bytes, not \d+\.$/);

      assert.deepEqual(steps(noTool).slice(0, 2), ["check - - skipped no_tool rc=-", "bench cpu - ok - rc=0"]);
      assert.equal(kvFile(path.join(noTool.out, "model.txt")).check, "no_tool");
      const parsed = parse(noTool);
      assert.equal(parsed.verdict.rating, "usable");
      assert.ok(parsed.notes.some((n) => n.startsWith("The device has no sha256 tool")));
    });

    it("downloads a missing model itself, and fails with exit 3 without curl, on a refused or a short download", async () => {
      const worlds4 = [
        makeWorld("android", { backends: ["cpu"], curl: true }),
        makeWorld("android", { backends: ["cpu"] }),
        makeWorld("android", { backends: ["cpu"], curl: true }),
        makeWorld("android", { backends: ["cpu"], curl: true }),
      ];
      const [ok, noCurl, refused, short] = worlds4;
      for (const w of worlds4) rmSync(w.model);
      const url = `https://huggingface.co/${ok.subject.repo}/resolve/${ok.subject.revision}/m.gguf`;
      const fetchEnv = (w: World, extra: Record<string, string> = {}) => ({
        MM_MODEL_URL: url,
        FAKE_CURL_FROM: path.join(w.dir, "model.copy"),
        ...extra,
      });
      const runs = await Promise.all([
        runKit(shell, ok, fetchEnv(ok)),
        runKit(shell, noCurl, fetchEnv(noCurl)),
        runKit(shell, refused, fetchEnv(refused, { FAKE_CURL: "fail" })),
        runKit(shell, short, fetchEnv(short, { FAKE_CURL: "short" })),
      ]);
      assert.deepEqual(runs.map((x) => x.code), [0, 3, 3, 3]);

      assert.deepEqual(argsOf(ok, "curl"), ["-fL", "-sS", "--retry", "5", "--retry-delay", "10", "-C", "-", "-o", `${ok.model}.part`, url]);
      assert.deepEqual(steps(ok).slice(0, 3), ["fetch - - ok - rc=0", "check - - ok - rc=0", "bench cpu - ok - rc=0"]);
      const model = kvFile(path.join(ok.out, "model.txt"));
      assert.deepEqual([model.fetched, model.check], ["1", "ok"]);
      assert.match(model.fetch_seconds, /^\d+$/);
      assert.ok(existsSync(ok.model) && !existsSync(`${ok.model}.part`));
      assert.ok(!existsSync(path.join(ok.out, "fetch.log")), "no fetch.log without an error");
      assert.equal(parse(ok).model.fetched, true);

      assert.deepEqual(steps(noCurl), ["fetch - - skipped no_curl rc=-", "bench cpu - skipped model rc=-"]);
      const noCurlRun = kvFile(path.join(noCurl.out, "run.txt"));
      assert.deepEqual([noCurlRun.status, noCurlRun.why], ["failed", "no_curl"]);
      assert.equal(kvFile(path.join(noCurl.out, "model.txt")).check, "missing");
      const noCurlResult = parse(noCurl);
      assert.deepEqual(noCurlResult.verdict.reasons, ["The model file wasn't on the device."]);
      assert.ok(noCurlResult.notes.includes("The device has no curl, so the kit couldn't download the model."));

      assert.deepEqual(steps(refused), ["fetch - - error - rc=22", "bench cpu - skipped model rc=-"]);
      assert.equal(kvFile(path.join(refused.out, "run.txt")).why, "fetch");
      const fetchLog = read(path.join(refused.out, "fetch.log"));
      assert.match(fetchLog, /^curl: \(22\) The requested URL returned error: 403 for https:\/\/cdn\.example\.test\/m\.gguf$/m);
      for (const name of readdirSync(refused.out)) {
        assert.ok(!/X-Amz|fake-signature|fake-credential/.test(read(path.join(refused.out, name))), `a signed URL is in ${name}`);
      }
      const refusedResult = parse(refused);
      assert.deepEqual(refusedResult.verdict.reasons, ["The model file wasn't on the device and the kit's download failed."]);
      assert.ok(refusedResult.notes.some((n) => n.startsWith("The kit's download failed or ran out of time: curl: (22)")));

      assert.deepEqual(steps(short), ["fetch - - error size rc=0", "bench cpu - skipped model rc=-"]);
      assert.ok(!existsSync(`${short.model}.part`) && !existsSync(short.model), "a download of the wrong size isn't kept");
    });

    it("skips a phone with too little RAM before anything is checked or run", async () => {
      // A 30 GB file: kitEnvFor's MM_MIN_RAM_KB is its run need, above the fake phone's 23,760,480 kB.
      const w = makeWorld("android", { curl: true, bytes: 30_000_000_000 });
      rmSync(w.model);
      assert.equal(w.env.MM_MIN_RAM_KB, String(Math.ceil(31_200_000_000 / 1024)));
      const r = await runKit(shell, w, { MM_MODEL_URL: "https://huggingface.co/x/y/resolve/main/m.gguf" });
      assert.equal(r.code, 0, r.stderr);
      const run = kvFile(path.join(w.out, "run.txt"));
      assert.deepEqual([run.status, run.why], ["skipped", "ram"]);
      assert.equal(kvFile(path.join(w.out, "model.txt")).check, "skipped");
      assert.deepEqual(steps(w), ["bench cpu - skipped ram rc=-", "bench gpu - skipped ram rc=-", "bench npu - skipped ram rc=-"]);
      assert.deepEqual(readdirSync(w.out).sort(), ["device.txt", "kit.log", "model.txt", "run.txt", "steps.txt"]);
      assert.ok(!existsSync(path.join(w.log, "curl.args")) && !existsSync(path.join(w.log, "bench-cpu.args")));
      const result = parse(w);
      assert.equal(result.status, "skipped");
      assert.deepEqual(result.llama.builds, [], "no build ran");
      assert.deepEqual(result.verdict.reasons, ["This phone has 24 GB of RAM and the file's run needs 31.2 GB."]);
      assert.equal(result.verdict.rating, "unusable");
    });

    it("cuts the run once under 30 s of MM_LIMIT_TOTAL are left", async () => {
      const w = makeWorld("mac", { backends: ["cpu", "gpu"] });
      const r = await runKit(shell, w, { MM_LIMIT_TOTAL: "35", FAKE_HOLD: "7" });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(steps(w), [
        "check - - ok - rc=0",
        "bench cpu - ok - rc=0",
        "bench gpu - skipped time rc=-",
        ...skippedAnswers("gpu", "time"),
        ...skippedAnswers("cpu", "time"),
      ]);
      const run = kvFile(path.join(w.out, "run.txt"));
      assert.deepEqual([run.status, run.why], ["cut", "time"]);
      assert.ok(Number(/limit=(\d+)/.exec(read(path.join(w.out, "steps.txt")).split("\n")[1])![1]) <= 35);
      const result = parse(w);
      assert.equal(result.status, "cut");
      assert.deepEqual(result.verdict.reasons.slice(0, 2), ["cpu: answers not asked, out of time.", "gpu: not run, out of time."]);
    });

    it("caps a long answer at 64 KiB and a long log at 256 KiB, keeping both ends", async () => {
      const w = makeWorld("mac", { backends: ["cpu"] });
      const r = await runKit(shell, w, { FAKE_ANSWERS_cpu: "big", MM_PROMPTS: "capital" });
      assert.equal(r.code, 0, r.stderr);
      const cut = "\n[... cut by the kit ...]\n";
      const answer = read(path.join(w.out, "answer-cpu-capital.txt"));
      assert.equal(Buffer.byteLength(answer), 49152 + cut.length + 16384);
      assert.ok(answer.startsWith("START") && answer.endsWith("END") && answer.includes(cut));
      const log = read(path.join(w.out, "answer-cpu-capital.log"));
      assert.equal(Buffer.byteLength(log), 196608 + cut.length + 65536);
      assert.ok(log.startsWith("0.00.019.045 I llama_completion") && log.endsWith("LOGEND") && log.includes(cut));
      const result = parse(w);
      assert.equal(result.completions[0].genTps, 504.4, "the perf lines survive the cap");
      assert.equal(result.completions[0].raw.length, 4000);
    });

    it("stops cleanly on a TERM from outside: the tool is killed and run.txt says why", async () => {
      const w = makeWorld("mac", { backends: ["cpu"] });
      const pidFile = path.join(w.log, "bench-cpu.pid");
      const r = await runKit(shell, w, { FAKE_BENCH_cpu: "slow", MM_LIMIT_BENCH: "60" }, async (pid) => {
        for (let i = 0; i < 200 && !existsSync(pidFile); i++) await sleep(50);
        await sleep(300);
        process.kill(pid, "SIGTERM");
      });
      assert.equal(r.code, 143, r.stderr);
      const run = kvFile(path.join(w.out, "run.txt"));
      assert.deepEqual([run.status, run.why], ["cut", "signal"]);
      assert.deepEqual(steps(w), ["check - - ok - rc=0"]);
      const tool = Number(read(pidFile));
      for (let i = 0; i < 20 && isAlive(tool); i++) await sleep(100);
      assert.ok(!isAlive(tool), "the bench was killed with the kit");
      await assertNothingLeft(w, []);
      const result = parse(w);
      assert.equal(result.status, "cut");
      assert.deepEqual(result.backends.map((b) => [b.end, b.why]), [["skipped", "stopped"]]);
      assert.deepEqual(result.completions.map((c) => c.why), ["stopped", "stopped", "stopped"]);
      assert.ok(result.notes.includes("A signal from outside stopped the kit before it finished."));
    });

    it("deletes the model at the end only when MM_CLEANUP asks", async () => {
      const keep = makeWorld("mac", { backends: ["cpu"] });
      const clean = makeWorld("mac", { backends: ["cpu"] });
      const [a, b] = await Promise.all([runKit(shell, keep), runKit(shell, clean, { MM_CLEANUP: "model" })]);
      assert.deepEqual([a.code, b.code], [0, 0]);
      assert.ok(existsSync(keep.model));
      assert.ok(!existsSync(clean.model));
      const run = kvFile(path.join(clean.out, "run.txt"));
      assert.deepEqual([run.cleanup, run.removed, run.status], ["model", "1", "done"]);
      assert.equal(kvFile(path.join(keep.out, "run.txt")).removed, undefined);
    });

    it("refuses bad inputs with one line and exit 2, writing nothing", async () => {
      const w = makeWorld("mac", { backends: ["cpu"] });
      const cases: Array<[string, Record<string, string | undefined>]> = [
        ["MM_OUT is not set", { MM_OUT: undefined }],
        ["MM_BACKENDS is not set", { MM_BACKENDS: undefined }],
        ["MM_MODEL_SHA256 must be 64 lowercase hex characters", { MM_MODEL_SHA256: "A".repeat(64) }],
        ["MM_MODEL_SHA256 must be 64 lowercase hex characters", { MM_MODEL_SHA256: "abc" }],
        ["MM_MODEL_BYTES must be the file's size in bytes", { MM_MODEL_BYTES: "0" }],
        ["MM_MODEL_BYTES must be the file's size in bytes", { MM_MODEL_BYTES: "12a" }],
        ["MM_BACKENDS has an unknown backend: tpu", { MM_BACKENDS: "cpu,tpu" }],
        ["MM_BACKENDS names cpu twice", { MM_BACKENDS: "cpu,cpu" }],
        ["no build folder is set for the gpu backend", { MM_BACKENDS: "cpu,gpu", MM_LLAMA_GPU: undefined }],
        ["no prompt file for missing in the kit's prompts folder", { MM_PROMPTS: "capital,missing" }],
        ["MM_MODEL has a character the kit can't take", { MM_MODEL: "/tmp/m.gguf;reboot" }],
        ["MM_SUBJECT has a character the kit can't take", { MM_SUBJECT: "a b" }],
        ["MM_LIMIT_TOTAL must be a whole number below 1000000000", { MM_LIMIT_TOTAL: "010" }],
        ["MM_LIMIT_TOTAL must be at least 1", { MM_LIMIT_TOTAL: "0" }],
        ["MM_NPU_SESSIONS must be 16 or less", { MM_NPU_SESSIONS: "17" }],
        ["MM_SYSTEM_FILE isn't a readable file", { MM_SYSTEM_FILE: path.join(w.dir, "nope.txt") }],
        ["MM_MODEL_URL must be an http or https URL", { MM_MODEL_URL: "ftp://example.test/m.gguf" }],
        ["MM_CLEANUP takes only the value model", { MM_CLEANUP: "all" }],
      ];
      for (const [message, extra] of cases) {
        const r = await runKit(shell, w, extra);
        assert.equal(r.code, 2, message);
        assert.equal(r.stdout, "", message);
        assert.equal(r.stderr, `run.sh: ${message}\n`);
        assert.ok(!existsSync(w.out), `${message}: MM_OUT was created`);
      }
      mkdirSync(w.out);
      writeFileSync(path.join(w.out, "old.txt"), "from an earlier run\n");
      const r = await runKit(shell, w);
      assert.deepEqual([r.code, r.stderr], [2, "run.sh: MM_OUT isn't empty\n"]);
      assert.deepEqual(readdirSync(w.out), ["old.txt"]);
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
