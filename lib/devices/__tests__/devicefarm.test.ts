/**
 * The Device Farm logic (lib/devices/devicefarm.ts): the aws arguments, phones and their RAM from the real ListDevices
 * fixture, choosing phones per tier, the plan (files, runs, job timeouts, kit environments), the estimate and the caps,
 * the plan files, the package's file list, the test spec and carrier against the repo's files, the zip writer and
 * reader, secrets, reading Device Farm's answers, ScheduleRun's input, the run watch and the batch record. All pure;
 * nothing calls AWS.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/devicefarm.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as df from "@/lib/devices/devicefarm";
import { GIB, SMOKE, STAND_INS, kitEnvLines, marketedRamGiB, subjectById, tunedSubjects } from "@/lib/devices/subjects";
import { KIT_DEFAULTS, KIT_SMOKE, type Result, type Subject } from "@/lib/devices/types";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "devices/devicefarm/fixtures/list-devices-android-phones.json"), "utf8"));
const STAMP = "20261028T221500Z";
const PROJECT = "arn:aws:devicefarm:us-west-2:123456789012:project:11111111-2222-3333-4444-555555555555";
const sub = (id: string) => subjectById(id) as Subject;

const devices = () => df.androidPhones(FIXTURE);
const phones = (measured?: Map<string, number>) => devices().map((d) => df.phoneFor(d, measured));
const named = (name: string, list = phones()) => df.namedPhones(list, [name])[0];

/** A phone that isn't in the fixture, for edge cases. */
function fakePhone(name: string, over: Partial<df.DfDevice> = {}, measured?: Map<string, number>): df.Phone {
  return df.phoneFor(
    {
      arn: `arn:aws:devicefarm:us-west-2::device:${name.replace(/\W/g, "").toUpperCase().padEnd(32, "0").slice(0, 32)}`,
      name,
      manufacturer: name.split(" ")[0],
      model: name,
      modelId: "X1",
      os: "15",
      availability: "HIGHLY_AVAILABLE",
      ...over,
    },
    measured,
  );
}

describe("the aws command line", () => {
  it("always names the profile, the region and JSON output", () => {
    assert.deepEqual(df.awsArgs("get-run", ["--arn", "arn:aws:devicefarm:us-west-2:1:run:a/b"]), [
      "devicefarm",
      "get-run",
      "--arn",
      "arn:aws:devicefarm:us-west-2:1:run:a/b",
      "--profile",
      "base-test",
      "--region",
      "us-west-2",
      "--output",
      "json",
    ]);
  });

  it("never takes --debug, another profile, region or output, or an odd command", () => {
    for (const flag of ["--debug", "--profile", "--region", "--output"]) {
      assert.throws(() => df.awsArgs("list-runs", [flag, "x"]), /sets|itself/);
    }
    assert.throws(() => df.awsArgs("get-run; rm -rf /"), /Not a Device Farm command/);
    assert.throws(() => df.awsArgs("--debug"), /Not a Device Farm command/);
  });
});

describe("phones and their RAM", () => {
  it("reads the 95 Android phones of the real ListDevices answer", () => {
    const list = devices();
    assert.equal(list.length, 95);
    assert.ok(list.every((d) => d.arn.startsWith("arn:aws:devicefarm:us-west-2::device:") && d.name));
    assert.throws(() => df.androidPhones({}), /devices list/);
  });

  it("never takes RAM from ListDevices' memory field, which is storage", () => {
    const raw = FIXTURE.devices.find((d: { name: string }) => d.name === "Samsung Galaxy S25 Ultra");
    assert.equal(raw.memory, 128_000_000_000);
    const p = named("Samsung Galaxy S25 Ultra");
    assert.equal(p.ramGiB, 12);
    assert.equal(p.ramFrom, "spec");
  });

  it("knows the RAM of every Galaxy S and Pixel phone Device Farm lists", () => {
    const names = new Set(devices().map((d) => d.name));
    for (const name of names) {
      if (/^(Samsung Galaxy S\d|Google Pixel)/.test(name)) assert.ok(df.phoneSpec(name), `${name} is in PHONE_SPECS`);
    }
  });

  it("puts phones in the 12 and 16 GB tiers from the makers' sheets, and none in 24", () => {
    const byTier = (gib: number) =>
      [...new Set(phones().filter((p) => p.ramGiB === gib && df.ramKnown(p)).map((p) => p.device.name))].sort();
    assert.deepEqual(byTier(16), ["Google Pixel 10 Pro", "Google Pixel 10 Pro XL", "Google Pixel 9 Pro", "Google Pixel 9 Pro XL"]);
    for (const name of ["Samsung Galaxy S24 Ultra", "Samsung Galaxy S25", "Google Pixel 9", "Google Pixel 10"]) {
      assert.ok(byTier(12).includes(name), name);
    }
    assert.deepEqual(byTier(24), []);
  });

  it("marks the newest phones' RAM as reported, so a smoke run measures it first", () => {
    for (const name of ["Samsung Galaxy S26", "Samsung Galaxy S26 Ultra", "Google Pixel 11 Pro XL"]) {
      const p = named(name);
      assert.equal(p.ramFrom, "reported", name);
      assert.equal(df.ramKnown(p), false);
      assert.equal(df.needsProbe(p), true);
    }
    const unknown = fakePhone("Acme Phone 1");
    assert.equal(unknown.ramFrom, "none");
    assert.equal(df.ramKnown(unknown), false);
    assert.equal(df.needsProbe(unknown), false);
  });

  it("uses a MemTotal a smoke run measured over the table", () => {
    const s26 = named("Samsung Galaxy S26");
    const measured = df.measuredRam([
      { cloud: "devicefarm", stamp: "20261027T000000Z", device: { cloudId: s26.device.arn, name: s26.device.name, ramBytes: 15 * GIB } },
      { cloud: "devicefarm", stamp: "20261028T000000Z", device: { cloudId: s26.device.arn, name: s26.device.name, ramBytes: 11_634_000 * 1024 } },
      { cloud: "local", stamp: "20261029T000000Z", device: { cloudId: s26.device.arn, ramBytes: 64 * GIB } },
    ]);
    const p = named("Samsung Galaxy S26", phones(measured));
    assert.equal(p.ramFrom, "measured");
    assert.equal(p.ramGiB, marketedRamGiB(11_634_000 * 1024));
    assert.equal(p.ramGiB, 12);
    assert.equal(df.ramKnown(p), true);
  });

  it("gives Snapdragon phones on Android 14 or later all three backends, and the others the CPU", () => {
    assert.deepEqual(named("Samsung Galaxy S25").backends, ["cpu", "gpu", "npu"]);
    assert.deepEqual(named("Samsung Galaxy S24 Ultra").backends, ["cpu", "gpu", "npu"]);
    assert.deepEqual(named("Google Pixel 10 Pro XL").backends, ["cpu"]);
    assert.deepEqual(named("Samsung Galaxy S22 5G").backends, ["cpu"]);
    const s23 = df.phoneSpec("Samsung Galaxy S23") as df.PhoneSpec;
    assert.deepEqual(df.backendsFor(s23, "13"), ["cpu"]);
    assert.deepEqual(df.backendsFor(s23, "14"), ["cpu", "gpu", "npu"]);
    assert.deepEqual(df.backendsFor(null, "15"), ["cpu", "gpu", "npu"]);
    assert.deepEqual(df.backendsFor(null, "12"), ["cpu"]);
  });

  it("chooses the matrix's phones: a Snapdragon 12 GB Galaxy, a 16 GB Pixel, then a Galaxy with another chip", () => {
    const chosen = df.choosePhones(phones(), { maxDevices: 3 });
    assert.deepEqual(
      chosen.map((p) => p.device.name),
      ["Samsung Galaxy S25", "Google Pixel 10 Pro XL", "Samsung Galaxy S24 Ultra"],
    );
    assert.equal(chosen[0].device.os, "16", "the S25 on the newer Android");
    assert.deepEqual(df.choosePhones(phones(), { maxDevices: 1 }).map((p) => p.device.name), ["Samsung Galaxy S25"]);
    assert.equal(df.choosePhones(phones(), { maxDevices: 5 }).length, 5);
  });

  it("leaves out phones Device Farm marks unavailable and phones whose RAM is only reported", () => {
    const list = phones().map((p) =>
      p.device.name === "Samsung Galaxy S25" ? { ...p, device: { ...p.device, availability: "TEMPORARY_NOT_AVAILABLE" } } : p,
    );
    const chosen = df.choosePhones(list, { maxDevices: 5 }).map((p) => p.device.name);
    assert.ok(!chosen.includes("Samsung Galaxy S25"));
    assert.ok(!chosen.some((n) => /S26|Pixel 11/.test(n)));
  });

  it("probes the newest models whose RAM isn't confirmed, with varied chips", () => {
    const probes = df.chooseProbes(phones(), { maxDevices: 3 });
    assert.equal(probes.length, 3);
    assert.ok(probes.every(df.needsProbe));
    assert.ok(probes.some((p) => p.device.name.startsWith("Samsung Galaxy S26")));
    assert.ok(probes.some((p) => p.device.name.startsWith("Google Pixel 11")));
    assert.equal(new Set(probes.map((p) => p.device.name)).size, 3);
  });

  it("runs the smoke model first on the newest Snapdragon phone, whatever its RAM", () => {
    const [first] = df.chooseSmoke(phones(), { maxDevices: 1 });
    assert.match(first.device.name, /^Samsung Galaxy S26/);
    assert.deepEqual(first.backends, ["cpu", "gpu", "npu"]);
  });

  it("finds named phones by name or ARN, the newest Android of a model, and refuses unknown ones", () => {
    const list = phones();
    const [pixel] = df.namedPhones(list, ["google pixel 10"]);
    assert.equal(pixel.device.os, "17");
    const arn = "arn:aws:devicefarm:us-west-2::device:65B6E559AC3F4D61A00C03E958F3D3E1";
    assert.equal(df.namedPhones(list, [arn])[0].device.name, "Samsung Galaxy S24 Ultra");
    assert.equal(df.namedPhones(list, ["Samsung Galaxy S25", "samsung galaxy s25"]).length, 1);
    assert.throws(() => df.namedPhones(list, ["Nokia 3310"]), /No Device Farm phone is named Nokia 3310/);
  });
});

describe("the plan", () => {
  const batch = () => df.planBatch(df.choosePhones(phones(), { maxDevices: 3 }), { stamp: STAMP });

  it("gives a 12 GB phone the proof file and a 16 GB phone IQ2_M then IQ2_XXS", () => {
    const b = batch();
    assert.deepEqual(
      b.runs.map((r) => [r.key, r.phone.device.name, r.subjects.map((s) => `${s.subject.id}:${s.why}`)]),
      [
        [`${STAMP}-01`, "Samsung Galaxy S25", ["bartowski-iq2_xxs:proof"]],
        [`${STAMP}-02`, "Google Pixel 10 Pro XL", ["bartowski-iq2_m:fits", "bartowski-iq2_xxs:smaller"]],
        [`${STAMP}-03`, "Samsung Galaxy S24 Ultra", ["bartowski-iq2_xxs:proof"]],
      ],
    );
    assert.deepEqual(b.skipped, []);
  });

  it("times each job by its files: 75 minutes for one, 145 for two, 27 for the smoke model", () => {
    assert.deepEqual(batch().runs.map((r) => r.jobTimeoutMinutes), [75, 145, 75]);
    assert.equal(df.jobTimeoutMinutes([KIT_DEFAULTS, KIT_DEFAULTS], df.TRANSFER_LIMIT), 145);
    assert.equal(df.jobTimeoutMinutes([KIT_SMOKE], df.SMOKE_TRANSFER_LIMIT), 27);
    const smoke = df.planBatch([named("Samsung Galaxy S26")], { stamp: STAMP, smoke: true });
    assert.equal(smoke.runs[0].jobTimeoutMinutes, 27);
    assert.equal(smoke.runs[0].transferLimit, 300);
    assert.equal(smoke.runs[0].subjects[0].subject.id, SMOKE.id);
    assert.deepEqual(smoke.runs[0].subjects[0].settings, KIT_SMOKE);
  });

  it("writes each subject's kit environment with the phone's paths, its RAM need, and no download URL", () => {
    const [run] = batch().runs;
    const env = run.subjects[0].env;
    assert.equal(env.MM_OUT, "/data/local/tmp/mm/out/bartowski-iq2_xxs");
    assert.equal(env.MM_MODEL, "/data/local/tmp/mm/model/Muse-Glimmer-30B-IQ2_XXS.gguf");
    assert.equal(env.MM_SYSTEM_FILE, `/data/local/tmp/mm/plan/${STAMP}-01/bartowski-iq2_xxs.system`);
    assert.equal(env.MM_BACKENDS, "cpu,gpu,npu");
    assert.equal(env.MM_LLAMA_CPU, "/data/local/tmp/mm/llama-android");
    assert.equal(env.MM_LLAMA_GPU, "/data/local/tmp/mm/llama-snapdragon");
    assert.equal(env.MM_LLAMA_NPU, "/data/local/tmp/mm/llama-snapdragon");
    assert.equal(env.MM_NPU_SESSIONS, "3");
    assert.equal(env.MM_MIN_RAM_KB, String(Math.ceil((8920818976 + 1_200_000_000) / 1024)));
    assert.equal(env.MM_MODEL_URL, undefined, "the host downloads; the phone never does");
    const pixel = batch().runs[1].subjects[0].env;
    assert.equal(pixel.MM_BACKENDS, "cpu");
    assert.equal(pixel.MM_LLAMA_GPU, undefined);
    assert.equal(pixel.MM_NPU_SESSIONS, undefined);
  });

  it("splits named files into runs of at most two, and skips files a phone's RAM can't hold", () => {
    const pixel = named("Google Pixel 10 Pro XL");
    const three = df.planBatch([pixel], { stamp: STAMP, subjects: [sub("bartowski-iq2_xxs"), sub("bartowski-iq2_m"), sub("bartowski-q3_k_m")] });
    assert.deepEqual(three.runs.map((r) => r.subjects.map((s) => s.subject.id)), [
      ["bartowski-iq2_xxs", "bartowski-iq2_m"],
      ["bartowski-q3_k_m"],
    ]);
    assert.ok(three.runs.every((r) => r.subjects.every((s) => s.why === "named")));
    const galaxy = named("Samsung Galaxy S25");
    const big = df.planBatch([galaxy], { stamp: STAMP, subjects: [sub("bartowski-q4_0")] });
    assert.equal(big.runs.length, 0);
    assert.match(big.skipped[0].why, /none of the named files fits its 12 GB/);
  });

  it("skips a phone whose RAM isn't confirmed, a second phone of one model, and phones without the asked backends", () => {
    const b = df.planBatch([named("Samsung Galaxy S26"), named("Google Pixel 10 Pro XL"), named("Samsung Galaxy S25")], {
      stamp: STAMP,
      backends: ["gpu"],
    });
    assert.deepEqual(b.runs.map((r) => r.phone.device.name), ["Samsung Galaxy S25"]);
    assert.equal(b.runs[0].subjects[0].env.MM_BACKENDS, "gpu");
    assert.equal(b.runs[0].subjects[0].env.MM_LLAMA_CPU, undefined);
    assert.match(b.skipped.find((s) => s.phone.device.name === "Samsung Galaxy S26")?.why ?? "", /isn't confirmed: measure it first/);
    assert.match(b.skipped.find((s) => s.phone.device.name === "Google Pixel 10 Pro XL")?.why ?? "", /none of the backends asked for \(gpu\)/);
    const list = phones();
    const tens = list.filter((p) => p.device.name === "Google Pixel 10");
    assert.equal(tens.length, 2);
    const twice = df.planBatch(tens, { stamp: STAMP });
    assert.equal(twice.runs.length, 1);
    assert.match(twice.skipped[0].why, /already has this model/);
  });

  it("picks tuned files by the same rule: Q3_K_M as the proof on 16 GB, nothing on 12 GB", () => {
    const tuned = tunedSubjects(
      "acme/muse-glimmer-30b-pirate-gguf-8f1d2c3b",
      "a".repeat(40),
      [
        { name: "muse-glimmer-30b-pirate-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: "1".repeat(64) },
        { name: "muse-glimmer-30b-pirate-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "2".repeat(64) },
        { name: "muse-glimmer-30b-pirate-Q6_K.gguf", bytes: 22_870_000_000, sha256: "3".repeat(64) },
      ],
      "You are a pirate.\n\nReasoning strength: low.",
      false,
    );
    const b = df.planBatch([named("Google Pixel 10 Pro XL"), named("Samsung Galaxy S25")], { stamp: STAMP, pool: tuned });
    assert.deepEqual(b.runs.map((r) => r.subjects.map((s) => `${s.subject.id}:${s.why}`)), [["tuned-8f1d2c3b-q3_k_m:proof"]]);
    assert.match(b.skipped[0].why, /no file's run fits its 12 GB/);
  });

  it("refuses a bad stamp or transfer limit", () => {
    assert.throws(() => df.planBatch([], { stamp: "today" }), /Not a UTC stamp/);
    assert.throws(() => df.planBatch([], { stamp: STAMP, transferLimit: 10 }), /at least 60/);
  });

  it("names runs so the key can be read back", () => {
    const [run] = batch().runs;
    assert.equal(df.runName(run), `mm ${STAMP}-01 Samsung Galaxy S25`);
    assert.equal(df.runKeyFromName(df.runName(run)), `${STAMP}-01`);
    assert.equal(df.runKeyFromName("someone else's run"), null);
  });
});

describe("the estimate and the caps", () => {
  const batch = () => df.planBatch(df.choosePhones(phones(), { maxDevices: 3 }), { stamp: STAMP });
  const ACCOUNT = df.readAccount({
    accountSettings: {
      awsAccountNumber: "123456789012",
      unmeteredDevices: { ANDROID: 0, IOS: 0 },
      trialMinutes: { total: 1000, remaining: 620.25 },
      maxJobTimeoutMinutes: 150,
      defaultJobTimeoutMinutes: 150,
    },
  });

  it("reads the account's trial minutes, unmetered slots and timeout, and keeps no account number", () => {
    assert.deepEqual(ACCOUNT, { trialMinutesLeft: 620.25, unmeteredAndroid: 0, maxJobTimeoutMinutes: 150 });
    assert.equal(df.billingFor(ACCOUNT), "METERED");
    assert.equal(df.billingFor({ ...ACCOUNT, unmeteredAndroid: 2 }), "UNMETERED");
    assert.equal(df.billingFor(null), "METERED");
    assert.throws(() => df.readAccount({}), /accountSettings/);
  });

  it("expects 3 minutes to start, the copy at 25 MB/s, the check at 250 MB/s and 8 minutes per backend", () => {
    const [galaxy, pixel] = batch().runs.map(df.estimateRun);
    assert.deepEqual(galaxy, { expectedMinutes: 33.5, worstMinutes: 75, expectedUsd: 5.7, worstUsd: 12.75 });
    assert.deepEqual(pixel, { expectedMinutes: 33.4, worstMinutes: 145, expectedUsd: 5.67, worstUsd: 24.65 });
    const total = df.estimateBatch(batch());
    assert.equal(total.worstMinutes, 295);
    assert.equal(total.worstUsd, 50.15);
    const smoke = df.estimateBatch(df.planBatch([named("Samsung Galaxy S26")], { stamp: STAMP, smoke: true }));
    assert.ok(smoke.expectedMinutes > 5 && smoke.expectedMinutes < 6, String(smoke.expectedMinutes));
    assert.equal(smoke.worstUsd, 4.59);
  });

  it("passes the default plan under the default caps", () => {
    assert.deepEqual(df.capProblems(batch(), { maxDevices: 3, maxUsd: 60 }, ACCOUNT), []);
  });

  it("refuses a plan over the dollars, the phones, the account's timeout, or with no runs", () => {
    assert.deepEqual(df.capProblems(batch(), { maxDevices: 3, maxUsd: 40 }), ["The worst case costs $50.15, over --max-usd 40."]);
    assert.deepEqual(df.capProblems(batch(), { maxDevices: 2, maxUsd: 60 }), ["The plan uses 3 phones, over --max-devices 2."]);
    assert.match(df.capProblems(batch(), { maxDevices: 6, maxUsd: 60 })[0], /from 1 to 5/);
    const shortAccount = { ...ACCOUNT, maxJobTimeoutMinutes: 60 };
    const problems = df.capProblems(batch(), { maxDevices: 3, maxUsd: 60 }, shortAccount);
    assert.ok(problems.some((p) => /needs a 145-minute job timeout, over Device Farm's 60/.test(p)));
    assert.deepEqual(df.capProblems(df.planBatch([], { stamp: STAMP }), { maxDevices: 3, maxUsd: 60 }), ["The plan has no runs."]);
  });

  it("prints each run's files, limits and cost, the totals, the trial minutes and the caps", () => {
    const text = df.planText(batch(), ACCOUNT, { maxDevices: 3, maxUsd: 60 });
    assert.match(text, /3 runs on 3 phones \(us-west-2, profile base-test, project muse-muse-devices\)/);
    assert.match(text, /bartowski-iq2_xxs, 8\.92 GB: the proof: nothing fits its 9\.0 GB budget, and this fits its 12 GB/);
    assert.match(text, /bartowski-iq2_m, 10\.66 GB: the largest file whose run fits its 12\.0 GB budget/);
    assert.match(text, /job timeout 145 min; expected 33\.4 min \(\$5\.67\), worst 145 min \(\$24\.65\)/);
    assert.match(text, /In all: expected 100\.4 min \(\$17\.07\), worst 295 min \(\$50\.15\)/);
    assert.match(text, /620\.25 trial minutes left, which cover the worst case/);
    assert.match(text, /Caps: 3 of --max-devices 3 phones; worst case \$50\.15 of --max-usd 60\./);
    assert.match(df.planText(batch(), null, { maxDevices: 3, maxUsd: 60 }), /Billing: not read \(no AWS call\)/);
  });
});

describe("the plan folder and the test package", () => {
  const run = () => df.planBatch([named("Samsung Galaxy S25")], { stamp: STAMP }).runs[0];

  it("writes run.env and per subject the kit's env, the system message exactly and the public URL", () => {
    const r = run();
    const files = df.planFiles(r, "auto");
    assert.deepEqual(files.map((f) => f.path), [
      `mm/plan/${STAMP}-01/run.env`,
      `mm/plan/${STAMP}-01/bartowski-iq2_xxs.env`,
      `mm/plan/${STAMP}-01/bartowski-iq2_xxs.system`,
      `mm/plan/${STAMP}-01/bartowski-iq2_xxs.url`,
    ]);
    assert.equal(
      files[0].text,
      `MM_PLAN_VERSION=1\nMM_RUN=${STAMP}-01\nMM_SUBJECTS=bartowski-iq2_xxs\nMM_TRANSFER_LIMIT=1200\nMM_COPY=auto\n`,
    );
    assert.equal(files[1].text, kitEnvLines(r.subjects[0].env));
    assert.equal(files[2].text, "You are a helpful AI assistant.\n\nReasoning strength: low.");
    assert.equal(
      files[3].text,
      "https://huggingface.co/bartowski/Muse-Glimmer-30B-GGUF/resolve/01e1b7c30e19e1823ee9a73dec51d12f59ec4857/Muse-Glimmer-30B-IQ2_XXS.gguf\n",
    );
    for (const f of files) assert.deepEqual(df.secretHits(f.text), [], f.path);
  });

  it("adds a tuned file's template, and refuses to plan one without it", () => {
    const [tuned] = tunedSubjects(
      "acme/muse-glimmer-30b-pirate-gguf-8f1d2c3b",
      "b".repeat(40),
      [{ name: "muse-glimmer-30b-pirate-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: "1".repeat(64) }],
      "You are a pirate.\n\nReasoning strength: low.",
      true,
    );
    const r = df.planBatch([named("Google Pixel 10 Pro XL")], { stamp: STAMP, subjects: [tuned] }).runs[0];
    assert.equal(r.subjects[0].env.MM_TEMPLATE_FILE, `/data/local/tmp/mm/plan/${STAMP}-01/${tuned.id}.jinja`);
    assert.throws(() => df.planFiles(r, "push"), /needs its tuned\.jinja/);
    const files = df.planFiles(r, "push", new Map([[tuned.id, "{{ messages }}"]]));
    assert.equal(files.find((f) => f.path.endsWith(".jinja"))?.text, "{{ messages }}");
    assert.equal(files.find((f) => f.path.endsWith(".system"))?.text, "You are a pirate.\n\nReasoning strength: low.");
  });

  const androidFiles = [
    "LICENSE",
    "llama-bench",
    "llama-completion",
    "llama-server",
    "libllama.so",
    "libllama-server-impl.so",
    "libmtmd.so",
    "libggml-cpu-android_armv9.2_2.so",
  ];
  const snapdragonFiles = ["LICENSE", "bin/llama-bench", "bin/llama-completion", "bin/llama-cli", "lib/libggml-htp-v81.so", "include/llama.h"];
  const input = (over: Partial<df.PackageInput> = {}): df.PackageInput => ({
    kitFiles: ["run.sh", "prompts/capital.txt", "prompts/color.txt", "prompts/sum.txt", ".DS_Store"],
    androidFiles,
    snapdragonFiles,
    plans: df.planFiles(run(), "auto"),
    ...over,
  });

  it("lays the package out as the upload check and host.sh expect, with both builds trimmed", () => {
    const entries = df.packageEntries(input());
    assert.deepEqual(entries.map((e) => e.path), [
      "mm/host.sh",
      "mm/kit/prompts/capital.txt",
      "mm/kit/prompts/color.txt",
      "mm/kit/prompts/sum.txt",
      "mm/kit/run.sh",
      "mm/llama-android/libggml-cpu-android_armv9.2_2.so",
      "mm/llama-android/libllama.so",
      "mm/llama-android/LICENSE",
      "mm/llama-android/llama-bench",
      "mm/llama-android/llama-completion",
      "mm/llama-snapdragon/bin/llama-bench",
      "mm/llama-snapdragon/bin/llama-completion",
      "mm/llama-snapdragon/lib/libggml-htp-v81.so",
      "mm/llama-snapdragon/LICENSE",
      `mm/plan/${STAMP}-01/bartowski-iq2_xxs.env`,
      `mm/plan/${STAMP}-01/bartowski-iq2_xxs.system`,
      `mm/plan/${STAMP}-01/bartowski-iq2_xxs.url`,
      `mm/plan/${STAMP}-01/run.env`,
      "requirements.txt",
      "tests/test_carrier.py",
      ...df.CARRIER_WHEELS.map((w) => `wheelhouse/${w.file}`).sort((a, b) => a.localeCompare(b)),
    ]);
    const mode = (p: string) => entries.find((e) => e.path === p)?.mode;
    assert.equal(mode("mm/host.sh"), 0o755);
    assert.equal(mode("mm/kit/run.sh"), 0o755);
    assert.equal(mode("mm/llama-snapdragon/bin/llama-bench"), 0o755);
    assert.equal(mode("mm/llama-android/libllama.so"), 0o755);
    assert.equal(mode("mm/kit/prompts/sum.txt"), 0o644);
    assert.deepEqual(entries.find((e) => e.path === "requirements.txt")?.from, { root: "carrier", path: "requirements.txt" });
  });

  it("refuses a package without the tools, the kit, or with a stray plan path", () => {
    assert.throws(() => df.packageEntries(input({ kitFiles: ["prompts/sum.txt"] })), /no run\.sh/);
    assert.throws(() => df.packageEntries(input({ androidFiles: ["llama-bench"] })), /android build has no llama-completion/);
    assert.throws(() => df.packageEntries(input({ snapdragonFiles: ["llama-bench", "llama-completion"] })), /snapdragon build has no bin\/llama-bench/);
    assert.throws(() => df.packageEntries(input({ androidFiles: ["bin/llama-bench", "bin/llama-completion"] })), /android build has no llama-bench/);
    assert.throws(() => df.packageEntries(input({ plans: [{ path: "mm/host.sh", text: "" }] })), /Not a plan file/);
    assert.throws(() => df.packageEntries(input({ plans: [{ path: "mm/plan/../../x", text: "" }] })), /Not a plan file/);
  });

  it("keeps the repo's test spec, carrier requirements and carrier test as the code writes them", () => {
    assert.equal(readFileSync(path.join(ROOT, "devices/devicefarm/testspec.yml"), "utf8"), df.testSpecYaml());
    assert.equal(readFileSync(path.join(ROOT, "devices/devicefarm/carrier/requirements.txt"), "utf8"), df.carrierRequirements());
    const test = readFileSync(path.join(ROOT, "devices/devicefarm/carrier/tests/test_carrier.py"), "utf8");
    assert.equal(test.match(/^def test_\w+\(/gm)?.length, 1);
  });

  it("writes a spec that runs host.sh in every phase on Amazon Linux 2023 and keeps the log folder", () => {
    const spec = df.testSpecYaml();
    assert.match(spec, /^version: 0\.1$/m);
    assert.match(spec, /^android_test_host: amazon_linux_2023$/m);
    for (const phase of ["install", "pre_test", "test", "post_test"]) {
      assert.ok(spec.includes(`  ${phase}:\n    commands:\n      - bash "$DEVICEFARM_TEST_PACKAGE_PATH/mm/host.sh" ${phase}\n`), phase);
    }
    assert.match(spec, /^artifacts:\n {2}- \$DEVICEFARM_LOG_DIR$/m);
    assert.ok(!spec.includes("\t"), "YAML has no tabs");
  });

  it("pins pytest 8.4.2 and its dependencies as py3-none-any wheels with their sha256", () => {
    const names = df.CARRIER_WHEELS.map((w) => w.name);
    for (const n of ["pytest", "iniconfig", "packaging", "pluggy", "pygments"]) assert.ok(names.includes(n), n);
    assert.equal(df.CARRIER_WHEELS[0].version, "8.4.2");
    for (const w of df.CARRIER_WHEELS) {
      assert.match(w.file, /-py3-none-any\.whl$/);
      assert.match(w.sha256, /^[0-9a-f]{64}$/);
      assert.ok(w.url.startsWith("https://files.pythonhosted.org/packages/") && w.url.endsWith(`/${w.file}`));
      assert.ok(w.file.startsWith(`${w.name}-${w.version}-`));
    }
    assert.equal(df.carrierRequirements(), df.CARRIER_WHEELS.map((w) => `${w.name}==${w.version}\n`).join(""));
  });
});

describe("zip files", () => {
  const entries: df.ZipEntry[] = [
    { path: "requirements.txt", data: Buffer.from("pytest==8.4.2\n"), mode: 0o644 },
    { path: "mm/host.sh", data: Buffer.from("#!/usr/bin/env bash\necho hi\n"), mode: 0o755 },
    { path: "mm/empty.txt", data: Buffer.alloc(0) },
    { path: "mm/big.bin", data: Buffer.alloc(300_000, 7) },
    { path: "mm/random.bin", data: Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 2654435761) % 251)) },
  ];

  it("reads back what it writes, modes included, and writes the same bytes every time", () => {
    const zip = df.zipBuild(entries);
    const back = df.zipRead(zip);
    assert.deepEqual(back.map((e) => e.path), entries.map((e) => e.path));
    for (const [i, e] of back.entries()) assert.ok(Buffer.from(e.data).equals(Buffer.from(entries[i].data)), e.path);
    assert.equal(back[1].mode, 0o755);
    assert.equal(back[0].mode, 0o644);
    assert.ok(df.zipBuild(entries).equals(zip));
    assert.ok(zip.length < 300_000 / 10, "compressible data is deflated");
  });

  it("writes zips other tools read, and reads zips the system's zip writes", { skip: spawnSync("unzip", ["-v"]).status !== 0 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mm-df-zip-"));
    try {
      writeFileSync(path.join(dir, "ours.zip"), df.zipBuild(entries));
      assert.equal(spawnSync("unzip", ["-tq", path.join(dir, "ours.zip")]).status, 0);
      writeFileSync(path.join(dir, "a.txt"), "hello from zip\n".repeat(100));
      const made = spawnSync("zip", ["-q", "theirs.zip", "a.txt"], { cwd: dir });
      if (made.status === 0) {
        const back = df.zipRead(readFileSync(path.join(dir, "theirs.zip")));
        assert.equal(Buffer.from(back[0].data).toString(), "hello from zip\n".repeat(100));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unsafe paths, encrypted entries and zips that unpack too large", () => {
    assert.throws(() => df.zipBuild([{ path: "../x", data: Buffer.from("x") }]), /Not a safe zip path/);
    assert.throws(() => df.zipBuild([{ path: "/etc/x", data: Buffer.from("x") }]), /Not a safe zip path/);
    const zip = df.zipBuild([{ path: "aaaa", data: Buffer.from("x") }]);
    const evil = Buffer.from(zip);
    const name = evil.indexOf("aaaa", evil.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
    evil.write("../a", name);
    assert.throws(() => df.zipRead(evil), /unsafe path/);
    const locked = Buffer.from(zip);
    const cd = locked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    locked.writeUInt16LE(1, cd + 8);
    assert.throws(() => df.zipRead(locked), /encrypted/);
    assert.throws(() => df.zipRead(df.zipBuild(entries), { maxBytes: 1000 }), /more than 1000 bytes/);
    assert.throws(() => df.zipRead(Buffer.from("not a zip at all, just text")), /Not a zip file/);
  });
});

describe("secrets", () => {
  it("finds AWS keys, signed URLs, Hugging Face tokens, QDC keys and the values of secret variables", () => {
    assert.equal(df.secretHits("AKIAIOSFODNN7EXAMPLE").length, 1);
    assert.equal(df.secretHits("aws_secret_access_key = x").length, 1);
    assert.equal(df.secretHits("https://s3.amazonaws.com/x?X-Amz-Signature=abc").length, 1);
    assert.equal(df.secretHits("hf_abcdefghijklmnopqrstuvwxyzABCDEF").length, 1);
    assert.equal(df.secretHits("QDC_API_KEY=fake-qdc-key").length, 1);
    assert.deepEqual(df.secretHits("MM_MODEL=/data/local/tmp/mm/model/a.gguf\nhttps://huggingface.co/x/y/resolve/z/a.gguf"), []);
    const values = df.secretValues({
      AWS_SECRET_ACCESS_KEY: "fakeSecretAccessKey000",
      HF_TOKEN: "hf_fakefakefakefakefake",
      MY_API_KEY: "fake-api-key-1",
      SHORT_TOKEN: "abc",
      HOME: "/Users/someone",
    });
    assert.deepEqual(values.map((v) => v.name), ["AWS_SECRET_ACCESS_KEY", "HF_TOKEN", "MY_API_KEY"]);
    assert.deepEqual(df.secretHits("nothing here but fake-api-key-1", values), ["the value of MY_API_KEY"]);
  });

  it("removes presigned URLs and keeps public ones", () => {
    const text =
      'Upload to "https://prod-us-west-2-uploads.s3-us-west-2.amazonaws.com/arn%3Aaws/x.zip?X-Amz-Algorithm=AWS4&X-Amz-Credential=AKIA%2F&X-Amz-Signature=abc" now; ' +
      "see https://huggingface.co/bartowski/x/resolve/abc/f.gguf and https://bucket.s3.amazonaws.com/f?AWSAccessKeyId=AKIA&Signature=x";
    const out = df.scrubPresigned(text);
    assert.ok(!/X-Amz|Signature|AKIA/.test(out), out);
    assert.match(out, /https:\/\/huggingface\.co\/bartowski\/x\/resolve\/abc\/f\.gguf/);
    assert.equal(out.split("[presigned URL removed]").length - 1, 2);
  });
});

describe("Device Farm's answers", () => {
  const signed = "https://prod-us-west-2-results.s3-us-west-2.amazonaws.com/x?X-Amz-Credential=AKIAFAKE&X-Amz-Signature=fake";

  it("reads uploads, projects, runs and jobs, with presigned URLs scrubbed from their messages", () => {
    const upload = df.readUpload({
      upload: { arn: "arn:aws:devicefarm:us-west-2:1:upload:p/u", status: "FAILED", url: signed, message: `bad, see ${signed}`, metadata: '{"errors":["x"]}' },
    });
    assert.equal(upload.url, signed, "the PUT URL is kept for the PUT only");
    assert.equal(upload.message, "bad, see [presigned URL removed]");
    assert.equal(upload.metadata, '{"errors":["x"]}');
    assert.deepEqual(df.readProjects({ projects: [{ arn: PROJECT, name: "muse-muse-devices" }, { name: "no arn" }] }), [
      { arn: PROJECT, name: "muse-muse-devices" },
    ]);
    assert.equal(df.readProject({ project: { arn: PROJECT, name: "muse-muse-devices" } }).arn, PROJECT);
    assert.throws(() => df.readProject({}), /without a project/);
    const run = df.readRun({
      run: { arn: "arn:r", name: "mm x", status: "COMPLETED", result: "PASSED", message: signed, deviceMinutes: { total: 27.5, metered: 27.5, unmetered: 0 } },
    });
    assert.deepEqual(run, { arn: "arn:r", name: "mm x", status: "COMPLETED", result: "PASSED", message: "[presigned URL removed]", deviceMinutes: 27.5 });
    assert.equal(df.runDone(run), true);
    assert.equal(df.runDone({ status: "STOPPING" }), false);
    const [job] = df.readJobs({
      jobs: [
        {
          arn: "arn:aws:devicefarm:us-west-2:1:job:p/r/00000",
          status: "COMPLETED",
          result: "FAILED",
          device: { arn: "arn:d", name: "Samsung Galaxy S26", manufacturer: "Samsung", model: "Samsung Galaxy S26", os: "16" },
          deviceMinutes: { total: 12 },
        },
      ],
    });
    assert.deepEqual(job.device, { arn: "arn:d", name: "Samsung Galaxy S26", manufacturer: "Samsung", model: "Samsung Galaxy S26", os: "16" });
    assert.equal(job.deviceMinutes, 12);
  });

  it("picks the customer artifact and the spec's console from ListArtifacts", () => {
    const files = df.readArtifacts({
      artifacts: [
        { arn: "a1", name: "Customer Artifacts", type: "CUSTOMER_ARTIFACT", extension: "zip", url: signed },
        { arn: "a2", name: "Video", type: "VIDEO", extension: "mp4", url: signed },
        { arn: "a3", name: "no url", type: "CUSTOMER_ARTIFACT" },
      ],
    });
    const logs = df.readArtifacts({ artifacts: [{ arn: "l1", name: "TestSpec Output", type: "TESTSPEC_OUTPUT", extension: "txt", url: signed }] });
    const picked = df.pickArtifacts(files, logs);
    assert.equal(picked.customer?.arn, "a1");
    assert.equal(picked.console?.arn, "l1");
    assert.deepEqual(df.pickArtifacts([], []), { customer: null, console: null });
    assert.deepEqual(df.readArns({ suites: [{ arn: "s1" }, { arn: "s2" }] }, "suites"), ["s1", "s2"]);
  });

  it("finds each subject's kit folder in the customer artifact, whatever folder Device Farm puts first", () => {
    const dirs = df.kitDirsIn([
      "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/host.log",
      "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/bartowski-iq2_m/run.txt",
      "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/bartowski-iq2_m/steps.txt",
      "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/bartowski-iq2_xxs/host-bartowski-iq2_xxs.txt",
      "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/other/host-bartowski-iq2_m.txt",
      "mm/smoke-smollm2-135m-q4_0/run.txt",
    ]);
    assert.deepEqual([...dirs.entries()], [
      ["bartowski-iq2_m", "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/bartowski-iq2_m"],
      ["bartowski-iq2_xxs", "Host_Machine_Files/$DEVICEFARM_LOG_DIR/mm/bartowski-iq2_xxs"],
      ["smoke-smollm2-135m-q4_0", "mm/smoke-smollm2-135m-q4_0"],
    ]);
  });

  it("says in plain words how host.sh got each file onto the phone, or why it didn't", () => {
    assert.deepEqual(df.hostNotes({ copy: "push", download_seconds: "212", host_sha256: "ok", push_seconds: "640" }), [
      "The Device Farm host downloaded the file in 212 s, checked its sha256 and pushed it with adb in 640 s.",
    ]);
    assert.match(df.hostNotes({ copy: "stream", stream_seconds: "700" })[0], /streamed from the Hub to the phone in 700 s/);
    assert.match(df.hostNotes({ copy: "ram_skip", mem_total_kb: "7500000", min_ram_kb: "9883613" })[0], /MemTotal \(7500000 kB\) is under/);
    assert.equal(df.hostNotes({ copy: "push", adb_dropped: "1", kit_finished: "0" }).length, 3);
    assert.match(df.notTestedReason({ copy: "no_space", phone_free_kb: "4000000" }), /had 4\.1 GB free in \/data\/local\/tmp/);
    assert.equal(df.notTestedReason({ copy: "failed", copy_why: "sha256" }), "the copy to the phone failed (sha256)");
    assert.match(df.notTestedReason({ copy: "push", kit_rc: "2" }), /refused its inputs/);
    assert.match(df.notTestedReason(null), /nothing for it/);
  });
});

describe("scheduling and watching runs", () => {
  const run = () => df.planBatch([named("Samsung Galaxy S25")], { stamp: STAMP }).runs[0];
  const targets: df.ScheduleTargets = {
    projectArn: PROJECT,
    packageArn: "arn:aws:devicefarm:us-west-2:123456789012:upload:11111111/aaaa",
    specArn: "arn:aws:devicefarm:us-west-2:123456789012:upload:11111111/bbbb",
    billing: "METERED",
  };

  it("names the uploads .zip and .yml", () => {
    assert.deepEqual(df.uploadNames(STAMP), { package: `mm-devices-${STAMP}.zip`, spec: `mm-devices-${STAMP}.yml` });
    assert.throws(() => df.uploadNames("x/y"), /Not a UTC stamp/);
  });

  it("schedules one phone by ARN with the package, the spec, MM_PLAN, the job timeout and no video or app", () => {
    assert.deepEqual(df.scheduleRunInput(run(), targets), {
      projectArn: PROJECT,
      name: `mm ${STAMP}-01 Samsung Galaxy S25`,
      deviceSelectionConfiguration: {
        filters: [{ attribute: "ARN", operator: "IN", values: ["arn:aws:devicefarm:us-west-2::device:092D78E7B4694568812D5FF0711CD346"] }],
        maxDevices: 1,
      },
      test: { type: "APPIUM_WEB_PYTHON", testPackageArn: targets.packageArn, testSpecArn: targets.specArn },
      configuration: { billingMethod: "METERED", environmentVariables: [{ name: "MM_PLAN", value: `${STAMP}-01` }] },
      executionConfiguration: { jobTimeoutMinutes: 75, videoCapture: false },
    });
  });

  it("refuses ARNs from elsewhere and job timeouts Device Farm wouldn't take", () => {
    assert.throws(() => df.scheduleRunInput(run(), { ...targets, projectArn: "arn:aws:devicefarm:us-east-1:1:project:x" }), /us-west-2/);
    assert.throws(() => df.scheduleRunInput({ ...run(), jobTimeoutMinutes: 151 }, targets), /isn't from 5 to 150/);
    assert.throws(() => df.scheduleRunInput({ ...run(), subjects: [] }, targets), /1 to 2/);
  });

  it("stops a run that waits six hours for its phone or runs 20 minutes past its job timeout, and nothing else", () => {
    const t0 = Date.UTC(2026, 9, 28, 22, 0, 0);
    const min = 60_000;
    let w: df.RunWatch = { scheduledAt: t0, startedAt: null, jobTimeoutMinutes: 75 };
    assert.equal(df.watchRun(w, "PENDING_DEVICE", t0 + 300 * min).stop, null);
    assert.match(df.watchRun(w, "PENDING_DEVICE", t0 + 361 * min).stop ?? "", /waited 361 minutes for its phone/);
    let step = df.watchRun(w, "RUNNING", t0 + 10 * min);
    assert.equal(step.watch.startedAt, t0 + 10 * min);
    w = step.watch;
    step = df.watchRun(w, "RUNNING", t0 + 10 * min + 95 * min);
    assert.equal(step.stop, null);
    step = df.watchRun(w, "RUNNING", t0 + 10 * min + 96 * min);
    assert.match(step.stop ?? "", /ran 96 minutes, past its 75-minute job timeout/);
    assert.equal(df.watchRun(w, "COMPLETED", t0 + 999 * min).stop, null);
    assert.equal(df.watchRun(w, "STOPPING", t0 + 999 * min).stop, null);
  });
});

describe("the batch record", () => {
  const batch = () => df.planBatch(df.choosePhones(phones(), { maxDevices: 3 }), { stamp: STAMP });

  it("keeps what fetch and stop need, and reads back", () => {
    const record = df.batchRecord(batch());
    record.runs[0].arn = "arn:aws:devicefarm:us-west-2:123456789012:run:p/r1";
    const back = df.readBatchRecord(JSON.parse(JSON.stringify(record)));
    assert.equal(back.stamp, STAMP);
    assert.deepEqual(back.runs.map((r) => [r.key, r.jobTimeoutMinutes, r.subjects.map((s) => s.id)]), [
      [`${STAMP}-01`, 75, ["bartowski-iq2_xxs"]],
      [`${STAMP}-02`, 145, ["bartowski-iq2_m", "bartowski-iq2_xxs"]],
      [`${STAMP}-03`, 75, ["bartowski-iq2_xxs"]],
    ]);
    assert.deepEqual(back.runs[1].phone, {
      arn: "arn:aws:devicefarm:us-west-2::device:601095261F73476B92209274AD22553A",
      name: "Google Pixel 10 Pro XL",
      manufacturer: "Google",
      model: "Google Pixel 10 Pro XL",
      os: "16",
      ramGiB: 16,
      ramFrom: "spec",
    });
    assert.equal(df.recordedRun(back, { arn: "arn:aws:devicefarm:us-west-2:123456789012:run:p/r1", name: "" })?.key, `${STAMP}-01`);
    assert.equal(df.recordedRun(back, { arn: "arn:other", name: `mm ${STAMP}-03 Samsung Galaxy S24 Ultra` })?.key, `${STAMP}-03`);
    assert.equal(df.recordedRun(back, { arn: "arn:other", name: "elsewhere" }), null);
    assert.throws(() => df.readBatchRecord({ version: 9, stamp: STAMP, runs: [] }), /version 1/);
    assert.ok(!JSON.stringify(record).includes("X-Amz"));
  });

  it("tells the parser the phone's Device Farm names, ARN and planned RAM", () => {
    const record = df.batchRecord(batch());
    assert.deepEqual(df.kitDevice(record.runs[0].phone), {
      name: "Samsung Galaxy S25",
      manufacturer: "Samsung",
      model: "Samsung Galaxy S25",
      os: "android",
      cloudId: "arn:aws:devicefarm:us-west-2::device:092D78E7B4694568812D5FF0711CD346",
      ramBytes: 12 * GIB,
      marketedRamGiB: 12,
    });
    const job: df.DfJob = {
      arn: "arn:j",
      status: "COMPLETED",
      result: "PASSED",
      message: "",
      device: { arn: "arn:d", name: "Google Pixel 9 Pro", manufacturer: "Google", model: "", os: "15" },
      deviceMinutes: 1,
    };
    assert.deepEqual(df.phoneOfJob(job), {
      arn: "arn:d",
      name: "Google Pixel 9 Pro",
      manufacturer: "Google",
      model: "Google Pixel 9 Pro",
      os: "15",
      ramGiB: 16,
      ramFrom: "spec",
    });
  });

  it("counts a smoke run as passed only on Device Farm, finished, with a backend that loaded", () => {
    const smokeResult = (over: Partial<Result>, loaded = true) =>
      ({ cloud: "devicefarm", status: "done", subject: SMOKE, backends: [{ loaded }], ...over }) as unknown as Result;
    assert.equal(df.smokePassed([]), false);
    assert.equal(df.smokePassed([smokeResult({})]), true);
    assert.equal(df.smokePassed([smokeResult({ status: "cut" })]), true);
    assert.equal(df.smokePassed([smokeResult({}, false)]), false);
    assert.equal(df.smokePassed([smokeResult({ status: "failed" })]), false);
    assert.equal(df.smokePassed([smokeResult({ cloud: "local" })]), false);
    assert.equal(df.smokePassed([smokeResult({ subject: STAND_INS[0] })]), false);
  });
});
