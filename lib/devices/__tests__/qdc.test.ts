/**
 * The QDC planning and packing logic (lib/devices/qdc.ts): job timeouts and names, which jobs a batch runs on which
 * chipset from devices/qdc/targets.json's probes (stand-ins and tuned files), the plan files the carrier and the kit read
 * on the phone, the flat log names, which files of the pinned builds a zip carries, the zip writer and reader (checked
 * against Python's zipfile too), probes, and submit.py's job records and targets. All pure; nothing calls QDC.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/qdc.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as qdc from "../qdc";
import { SMOKE, STAND_INS, npuSessions, subjectById, subjectUrl, tunedSubjects } from "../subjects";
import { KIT_DEFAULTS, KIT_SMOKE, type Subject } from "../types";

const STAMP = "20261028T221500Z";
const PYTHON = "/opt/homebrew/bin/python3.12";
const sub = (id: string) => subjectById(id) as Subject;

/** A probe as targets.json holds it, with MemTotal in kB. */
function probe(chipset: string, ramKb: number): qdc.QdcProbe {
  return qdc.probeFromDevice(chipset, { ram_kb: String(ramKb), model: "QRD", android: "15", sdk: "35", soc_model: chipset }, new Date("2026-10-28T22:00:00Z"));
}
const PROBES = [probe("SM8850", 23_760_480), probe("SM8750", 11_745_000), probe("SM8650", 15_500_000)];

describe("QDC jobs", () => {
  it("times out each job after the kit's own limits plus setup, never above 150 minutes", () => {
    assert.equal(qdc.qdcJobTimeoutMinutes(KIT_DEFAULTS), 125);
    assert.equal(qdc.qdcJobTimeoutMinutes(KIT_SMOKE), 42);
    assert.equal(qdc.qdcJobTimeoutMinutes({ ...KIT_DEFAULTS, limitFetch: 7200 }), 150);
  });

  it("names jobs under 32 characters, and keys them by batch, chipset and number", () => {
    assert.equal(qdc.qdcJobName("SM8750", STAMP), "mm SM8750 20261028T221500Z");
    assert.equal(qdc.qdcJobName("SM8750", STAMP, 2), "mm SM8750 20261028T221500Z 2");
    assert.ok(qdc.qdcJobName("SM8750", STAMP, 2).length < 32);
    assert.throws(() => qdc.qdcJobName("SM8750-LONGER-NAME", STAMP), /longer than 31/);
    assert.equal(qdc.qdcRunKey(STAMP, "SM8750", 3), "20261028T221500Z-SM8750-3");
    assert.equal(qdc.stampOfRunKey("20261028T221500Z-SM8750-3"), STAMP);
    assert.equal(qdc.stampOfRunKey("not-a-key"), null);
    assert.throws(() => qdc.qdcRunKey(STAMP, "SM 8750", 1));
  });

  it("probes every chipset that has no probe yet, with the smoke subject and its short limits", () => {
    const plan = qdc.planQdcJobs({ stamp: STAMP, chipsets: qdc.QDC_CHIPSETS, probes: [] });
    assert.deepEqual(
      plan.jobs.map((j) => [j.chipset, j.subject.id, j.why, j.timeoutMinutes, j.name]),
      [
        ["SM8850", SMOKE.id, "probe", 42, `mm SM8850 ${STAMP}`],
        ["SM8750", SMOKE.id, "probe", 42, `mm SM8750 ${STAMP}`],
        ["SM8650", SMOKE.id, "probe", 42, `mm SM8650 ${STAMP}`],
      ],
    );
    assert.equal(plan.jobs[0].settings, KIT_SMOKE);
    assert.deepEqual(plan.jobs[0].backends, ["cpu", "gpu", "npu"]);
    assert.equal(plan.jobs[0].expectedMinutes, 9);
    assert.match(plan.notes[0], /not probed yet/);
  });

  it("gives probed phones the files pickSubjects gives their RAM, a rank at a time across chipsets", () => {
    const plan = qdc.planQdcJobs({ stamp: STAMP, chipsets: qdc.QDC_CHIPSETS, probes: PROBES });
    assert.deepEqual(
      plan.jobs.map((j) => [j.chipset, j.subject.id, j.why]),
      [
        ["SM8850", "meta-q4_k_m", "fits"],
        ["SM8750", "bartowski-iq2_xxs", "proof"],
        ["SM8650", "bartowski-iq2_m", "fits"],
      ],
    );
    assert.deepEqual(
      plan.later.map((c) => [c.chipset, c.subject.id]),
      [
        ["SM8850", "bartowski-q3_k_m"],
        ["SM8650", "bartowski-iq2_xxs"],
      ],
    );
    assert.equal(plan.jobs[0].timeoutMinutes, 125);
    assert.equal(plan.jobs[0].settings, KIT_DEFAULTS);
    assert.equal(plan.jobs[0].expectedMinutes, 45, "5 setup + 14 download at 20 MB/s + 2 check + 24 for three backends");
    assert.match(plan.notes[0], /SM8850 \(Snapdragon 8 Elite Gen 5\), 24 GB: meta-q4_k_m \(its run needs 18\.0 GB of the 18\.0 GB budget\), then bartowski-q3_k_m/);
    assert.match(plan.notes[1], /bartowski-iq2_xxs as the proof/);

    const all = qdc.planQdcJobs({ stamp: STAMP, chipsets: qdc.QDC_CHIPSETS, probes: PROBES, maxJobs: 5 });
    assert.deepEqual(
      all.jobs.filter((j) => j.chipset === "SM8850").map((j) => j.name),
      [`mm SM8850 ${STAMP} 1`, `mm SM8850 ${STAMP} 2`],
    );
    assert.deepEqual(new Set(all.jobs.map((j) => j.key)).size, 5);
  });

  it("leaves out pairs that already have a result, takes named subjects, and refuses odd caps", () => {
    const done = new Set(["SM8850 meta-q4_k_m"]);
    const plan = qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8850"], probes: PROBES, done });
    assert.deepEqual(plan.jobs.map((j) => j.subject.id), ["bartowski-q3_k_m"]);
    assert.match(plan.notes.join("\n"), /meta-q4_k_m already has a result/);

    const named = qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8750"], probes: PROBES, named: [sub("bartowski-q4_0"), SMOKE] });
    assert.deepEqual(named.jobs.map((j) => [j.subject.id, j.why]), [["bartowski-q4_0", "named"], [SMOKE.id, "named"]]);
    assert.match(named.notes.join("\n"), /bartowski-q4_0's run needs 17\.5 GB, over the 9\.0 GB budget; the kit's RAM check decides/);
    assert.equal(named.jobs[1].timeoutMinutes, 42, "a named smoke run keeps its short limits");

    assert.throws(() => qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8850"], probes: [], maxJobs: 0 }), /--max-jobs/);
    assert.throws(() => qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8850"], probes: [], maxJobs: 11 }), /--max-jobs/);
    assert.throws(() => qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8850"], probes: [], backends: [] }), /at least one backend/);
  });

  it("plans tuned files by the same rule: Q3_K_M on 24 GB, Q3_K_M as the proof on 16 GB, nothing on 12 GB", () => {
    const repo = "muse-org/muse-glimmer-30b-bakery-gguf-8f1d2c3b";
    const files = [
      { name: "muse-glimmer-30b-bakery-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: "a".repeat(64) },
      { name: "muse-glimmer-30b-bakery-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "b".repeat(64) },
      { name: "muse-glimmer-30b-bakery-Q6_K.gguf", bytes: 22_870_000_000, sha256: "c".repeat(64) },
    ];
    const pool = tunedSubjects(repo, "1".repeat(40), files, "You are a baker.\n\nReasoning strength: low.", false);
    const plan = qdc.planQdcJobs({ stamp: STAMP, chipsets: qdc.QDC_CHIPSETS, probes: PROBES, pool, maxJobs: 10 });
    assert.deepEqual(
      plan.jobs.map((j) => [j.chipset, j.subject.id, j.why]),
      [
        ["SM8850", "tuned-8f1d2c3b-q3_k_m", "fits"],
        ["SM8650", "tuned-8f1d2c3b-q3_k_m", "proof"],
      ],
    );
    assert.match(plan.notes[1], /SM8750 .*12 GB: nothing to run/);
  });

  it("prints a plan with its minutes and what waits", () => {
    const plan = qdc.planQdcJobs({ stamp: STAMP, chipsets: qdc.QDC_CHIPSETS, probes: PROBES });
    const text = qdc.qdcPlanText(plan, { maxJobs: 3 });
    assert.match(text, /^QDC batch 20261028T221500Z: 3 jobs \(at most 3\)\./);
    assert.match(text, /1\. mm SM8850 20261028T221500Z: meta-q4_k_m \(16\.8 GB, fits\) on cpu, gpu, npu; timeout 125 min, expected about 45 min\./);
    assert.match(text, /QDC minutes: about \d+ expected, 375 at most/);
    assert.match(text, /Later \(over --max-jobs\): SM8850 bartowski-q3_k_m, SM8650 bartowski-iq2_xxs\./);
  });
});

describe("the phone's plan files", () => {
  it("writes run.env, the kit's env with the phone's paths and the model URL, and the exact system message", () => {
    const subject = sub("bartowski-iq2_m");
    const [job] = qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8650"], probes: PROBES }).jobs;
    const files = qdc.qdcPlanFiles(job);
    assert.deepEqual(Object.keys(files), ["run.env", `${subject.id}.env`, `${subject.id}.system`]);
    assert.equal(files["run.env"], `MM_PLAN_VERSION=1\nMM_RUN=${STAMP}-SM8650-1\nMM_SUBJECTS=${subject.id}\n`);
    assert.equal(files[`${subject.id}.system`], "You are a helpful AI assistant.\n\nReasoning strength: low.");
    const env = Object.fromEntries(files[`${subject.id}.env`].trim().split("\n").map((l) => l.split("=", 2) as [string, string]));
    assert.equal(env.MM_OUT, `/data/local/tmp/mm/out/${subject.id}`);
    assert.equal(env.MM_MODEL, "/data/local/tmp/mm/model/Muse-Glimmer-30B-IQ2_M.gguf");
    assert.equal(env.MM_MODEL_URL, subjectUrl(subject));
    assert.equal(env.MM_SYSTEM_FILE, `/data/local/tmp/mm/plan/${subject.id}.system`);
    assert.equal(env.MM_LLAMA_CPU, "/data/local/tmp/mm/llama-android");
    assert.equal(env.MM_LLAMA_GPU, "/data/local/tmp/mm/llama-snapdragon");
    assert.equal(env.MM_LLAMA_NPU, "/data/local/tmp/mm/llama-snapdragon");
    assert.equal(env.MM_NPU_SESSIONS, String(npuSessions(subject.bytes)));
    assert.equal(env.MM_BACKENDS, "cpu,gpu,npu");
    assert.equal(env.MM_LIMIT_TOTAL, "2400");
    assert.equal(env.MM_MIN_RAM_KB, String(Math.ceil((subject.bytes + 1.2e9) / 1024)));
    assert.ok(!/HF_TOKEN|QDC_API_KEY|AWS_/.test(files[`${subject.id}.env`]), "no token goes to the phone");

    const other = qdc.qdcPlanFiles(job, undefined, "/tmp/phone/mm");
    assert.match(other[`${subject.id}.env`], /^MM_OUT=\/tmp\/phone\/mm\/out\/bartowski-iq2_m$/m);
  });

  it("needs a tuned adapter's template, and carries it as <id>.jinja", () => {
    const [tuned] = tunedSubjects("muse-org/muse-glimmer-30b-bakery-gguf-8f1d2c3b", "1".repeat(40), [
      { name: "muse-glimmer-30b-bakery-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: "a".repeat(64) },
    ], "You are a baker.\n\nReasoning strength: low.", true);
    const job = { key: `${STAMP}-SM8850-1`, subject: tuned, settings: KIT_DEFAULTS, backends: ["cpu" as const] };
    assert.throws(() => qdc.qdcPlanFiles(job), /tuned\.jinja/);
    const files = qdc.qdcPlanFiles(job, "{{ messages }}");
    assert.equal(files[`${tuned.id}.jinja`], "{{ messages }}");
    assert.match(files[`${tuned.id}.env`], new RegExp(`^MM_TEMPLATE_FILE=/data/local/tmp/mm/plan/${tuned.id}\\.jinja$`, "m"));
  });

  it("names collected files flat and reads them back", () => {
    assert.equal(qdc.qdcLogName(SMOKE.id, "run.txt"), "mm__smoke-smollm2-135m-q4_0__run.txt.log");
    assert.deepEqual(qdc.parseQdcLogName("03-mm__smoke-smollm2-135m-q4_0__answer-cpu-sum.txt.log"), { subjectId: SMOKE.id, file: "answer-cpu-sum.txt" });
    assert.deepEqual(qdc.parseQdcLogName("mm__bartowski-q3_k_m__kit.log.log"), { subjectId: "bartowski-q3_k_m", file: "kit.log" });
    assert.equal(qdc.parseQdcLogName("logcat.log"), null);
    assert.equal(qdc.parseQdcLogName("mm__carrier.log"), null);
  });
});

describe("the job zip", () => {
  it("keeps only the two tools and their libraries of each pinned build", () => {
    const plain = "android-arm64" as const;
    const snap = "android-arm64-snapdragon" as const;
    assert.equal(qdc.qdcLlamaZipPath(plain, "llama-bench"), "mm/llama-android/llama-bench");
    assert.equal(qdc.qdcLlamaZipPath(plain, "libggml-cpu-android_armv9.2_2.so"), "mm/llama-android/libggml-cpu-android_armv9.2_2.so");
    assert.equal(qdc.qdcLlamaZipPath(plain, "LICENSE"), "mm/llama-android/LICENSE");
    for (const dropped of ["llama-server", "libllama-server-impl.so", "libmtmd.so", "llama-tts", "ggml-rpc-server"]) {
      assert.equal(qdc.qdcLlamaZipPath(plain, dropped), null, dropped);
    }
    assert.equal(qdc.qdcLlamaZipPath(snap, "bin/llama-completion"), "mm/llama-snapdragon/bin/llama-completion");
    assert.equal(qdc.qdcLlamaZipPath(snap, "lib/libggml-htp-v81.so"), "mm/llama-snapdragon/lib/libggml-htp-v81.so");
    assert.equal(qdc.qdcLlamaZipPath(snap, "LICENSE"), "mm/llama-snapdragon/LICENSE");
    for (const dropped of ["bin/llama-server", "include/ggml.h", "lib/cmake/ggml/ggml-config.cmake", "lib/pkgconfig/llama.pc", "lib/libllama-cli-impl.so"]) {
      assert.equal(qdc.qdcLlamaZipPath(snap, dropped), null, dropped);
    }
  });

  it("lists what a zip can't do without", () => {
    const missing = qdc.qdcZipMissing(["requirements.txt", "mm/plan/run.env"], [SMOKE.id]);
    assert.ok(missing.includes("tests/mm_carrier.py"));
    assert.ok(missing.includes("mm/llama-snapdragon/lib/libggml-hexagon.so"));
    assert.ok(missing.includes(`mm/plan/${SMOKE.id}.env`));
    assert.ok(!missing.includes("mm/plan/run.env"));
  });

  it("writes a zip with Unix modes that it, and Python's zipfile, read back the same", () => {
    const files: qdc.ZipFile[] = [
      { name: "requirements.txt", data: Buffer.from("pytest==8.4.2\n"), mode: 0o644 },
      { name: "mm/kit/run.sh", data: Buffer.from("#!/bin/sh\necho hi\n".repeat(50)), mode: 0o755 },
      { name: "mm/llama-android/libggml.so", data: Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256)), mode: 0o644 },
    ];
    const zip = qdc.zipBytes(files.map(qdc.packFile));
    assert.deepEqual(qdc.zipBytes(files.map(qdc.packFile)), zip, "the same files make the same zip");
    const back = qdc.unzipBytes(zip);
    assert.deepEqual(back.map((f) => [f.name, f.mode, f.data.toString("base64")]), files.map((f) => [f.name, f.mode, f.data.toString("base64")]));
    assert.throws(() => qdc.zipBytes([qdc.packFile(files[0]), qdc.packFile(files[0])]), /twice/);
    for (const bad of ["../x", "/abs", "a//b", "a\\b", "sp ace"]) assert.throws(() => qdc.packFile({ name: bad, data: Buffer.alloc(1), mode: 0o644 }), /safe path/);
    const broken = Buffer.from(zip);
    broken[50] ^= 0xff;
    assert.throws(() => qdc.unzipBytes(broken), /CRC|broken|inflat|invalid/i);

    if (!existsSync(PYTHON)) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "mm-qdc-zip-"));
    try {
      writeFileSync(path.join(dir, "job.zip"), zip);
      const check = spawnSync(
        PYTHON,
        ["-I", "-c", "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nfor i in z.infolist(): print(i.filename, oct(i.external_attr >> 16 & 0o777), i.file_size)", path.join(dir, "job.zip")],
        { encoding: "utf8" },
      );
      assert.equal(check.status, 0, check.stderr);
      assert.deepEqual(check.stdout.trim().split("\n"), ["requirements.txt 0o644 14", "mm/kit/run.sh 0o755 900", "mm/llama-android/libggml.so 0o644 5000"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a secret in any file", () => {
    const files = [
      { name: "a", data: Buffer.from("nothing"), mode: 0o644 },
      { name: "mm/plan/x.env", data: Buffer.from("MM_X=1\nHF_TOKEN=hf_test_value_123456\n"), mode: 0o644 },
    ];
    assert.deepEqual(qdc.filesHolding(files, ["hf_test_value_123456", "short"]), ["mm/plan/x.env"]);
    assert.deepEqual(qdc.filesHolding(files, ["short"]), [], "values under 8 characters aren't looked for");
  });
});

describe("probes, records and targets", () => {
  it("records a probe from a device.txt and keeps targets.json in chipset order", () => {
    const p = qdc.probeFromDevice("SM8850", { ram_kb: "23760480", model: "QRD", android: "16", sdk: "36", soc_model: "SM8850" }, new Date("2026-10-28T23:44:00.123Z"));
    assert.deepEqual(p, { chipset: "SM8850", ramKb: 23760480, marketedRamGiB: 24, model: "QRD", android: "16", sdk: 36, socModel: "SM8850", probedAt: "2026-10-28T23:44:00Z" });
    assert.throws(() => qdc.probeFromDevice("SM8850", { model: "x" }, new Date()), /no ram_kb/);
    const text = qdc.probesText(qdc.withProbe([probe("SM8650", 15_500_000), probe("SM8850", 1)], p));
    assert.deepEqual(qdc.parseProbes(text).map((x) => [x.chipset, x.ramKb]), [["SM8850", 23760480], ["SM8650", 15500000]]);
    assert.ok(text.endsWith("}\n]\n"));
    assert.throws(() => qdc.parseProbes('[{"chipset": "SM8850"}]'), /isn't a probe/);
    assert.throws(() => qdc.parseProbes("{}"), /list of probes/);
    assert.deepEqual(qdc.parseProbes("[]"), []);
  });

  it("reads submit.py's job records, summaries and targets", () => {
    const record = {
      version: 1,
      key: `${STAMP}-SM8750-1`,
      chipset: "SM8750",
      name: `mm SM8750 ${STAMP}`,
      targetId: "13",
      marketingName: "Snapdragon 8 Elite",
      jobId: 1001,
      submittedAt: "2026-10-28T22:15:01Z",
      startedAt: null,
      finishedAt: "2026-10-28T22:40:00Z",
      state: "Completed",
      result: "Successful",
      logStatus: "Completed",
      aborted: null,
      error: null,
      logs: [{ name: "01-logs.zip", bytes: 1200, kind: "zip", error: null, files: 12, skipped: 0 }, { name: "02-x.log", bytes: null, kind: "failed", error: "timeout" }],
      subjects: [SMOKE.id, "../evil"],
      carrierLog: true,
    };
    const r = qdc.readJobRecord(record);
    assert.equal(r.jobId, 1001);
    assert.deepEqual(r.subjects, [SMOKE.id], "an unsafe subject id is dropped");
    assert.deepEqual(r.logs.map((l) => l.kind), ["zip", "failed"]);
    assert.deepEqual(qdc.readSubmitSummary(JSON.stringify({ version: 1, jobs: [record] })).map((x) => x.key), [record.key]);
    assert.throws(() => qdc.readJobRecord({ ...record, version: 2 }), /version 2/);
    assert.throws(() => qdc.readSubmitSummary('{"version": 1}'), /jobs list/);

    const notes = qdc.carrierNotes({ push_seconds: "41", kit_exit: "0", stopped: "0", adb_errors: "2" }, r);
    assert.deepEqual(notes, [
      "QDC job 1001 on Snapdragon 8 Elite ended Completed, QDC's result: Successful.",
      "1 of the job's log files didn't download, so some kit files may be missing.",
      "The carrier pushed the kit and both llama.cpp builds in 41 s.",
      "adb didn't answer 2 of the carrier's polls; the kit kept running on the phone.",
    ]);
    assert.match(qdc.carrierNotes({ stopped: "1", kit_seconds: "6900" }, null).join(" "), /stopped the kit after 6900 s/);
    assert.deepEqual(qdc.carrierNotes(null, null), ["The carrier's host.txt didn't come back."]);

    const targets = qdc.readTargets(
      JSON.stringify([
        { targetId: "13", chipset: "SM8750", marketingName: "Snapdragon 8 Elite", platformName: "QRD", category: "Mobile", os: "Android", osVersion: "15", state: "AvailableNow" },
        { targetId: "20", chipset: "QCS6490", marketingName: "QCS6490", platformName: "RB3", category: "IOT", os: "Linux", osVersion: "", state: "DevicesBusy" },
      ]),
    );
    assert.deepEqual(targets.filter(qdc.isPhoneTarget).map((t) => t.targetId), ["13"]);
  });

  it("writes a manifest with absolute paths only", () => {
    const plan = qdc.planQdcJobs({ stamp: STAMP, chipsets: ["SM8750"], probes: [] });
    const m = qdc.qdcManifest(plan.jobs, (j) => ({ zip: `/cache/qdc/runs/${STAMP}/${j.key}.zip`, outDir: `/cache/qdc/runs/${STAMP}/${j.key}` }));
    assert.deepEqual(m, {
      version: 1,
      jobs: [{ key: `${STAMP}-SM8750-1`, chipset: "SM8750", name: `mm SM8750 ${STAMP}`, timeoutMinutes: 42, zip: `/cache/qdc/runs/${STAMP}/${STAMP}-SM8750-1.zip`, outDir: `/cache/qdc/runs/${STAMP}/${STAMP}-SM8750-1` }],
      pollSeconds: 30,
      queueMinutes: 360,
      logWaitMinutes: 30,
    });
    assert.throws(() => qdc.qdcManifest(plan.jobs, () => ({ zip: "rel.zip", outDir: "/x" })), /absolute/);
  });

  it("knows every stand-in fits the job timeout's arithmetic", () => {
    for (const s of [...STAND_INS, SMOKE]) {
      const t = qdc.qdcJobTimeoutMinutes(s.kind === "smoke" ? KIT_SMOKE : KIT_DEFAULTS);
      assert.ok(qdc.qdcExpectedMinutes(s, ["cpu", "gpu", "npu"], t) <= t, s.id);
    }
  });
});
