/**
 * Any Meta base (lib/train/bases.ts, base-check.ts): Muse Glimmer only (Llama is refused, per the Nov 2 ruling), what is
 * pinned, and each family's duties. No network: the Hub is a fake.
 *
 *   npx tsx --test lib/train/__tests__/bases.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSparkOpenDerivative, licenseDuties, PLAIN_GLIMMER_MODEL, PLAIN_GLIMMER_REVISION } from "../base";
import { gatedBaseFiles, resolveBase } from "../base-check";
import { askedBase, baseMeasured, checkFacts, CURATED_BASES, GATED_REFUSAL, GLIMMER_ONLY_REFUSAL, repoProblem, type HubFacts } from "../bases";
import { GLIMMER_PY } from "../recipes/glimmer";

const SHA = "a".repeat(40);
const GLIMMER = "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit";
const GATED_GLIMMER = "OfflineBase/Muse-Glimmer-30B-gated";
const facts = (over: Partial<HubFacts> = {}): HubFacts => ({
  id: GLIMMER,
  sha: SHA,
  gated: false,
  private: false,
  license: "apache-2.0",
  architectures: ["MuseGlimmerForConditionalGeneration"],
  quantized: true,
  params: 29_000_000_000,
  bytes: 18_000_000_000,
  ...over,
});

function hub(over: { status?: number; model?: Record<string, unknown>; head?: number } = {}) {
  const calls: { url: string; auth: boolean }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: Boolean((init?.headers as Record<string, string> | undefined)?.authorization) });
    if (init?.method === "HEAD") return new Response(null, { status: over.head ?? 200 });
    if (url.includes("/tree/")) return Response.json([{ path: "model.safetensors", size: 60_000_000_000 }]);
    return Response.json(
      { id: GATED_GLIMMER, sha: SHA, gated: "manual", private: false, cardData: { license: "apache-2.0" }, config: { architectures: ["MuseGlimmerForConditionalGeneration"] }, safetensors: { total: 29_776_626_688 }, ...over.model },
      { status: over.status ?? 200 },
    );
  }) as unknown as typeof fetch;
  return { fake, calls };
}

describe("the allowlist", () => {
  it("takes Muse Glimmer builds from unsloth and OfflineBase", () => {
    for (const id of [GLIMMER, "OfflineBase/Muse-Glimmer-30B-2026-Knowledge", "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"]) {
      assert.equal(repoProblem(id), null, id);
    }
  });
  it("refuses every Llama, in any version or org, with the Glimmer-only sentence", () => {
    for (const id of ["meta-llama/Llama-3.2-3B-Instruct", "unsloth/Llama-3.2-3B-Instruct-bnb-4bit", "unsloth/Llama-3.1-8B-Instruct-bnb-4bit", "unsloth/Llama-3.3-70B-Instruct-bnb-4bit", "unsloth/Llama-4-Scout-17B-16E-Instruct-unsloth-bnb-4bit", "meta-llama/Llama-Guard-3-8B", "meta-llama/Llama-Prompt-Guard-2-22M", "meta-llama/Muse-Glimmer-30B"]) {
      assert.equal(repoProblem(id), GLIMMER_ONLY_REFUSAL, id);
    }
    assert.ok(!askedBase({ repo: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit" }).ok);
  });
  it("refuses everything else, LFM included", () => {
    for (const id of ["LiquidAI/LFM2.5-1.2B", "unsloth/LFM2-8B", "OfflineBase/Nemotron-3.5-Bolt-E4B-Vision-GGUF", "evil/Muse-Glimmer-30B", "unsloth/mistral-7b", "unsloth/LFM-Llama-3.2", "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF", "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-LoRA", "unsloth/Muse-Glimmer-30B/../../evil", "unsloth/Llama-2-7b", "", null, 5]) {
      assert.ok(repoProblem(id), String(id));
    }
    assert.ok(!/Llama 3|meta-llama/.test(String(repoProblem(""))), "the example id is a Glimmer one");
  });
  it("offers only Muse Glimmer in the picker", () => {
    assert.ok(CURATED_BASES.length > 0);
    for (const b of CURATED_BASES) {
      assert.equal(repoProblem(b.repo), null, b.repo);
      assert.ok(!/llama/i.test(`${b.repo} ${b.label} ${b.note}`), b.repo);
    }
  });
  it("refuses a revision that isn't a full commit", () => {
    assert.equal(askedBase({ repo: GLIMMER, revision: "main" }).ok, false);
  });
});

describe("the Hub's facts", () => {
  it("refuses a Llama architecture or name, a mismatch, a wrong license and no weights", () => {
    assert.equal(checkFacts(facts({ architectures: ["LlamaForCausalLM"] })).ok, false);
    assert.equal(checkFacts(facts({ architectures: ["Llama4ForConditionalGeneration"] })).ok, false);
    assert.equal(checkFacts(facts({ id: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit", license: "llama3.2", architectures: ["LlamaForCausalLM"] })).ok, false);
    assert.equal(checkFacts(facts({ license: "llama3.2" })).ok, false);
    assert.equal(checkFacts(facts({ bytes: 0 })).ok, false);
    assert.equal(checkFacts(facts({ sha: "main" })).ok, false);
  });
  it("sizes against the GPUs, and refuses a 16-bit repo too big to quantize on a job", () => {
    const glimmer = checkFacts(facts());
    assert.ok(glimmer.ok && glimmer.base.gpus.includes("gpu_1x_a100_sxm4") && glimmer.base.decide);
    assert.equal(checkFacts(facts({ quantized: false, bytes: 70e9 })).ok, false);
  });
  it("scales the step time from r30b's", () => {
    const glimmer = checkFacts(facts());
    assert.ok(glimmer.ok && glimmer.base.scale >= 0.5 && glimmer.base.scale <= 1);
  });
  it("counts the original Glimmer as measured only at the commit it ran", () => {
    assert.equal(baseMeasured(GLIMMER, PLAIN_GLIMMER_REVISION), true);
    assert.equal(baseMeasured(GLIMMER, SHA), false);
    assert.equal(baseMeasured("unsloth/Llama-3.2-3B-Instruct-bnb-4bit", "bb1d317a108579fb40e646af8924a5e7ec5604b1"), false);
  });
});

describe("resolveBase", () => {
  it("never asks the Hub about a refused id", async () => {
    const { fake, calls } = hub();
    const r = await resolveBase({ repo: "LiquidAI/LFM2.5-1.2B" }, { fetch: fake, token: "t" });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
  it("never asks the Hub about a Llama", async () => {
    const { fake, calls } = hub();
    const r = await resolveBase({ repo: "meta-llama/Llama-3.2-3B-Instruct" }, { fetch: fake, token: "t" });
    assert.deepEqual(r, { ok: false, error: GLIMMER_ONLY_REFUSAL });
    assert.equal(calls.length, 0);
  });
  it("refuses when the Hub answers with an id off the allowlist", async () => {
    const { fake } = hub({ model: { id: "LiquidAI/LFM2.5-1.2B" } });
    assert.equal((await resolveBase({ repo: GATED_GLIMMER }, { fetch: fake, token: "t" })).ok, false);
  });
  it("gated: a 401 or 403, or no token, refuses with the license sentence", async () => {
    for (const head of [401, 403]) {
      const r = await resolveBase({ repo: GATED_GLIMMER }, { fetch: hub({ head }).fake, token: "t" });
      assert.deepEqual(r, { ok: false, error: GATED_REFUSAL });
    }
    assert.deepEqual(await resolveBase({ repo: GATED_GLIMMER }, { fetch: hub().fake, token: null }), { ok: false, error: GATED_REFUSAL });
  });
  it("gated and open: pinned to the commit, the token only on the access check", async () => {
    const { fake, calls } = hub();
    const r = await resolveBase({ repo: GATED_GLIMMER }, { fetch: fake, token: "t" });
    assert.ok(r.ok && r.base.revision === SHA && r.base.gated && !r.base.quantized, JSON.stringify(r));
    assert.deepEqual(calls.filter((c) => c.auth).map((c) => c.url), [`https://huggingface.co/${GATED_GLIMMER}/resolve/${SHA}/config.json`]);
  });
  it("a Hub that moved the commit is refused", async () => {
    const { fake } = hub();
    assert.equal((await resolveBase({ repo: GATED_GLIMMER, revision: "b".repeat(40) }, { fetch: fake, token: "t" })).ok, false);
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

describe("the review's rules", () => {
  it("a Glimmer build other than r30b must say Apache 2.0", () => {
    const glimmer = { architectures: ["MuseGlimmerForConditionalGeneration"], bytes: 18e9, params: 29e9 };
    assert.equal(checkFacts(facts({ ...glimmer, id: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", license: "apache-2.0" })).ok, true);
    assert.equal(checkFacts(facts({ ...glimmer, id: "unsloth/Muse-Glimmer-30B-other", license: "other" })).ok, false);
    assert.equal(checkFacts(facts({ ...glimmer, id: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit", license: "other" })).ok, true);
  });

  it("a gated small file redirecting within the Hub goes inline, never as a link to the GPU", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes("/tree/")) return Response.json([{ type: "file", path: "config.json", size: 2 }, { type: "file", path: "model.safetensors", size: 9, lfs: { oid: "abc" } }]);
      if (url.includes("/resolve/") && url.endsWith("config.json")) return new Response(null, { status: 307, headers: { location: "/api/resolve-cache/models/x/config.json" } });
      if (url.includes("/resolve-cache/")) return new Response("{}");
      return new Response(null, { status: 302, headers: { location: "https://cas-bridge.xethub.hf.co/signed" } });
    }) as unknown as typeof fetch;
    const files = await gatedBaseFiles(GATED_GLIMMER, SHA, { fetch: fake, token: "made-up" });
    assert.equal(files?.[0]?.url, undefined);
    assert.equal(files?.[0]?.inline, Buffer.from("{}").toString("base64"));
    assert.equal(files?.[1]?.url, "https://cas-bridge.xethub.hf.co/signed");
  });
});
