/**
 * The pure side of a judged adapter's local files (lib/train/hub-cards.ts and logic.ts, docs/TRAINING.md "Local
 * files"): the GGUF repo and file names under the Hub's rules and lined up with the adapter's, the params the platform
 * writes, the names and size caps each recipe publishes, the small files byte for byte, the hub state's rules for a
 * GGUF repo, the publishing gate, the local files contract from a job's records, the run's estimate and the adapter's
 * checks, the GGUF card (its front matter line for line, as the Hub's validator took it on 2026-10-28, its sections in
 * order, every number from the records, no em dash, a model-written task shown as text), its record, and the adapter
 * card's pointer to it.
 *
 *   npx tsx --test lib/train/__tests__/gguf-cards.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as cards from "../hub-cards";
import { QUANT_LEVELS } from "../local-files";
import { QUANT_KL_MAX, quantProblem, runEstimate, runFitProblem, trainChannelOf } from "../logic";
import { GLIMMER_PY } from "../recipes/glimmer";
import { TUNED_TEMPLATE } from "../tuned-template";
import { HUB_FILE_MAX_BYTES, HUB_GGUF_FILE_MAX_BYTES, type HubState } from "../types";

const EM_DASH = String.fromCharCode(0x2014);
const JOB = "83d71f74-d84b-40bf-925a-cd36c90b6de5";
const QUANT = "9a1b2c3d-0000-4000-8000-000000000001";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const META = readFileSync(new URL("./fixtures/meta-chat-template.jinja", import.meta.url), "utf8");

function facts(over: Partial<cards.GgufFacts> = {}): cards.GgufFacts {
  return {
    repo: `muse-org/${cards.ggufRepoName("brief-writer", JOB)}`,
    slug: "brief-writer",
    adapterRepo: `muse-org/${cards.modelRepoName("Muse Muse's brief writer", JOB)}`,
    adapterCommit: "1".repeat(40),
    datasetRepo: "muse-org/muse-muse-brief-writer-17c76f2c",
    adapterJobId: JOB,
    quantJobId: QUANT,
    dataset: { title: "Muse Muse's brief writer", task: "Write a short app brief: name, tagline, flow, models, limits and the cost per run.", evalCount: 40 },
    role: "You are Muse Muse's brief writer.",
    trainChannel: 0,
    builds: [
      { level: "Q3_K_M", name: cards.ggufFileName("brief-writer", "Q3_K_M"), bytes: 13_683_456_789, sha256: "a".repeat(64), klMean: 0.0412, klP99: 0.31, topTokenPct: 92.13 },
      { level: "Q4_K_M", name: cards.ggufFileName("brief-writer", "Q4_K_M"), bytes: 16_941_234_567, sha256: "b".repeat(64), klMean: 0.0143, klP99: 0.12, topTokenPct: 95.27 },
    ],
    leftOut: [{ level: "Q6_K", klMean: 0.0061 }],
    channel: { final: 39, total: 40 },
    agreement: { same: 31, total: 37 },
    tensors: 1436,
    llamacpp: { tag: "b11669", commit: "620d2225cc436ab0b001e3200e590e3b286ef9ab" },
    mergeBase: { repo: "unsloth/Muse-Glimmer-30B", revision: "2".repeat(40) },
    adapterBase: { model: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", revision: "ecedda395d4d099b477d135a9a573eedaa5a7aad" },
    small: [
      { name: "params", bytes: 121, sha256: "c".repeat(64) },
      { name: "system", bytes: 59, sha256: "d".repeat(64) },
      { name: "tuned.jinja", bytes: 10_010, sha256: cards.TUNED_TEMPLATE_SHA256 },
    ],
    job: { gpuLabel: "1x A100 SXM4 (40 GB)", gpuMinutes: 78, costUsd: 2.587, finishedAt: "2026-10-29T03:10:00.000Z" },
    ...over,
  };
}

describe("the GGUF repo's names", () => {
  it("line up with the adapter's repo, take its slug, and stay under the Hub's 96 characters", () => {
    assert.equal(cards.ggufRepoName("brief-writer", JOB), "muse-glimmer-30b-brief-writer-gguf-83d71f74");
    assert.equal(cards.ggufFileName("brief-writer", "Q4_K_M"), "muse-glimmer-30b-brief-writer-Q4_K_M.gguf");
    // The adapter's own repo name gives the slug, so a run's three repos line up even if the dataset slug rule changes.
    assert.equal(cards.ggufSlug("muse-org/muse-glimmer-30b-gull-counter-lora-83d71f74", "Something else", JOB), "gull-counter");
    assert.equal(cards.ggufSlug(null, "Muse Muse's brief writer", JOB), "brief-writer");
    assert.equal(cards.ggufSlug("muse-org/muse-glimmer-30b-gull-counter-lora-00000000", "Muse Muse's brief writer", JOB), "brief-writer", "another job's repo");
    const longest = cards.hubSlug("a".repeat(30) + " " + "b".repeat(30));
    assert.ok(longest.length <= cards.SLUG_MAX);
    const slug = "w".repeat(cards.SLUG_MAX);
    for (const name of [cards.ggufRepoName(slug, JOB), ...QUANT_LEVELS.map((l) => cards.ggufFileName(slug, l))]) {
      assert.ok(name.length < 96 && cards.validRepoName(name.replace(/\.gguf$/, "")), name);
    }
    assert.ok(cards.validSlug("brief-writer") && !cards.validSlug("Brief") && !cards.validSlug("a--b") && !cards.validSlug("x".repeat(41)));
  });

  it("are written onto a quantize job by the platform: the builds, the adapter's slug and its channel", () => {
    const adapter = { id: JOB, params: { datasetId: "x", trainChannel: 1 }, hub: { status: "published", modelRepo: "muse-org/muse-glimmer-30b-gull-counter-lora-83d71f74" } as HubState };
    assert.deepEqual(cards.quantParams(adapter, "Muse Muse's brief writer"), { levels: "Q3_K_M,Q4_K_M,Q6_K", slug: "gull-counter", trainChannel: 1 });
    assert.deepEqual(cards.quantParams({ ...adapter, params: {}, hub: null }, "Muse Muse's brief writer"), { levels: "Q3_K_M,Q4_K_M,Q6_K", slug: "brief-writer", trainChannel: 0 });
    assert.deepEqual(cards.quantLevels({ levels: "Q6_K, Q3_K_M,Q8_0,IQ2_M" }), ["Q3_K_M", "Q6_K"], "only listed builds, in order");
    assert.equal(trainChannelOf({ trainChannel: "1" }), 1);
    assert.equal(trainChannelOf({ trainChannel: 2 }), 0);
  });
});

describe("what each recipe publishes", () => {
  const quant = { recipe: "glimmer-quantize" as const, params: { slug: "brief-writer", levels: "Q3_K_M,Q4_K_M" } };
  const lora = { recipe: "glimmer-lora" as const, params: {} };

  it("names only a quantize job's own builds and small files, and only an adapter's files for any other job", () => {
    for (const ok of ["muse-glimmer-30b-brief-writer-Q3_K_M.gguf", "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", "system", "params", "tuned.jinja"]) {
      assert.equal(cards.hubNameProblem(quant, ok), null, ok);
    }
    for (const bad of [
      "muse-glimmer-30b-brief-writer-Q6_K.gguf",
      "muse-glimmer-30b-other-Q4_K_M.gguf",
      "muse-glimmer-30b-brief-writer-Q8_0.gguf",
      "bf16.gguf",
      "adapter_model.safetensors",
      "README.md",
      "System",
    ]) {
      assert.match(cards.hubNameProblem(quant, bad) ?? "", /only the builds' GGUF files/, bad);
    }
    assert.equal(cards.hubNameProblem(lora, "adapter_model.safetensors"), null);
    assert.ok(cards.hubNameProblem(lora, "muse-glimmer-30b-brief-writer-Q4_K_M.gguf"));
    assert.ok(cards.hubNameProblem({ recipe: "glimmer-quantize", params: { slug: "Bad Slug", levels: "Q4_K_M" } }, "muse-glimmer-30b-Bad Slug-Q4_K_M.gguf"));
  });

  it("caps a build at 32 GB and every other file at an adapter's 10 GB", () => {
    assert.equal(cards.hubMaxBytes(quant, "muse-glimmer-30b-brief-writer-Q6_K.gguf"), HUB_GGUF_FILE_MAX_BYTES);
    assert.equal(cards.hubMaxBytes(quant, "system"), HUB_FILE_MAX_BYTES);
    assert.equal(cards.hubMaxBytes(lora, "adapter_model.safetensors"), HUB_FILE_MAX_BYTES);
    assert.ok(HUB_GGUF_FILE_MAX_BYTES > 29.61e9, "Q8_0 would fit, should it ever be added");
  });

  it("takes the small files only as the platform would write them", () => {
    const role = "You are Muse Muse's brief writer.";
    assert.equal(cards.ggufSystemLine(role), "You are Muse Muse's brief writer.\n\nReasoning strength: low.", "no newline at the end, which Ollama would keep");
    assert.deepEqual(JSON.parse(cards.ggufParams(0)), { temperature: 0, num_ctx: 8192, stop: ["<|eot|>", "<|eom|>", "<|end_of_text|>", "<|start|>"] });
    assert.deepEqual(JSON.parse(cards.ggufParams(1)), { temperature: 0, num_ctx: 8192, stop: ["<|eot|>", "<|end_of_text|>"] });
    const expect = { role, trainChannel: 0 as const };
    const system = Buffer.from(cards.ggufSystemLine(role));
    assert.equal(cards.ggufSmallProblem("system", system, sha(system), expect), null);
    const other = Buffer.from(cards.ggufSystemLine("You are a helpful assistant."));
    assert.match(cards.ggufSmallProblem("system", other, sha(other), expect) ?? "", /isn't the system message the adapter trained with/);
    const params = Buffer.from(cards.ggufParams(0));
    assert.equal(cards.ggufSmallProblem("params", params, sha(params), expect), null);
    assert.ok(cards.ggufSmallProblem("params", Buffer.from(cards.ggufParams(1)), "", expect));
    const tuned = Buffer.from("x");
    assert.match(cards.ggufSmallProblem("tuned.jinja", tuned, sha(tuned), expect) ?? "", /isn't Meta's template/);
    assert.equal(cards.ggufSmallProblem("tuned.jinja", tuned, cards.TUNED_TEMPLATE_SHA256, expect), null);
    assert.match(cards.ggufSmallProblem("tuned.jinja", tuned, cards.TUNED_TEMPLATE_SHA256, { role, trainChannel: 1 }) ?? "", /doesn't need/);
  });

  it("pins Meta's template, and tuned.jinja as Meta's with low reasoning and the final channel opened", () => {
    assert.equal(sha(META), cards.META_TEMPLATE_SHA256);
    const tuned = META.replace("else 'high' -%}", "else 'low' -%}").replace(
      "{%- if add_generation_prompt -%}\n    {{- '<|start|>assistant' -}}\n{%- endif -%}",
      "{%- if add_generation_prompt -%}\n    {{- '<|start|>assistant to=user<|message|>' -}}\n{%- endif -%}",
    );
    assert.equal(sha(tuned), cards.TUNED_TEMPLATE_SHA256);
    assert.ok(META.includes("'reasoning strength' not in (sys_text | lower)"), "Meta's template skips its own line when the system message has one");
    // The copy the run-locally page shows is the same bytes.
    assert.equal(TUNED_TEMPLATE, tuned);
    assert.equal(sha(TUNED_TEMPLATE), cards.TUNED_TEMPLATE_SHA256);
  });
});

describe("a GGUF repo's state and gate", () => {
  const gguf = (n: number, s: string) => ({ path: cards.ggufFileName("brief-writer", "Q4_K_M").replace("Q4_K_M", ["Q3_K_M", "Q4_K_M", "Q6_K"][n]!), size: 10, sha256: s });
  const state = (over: Partial<HubState> = {}): HubState => ({
    status: "uploading",
    files: [gguf(0, "1".repeat(64)), gguf(1, "2".repeat(64))],
    uploaded: ["1".repeat(64), "2".repeat(64)],
    small: { system: "eA==", params: "eA==", "tuned.jinja": "eA==" },
    ...over,
  });

  it("counts as uploaded once every build is in and the small files the model needs are inline", () => {
    assert.equal(cards.ggufUploaded(state(), { trainChannel: 0 }), true);
    assert.equal(cards.ggufUploaded(state({ uploaded: ["1".repeat(64)] }), { trainChannel: 0 }), false);
    assert.equal(cards.ggufUploaded(state({ small: { system: "eA==", params: "eA==" } }), { trainChannel: 0 }), false, "an old adapter needs tuned.jinja");
    assert.equal(cards.ggufUploaded(state({ small: { system: "eA==", params: "eA==" } }), { trainChannel: 1 }), true);
    assert.equal(cards.ggufUploaded(state({ files: [] }), {}), false, "at least one build");
    assert.equal(cards.jobUploaded({ recipe: "glimmer-quantize", params: {} }, state()), true);
    assert.equal(cards.jobUploaded({ recipe: "glimmer-lora", params: {} }, state()), false, "an adapter's rule needs its weights");
    const done = cards.withDone(state({ uploaded: [] }), { uploaded: ["1".repeat(64), "2".repeat(64)], failed: [] }, new Date(), (h) => cards.ggufUploaded(h, {}));
    assert.equal(done.status, "uploaded");
  });

  it("publishes a quantize job that succeeded, shut down, passed and uploaded, once its adapter is published", () => {
    const job = { recipe: "glimmer-quantize" as const, status: "succeeded" as const, terminatedAt: new Date() };
    const ok = { checks_passed: "yes", hub_uploaded: "yes" };
    const adapter = { hub: { status: "published", modelRepo: "muse-org/x-lora-83d71f74" } as HubState };
    assert.equal(cards.ggufJobProblem(job, ok, adapter), null);
    assert.match(cards.ggufJobProblem({ ...job, status: "failed" }, ok, adapter) ?? "", /didn't succeed/);
    assert.match(cards.ggufJobProblem({ ...job, terminatedAt: null }, ok, adapter) ?? "", /shut down/);
    assert.match(cards.ggufJobProblem(job, { checks_passed: "yes", hub_uploaded: "no" }, adapter) ?? "", /didn't all pass/);
    assert.match(cards.ggufJobProblem(job, ok, { hub: { status: "failed", modelRepo: "x" } }) ?? "", /isn't published/);
    assert.match(cards.ggufJobProblem(job, ok, null) ?? "", /gone/);
    assert.match(cards.ggufJobProblem({ ...job, recipe: "glimmer-lora" }, ok, adapter) ?? "", /Only a local files job/);
  });

  it("gives the local files contract from a job's records: only the builds that passed, and the repo once published", () => {
    const metrics = {
      checks_passed: "yes",
      hub_uploaded: "yes",
      system: "You are Muse Muse's brief writer.",
      q3_k_m_passed: "yes",
      q3_k_m_bytes: 1300,
      q3_k_m_sha256: "1".repeat(64),
      q4_k_m_passed: "yes",
      q4_k_m_bytes: 1600,
      q4_k_m_sha256: "2".repeat(64),
      q6_k_passed: "no",
      q6_k_kl_mean: 0.009,
    };
    const job = { id: QUANT, title: "Local files: Brief writer", params: { adapterJobId: JOB, slug: "brief-writer", levels: "Q3_K_M,Q4_K_M,Q6_K", trainChannel: 0 }, hub: null };
    const before = cards.localFilesOf({ job, metrics, datasetTitle: "Muse Muse's brief writer", adapterPublic: true })!;
    assert.deepEqual(before, {
      adapterJobId: JOB,
      quantJobId: QUANT,
      repo: null,
      commit: null,
      public: false,
      files: [
        { level: "Q3_K_M", name: "muse-glimmer-30b-brief-writer-Q3_K_M.gguf", bytes: 1300, sha256: "1".repeat(64) },
        { level: "Q4_K_M", name: "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", bytes: 1600, sha256: "2".repeat(64) },
      ],
      systemLine: "You are Muse Muse's brief writer.\n\nReasoning strength: low.",
      needsTunedTemplate: true,
      title: "Muse Muse's brief writer",
      slug: "brief-writer",
    });
    const hub: HubState = {
      status: "published",
      modelRepo: "muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74",
      modelCommit: "c".repeat(40),
      public: true,
      files: [{ path: "muse-glimmer-30b-brief-writer-Q3_K_M.gguf", size: 1300, sha256: "1".repeat(64) }, { path: "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", size: 1600, sha256: "f".repeat(64) }],
    };
    const after = cards.localFilesOf({ job: { ...job, hub, params: { ...job.params, trainChannel: 1 } }, metrics, datasetTitle: null, adapterPublic: true })!;
    assert.equal(after.repo, hub.modelRepo);
    assert.equal(after.commit, "c".repeat(40));
    assert.equal(after.public, true);
    const hidden = cards.localFilesOf({ job: { ...job, hub }, metrics, datasetTitle: null, adapterPublic: false })!;
    assert.deepEqual([hidden.repo, hidden.public], [hub.modelRepo, false], "an adapter made private takes its files' public pages with it");
    assert.deepEqual(after.files.map((f) => f.level), ["Q3_K_M"], "a build the repo doesn't hold as those bytes isn't listed");
    assert.equal(after.needsTunedTemplate, false);
    assert.equal(after.title, "Local files: Brief writer", "the job's title without the dataset's");
    assert.equal(cards.localFilesOf({ job, metrics: { ...metrics, q3_k_m_passed: "no", q4_k_m_passed: "no" }, datasetTitle: null, adapterPublic: true }), null);
    assert.equal(cards.localFilesOf({ job: { ...job, params: { ...job.params, slug: "../x" } }, metrics, datasetTitle: null, adapterPublic: true }), null);
  });
});

describe("the run's estimate and the adapter's checks", () => {
  it("estimates a quantize job at 80 minutes with the region's venvs on its cache, 90 without, and says so when it can't fit", () => {
    const warm = runEstimate("glimmer-quantize", {}, "gpu_1x_a100_sxm4", true)!;
    assert.deepEqual([warm.minutes, warm.what, warm.steps], [80, "quantize", 0]);
    assert.equal(runEstimate("glimmer-quantize", {}, "gpu_1x_a10", false)!.minutes, 90);
    assert.equal(runFitProblem(warm, 80, "1x A100 SXM4 (40 GB)"), null);
    assert.equal(
      runFitProblem(warm, 60, "1x A100 SXM4 (40 GB)"),
      "Making local files on 1x A100 SXM4 (40 GB) needs about 80 minutes (the merge, the conversion, three sizes and their checks, and the upload), but this job's limits stop it after 60 minutes. Raise the time or dollar limit, or pick a faster GPU.",
    );
  });

  it("makes files only from a judged adapter trained under the short student prompt", () => {
    const judged = { terminatedAt: new Date(), evalSummary: { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 } };
    assert.equal(quantProblem({ ...judged, params: { studentPrompt: "short" } }, { student_prompt: "short" }), null);
    assert.equal(quantProblem({ ...judged, params: { studentPrompt: "Short " } }, null), null);
    assert.match(quantProblem({ ...judged, params: {} }, null) ?? "", /whole task prompt/, "a job from before the param trained under it");
    assert.match(quantProblem({ ...judged, params: {} }, { student_prompt: "full" }) ?? "", /whole task prompt/);
    assert.match(quantProblem({ ...judged, terminatedAt: null, params: {} }, null) ?? "", /isn't judged yet/);
    const unjudged = { ...judged.evalSummary, items: 0, note: "Judging skipped: MODEL_API_KEY isn't set." };
    assert.match(quantProblem({ ...judged, evalSummary: unjudged, params: {} }, null) ?? "", /isn't judged yet/);
    assert.deepEqual(Object.keys(QUANT_KL_MAX), [...QUANT_LEVELS], "a limit for every build, in order");
  });
});

describe("the GGUF card", () => {
  it("has the front matter the Hub's validator took, line for line", () => {
    const card = cards.ggufCard(facts());
    assert.equal(
      card.split("\n---\n")[0] + "\n---",
      [
        "---",
        "base_model: meta-models/Muse-Glimmer-30B",
        "base_model_relation: finetune",
        "pipeline_tag: text-generation",
        "license: apache-2.0",
        "language:",
        "- en",
        "tags:",
        "- gguf",
        "- llama.cpp",
        "- muse-muse",
        "- lora-merged",
        "datasets:",
        "- muse-org/muse-muse-brief-writer-17c76f2c",
        "---",
      ].join("\n"),
    );
    assert.ok(!card.includes("library_name"), "the Hub tells GGUF from the files");
    const other = cards.ggufCard(facts({ datasetRepo: null, dataset: { title: "Écrire un brief", task: "Écrire un brief court pour une app.", evalCount: 8 } }));
    assert.ok(!/^language:/m.test(other) && !/^datasets:/m.test(other), "English only for plain ASCII, and no dataset without its repo");
  });

  it("goes from which file fits to running it, the prompt, closeness, how it was made, checksums, limits, license and provenance", () => {
    const card = cards.ggufCard(facts());
    const heads = [...card.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, [
      "Which file for my computer",
      "Run it",
      "Prompt it the way it was trained",
      "How close the files are",
      "How it was made",
      "Files and checksums",
      "Limits",
      "License",
      "Provenance",
    ]);
    const lead = card.split("\n## ")[0]!;
    assert.match(lead, /^# muse-glimmer-30b-brief-writer-gguf-83d71f74$/m);
    assert.match(lead, /GGUF files of \[muse-org\/muse-glimmer-30b-brief-writer-lora-83d71f74\]\(https:\/\/huggingface\.co\/muse-org\/muse-glimmer-30b-brief-writer-lora-83d71f74\)/);
    assert.match(lead, /\[the run's public page\]\(https:\/\/muse-muse\.vercel\.app\/fine-tuning\/83d71f74-d84b-40bf-925a-cd36c90b6de5\)/);
    assert.match(lead, /Not an official Meta product\.$/m);
    assert.ok(!card.includes(EM_DASH));
  });

  it("states only the records' numbers: sizes, memory, closeness, the checks, the cost and every checksum", () => {
    const card = cards.ggufCard(facts());
    assert.ok(card.includes("| Q3_K_M | `muse-glimmer-30b-brief-writer-Q3_K_M.gguf` | 13.68 GB | about 15 GB |"));
    assert.ok(card.includes("| Q4_K_M | `muse-glimmer-30b-brief-writer-Q4_K_M.gguf` | 16.94 GB | about 18 GB |"));
    assert.ok(!/\| Q6_K \| `/.test(card.split("## Run it")[0]!), "a build left out isn't offered");
    assert.ok(card.includes("| Q3_K_M | 0.0412 | 0.0800 | 0.3100 | 92.1% |") && card.includes("| Q4_K_M | 0.0143 | 0.0300 | 0.1200 | 95.3% |"));
    assert.ok(card.includes("Q6_K isn't published: its mean KL divergence was 0.0061, over its limit of 0.0050."));
    assert.ok(card.includes("gave a final answer to 39 of 40 held-out prompts") && card.includes("at least 90% do"));
    assert.ok(card.includes("31 of those 37 answers start with the same 200 characters"));
    assert.ok(card.includes("Measured on this model's 40 held-out prompts"));
    assert.ok(card.includes("78 minutes from launch to shutdown, $2.59"));
    assert.ok(card.includes("llama.cpp `b11669` (commit `620d2225cc436ab0b001e3200e590e3b286ef9ab`)"));
    assert.ok(card.includes(`revision \`${cards.META_REVISION}\``) && card.includes("at revision `2222222222222222222222222222222222222222`"));
    assert.ok(card.includes("The merged model has the base's 1,436 tensor names and shapes.") && card.includes("No importance matrix"));
    for (const b of facts().builds) assert.ok(card.includes(`| \`${b.name}\` | ${cards.gigabytes(b.bytes)} | \`${b.sha256}\` |`), b.level);
    assert.ok(card.includes(`| \`tuned.jinja\` | 10,010 bytes | \`${cards.TUNED_TEMPLATE_SHA256}\` |`));
    // Without an agreement count or a known merge revision, the card says nothing it doesn't know.
    const bare = cards.ggufCard(facts({ agreement: null, mergeBase: { repo: "unsloth/Muse-Glimmer-30B", revision: null }, tensors: null, leftOut: [] }));
    assert.ok(!bare.includes("start with the same 200 characters") && !bare.includes("at revision `null`") && !bare.includes("tensor names and shapes") && !bare.includes("isn't published"));
    assert.ok(card.includes("whose two safetensors shards have the same SHA-256 as") && !bare.includes("same SHA-256"), "the shards are Meta's only when the job checked them");
  });

  it("runs it with tuned.jinja for an old adapter, and with the file's own template and parser for one trained with trainChannel", () => {
    const old = cards.ggufCard(facts());
    assert.ok(old.includes("--chat-template-file tuned.jinja --skip-chat-parsing --reasoning off"));
    assert.ok(old.includes("curl -LO https://huggingface.co/muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74/resolve/main/tuned.jinja"));
    assert.ok(old.includes('TEMPLATE """') && old.includes("PARAMETER stop <|start|>") && !old.includes("RENDERER glimmer"));
    assert.ok(old.includes(cards.ggufModelfile("muse-glimmer-30b-brief-writer-Q4_K_M.gguf", "You are Muse Muse's brief writer.\n\nReasoning strength: low.", 0)), "the Modelfile the run-locally page gives too");
    assert.ok(old.includes("`ollama create brief-writer -f Modelfile` and `ollama run brief-writer`"), "named by its slug, as the page names it");
    assert.ok(old.includes("--no-mmproj -c 8192 -np 1 --chat-template-file tuned.jinja"), "an 8K context in one slot, as the memory table counts");
    assert.ok(old.includes("can't run it yet") && !old.includes("which this adapter's answers don't open"));
    assert.ok(old.includes("In a new chat, paste the system message below into the System Prompt"), "where the run-locally page puts it");
    assert.ok(old.includes("`lmstudio://open_from_hf?model=muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74&file=muse-glimmer-30b-brief-writer-Q4_K_M.gguf`"));
    const fresh = cards.ggufCard(facts({ trainChannel: 1, small: facts().small.filter((f) => f.name !== "tuned.jinja") }));
    assert.ok(fresh.includes("llama serve -hf muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74:Q4_K_M --no-mmproj -c 8192 -np 1\n"));
    assert.ok(fresh.includes("RENDERER glimmer\nPARSER glimmer") && !fresh.includes("tuned.jinja") && !fresh.includes('TEMPLATE """'));
    assert.ok(fresh.includes("`llama://install?repo=muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74&quant=Q4_K_M`"));
    // The system message to paste, exactly, in a fence and in the Modelfile.
    assert.ok(old.includes("```text\nYou are Muse Muse's brief writer.\n\nReasoning strength: low.\n```"));
    assert.ok(old.includes('SYSTEM """You are Muse Muse\'s brief writer.\n\nReasoning strength: low."""'));
    // Without Q4_K_M among the builds, the commands use the first that passed.
    const noQ4 = cards.ggufCard(facts({ builds: [facts().builds[0]!], leftOut: [{ level: "Q4_K_M", klMean: 0.05 }] }));
    assert.ok(noQ4.includes(":Q3_K_M --no-mmproj"));
    // Each build is picked for a graphics card of any maker, and the 12 GB split says it needs 32 GB of RAM.
    assert.ok(cards.ggufCard(facts()).includes("| A Mac with 24 GB, a graphics card with 16 GB, or one with 12 GB and 32 GB of RAM, with part of it on the processor |"));
    assert.ok(!cards.ggufCard(facts()).includes("NVIDIA GPU"));
  });

  it("shows a model-written task as text, and keeps the license, the age note and that Meta didn't endorse it", () => {
    const card = cards.ggufCard(facts({ dataset: { title: "x", task: "Summarize notes ![x](https://evil.example) and <script>. Then more.", evalCount: 8 } }));
    const lead = card.split("\n## ")[0]!;
    assert.ok(!lead.includes("![x](") && !lead.includes("<script>"), lead);
    assert.ok(lead.includes("\\!\\[x\\](https://evil.example) and &lt;script&gt;"));
    assert.ok(card.includes('which says Muse Glimmer "is not intended for individuals under the age of 18"'));
    assert.ok(card.includes("it didn't make, review or endorse these files."));
  });

  it("keeps a record of the builds, their checks and the pins, and nothing of the instance", () => {
    const record = cards.quantRecord(facts());
    const text = JSON.stringify(record);
    assert.deepEqual((record.builds as Array<{ level: string }>).map((b) => b.level), ["Q3_K_M", "Q4_K_M"]);
    assert.deepEqual(record.template, { from: "meta-models/Muse-Glimmer-30B", revision: cards.META_REVISION, sha256: cards.META_TEMPLATE_SHA256, tuned: cards.TUNED_TEMPLATE_SHA256 });
    assert.equal(record.system, "You are Muse Muse's brief writer.\n\nReasoning strength: low.");
    assert.ok(!/lambda\/nfs|blob\.vercel|instance|"ip"/.test(text), text);
  });
});

describe("the adapter's card", () => {
  it("points local apps to its GGUF repo once one is published, and is unchanged without one", () => {
    const template = cards.glimmerTemplate(GLIMMER_PY);
    const base: cards.CardFacts = {
      modelRepo: `muse-org/${cards.modelRepoName("Muse Muse's brief writer", JOB)}`,
      datasetRepo: "muse-org/muse-muse-brief-writer-17c76f2c",
      job: { id: JOB, title: "Brief writer", instanceType: "gpu_1x_a100_sxm4", gpuLabel: "1x A100 SXM4 (40 GB)", gpuMinutes: 42, costUsd: 1.39, finishedAt: null, maxSteps: 120, learningRate: 0.0002, loraRank: 16, studentPrompt: "short" },
      metrics: {},
      summary: { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 },
      example: null,
      dataset: { id: "17c76f2c-1c4a-4335-b01f-ae55a655a881", title: "Muse Muse's brief writer", task: "Write a short app brief.", trainCount: 360, evalCount: 40, costUsd: 1.51 },
      template,
      revision: template.revision,
      system: "You are Muse Muse's brief writer.",
      why: null,
      story: "A story.",
    };
    const without = cards.modelCard(base);
    assert.equal(cards.modelCard({ ...base, gguf: null }), without);
    const withGguf = cards.modelCard({ ...base, gguf: { repo: "muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74" } });
    assert.ok(
      withGguf.includes(
        "To run it on your own computer, in LM Studio, llama.cpp or Ollama, take [muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74](https://huggingface.co/muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74)",
      ),
    );
    assert.equal(withGguf.split("## How to use it")[0], without.split("## How to use it")[0], "only How to use it changes");
  });
});
