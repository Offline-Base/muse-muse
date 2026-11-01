/**
 * Any Meta base (lib/train/bases.ts, base-check.ts): what is refused, what is pinned, and each family's duties. No
 * network: the Hub is a fake.
 *
 *   npx tsx --test lib/train/__tests__/bases.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSparkOpenDerivative, licenseDuties, PLAIN_GLIMMER_MODEL } from "../base";
import { resolveBase } from "../base-check";
import { askedBase, checkFacts, GATED_REFUSAL, repoProblem, type HubFacts } from "../bases";
import { GLIMMER_PY } from "../recipes/glimmer";

const SHA = "a".repeat(40);
const facts = (over: Partial<HubFacts> = {}): HubFacts => ({
  id: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit",
  sha: SHA,
  gated: false,
  private: false,
  license: "llama3.2",
  architectures: ["LlamaForCausalLM"],
  quantized: true,
  params: 3_300_000_000,
  bytes: 1_900_000_000,
  ...over,
});

function hub(over: { status?: number; model?: Record<string, unknown>; head?: number } = {}) {
  const calls: { url: string; auth: boolean }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: Boolean((init?.headers as Record<string, string> | undefined)?.authorization) });
    if (init?.method === "HEAD") return new Response(null, { status: over.head ?? 200 });
    if (url.includes("/tree/")) return Response.json([{ path: "model.safetensors", size: 6_400_000_000 }]);
    return Response.json(
      { id: "meta-llama/Llama-3.2-3B-Instruct", sha: SHA, gated: "manual", private: false, cardData: { license: "llama3.2" }, config: { architectures: ["LlamaForCausalLM"] }, safetensors: { total: 3_212_749_824 }, ...over.model },
      { status: over.status ?? 200 },
    );
  }) as unknown as typeof fetch;
  return { fake, calls };
}

describe("the allowlist", () => {
  it("takes Llama and Glimmer builds from the three orgs", () => {
    for (const id of ["meta-llama/Llama-3.2-3B-Instruct", "unsloth/Llama-4-Scout-17B-16E-Instruct-unsloth-bnb-4bit", "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", "OfflineBase/Muse-Glimmer-30B-2026-Knowledge", "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"]) {
      assert.equal(repoProblem(id), null, id);
    }
  });
  it("refuses everything else, LFM included", () => {
    for (const id of ["LiquidAI/LFM2.5-1.2B", "unsloth/LFM2-8B", "OfflineBase/Nemotron-3.5-Bolt-E4B-Vision-GGUF", "meta-llama/Llama-Guard-3-8B", "meta-llama/Llama-3.2-11B-Vision", "evil/Llama-3.2-3B-Instruct", "unsloth/mistral-7b", "unsloth/LFM-Llama-3.2", "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF", "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-LoRA", "unsloth/Llama-3.2-3B/../../evil", "unsloth/Llama-2-7b", "", null, 5]) {
      assert.ok(repoProblem(id), String(id));
    }
  });
  it("refuses a revision that isn't a full commit", () => {
    assert.equal(askedBase({ repo: "meta-llama/Llama-3.2-3B-Instruct", revision: "main" }).ok, false);
  });
});

describe("the Hub's facts", () => {
  it("refuses an unsupported architecture, a mismatch, a wrong license and no weights", () => {
    assert.equal(checkFacts(facts({ architectures: ["MllamaForConditionalGeneration"] })).ok, false);
    assert.equal(checkFacts(facts({ architectures: ["Llama4ForConditionalGeneration"] })).ok, false);
    assert.equal(checkFacts(facts({ license: "apache-2.0" })).ok, false);
    assert.equal(checkFacts(facts({ bytes: 0 })).ok, false);
    assert.equal(checkFacts(facts({ sha: "main" })).ok, false);
  });
  it("sizes against the GPUs: 3.2 on an A100, 70B and Scout on H100s only, Maverick and big 16-bit repos refused", () => {
    const small = checkFacts(facts());
    assert.ok(small.ok && small.base.gpus.includes("gpu_1x_a100_sxm4"));
    const big = checkFacts(facts({ id: "unsloth/Llama-3.3-70B-Instruct-bnb-4bit", license: "llama3.3", bytes: 39.5e9, params: 70.5e9 }));
    assert.ok(big.ok && !big.base.gpus.includes("gpu_1x_a100_sxm4") && big.base.gpus.length === 2);
    const scout = checkFacts(facts({ id: "unsloth/Llama-4-Scout-17B-16E-Instruct-unsloth-bnb-4bit", license: "other", architectures: ["Llama4ForConditionalGeneration"], bytes: 60.4e9, params: 108.6e9 }));
    assert.ok(scout.ok && scout.base.family === "llama4" && !scout.base.decide);
    assert.equal(checkFacts(facts({ id: "unsloth/Llama-4-Maverick-17B-128E-Instruct", license: "other", architectures: ["Llama4ForConditionalGeneration"], bytes: 215e9, params: 401e9 })).ok, false);
    assert.equal(checkFacts(facts({ id: "meta-llama/Llama-3.3-70B-Instruct", license: "llama3.3", quantized: false, bytes: 141e9, params: 70.5e9 })).ok, false);
  });
  it("estimates a larger base as slower, never below half r30b's step", () => {
    const small = checkFacts(facts());
    assert.ok(small.ok && small.base.scale === 0.5 && !small.base.measured);
    const big = checkFacts(facts({ id: "unsloth/Llama-3.3-70B-Instruct-bnb-4bit", license: "llama3.3", bytes: 39.5e9, params: 70.5e9 }));
    assert.ok(big.ok && big.base.scale > 2);
  });
});

describe("resolveBase", () => {
  it("never asks the Hub about a refused id", async () => {
    const { fake, calls } = hub();
    const r = await resolveBase({ repo: "LiquidAI/LFM2.5-1.2B" }, { fetch: fake, token: "t" });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
  it("refuses when the Hub answers with an id off the allowlist", async () => {
    const { fake } = hub({ model: { id: "LiquidAI/LFM2.5-1.2B" } });
    assert.equal((await resolveBase({ repo: "unsloth/Llama-3.2-3B-Instruct" }, { fetch: fake, token: "t" })).ok, false);
  });
  it("gated: a 401 or 403, or no token, refuses with the license sentence", async () => {
    for (const head of [401, 403]) {
      const r = await resolveBase({ repo: "meta-llama/Llama-3.2-3B-Instruct" }, { fetch: hub({ head }).fake, token: "t" });
      assert.deepEqual(r, { ok: false, error: GATED_REFUSAL });
    }
    assert.deepEqual(await resolveBase({ repo: "meta-llama/Llama-3.2-3B-Instruct" }, { fetch: hub().fake, token: null }), { ok: false, error: GATED_REFUSAL });
  });
  it("gated and open: pinned to the commit, the token only on the access check", async () => {
    const { fake, calls } = hub();
    const r = await resolveBase({ repo: "meta-llama/Llama-3.2-3B-Instruct" }, { fetch: fake, token: "t" });
    assert.ok(r.ok && r.base.revision === SHA && r.base.gated && !r.base.quantized);
    assert.deepEqual(calls.filter((c) => c.auth).map((c) => c.url), [`https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/resolve/${SHA}/config.json`]);
  });
  it("a Hub that moved the commit is refused", async () => {
    const { fake } = hub();
    assert.equal((await resolveBase({ repo: "meta-llama/Llama-3.2-3B-Instruct", revision: "b".repeat(40) }, { fetch: fake, token: "t" })).ok, false);
  });
});

describe("license duties", () => {
  it("Llama: the line, the name prefix and the version's license", () => {
    const d = licenseDuties({ params: { baseModel: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit" } });
    assert.equal(d.line, "Built with Llama");
    assert.equal(d.namePrefix, "Llama-");
    assert.match(d.license, /Llama 3\.2 Community License/);
    assert.match(licenseDuties({ metrics: { base_model: "unsloth/Llama-4-Scout" } }).points.join(" "), /European Union/);
  });
  it("Glimmer as before, under r30b's old and new names", () => {
    assert.equal(licenseDuties({ params: { baseModel: PLAIN_GLIMMER_MODEL } }).line, null);
    assert.equal(licenseDuties({ params: { baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } }).line, "Built with Muse Spark Open");
    assert.ok(isSparkOpenDerivative({ params: { baseModel: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } }));
  });
});

describe("the recipe", () => {
  it("keeps today's model and markers as its constants, with each family's own apart", () => {
    assert.match(GLIMMER_PY, /^MODEL = "OfflineBase\/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"$/m);
    assert.match(GLIMMER_PY, /^INSTRUCTION_PART = "<\|start\|>user<\|message\|>"$/m);
    assert.ok(GLIMMER_PY.includes("<|start_header_id|>assistant<|end_header_id|>\\n\\n"));
    assert.ok(GLIMMER_PY.includes("<|header_start|>assistant<|header_end|>\\n\\n"));
    assert.ok(GLIMMER_PY.includes("use_exact_model_name=True"));
    assert.ok(!/lfm/i.test(GLIMMER_PY));
  });
});
