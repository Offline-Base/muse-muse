import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WhereItRuns } from "@/components/train/room/WhereItRuns";
import { makeFilesCostText, quantLowBitText, quantRows, quantRowText, type QuantState } from "@/components/train/format";
import { adapterProblem, quantKlLimit, quantProblem, recipeDefaults, runEstimate } from "@/lib/train/logic";
import { deviceModelTarget, LOW_BIT_FACTS, quantBaseForAdapter, quantBaseOf } from "@/lib/train/quant-targets";

const LLAMA = { baseModel: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit", baseRevision: "9".repeat(40), baseFamily: "llama3", studentPrompt: "short" };
const summary = { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 };
const judged = (params: Record<string, string | number>) => ({ params, terminatedAt: new Date(), evalSummary: summary });

describe("deviceModelTarget", () => {
  it("gives a Jetson Orin Nano one-bit Glimmer, and everything else the small Llama", () => {
    const board = deviceModelTarget("jetson_orin_nano");
    assert.deepEqual([board.model, board.level, board.quantBase, board.fileStem], ["one-bit-glimmer", "IQ1_S", null, "muse-glimmer-30b-"]);
    for (const kind of ["mac", "windows", "phone", "jetson_agx", "", "anything"]) {
      const t = deviceModelTarget(kind);
      assert.deepEqual([t.model, t.level, t.quantBase, t.fileStem], ["small-llama", "Q4_K_M", "llama-3.2-3b", "Llama-3.2-3B-"], kind);
    }
  });

  it("keeps the memory visible and never claims a device has run a file", () => {
    assert.match(deviceModelTarget("jetson_orin_nano").fit, /Not run on a real board yet.*x86.*6\.53 GB.*7\.3 GB.*2\.4 tokens.*8 GB is shared/);
    assert.equal(deviceModelTarget("jetson_orin_nano").provenOnDevice, false);
    assert.equal(deviceModelTarget("mac").provenOnDevice, false);
    assert.ok(LOW_BIT_FACTS.runGbMeasured < LOW_BIT_FACTS.boardGb);
  });

  it("finds a small base by the adapter's exact repo, and ignores names not on its list", () => {
    assert.equal(quantBaseForAdapter(LLAMA)?.name, "llama-3.2-3b");
    assert.equal(quantBaseForAdapter({ baseModel: "unsloth/Llama-3.2-1B-Instruct-bnb-4bit" }), null);
    assert.equal(quantBaseOf({ quantBase: "constructor" }), null);
  });
});

describe("the adapter checks with QUANT_TARGETS", () => {
  it("refuses a Llama adapter with the flag off, as before, and takes Llama 3.2 3B with it on", () => {
    assert.match(quantProblem(judged(LLAMA), { student_prompt: "short" }) ?? "", /only merge into the 2026 Glimmer/);
    assert.equal(quantProblem(judged(LLAMA), { student_prompt: "short" }, { targets: true }), null);
    const { baseRevision: _pin, ...unpinned } = LLAMA;
    assert.match(quantProblem(judged(unpinned), { student_prompt: "short" }, { targets: true }) ?? "", /pinned commit/);
    assert.match(quantProblem(judged({ ...LLAMA, baseModel: "unsloth/Llama-3.3-70B-Instruct-bnb-4bit" }), { student_prompt: "short" }, { targets: true }) ?? "", /another Llama/);
    assert.match(quantProblem({ ...judged(LLAMA), terminatedAt: null }, null, { targets: true }) ?? "", /isn't judged/, "still judged first");
  });

  it("lets the merge's adapter check through only for its own base", () => {
    const id = "83d71f74-d84b-40bf-925a-cd36c90b6de5";
    const job = { id, recipe: "glimmer-lora" as const, status: "succeeded" as const, params: LLAMA };
    const metrics = { cache_used: "yes", adapter_dir: `/c/models/${id}` };
    assert.match(adapterProblem(job, metrics) ?? "", /only load the 2026 Glimmer/, "a serve job's check is unchanged");
    assert.equal(adapterProblem(job, metrics, { smallQuantBase: true }), null);
    assert.match(adapterProblem({ ...job, params: {} }, metrics, { smallQuantBase: true }) ?? "", /plain Muse Glimmer/);
  });
});

describe("limits and words", () => {
  it("gives the one-bit job room, and leaves the old job's limits alone", () => {
    const recipe = { id: "glimmer-quantize" as const, defaultMaxMinutes: 110, defaultMaxUsd: 3.7 };
    assert.deepEqual(recipeDefaults(recipe, { levels: "Q3_K_M,Q4_K_M,Q6_K" }), { defaultMaxMinutes: 110, defaultMaxUsd: 3.7 });
    const room = recipeDefaults(recipe, { levels: "IQ1_S,Q3_K_M,Q4_K_M,Q6_K" });
    assert.ok((room.defaultMaxUsd * 100 * 60) / 199 >= room.defaultMaxMinutes, "dollars never stop it before its time on an A100 SXM4");
    const estimate = (p: Record<string, string>) => runEstimate("glimmer-quantize", p, "gpu_1x_a100_sxm4", true)!.minutes;
    assert.equal(estimate({ levels: "Q3_K_M,Q4_K_M,Q6_K" }), 80);
    assert.equal(estimate({ levels: "IQ1_S,Q3_K_M,Q4_K_M,Q6_K" }), 110);
    assert.equal(estimate({ levels: "Q4_K_M", quantBase: "llama-3.2-3b" }), 45);
  });

  it("shows no KL limit where none is measured, and reports the one-bit check", () => {
    assert.equal(quantKlLimit("IQ1_S"), null);
    assert.equal(quantKlLimit("Q4_K_M"), 0.03);
    assert.equal(quantKlLimit("Q4_K_M", { quantBase: "llama-3.2-3b" }), null);
    const rows = quantRows({ levels: "IQ1_S,Q4_K_M" }, { iq1_s_passed: "yes", iq1_s_bytes: 6_530_000_000, iq1_s_kl_mean: 0.42, q4_k_m_passed: "yes", q4_k_m_kl_mean: 0.01 });
    assert.deepEqual(rows.map((r) => r.level), ["IQ1_S", "Q4_K_M"]);
    assert.match(quantRowText(rows[0]!), /Passed · 6\.53 GB · mean KL 0\.4200, no limit yet/);
    assert.match(quantRowText(rows[1]!), /limit 0\.0300/);
    assert.match(quantLowBitText({ iq1_s_final: 28, iq1_s_final_total: 30 }) ?? "", /28 of 30.*much weaker/);
    assert.match(quantLowBitText({ iq1_s_problem: "llama-imatrix failed" }) ?? "", /isn't published: llama-imatrix failed/);
    assert.equal(quantLowBitText({ q4_k_m_passed: "yes" }), null);
  });

  it("says what each kind of job costs, as an estimate where it is one", () => {
    const state = (over: Partial<QuantState>) => ({ quantOff: null, hubOff: null, problem: null, latest: null, files: null, ...over });
    assert.match(makeFilesCostText(state({})), /^about 80 minutes.*\$2\.50/);
    assert.match(makeFilesCostText(state({ targets: true })), /110 minutes.*one-bit.*by estimate/);
    assert.match(makeFilesCostText(state({ targets: true, smallBase: "Llama 3.2 3B" })), /45 minutes.*Llama 3\.2 3B.*by estimate/);
  });

  it("Where it runs names no Qwen, keeps its old Jetson line with the flag off, and labels the board unproven with it on", () => {
    const render = (quantTargets: boolean) => renderToStaticMarkup(createElement(WhereItRuns, { jobHref: "/fine-tuning/x", demoHere: false, localFilesHere: false, admin: true, quantTargets }));
    const off = render(false);
    assert.match(off, /Not on a Jetson Orin Nano\./);
    assert.doesNotMatch(off, /qwen/i);
    const on = render(true);
    assert.doesNotMatch(on, /qwen|Not on a Jetson/i);
    assert.match(on, /On a Jetson Orin Nano, maybe/);
    assert.match(on, /Not run on a real board yet/);
    assert.match(on, /6\.53 GB/);
    assert.match(on, /much weaker answers/);
    assert.match(on, /Llama 3\.2 3B/);
  });
});
