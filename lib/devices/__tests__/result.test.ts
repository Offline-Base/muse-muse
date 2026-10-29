/**
 * lib/devices/result.ts on kit output folders: a real Snapdragon 8 Elite Gen 5 run of bartowski's Q3_K_M (llama-bench's
 * own JSONL and logs from the phone, in the kit's layout, with constructed Glimmer answers), a constructed 12 GB phone
 * where the low-memory killer ends the CPU bench, the GPU fails to load and the NPU isn't there, and a real smoke run on
 * the owner's Mac (each fixture's README says what is real). Then the final answer in Glimmer's channels and SmolLM2's
 * ChatML, each file's parser, folders the kit never finished or that are malformed, the verdict at its edges, and
 * writeResult. Nothing here runs anything.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/result.test.ts
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  finalAnswer,
  firstError,
  keyValues,
  memSummary,
  parseAnswerLog,
  parseBenchJsonl,
  parseBenchLog,
  parseKitOutput,
  parseMem,
  parseSteps,
  readResult,
  verdictFor,
  writeResult,
  type KitContext,
} from "@/lib/devices/result";
import { SMOKE, subjectById } from "@/lib/devices/subjects";
import { RESULT_SCHEMA, type Backend, type BackendRun, type Completion, type PromptId, type Result } from "@/lib/devices/types";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixture = (name: string) => path.join(FIXTURES, name);
const Q3 = subjectById("bartowski-q3_k_m")!;
const IQ2 = subjectById("bartowski-iq2_xxs")!;

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-result-"));
  temps.push(dir);
  return dir;
}

/** A copy of a fixture folder, to change. */
function copyFixture(name: string): string {
  const dir = path.join(tempDir(), name);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

const QDC_PHONE: KitContext = {
  cloud: "qdc",
  runId: "qdc-job-12345",
  stamp: "20261028T235200Z",
  subject: Q3,
  device: { name: "Snapdragon 8 Elite Gen 5 QRD", manufacturer: "Qualcomm", model: "SM8850 QRD", cloudId: "qdc:SM8850" },
};

describe("finalAnswer", () => {
  it("takes SmolLM2's ChatML answer whole, up to <|im_end|>", () => {
    assert.deepEqual(finalAnswer("The capital of France is Paris.<|im_end|> [end of text]\n\n\n"), {
      answer: "The capital of France is Paris.",
      finished: true,
    });
  });

  it("takes Glimmer's to=user answer after its to=self reasoning, up to <|eot|>", () => {
    const raw =
      " to=self<|message|>The user wants the capital of France in one word. That is Paris.<|eom|>" +
      "<|start|>assistant to=user<|message|>Paris<|eot|> [end of text]\n\n";
    assert.deepEqual(finalAnswer(raw), { answer: "Paris", finished: true });
    assert.deepEqual(finalAnswer(" to=user<|message|>42<|eot|> [end of text]"), { answer: "42", finished: true });
  });

  it("gives no answer when Glimmer never opens to=user, even when it reasons its way to the right word", () => {
    const raw = " to=self<|message|>Blue and yellow paint make green, and the user wants one word, so the answer is";
    assert.deepEqual(finalAnswer(raw), { answer: "", finished: false });
    assert.deepEqual(finalAnswer(" to=self<|message|>Green.<|eom|><|start|>assistant [end of text]"), { answer: "", finished: true });
  });

  it("keeps the last to=user message, cuts at the first end token after it, and drops other control tokens", () => {
    const raw = " to=user<|message|>Lyon<|eom|><|start|>assistant to=user<|message|>Par<|finetune_right_pad|>is<|eom|><|start|>assistant";
    assert.deepEqual(finalAnswer(raw), { answer: "Paris", finished: false });
    assert.deepEqual(finalAnswer(" to=user<|message|>Green<|end_of_text|>"), { answer: "Green", finished: false });
    assert.deepEqual(finalAnswer("Green<|start|>user"), { answer: "Green", finished: false });
    assert.deepEqual(finalAnswer("  Plain words with no tokens at all  "), { answer: "Plain words with no tokens at all", finished: false });
  });
});

describe("the file parsers", () => {
  it("keyValues reads key=value lines, the last of a key winning, and skips anything else", () => {
    assert.deepEqual(keyValues("kit=1\nmodel=Fake Phone 24\r\nnot a line\nstatus=cut\nstatus=done\nBad=1\nempty=\n"), {
      kit: "1",
      model: "Fake Phone 24",
      status: "done",
      empty: "",
    });
    assert.deepEqual(keyValues(null), {});
  });

  it("parseSteps reads each line's codes, with - as none, and skips malformed lines", () => {
    const steps = parseSteps(
      "name=bench backend=cpu prompt=- start=1793231530 seconds=68 limit=900 rc=0 end=ok why=-\n" +
        "name=answer backend=npu prompt=sum start=1 seconds=0 limit=0 rc=- end=skipped why=noload\n" +
        "name=bench backend=cpu end=exploded\n\n",
    );
    assert.deepEqual(steps, [
      { name: "bench", backend: "cpu", prompt: null, start: 1793231530, seconds: 68, limit: 900, rc: 0, end: "ok", why: null },
      { name: "answer", backend: "npu", prompt: "sum", start: 1, seconds: 0, limit: 0, rc: null, end: "skipped", why: "noload" },
    ]);
  });

  it("parseBenchJsonl reads the phone's real pp and tg lines, and nothing from an empty file", () => {
    const cpu = parseBenchJsonl(readFileSync(fixture("android-sm8850-q3_k_m/bench-cpu.jsonl"), "utf8"));
    assert.deepEqual(cpu, { loaded: true, promptTps: 5.607882, genTps: 3.010551, promptTokens: 128, genTokens: 32, reps: 1 });
    assert.deepEqual(parseBenchJsonl(""), { loaded: false, promptTps: null, genTps: null, promptTokens: null, genTokens: null, reps: null });
    const half = parseBenchJsonl('noise\n{"n_prompt": 128, "n_gen": 0, "avg_ts": 6.3}\n{"broken": \n');
    assert.deepEqual([half.loaded, half.promptTps, half.genTps], [true, 6.3, null]);
  });

  it("parseBenchLog adds up a load's model buffers and keeps the largest KV and compute buffers", () => {
    const mac = parseBenchLog(readFileSync(fixture("mac-m4max-smoke/bench-cpu.log"), "utf8"));
    assert.equal(mac.offloaded, "0/31");
    assert.deepEqual(mac.buffersMiB, { "CPU_Mapped model": 30.28, "CPU_REPACK model": 84.22, "CPU KV": 5.62, "CPU compute": 25.47 });
    const gpu = parseBenchLog(readFileSync(fixture("mac-m4max-smoke/bench-gpu.log"), "utf8"));
    assert.deepEqual([gpu.offloaded, gpu.buffersMiB["MTL0_Mapped model"], gpu.buffersMiB["MTL0 compute"]], ["31/31", 85.93, 25.19]);
    assert.deepEqual(parseBenchLog(readFileSync(fixture("android-sm8850-q3_k_m/bench-cpu.log"), "utf8")), { offloaded: null, buffersMiB: {} });
  });

  it("parseAnswerLog reads llama-completion's perf lines through their log prefix", () => {
    const log = readFileSync(fixture("mac-m4max-smoke/answer-gpu-sum.log"), "utf8");
    const t = parseAnswerLog(log);
    assert.ok(t.promptTps! > 100 && t.genTps! > 100, JSON.stringify(t));
    assert.deepEqual([t.promptTokens, t.genTokens], [45, 11]);
    assert.ok(t.loadSeconds! > 0 && t.loadSeconds! < 5);
    const phone = parseAnswerLog(readFileSync(fixture("android-sm8850-q3_k_m/answer-cpu-color.log"), "utf8"));
    assert.deepEqual(phone, { promptTps: 5.62, genTps: 3.01, promptTokens: 45, genTokens: 192, loadSeconds: 8.111 });
    assert.deepEqual(parseAnswerLog(null), { promptTps: null, genTps: null, promptTokens: null, genTokens: null, loadSeconds: null });
  });

  it("memSummary takes the peak, the low point, the drop from t=0 and the hottest plausible zone", () => {
    const lmk = memSummary(parseMem(readFileSync(fixture("android-12gb-lmk/mem-bench-cpu.txt"), "utf8")));
    assert.deepEqual(lmk, {
      peakRssBytes: 8710344 * 1024,
      minAvailableBytes: 214880 * 1024,
      availDropBytes: (6012880 - 214880) * 1024,
      maxTempC: 49.8,
    });
    const mac = memSummary(parseMem("t=0 level=45\nt=0 rss_kb=208 level=45\nt=2 rss_kb=704512 level=44\nt=4 rss_kb= level=44\n"));
    assert.deepEqual(mac, { peakRssBytes: 704512 * 1024, minAvailableBytes: null, availDropBytes: null, maxTempC: null });
    assert.equal(memSummary(parseMem("t=0 temp_mc=999999\nt=1 temp_mc=0\nt=2 temp_mc=41500\n")).maxTempC, 41.5);
  });

  it("firstError skips the line every healthy -v log has, and keeps 300 characters", () => {
    const log = readFileSync(fixture("android-12gb-lmk/bench-gpu.log"), "utf8");
    assert.equal(firstError(log), "ggml_backend_opencl_buffer_type_alloc_buffer: failed to allocate 7980.25 MiB buffer");
    assert.equal(firstError(readFileSync(fixture("mac-m4max-smoke/bench-cpu.log"), "utf8")), null);
    assert.equal(firstError(null, `GGML_ASSERT(${"x".repeat(400)})`)?.length, 300);
  });
});

describe("parseKitOutput on real and constructed folders", () => {
  it("reads the Snapdragon 8 Elite Gen 5 run: real benches, a timed-out NPU, Glimmer's answers, slow on the CPU", () => {
    const r = parseKitOutput(fixture("android-sm8850-q3_k_m"), QDC_PHONE);
    assert.deepEqual([r.schema, r.kit, r.cloud, r.runId, r.stamp, r.status], [RESULT_SCHEMA, 1, "qdc", "qdc-job-12345", "20261028T235200Z", "done"]);
    assert.deepEqual(r.device, {
      cloud: "qdc",
      slug: "qualcomm-sm8850-qrd-24gb",
      name: "Snapdragon 8 Elite Gen 5 QRD",
      manufacturer: "Qualcomm",
      model: "SM8850 QRD",
      os: "android",
      osVersion: "16",
      apiLevel: 36,
      soc: "SM8850",
      ramBytes: 23760480 * 1024,
      marketedRamGiB: 24,
      cpuCores: 8,
      freeDiskBytes: 45088768 * 1024,
      cloudId: "qdc:SM8850",
    });
    assert.deepEqual(r.llama, { tag: "b11669", builds: ["android-arm64-snapdragon"] });
    assert.deepEqual([r.startedAt, r.finishedAt, r.seconds], ["2026-10-28T23:52:00.000Z", "2026-10-29T00:17:41.000Z", 1541]);
    assert.deepEqual(r.model, { check: "ok", bytes: Q3.bytes, sha256: Q3.sha256, seconds: 5, fetched: false, fetchSeconds: null });

    const [cpu, gpu, npu] = r.backends;
    assert.deepEqual(
      [cpu.device, cpu.loaded, cpu.promptTps, cpu.genTps, cpu.promptTokens, cpu.genTokens, cpu.reps, cpu.end, cpu.seconds],
      ["none", true, 5.607882, 3.010551, 128, 32, 1, "ok", 68],
    );
    assert.deepEqual(
      [cpu.peakRssBytes, cpu.minAvailableBytes, cpu.availDropBytes],
      [5624832 * 1024, 13549568 * 1024, (19523584 - 13549568) * 1024],
    );
    assert.deepEqual([gpu.device, gpu.promptTps, gpu.genTps, gpu.minAvailableBytes], ["GPUOpenCL", 5.81524, 2.092101, 6678528 * 1024]);
    assert.deepEqual(
      [npu.device, npu.available, npu.loaded, npu.end, npu.why, npu.rc, npu.error, npu.genTokens, npu.reps],
      ["HTP0", true, false, "timeout", "limit", 143, null, 32, 1],
    );

    assert.deepEqual(
      r.completions.filter((c) => c.end === "skipped").map((c) => [c.backend, c.promptId, c.why]),
      [["npu", "capital", "noload"], ["npu", "sum", "noload"], ["npu", "color", "noload"]],
    );
    const asked = r.completions.filter((c) => c.end !== "skipped");
    assert.deepEqual(
      asked.map((c) => [c.backend, c.promptId, c.answer, c.right, c.finished, c.genTps]),
      [
        ["cpu", "capital", "Paris", true, true, 3.02],
        ["cpu", "sum", "42", true, true, 3.03],
        ["cpu", "color", "", false, false, 3.01],
        ["gpu", "capital", "Paris", true, true, 2.11],
        ["gpu", "sum", "42", true, true, 2.1],
        ["gpu", "color", "Green", true, true, 2.1],
      ],
    );
    assert.equal(asked[2].genTokens, 192);
    assert.equal(asked[0].loadSeconds, 8.125);
    assert.ok(asked[2].raw.startsWith(" to=self<|message|>Blue and yellow"));

    assert.deepEqual(r.verdict, {
      rating: "slow",
      backend: "cpu",
      genTps: 3.010551,
      promptTps: 5.607882,
      answersRight: 2,
      answersTotal: 3,
      reasons: [
        "npu: the bench ran out of time after 910 s before its first result.",
        "cpu: 3.01 tokens a second with 2 of 3 answers right: slow (usable needs 4).",
        "It reads prompts at 5.61 tokens a second, so a 500-token prompt takes about 89 s before the first word.",
      ],
    });
    assert.deepEqual(r.notes, []);
  });

  it("reads the 12 GB phone: a low-memory kill, a load failure and no NPU make it unusable", () => {
    const r = parseKitOutput(fixture("android-12gb-lmk"), {
      cloud: "devicefarm",
      runId: "arn:aws:devicefarm:us-west-2:123456789012:run:fake/run",
      stamp: "20261029T072000Z",
      subject: IQ2,
      device: { name: "Samsung Galaxy S24 Ultra", cloudId: "arn:aws:devicefarm:us-west-2::device:FAKE" },
    });
    assert.deepEqual([r.device.slug, r.device.name, r.device.marketedRamGiB, r.device.apiLevel], ["samsung-sm-s928u1-12gb", "Samsung Galaxy S24 Ultra", 12, 35]);
    assert.deepEqual(r.llama.builds, ["android-arm64", "android-arm64-snapdragon"]);
    const [cpu, gpu, npu] = r.backends;
    assert.deepEqual([cpu.end, cpu.why, cpu.rc, cpu.loaded, cpu.promptTps, cpu.genTps], ["killed", "lmk", 137, true, 6.300356, null]);
    assert.deepEqual([cpu.peakRssBytes, cpu.minAvailableBytes, cpu.maxTempC], [8710344 * 1024, 214880 * 1024, 49.8]);
    assert.deepEqual(cpu.buffersMiB, { "CPU_Mapped model": 8495.06, "CPU KV": 13, "CPU compute": 212.51 });
    assert.deepEqual([gpu.end, gpu.loaded, gpu.offloaded], ["error", false, "53/53"]);
    assert.equal(gpu.error, "ggml_backend_opencl_buffer_type_alloc_buffer: failed to allocate 7980.25 MiB buffer");
    assert.deepEqual([npu.end, npu.why, npu.available, npu.device], ["skipped", "unavailable", false, "HTP0,HTP1,HTP2"]);
    assert.ok(r.completions.every((c) => c.end === "skipped" && c.why === "noload"));
    assert.equal(r.completions.length, 9);
    assert.deepEqual(r.verdict.rating, "unusable");
    assert.deepEqual(r.verdict.reasons, [
      "cpu: the bench was killed by the low-memory killer.",
      "gpu: it didn't load (ggml_backend_opencl_buffer_type_alloc_buffer: failed to allocate 7980.25 MiB buffer).",
      "npu: not run, its device isn't on this one.",
      "No backend ran with enough right answers and without a kill.",
    ]);
  });

  it("reads this Mac's real smoke run: usable on Metal with 2 of 3 answers right", () => {
    const r = parseKitOutput(fixture("mac-m4max-smoke"), { cloud: "local", runId: "local-20261029T031655Z", stamp: "20261029T031655Z", subject: SMOKE });
    assert.deepEqual(
      [r.device.slug, r.device.name, r.device.os, r.device.osVersion, r.device.soc, r.device.marketedRamGiB],
      ["apple-mac16-5-36gb", "Mac16,5 (Apple M4 Max)", "macos", "26.5.1", "Apple M4 Max", 36],
    );
    assert.deepEqual(r.llama.builds, ["macos-arm64"]);
    assert.deepEqual(r.backends.map((b) => [b.backend, b.device, b.offloaded]), [["gpu", "MTL0", "31/31"], ["cpu", "none", "0/31"]]);
    assert.ok(r.backends.every((b) => b.genTps! > 100 && b.availDropBytes === null));
    assert.deepEqual(r.completions.map((c) => c.right), [true, true, false, true, true, false]);
    assert.deepEqual([r.verdict.rating, r.verdict.backend, r.verdict.answersRight, r.verdict.answersTotal], ["usable", "gpu", 2, 3]);
  });

  it("throws only without a run.txt or with another kit version", () => {
    const empty = tempDir();
    assert.throws(() => parseKitOutput(empty, QDC_PHONE), /No run\.txt/);
    writeFileSync(path.join(empty, "run.txt"), "kit=2\nsubject=x\n");
    assert.throws(() => parseKitOutput(empty, QDC_PHONE), /from kit 2; this parser reads kit 1/);
    writeFileSync(path.join(empty, "run.txt"), "kit=1\n");
    const bare = parseKitOutput(empty, QDC_PHONE);
    assert.deepEqual([bare.status, bare.backends, bare.verdict.rating], ["cut", [], "failed"]);
  });

  it("reads a folder the kit never finished as cut, with every step it never wrote as stopped", () => {
    const dir = copyFixture("android-sm8850-q3_k_m");
    const run = readFileSync(path.join(dir, "run.txt"), "utf8").replace(/^(finished|seconds|status)=.*\n/gm, "");
    writeFileSync(path.join(dir, "run.txt"), run);
    const steps = readFileSync(path.join(dir, "steps.txt"), "utf8").split("\n").slice(0, 2).join("\n");
    writeFileSync(path.join(dir, "steps.txt"), `${steps}\n`);
    const r = parseKitOutput(dir, QDC_PHONE);
    assert.equal(r.status, "cut");
    assert.ok(r.notes[0].startsWith("The kit stopped before it finished"));
    assert.deepEqual(r.backends.map((b) => [b.backend, b.end, b.why]), [["cpu", "ok", null], ["gpu", "skipped", "stopped"], ["npu", "skipped", "stopped"]]);
    assert.equal(r.completions.length, 9);
    assert.ok(r.completions.every((c) => c.end === "skipped" && c.why === "stopped"));
    assert.equal(r.finishedAt, "2026-10-28T23:53:18.000Z", "the end of the last step written");
    assert.deepEqual(r.verdict.reasons, [
      "cpu: answers not asked, the kit was stopped first.",
      "gpu: not run, the kit was stopped first.",
      "npu: not run, the kit was stopped first.",
      "No backend ran with enough right answers and without a kill.",
    ]);
  });

  it("leaves out answers to prompts it doesn't know, with a note", () => {
    const dir = copyFixture("mac-m4max-smoke");
    writeFileSync(
      path.join(dir, "steps.txt"),
      `${readFileSync(path.join(dir, "steps.txt"), "utf8")}name=answer backend=cpu prompt=haiku start=1 seconds=1 limit=90 rc=0 end=ok why=-\n`,
    );
    const r = parseKitOutput(dir, { cloud: "local", runId: "x", stamp: "20261029T031655Z", subject: SMOKE });
    assert.equal(r.completions.length, 6);
    assert.deepEqual(r.notes, ["Answers to prompts this parser doesn't know were left out: haiku."]);
  });

  it("says why a phone with too little RAM was skipped", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "run.txt"), "kit=1\nplatform=android\nbackends=cpu\nprompts=capital,sum,color\nstarted=100\nfinished=101\nseconds=1\nstatus=skipped\nwhy=ram\n");
    writeFileSync(path.join(dir, "device.txt"), "platform=android\nram_kb=7654321\nmanufacturer=Google\nmodel=Pixel 8\nandroid=16\nsdk=36\n");
    writeFileSync(path.join(dir, "model.txt"), "check=skipped\nfetched=0\n");
    writeFileSync(path.join(dir, "steps.txt"), "name=bench backend=cpu prompt=- start=100 seconds=0 limit=0 rc=- end=skipped why=ram\n");
    const r = parseKitOutput(dir, { cloud: "devicefarm", runId: "r", stamp: "20261029T000000Z", subject: IQ2 });
    assert.deepEqual([r.status, r.device.slug, r.verdict.rating], ["skipped", "google-pixel-8-8gb", "unusable"]);
    assert.deepEqual(r.verdict.reasons, ["This phone has 8 GB of RAM and the file's run needs 10.1 GB."]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The verdict at its edges

function backendRun(backend: Backend, fields: Partial<BackendRun> = {}): BackendRun {
  return {
    backend,
    device: backend === "cpu" ? "none" : backend === "gpu" ? "GPUOpenCL" : "HTP0",
    build: "android-arm64-snapdragon",
    available: true,
    loaded: true,
    promptTps: 50,
    genTps: 5,
    promptTokens: 128,
    genTokens: 16,
    reps: 2,
    offloaded: null,
    buffersMiB: {},
    peakRssBytes: null,
    minAvailableBytes: null,
    availDropBytes: null,
    maxTempC: null,
    end: "ok",
    why: null,
    rc: 0,
    seconds: 60,
    error: null,
    ...fields,
  };
}

/** Three answers on a backend, right as `rights` says, ending as `ends` says (ok when not given). */
function answersFor(backend: Backend, rights: boolean[], ends: Array<Completion["end"]> = []): Completion[] {
  const ids: PromptId[] = ["capital", "sum", "color"];
  return rights.map((right, i) => ({
    backend,
    promptId: ids[i],
    answer: right ? "Paris" : "",
    raw: "",
    finished: right,
    right,
    promptTps: null,
    genTps: null,
    promptTokens: null,
    genTokens: null,
    loadSeconds: null,
    peakRssBytes: null,
    end: ends[i] ?? "ok",
    why: ends[i] === "killed" ? "lmk" : ends[i] === "skipped" ? "time" : null,
    rc: ends[i] === "killed" ? 137 : 0,
    seconds: 10,
    error: null,
  }));
}

function withoutVerdict(backends: BackendRun[], completions: Completion[], fields: Partial<Omit<Result, "verdict">> = {}): Omit<Result, "verdict"> {
  const r = parseKitOutput(fixture("android-sm8850-q3_k_m"), QDC_PHONE);
  const { verdict, ...rest } = r;
  void verdict;
  return { ...rest, backends, completions, ...fields };
}

const ratingAt = (genTps: number) => verdictFor(withoutVerdict([backendRun("cpu", { genTps })], answersFor("cpu", [true, true, true]))).rating;

describe("verdictFor", () => {
  it("rates by generation speed: 4 and up usable, 1 and up slow, below 1 unusable", () => {
    assert.deepEqual([ratingAt(4), ratingAt(3.999), ratingAt(1), ratingAt(0.999), ratingAt(250)], ["usable", "slow", "slow", "unusable", "usable"]);
  });

  it("counts a backend with 2 of 3 answers right and not with 1, and never with a killed answer", () => {
    const two = verdictFor(withoutVerdict([backendRun("cpu")], answersFor("cpu", [true, false, true])));
    assert.deepEqual([two.rating, two.answersRight, two.answersTotal], ["usable", 2, 3]);
    const one = verdictFor(withoutVerdict([backendRun("cpu")], answersFor("cpu", [true, false, false])));
    assert.deepEqual([one.rating, one.reasons[0]], ["unusable", "cpu: 1 of 3 answers right."]);
    const killed = verdictFor(withoutVerdict([backendRun("cpu")], answersFor("cpu", [true, true, false], ["ok", "ok", "killed"])));
    assert.deepEqual([killed.rating, killed.reasons[0]], ["unusable", "cpu: an answer was killed by the low-memory killer."]);
    const cut = verdictFor(withoutVerdict([backendRun("cpu")], answersFor("cpu", [true, true, false], ["ok", "ok", "skipped"])));
    assert.deepEqual([cut.rating, cut.answersRight, cut.answersTotal], ["usable", 2, 2]);
  });

  it("lets the fastest backend that counts decide, not the fastest one", () => {
    const v = verdictFor(
      withoutVerdict(
        [backendRun("cpu", { genTps: 2.5 }), backendRun("gpu", { genTps: 9 }), backendRun("npu", { genTps: 3.5 })],
        [...answersFor("cpu", [true, true, true]), ...answersFor("gpu", [false, false, true]), ...answersFor("npu", [true, true, false])],
      ),
    );
    assert.deepEqual([v.rating, v.backend, v.genTps], ["slow", "npu", 3.5]);
    assert.deepEqual(v.reasons, ["gpu: 1 of 3 answers right.", "npu: 3.50 tokens a second with 2 of 3 answers right: slow (usable needs 4)."]);
  });

  it("still counts a bench that crashed after measuring, and adds a note under 10 prompt tokens a second", () => {
    const v = verdictFor(withoutVerdict([backendRun("gpu", { end: "crashed", why: "signal11", rc: 139, promptTps: 9.99 })], answersFor("gpu", [true, true, true])));
    assert.equal(v.rating, "usable");
    assert.equal(v.reasons[1], "It reads prompts at 9.99 tokens a second, so a 500-token prompt takes about 50 s before the first word.");
    const fast = verdictFor(withoutVerdict([backendRun("gpu", { promptTps: 10 })], answersFor("gpu", [true, true, true])));
    assert.equal(fast.reasons.length, 1);
  });

  it("fails on a bad model file, and on no backend loading, saying why", () => {
    const base = withoutVerdict([backendRun("cpu")], answersFor("cpu", [true, true, true]));
    assert.deepEqual(verdictFor({ ...base, model: { ...base.model, check: "sha256" }, status: "failed" }).reasons, [
      "The model file's sha256 doesn't match the pinned one.",
    ]);
    assert.equal(verdictFor({ ...base, model: { ...base.model, check: "no_tool" } }).rating, "usable");
    assert.equal(verdictFor({ ...base, model: { ...base.model, check: "timeout" } }).rating, "usable");
    const skipped = verdictFor(
      withoutVerdict(
        [backendRun("cpu", { loaded: false, genTps: null, end: "skipped", why: "nobuild" }), backendRun("gpu", { loaded: false, genTps: null, end: "skipped", why: "android_sdk" })],
        [],
      ),
    );
    assert.deepEqual(skipped.reasons, ["No backend ran: cpu, no llama.cpp build for it; gpu, the Snapdragon build needs Android 14."]);
    assert.equal(skipped.rating, "failed");
  });
});

describe("writeResult and readResult", () => {
  it("copy the kit's files and write result.json at resultDir, leaving out hidden files, models, folders and big files", () => {
    const repo = tempDir();
    const kit = copyFixture("mac-m4max-smoke");
    writeFileSync(path.join(kit, ".timeout-bench-cpu"), "");
    writeFileSync(path.join(kit, "SmolLM2.gguf"), "model");
    writeFileSync(path.join(kit, "model.gguf.part"), "partial");
    writeFileSync(path.join(kit, "huge.log"), Buffer.alloc(2 * 1024 * 1024, 120));
    mkdirSync(path.join(kit, "sub"));
    const r = parseKitOutput(kit, { cloud: "local", runId: "local-x", stamp: "20261029T031655Z", subject: SMOKE });
    const dir = writeResult(repo, r, kit);
    assert.equal(dir, path.join(repo, "devices/results/local/apple-mac16-5-36gb/smoke-smollm2-135m-q4_0/20261029T031655Z"));
    const files = readdirSync(dir).sort();
    assert.ok(files.includes("result.json") && files.includes("steps.txt") && files.includes("answer-gpu-sum.txt"));
    for (const left of [".timeout-bench-cpu", "SmolLM2.gguf", "model.gguf.part", "huge.log", "sub"]) {
      assert.ok(!files.includes(left), `${left} was copied`);
    }
    assert.deepEqual(readResult(path.join(dir, "result.json")), JSON.parse(JSON.stringify(r)));
    writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ...r, schema: 2 }));
    assert.throws(() => readResult(path.join(dir, "result.json")), /result schema 2, not 1/);
    assert.ok(existsSync(path.join(dir, "kit.log")));
  });
});
