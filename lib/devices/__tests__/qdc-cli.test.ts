/**
 * The QDC runner's glue (scripts/devices/qdc.ts) with submit.py replaced by a fake executor that writes what the real
 * one writes (job.json and the kit folders, built here from the Oct 28 session's real llama.cpp output): plan without
 * calls, no key means nothing built, the probe batch from zips to results, probes into targets.json, the next plan by
 * RAM, pairs that already have a result, the child's environment, a zip refused for a secret, and fetch. It writes
 * into a temporary repo and cache; nothing reaches QDC or the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/qdc-cli.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseQdcArgs, runQdc, type Exec } from "../../../scripts/devices/qdc";
import { unzipBytes, type QdcManifest } from "../qdc";
import { QDC_SDK, SMOKE } from "../subjects";
import type { Result } from "../types";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = path.join(REPO, "devices", "qdc", "tests", "fixtures", "sm8850-session");
const RAM: Record<string, number> = { SM8850: 23_760_480, SM8750: 11_745_000, SM8650: 15_500_000 };
const KEY = "qdc_test_key_not_real_0123456789abcdef";
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

/** A kit folder as the carrier's files come back from QDC: the smoke subject's real Oct 28 output on three backends. */
function writeKitOutput(dir: string, subjectId: string, chipset: string): void {
  mkdirSync(dir, { recursive: true });
  const t = 1_793_240_000;
  const kv = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join("");
  writeFileSync(path.join(dir, "run.txt"), kv({ kit: 1, subject: subjectId, platform: "android", backends: "cpu,gpu,npu", prompts: "capital,sum,color", ctx: 4096, bench_prompt: 128, bench_gen: 16, bench_reps: 2, answer_tokens: 64, npu_sessions: 1, threads: "", started: t, layout_cpu: "flat", layout_gpu: "bin-lib", layout_npu: "bin-lib", finished: t + 300, seconds: 300, status: "done" }));
  writeFileSync(path.join(dir, "device.txt"), kv({ platform: "android", kernel: "6.6.30", arch: "aarch64", ram_kb: RAM[chipset], cores: 8, disk_free_kb: 45_000_000, manufacturer: "QUALCOMM", model: "QRD", android: "16", sdk: 36, soc_manufacturer: "QTI", soc_model: chipset }));
  writeFileSync(path.join(dir, "model.txt"), kv({ path: "/data/local/tmp/mm/model/x.gguf", bytes_expected: SMOKE.bytes, bytes: SMOKE.bytes, sha256_expected: SMOKE.sha256, sha256: SMOKE.sha256, check: "ok", tool: "sha256sum", seconds: 1, fetched: 1, fetch_seconds: 8 }));
  const step = (name: string, backend: string, prompt: string, end = "ok") => `name=${name} backend=${backend} prompt=${prompt} start=${t} seconds=2 limit=180 rc=0 end=${end} why=-\n`;
  let steps = step("fetch", "-", "-") + step("check", "-", "-");
  for (const b of ["cpu", "gpu", "npu"]) {
    if (b !== "cpu") steps += step("list", b, "-");
    steps += step("bench", b, "-");
    writeFileSync(path.join(dir, `bench-${b}.jsonl`), fixture(`smoke-bench-${b}.jsonl`));
  }
  for (const b of ["npu", "gpu", "cpu"]) {
    for (const p of ["capital", "sum", "color"]) {
      steps += step("answer", b, p);
      writeFileSync(path.join(dir, `answer-${b}-${p}.txt`), fixture(`smoke-answer-cpu-${p}.out`));
      writeFileSync(path.join(dir, `answer-${b}-${p}.log`), fixture(`smoke-answer-cpu-${p}.err`));
    }
  }
  writeFileSync(path.join(dir, "steps.txt"), steps);
  writeFileSync(path.join(dir, "host.txt"), kv({ carrier: 1, run: "x", subject: subjectId, push_seconds: 41, kit_exit: 0, kit_seconds: 300, limit_seconds: 1920, stopped: 0, adb_errors: 0, files: 30 }));
}

function jobRecord(job: { key: string; chipset: string; name: string }, jobId: number, subjects: string[]) {
  return { version: 1, key: job.key, chipset: job.chipset, name: job.name, targetId: `t-${job.chipset}`, marketingName: `${job.chipset} marketing`, jobId, submittedAt: "2026-10-28T22:15:01Z", startedAt: "2026-10-28T22:16:00Z", finishedAt: "2026-10-28T22:25:00Z", state: "Completed", result: "Successful", logStatus: "Completed", aborted: null, error: null, logs: [{ name: "01-logs.zip", bytes: 1000, kind: "zip", error: null }], subjects, carrierLog: true };
}

interface Rig {
  tmp: string;
  repo: string;
  cache: string;
  calls: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }>;
  zips: Map<string, { names: string[]; plan: string }>;
  lines: string[];
  keyOk: boolean;
}

function makeRig(): Rig {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mm-qdc-cli-"));
  const repo = path.join(tmp, "repo");
  cpSync(path.join(REPO, "devices", "kit"), path.join(repo, "devices", "kit"), { recursive: true });
  cpSync(path.join(REPO, "devices", "qdc", "carrier"), path.join(repo, "devices", "qdc", "carrier"), { recursive: true, filter: (p) => !p.includes("__pycache__") });
  cpSync(path.join(REPO, "devices", "qdc", "submit-requirements.txt"), path.join(repo, "devices", "qdc", "submit-requirements.txt"));
  writeFileSync(path.join(repo, "devices", "qdc", "targets.json"), "[]\n");
  // A venv that is already made, so ensureVenv returns without running uv.
  const cache = path.join(tmp, "cache");
  const venv = path.join(cache, "qdc", "venv-0.2.3");
  mkdirSync(path.join(venv, "bin"), { recursive: true });
  writeFileSync(path.join(venv, "bin", "python"), "");
  const requirements = readFileSync(path.join(repo, "devices", "qdc", "submit-requirements.txt"), "utf8");
  writeFileSync(path.join(venv, ".mm-ready"), `${createHash("sha256").update(`${QDC_SDK.wheelSha256}\n${requirements}`).digest("hex")}\n`);
  return { tmp, repo, cache, calls: [], zips: new Map(), lines: [], keyOk: true };
}

/** submit.py as an executor: check, run (reads the manifest, writes each job's job.json and kit folder) and fetch. */
function fakeSubmit(rig: Rig): Exec {
  let nextJob = 1001;
  return async (cmd, args, options) => {
    rig.calls.push({ cmd, args: [...args], env: { ...options.env } });
    const [flag, script, command, ...rest] = args;
    assert.equal(flag, "-I");
    assert.ok(script.endsWith(path.join("devices", "qdc", "submit.py")));
    if (command === "check") return rig.keyOk ? { code: 0, stdout: '{"ok": true, "source": "environment"}\n' } : { code: 2, stdout: "" };
    if (command === "run") {
      const manifest = JSON.parse(readFileSync(rest[1], "utf8")) as QdcManifest;
      const records = manifest.jobs.map((job) => {
        const files = unzipBytes(readFileSync(job.zip));
        const subject = /MM_SUBJECTS=(.*)/.exec(files.find((f) => f.name === "mm/plan/run.env")?.data.toString() ?? "")?.[1] ?? "";
        rig.zips.set(job.key, { names: files.map((f) => f.name), plan: files.find((f) => f.name === `mm/plan/${subject}.env`)?.data.toString() ?? "" });
        writeKitOutput(path.join(job.outDir, "out", subject), subject, job.chipset);
        const record = jobRecord(job, nextJob++, [subject]);
        writeFileSync(path.join(job.outDir, "job.json"), JSON.stringify(record));
        return record;
      });
      return { code: 0, stdout: JSON.stringify({ version: 1, jobs: records }) };
    }
    if (command === "fetch") {
      const out = rest[rest.indexOf("--out") + 1];
      const job = { key: "20261028T221500Z-SM8650-1", chipset: "SM8650", name: "mm SM8650 20261028T221500Z" };
      writeKitOutput(path.join(out, "out", SMOKE.id), SMOKE.id, "SM8650");
      writeFileSync(path.join(out, "job.json"), JSON.stringify(jobRecord(job, Number(rest[rest.indexOf("--job") + 1]), [SMOKE.id])));
      return { code: 0, stdout: "{}" };
    }
    return { code: 1, stdout: "" };
  };
}

async function fakeBuilds(rig: Rig, plant = "") {
  const plain = path.join(rig.tmp, "builds", "plain", "llama-b11669");
  const snap = path.join(rig.tmp, "builds", "snap", "llama-b11669");
  for (const f of ["llama-bench", "llama-completion", "libllama.so", "libggml-base.so", "libllama-server-impl.so", "LICENSE"]) {
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(plain, f), `${f}${plant}`);
  }
  for (const f of ["bin/llama-bench", "bin/llama-completion", "bin/llama-server", "lib/libllama.so", "lib/libggml-cpu.so", "lib/libggml-opencl.so", "lib/libggml-hexagon.so", "lib/libggml-htp-v81.so", "include/ggml.h"]) {
    mkdirSync(path.dirname(path.join(snap, f)), { recursive: true });
    writeFileSync(path.join(snap, f), f);
  }
  return { "android-arm64": plain, "android-arm64-snapdragon": snap } as const;
}

function deps(rig: Rig, env: Record<string, string> = {}, plant = "") {
  return {
    exec: fakeSubmit(rig),
    repoRoot: rig.repo,
    cache: rig.cache,
    env: { PATH: "/usr/bin:/bin", HOME: rig.tmp, ...env },
    now: () => new Date("2026-10-28T22:15:00Z"),
    say: (line: string) => rig.lines.push(line),
    stageBuilds: async () => fakeBuilds(rig, plant),
    fetchImpl: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
  };
}

function results(rig: Rig): Result[] {
  const out: Result[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name === "result.json") out.push(JSON.parse(readFileSync(path.join(dir, e.name), "utf8")) as Result);
    }
  };
  walk(path.join(rig.repo, "devices", "results", "qdc"));
  return out.sort((a, b) => (a.device.cloudId ?? "").localeCompare(b.device.cloudId ?? ""));
}

describe("the QDC runner", () => {
  const rigs: Rig[] = [];
  after(() => {
    for (const rig of rigs) rmSync(rig.tmp, { recursive: true, force: true });
  });

  it("plans without calling anything, and builds nothing without a key", async () => {
    const rig = makeRig();
    rigs.push(rig);
    assert.equal(await runQdc(parseQdcArgs(["plan"]), deps(rig)), 0);
    assert.equal(rig.calls.length, 0);
    assert.match(rig.lines.join("\n"), /3 jobs \(at most 3\)/);
    assert.match(rig.lines.join("\n"), /To run it:\n  npx tsx scripts\/devices\/qdc\.ts run --yes$/m);
    assert.equal(await runQdc(parseQdcArgs(["run"]), deps(rig)), 0, "run without --yes only plans");
    assert.equal(rig.calls.length, 0);

    rig.keyOk = false;
    assert.equal(await runQdc(parseQdcArgs(["run", "--yes"]), deps(rig)), 2);
    assert.deepEqual(rig.calls.map((c) => c.args[2]), ["check"]);
    assert.ok(!existsSync(path.join(rig.cache, "qdc", "runs")), "no zip was built");
    assert.match(rig.lines.join("\n"), /No usable QDC key, so nothing was submitted/);
  });

  it("runs the probes, writes their results and records their RAM, then plans the files", async () => {
    const rig = makeRig();
    rigs.push(rig);
    const code = await runQdc(parseQdcArgs(["run", "--yes"]), deps(rig, { QDC_API_KEY: KEY, HF_TOKEN: "hf_test_value_123456", AWS_SECRET_ACCESS_KEY: "aws_test_value_123456" }));
    assert.equal(code, 0, rig.lines.join("\n"));
    assert.deepEqual(rig.calls.map((c) => c.args[2]), ["check", "run"]);
    for (const call of rig.calls) {
      assert.equal(call.env.QDC_API_KEY, KEY, "submit.py gets the key from the environment");
      assert.equal(call.env.HF_TOKEN, undefined, "no other token reaches the child");
      assert.equal(call.env.AWS_SECRET_ACCESS_KEY, undefined);
    }

    const stamp = "20261028T221500Z";
    const manifest = JSON.parse(readFileSync(path.join(rig.cache, "qdc", "runs", stamp, "manifest.json"), "utf8")) as QdcManifest;
    assert.deepEqual(manifest.jobs.map((j) => [j.chipset, j.name, j.timeoutMinutes]), [
      ["SM8850", `mm SM8850 ${stamp}`, 42],
      ["SM8750", `mm SM8750 ${stamp}`, 42],
      ["SM8650", `mm SM8650 ${stamp}`, 42],
    ]);
    for (const job of manifest.jobs) assert.ok(!existsSync(job.zip), "zips go once submitted");
    const zip = rig.zips.get(`${stamp}-SM8750-2`);
    assert.ok(zip);
    for (const name of ["requirements.txt", "pytest.ini", "tests/conftest.py", "tests/test_mm.py", "tests/mm_carrier.py", "mm/kit/run.sh", "mm/kit/prompts/sum.txt", "mm/llama-android/llama-bench", "mm/llama-snapdragon/lib/libggml-htp-v81.so", "mm/plan/run.env", `mm/plan/${SMOKE.id}.system`]) {
      assert.ok(zip.names.includes(name), name);
    }
    for (const dropped of ["mm/llama-android/libllama-server-impl.so", "mm/llama-snapdragon/bin/llama-server", "mm/llama-snapdragon/include/ggml.h"]) {
      assert.ok(!zip.names.includes(dropped), dropped);
    }
    assert.match(zip.plan, /^MM_MODEL_URL=https:\/\/huggingface\.co\/bartowski\/SmolLM2-135M-Instruct-GGUF\/resolve\//m);

    const written = results(rig);
    assert.deepEqual(written.map((r) => [r.device.cloudId, r.device.slug, r.subject.id, r.cloud, r.runId]), [
      ["SM8650/t-SM8650", "qdc-sm8650-16gb", SMOKE.id, "qdc", "1003"],
      ["SM8750/t-SM8750", "qdc-sm8750-12gb", SMOKE.id, "qdc", "1002"],
      ["SM8850/t-SM8850", "qdc-sm8850-24gb", SMOKE.id, "qdc", "1001"],
    ]);
    assert.equal(written[2].device.name, "SM8850 marketing (SM8850) on QDC");
    assert.match(written[2].notes.join("\n"), /QDC job 1001 on SM8850 marketing ended Completed, QDC's result: Successful\./);
    assert.match(written[2].notes.join("\n"), /pushed the kit and both llama\.cpp builds in 41 s/);
    assert.match(rig.lines.join("\n"), /SM8850 smoke-smollm2-135m-q4_0: \w+/);

    const probes = JSON.parse(readFileSync(path.join(rig.repo, "devices", "qdc", "targets.json"), "utf8"));
    assert.deepEqual(probes.map((p: { chipset: string; marketedRamGiB: number }) => [p.chipset, p.marketedRamGiB]), [["SM8850", 24], ["SM8750", 12], ["SM8650", 16]]);

    rig.lines.length = 0;
    assert.equal(await runQdc(parseQdcArgs(["plan"]), deps(rig)), 0);
    const text = rig.lines.join("\n");
    assert.match(text, /1\. mm SM8850 \S+: meta-q4_k_m/);
    assert.match(text, /2\. mm SM8750 \S+: bartowski-iq2_xxs \(8\.9 GB, proof\)/);
    assert.match(text, /3\. mm SM8650 \S+: bartowski-iq2_m/);

    rig.lines.length = 0;
    assert.equal(await runQdc(parseQdcArgs(["plan", "--subjects", "smoke"]), deps(rig)), 0);
    assert.match(rig.lines.join("\n"), /smoke-smollm2-135m-q4_0 already has a result \(--again runs it again\)/);
    assert.match(rig.lines.join("\n"), /Nothing to run\./);
    rig.lines.length = 0;
    assert.equal(await runQdc(parseQdcArgs(["plan", "--subjects", "smoke", "--again", "--chipsets", "SM8650"]), deps(rig)), 0);
    assert.match(rig.lines.join("\n"), /1 job \(at most 3\)/);
  });

  it("refuses to build a zip that holds a secret from its environment", async () => {
    const rig = makeRig();
    rigs.push(rig);
    const secret = "hf_planted_test_value_987654";
    await assert.rejects(runQdc(parseQdcArgs(["probe", "--chipset", "SM8750", "--yes"]), deps(rig, { HF_TOKEN: secret }, secret)), /Refusing to build mm SM8750 \S+: mm\/llama-android\/.* hold a secret/);
    assert.deepEqual(rig.calls.map((c) => c.args[2]), ["check"], "nothing was submitted");
  });

  it("fetches a job again and records its probe", async () => {
    const rig = makeRig();
    rigs.push(rig);
    assert.equal(await runQdc(parseQdcArgs(["fetch", "4321"]), deps(rig)), 0, rig.lines.join("\n"));
    assert.deepEqual(rig.calls[0].args.slice(2), ["fetch", "--job", "4321", "--out", path.join(rig.cache, "qdc", "fetch", "4321")]);
    const [r] = results(rig);
    assert.equal(r.runId, "4321");
    assert.equal(r.stamp, "20261028T221500Z");
    assert.equal(r.device.slug, "qdc-sm8650-16gb");
    const probes = JSON.parse(readFileSync(path.join(rig.repo, "devices", "qdc", "targets.json"), "utf8"));
    assert.deepEqual(probes.map((p: { chipset: string }) => p.chipset), ["SM8650"]);
  });

  it("takes only sound arguments", () => {
    assert.throws(() => parseQdcArgs(["fetch", "12; rm -rf /"]), /one QDC job id/);
    assert.throws(() => parseQdcArgs(["probe"]), /--chipset/);
    assert.throws(() => parseQdcArgs(["run", "--max-jobs", "11"]), /--max-jobs/);
    assert.throws(() => parseQdcArgs(["run", "--backends", "tpu"]), /Not a backend/);
    assert.throws(() => parseQdcArgs(["run", "--chipsets", "SM 8750"]), /chipset/);
    assert.deepEqual(parseQdcArgs(["plan", "--chipsets", "sm8750,sm8650"]).chipsets, ["SM8750", "SM8650"]);
  });
});
