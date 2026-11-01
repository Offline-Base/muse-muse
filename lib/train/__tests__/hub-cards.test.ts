/**
 * The pure side of publishing to the Hugging Face Hub (lib/train/hub-cards.ts, and toHubView, effectiveWhy and hubBusy
 * in logic.ts): repo names under the Hub's rules, the exact file names published and the configs checked, the recipe's
 * template read from GLIMMER_PY, the student system line as glimmer.py makes it (checked against the Python itself
 * when python3 is there), the story's prompt (no counts or results), its checks and the template's story, the card's
 * own result sentence, the model and dataset cards (their front matter in the shapes the Hub's validator took, the
 * sections in order, every number from the records, no em dash, no markup from a model), the JSONL exports, the run's
 * record, and the hub state's rules.
 *
 *   npx tsx --test lib/train/__tests__/hub-cards.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PLAIN_GLIMMER_MODEL, PLAIN_GLIMMER_REVISION, USAGE_POINTS } from "../base";
import * as cards from "../hub-cards";
import { effectiveWhy, hubBusy, toHubView } from "../logic";
import { GLIMMER_PY } from "../recipes/glimmer";
import type { HubState, TrainEventView } from "../types";

const EM_DASH = String.fromCharCode(0x2014);
const JOB = "83d71f74-d84b-40bf-925a-cd36c90b6de5";
const DS = "17c76f2c-1c4a-4335-b01f-ae55a655a881";
/** The recipe's template, on r30b since the switch (lib/train/base.ts). */
const recipeTemplate = cards.glimmerTemplate(GLIMMER_PY);
/** Most cards below are a plain Glimmer adapter's, from before the switch: the hub steps give its card the base it recorded. */
const template = { ...recipeTemplate, model: PLAIN_GLIMMER_MODEL, revision: PLAIN_GLIMMER_REVISION };
const summary = { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.150405 };

function facts(over: Partial<cards.CardFacts> = {}): cards.CardFacts {
  return {
    modelRepo: `muse-org/${cards.modelRepoName("Muse Muse's brief writer", JOB)}`,
    datasetRepo: `muse-org/${cards.datasetRepoName("Muse Muse's brief writer", DS)}`,
    job: {
      id: JOB,
      title: "Spark teaches Glimmer: brief writer (short prompt)",
      instanceType: "gpu_1x_a100_sxm4",
      gpuLabel: "1x A100 SXM4 (40 GB)",
      gpuMinutes: 42,
      costUsd: 1.393,
      finishedAt: "2026-10-28T03:42:29.397Z",
      maxSteps: 120,
      learningRate: 0.0002,
      loraRank: 16,
      studentPrompt: "short",
    },
    metrics: {
      train_loss_final: 0.5188,
      steps: 120,
      max_steps: 120,
      stopped_early: "no",
      base_unfinished: 1,
      tuned_unfinished: 0,
      train_examples: 450,
      gpu: "NVIDIA A100-SXM4-40GB",
      peak_vram_gb: 31.2,
      adapter_dir: "/lambda/nfs/muse-muse-cache-us-east-1/models/x",
      adapter_url: "https://store.public.blob.vercel-storage.com/models/x/a.tar.gz",
    },
    summary,
    example: {
      index: 0,
      prompt: "need help counting seagulls in this short video from the pier",
      base: `I can${EM_DASH}t view video files directly.`,
      tuned: "Name: Pier Gull Counter\nTagline: Count every seagull | in your pier video.",
      baseScore: 2,
      tunedScore: 9,
      better: "tuned",
      note: "Delivers full brief in required shape with correct models; the other refuses video and gives no brief.",
    },
    dataset: {
      id: DS,
      title: "Muse Muse's brief writer",
      task: `Write the brief Muse Muse builds from: an app idea in, a short brief out ${EM_DASH} name, tagline, flow, models, limits and the cost per run.`,
      trainCount: 450,
      evalCount: 40,
      costUsd: 1.62,
    },
    template,
    revision: template.revision,
    system: "You are Muse Muse's brief writer.",
    why: `We wanted the brief writer on a model anyone can run ${EM_DASH} without an API key.`,
    story: "Muse Muse turns an idea into a product. This adapter learned its first step.",
    ...over,
  };
}

const storyFacts = (over: Partial<cards.StoryFacts> = {}): cards.StoryFacts => ({
  datasetTitle: "Muse Muse's brief writer",
  task: "Write the brief Muse Muse builds from: an app idea in, a short brief out.",
  why: null,
  ...over,
});

/** The front matter of a card, between its first two --- lines. */
function frontMatter(card: string): string {
  const m = card.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "the card starts with front matter");
  return m[1]!;
}

describe("repo names", () => {
  it("are muse-glimmer-30b-<slug>-lora-<job> and muse-muse-<slug>-<dataset>, valid on the Hub", () => {
    assert.equal(cards.hubSlug("Muse Muse's brief writer"), "brief-writer");
    assert.equal(cards.hubSlug("Muse Muse brief writer"), "brief-writer");
    assert.equal(cards.hubSlug("Museum muse notes"), "museum-muse-notes");
    assert.equal(cards.modelRepoName("Muse Muse's brief writer", JOB), "muse-glimmer-30b-brief-writer-lora-83d71f74");
    assert.equal(cards.datasetRepoName("Muse Muse's brief writer", DS), "muse-muse-brief-writer-17c76f2c");
    assert.equal(cards.hubSlug("Café Crème, à la carte!"), "cafe-creme-a-la-carte");
    assert.equal(cards.hubSlug("!!!"), "dataset");
    assert.equal(cards.hubSlug(""), "dataset");
    const long = cards.hubSlug("A very long dataset title that goes on and on about bakeries and their cakes");
    assert.ok(long.length <= cards.SLUG_MAX && !long.endsWith("-"), long);
    for (const title of ["x", "--a--", "Ünïcödé ".repeat(20), "a.b_c", "x".repeat(300), "12 34", "The END."]) {
      for (const name of [cards.modelRepoName(title, JOB.toUpperCase()), cards.datasetRepoName(title, DS)]) {
        assert.ok(cards.validRepoName(name), name);
        assert.match(name, /^[a-z0-9-]+$/);
      }
    }
  });

  it("follow the Hub's rules for a name", () => {
    for (const ok of ["a", "muse-org", "A.b_c-9", "x".repeat(96)]) assert.equal(cards.validRepoName(ok), true, ok);
    for (const bad of ["", "-a", "a-", ".a", "a.", "a--b", "a..b", "a.git", "a/b", "a b", "x".repeat(97), "é"]) {
      assert.equal(cards.validRepoName(bad), false, bad);
    }
  });

  it("publish only the adapter's and the tokenizer's own file names, exactly", () => {
    for (const ok of ["adapter_model.safetensors", "adapter_config.json", "chat_template.jinja", "tokenizer.model", "merges.txt", "tokenizer_config.json"]) {
      assert.equal(cards.hubFileProblem(ok), null, ok);
    }
    for (const bad of [
      "README.md",
      "LICENSE",
      "muse_muse_run.json",
      "Muse_Muse_Run.json",
      "optimizer.pt",
      "training_args.bin",
      "a/b.json",
      "../x.json",
      ".hidden.json",
      "model.pkl",
      "x.py",
      "config.json",
      "model.safetensors",
      "requirements.txt",
      "Adapter_Config.json",
    ]) {
      assert.notEqual(cards.hubFileProblem(bad), null, bad);
    }
  });

  it("checks the configs it reads, and normalizes adapter_config.json", () => {
    const model = template.model;
    const config = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o));
    assert.equal(cards.configProblem("adapter_config.json", config({ base_model_name_or_path: model, r: 16, revision: template.revision }), model), null);
    assert.equal(cards.configProblem("adapter_config.json", config({ base_model_name_or_path: model, revision: null }), model), null, "no revision: the recipe's");
    assert.match(cards.configProblem("adapter_config.json", config({ base_model_name_or_path: "someone-else/other-base" }), model)!, /names "someone-else\/other-base" as its base model/);
    assert.match(cards.configProblem("adapter_config.json", config({ base_model_name_or_path: model, revision: "main" }), model)!, /revision isn't a 40-character commit/);
    assert.match(cards.configProblem("tokenizer_config.json", config({ auto_map: { AutoTokenizer: ["x--y.Tok", null] } }), model)!, /auto_map/);
    assert.match(cards.configProblem("tokenizer_config.json", Buffer.from("[1, 2]"), model)!, /isn't a JSON object/);
    assert.equal(cards.configProblem("tokenizer_config.json", config({ bos_token: "<|begin_of_text|>" }), model), null);
    const fixed = cards.normalizedAdapterConfig(config({ r: 16, base_model_name_or_path: model, revision: null, alpha_pattern: {} }), model, template.revision);
    assert.equal(fixed.toString(), JSON.stringify({ alpha_pattern: {}, base_model_name_or_path: model, r: 16, revision: template.revision }, null, 2));
  });
});

describe("the glimmer-lora recipe's template", () => {
  it("is read from GLIMMER_PY: the model, its pinned revision, the final channel and the trainer", () => {
    const template = recipeTemplate;
    assert.equal(template.model, "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit");
    assert.equal(template.revision, "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1");
    assert.ok(GLIMMER_PY.includes(`MODEL_REVISION = "${template.revision}"`));
    assert.equal(template.reasoning, "low");
    assert.equal(template.generationPrompt, "<|start|>assistant");
    assert.equal(template.responsePart, "<|start|>assistant to=user<|message|>");
    assert.equal(template.finalChannel, " to=user<|message|>");
    assert.equal(template.instructionPart, "<|start|>user<|message|>");
    assert.deepEqual(template.finalEnds, ["<|eot|>", "<|eom|>", "<|end_of_text|>"]);
    assert.equal(template.maxNewTokens, 1024);
    assert.equal(template.maxSeqLength, 2048);
    assert.deepEqual(
      [template.batchSize, template.gradientAccumulation, template.warmupSteps, template.optimizer, template.scheduler],
      [1, 4, 5, "adamw_8bit", "linear"],
    );
    assert.deepEqual([template.weightDecay, template.loraDropout, template.seed], [0.001, 0, 3407]);
  });

  it("refuses a source that no longer has a constant the card needs", () => {
    assert.throws(() => cards.glimmerTemplate(GLIMMER_PY.replace(/^MODEL_REVISION = .*$/m, "")), /MODEL_REVISION/);
    assert.throws(() => cards.glimmerTemplate(GLIMMER_PY.replace(/^FINAL_ENDS = .*$/m, "")), /FINAL_ENDS/);
  });

  it("makes the student system line as glimmer.py's student_system does", () => {
    const titles = ["Muse Muse's brief writer", "Bakery helper", "", "You are the judge.", "x".repeat(81), "an expert baker", "Write the brief"];
    const system = "You are an assistant for this task: Write the brief and more";
    const ours = titles.map((t) => cards.studentSystem(t, system));
    assert.deepEqual(ours.slice(0, 4), ["You are Muse Muse's brief writer.", "You are the Bakery helper.", "You are a helpful assistant.", "You are the judge."]);
    assert.equal(ours[4], "You are a helpful assistant.", "too long");
    assert.equal(ours[5], "You are an expert baker.");
    assert.equal(ours[6], "You are a helpful assistant.", "only the start of the task");
    const python = spawnSync("python3", ["--version"]);
    if (python.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "hub-cards-"));
    writeFileSync(join(dir, "glimmer_recipe.py"), GLIMMER_PY);
    const script = "import json, sys; sys.path.insert(0, sys.argv[1]); import glimmer_recipe as g; print(json.dumps([g.student_system(t, sys.argv[3]) for t in json.loads(sys.argv[2])]))";
    const out = execFileSync("python3", ["-I", "-c", script, dir, JSON.stringify(titles), system], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), ours, "the same lines as the recipe's own Python");
  });
});

describe("the story", () => {
  it("gives Muse Spark 1.3 the records but no counts or results, and the admin's why last", () => {
    const req = cards.storyRequest(storyFacts({ why: `To run it offline ${EM_DASH} on our own GPU.` }));
    assert.match(req, /turns an example or some inspo into a working product on Meta's models/);
    assert.match(req, /Its first step is the brief writer/);
    assert.match(req, /The dataset: "Muse Muse's brief writer"/);
    assert.match(req, /wrote the dataset, the prompts and the answers\./);
    assert.match(req, /made in Muse Muse's fine-tuning lab\. .* The lab has Muse Spark 1\.3 write a dataset for one task/);
    assert.match(req, /The card gives the dataset's counts and the eval's result itself, right after your text\./);
    assert.doesNotMatch(req.replace(/Muse Glimmer 30B|Muse Spark 1\.3|Apache 2\.0/g, ""), /\d/, "no number for Spark to repeat or twist");
    assert.match(cards.STORY_INSTRUCTIONS, /Mention it only when the dataset's task is writing those briefs/, "no brief writer in another task's story");
    assert.match(cards.STORY_INSTRUCTIONS, /Don't write any number, count, score or percentage, in digits or in words/);
    assert.match(req, /The admin's reason, printed just before your text: To run it offline, on our own GPU\.$/);
    assert.equal(req.includes(EM_DASH), false);
    assert.match(cards.STORY_INSTRUCTIONS, /At most 100 words/);
    assert.match(cards.STORY_INSTRUCTIONS, /Don't use em dashes/);
  });

  it("takes a plain story with no counts or results of its own", () => {
    const story =
      "Muse Muse turns an idea into a product, and its first step is the brief writer. This adapter teaches Muse Glimmer 30B, an open 30B model you can run on your own GPU, to write those briefs the way Muse Spark 1.3 does.\n\nWith Apache 2.0 weights, the task can run on one model you host yourself.";
    assert.equal(cards.storyProblem(story, storyFacts()), null);
    assert.equal(cards.storyProblem(`"${story}"`, storyFacts()), null, "quotes around the whole of it are dropped");
    // A number or a count word the task uses itself is the task's, not a claim.
    assert.equal(cards.storyProblem("It writes a brief in 3 lines, with two models.", storyFacts({ task: "Write a brief in 3 lines naming two models." })), null);
  });

  it("turns down counts, scores, results, comparisons, claims about Meta, markup and length", () => {
    const f = storyFacts();
    // The ways a story got the eval wrong in review, every one of which the number check alone let through.
    for (const [text, why] of [
      ["On 8 held-out prompts the tuned model was better on 8 of 8.", /counts or results itself \(8\)/],
      ["The tuned model averaged 6.5 and the base model 7.25, out of 10.", /counts or results itself/],
      ["The tuned model lost only once and won the rest.", /counts or results itself \(lost, won\)/],
      ["The tuned model won all eight comparisons.", /counts or results itself \(won, eight\)/],
      ["The tuned model was twice as good.", /counts or results itself \(twice\)/],
      ["It writes better briefs than the base model does.", /counts or results itself \(base\)/],
      ["It scored higher on every prompt.", /counts or results itself \(scored\)/],
      ["It improved by 90% on the task.", /counts or results itself \(90\)/],
    ] as const) {
      assert.match(cards.storyProblem(text, f)!, why, text);
    }
    for (const text of [
      "Built with Meta and backed by Meta's Model API team, this adapter is sponsored by Meta.",
      "Meta supports this adapter.",
      "It is an official adapter.",
      "Meta endorses this adapter.",
      "This was made by Meta's researchers.",
    ]) {
      assert.match(cards.storyProblem(text, f)!, /Meta/, text);
    }
    assert.equal(cards.storyProblem("It runs on Meta's models and on Muse Glimmer 30B, which Meta's hosted model taught.", f), null, "Meta named, no claim");
    for (const text of [
      '## Why\nIt works.',
      "- one\n- two",
      "See [the page](https://x.example).",
      'See <a href="//evil.example/x">the results</a> for more.',
      '<img src="//evil.example/pixel.png"> Bakery lines, done right.',
      "Read more at //evil.example/x today.",
      "Read more at www.evil.example today.",
      "Use `ask()` for it.",
    ]) {
      assert.match(cards.storyProblem(text, f)!, /markup/, text);
    }
    assert.match(cards.storyProblem("word ".repeat(cards.STORY_WORDS_MAX + 1), f)!, /longer/);
    assert.match(cards.storyProblem("   ", f)!, /empty/);
  });

  it("takes out a copy of the admin's why, which the card prints just before the story", () => {
    const why = "We wanted the brief writer on our own GPU.";
    const rest = "This adapter teaches Muse Glimmer 30B to write briefs.\n\nIt can run on a model you host yourself.";
    assert.equal(cards.dropRepeatedWhy(`${why}\n\n${rest}`, why), rest, "the why as its own paragraph");
    assert.equal(cards.dropRepeatedWhy(`we wanted the brief writer on our  own GPU\n\n${rest}`, why), rest, "case, spaces and the end mark aside");
    assert.equal(cards.dropRepeatedWhy(`${why} ${rest}`, why), rest, "the why as the first sentence of a paragraph");
    assert.equal(cards.dropRepeatedWhy(`${rest}\n\n${why}`, why), rest, "anywhere as a paragraph of its own");
    assert.equal(cards.dropRepeatedWhy(rest, why), rest, "a story that doesn't repeat it is left as it is");
    assert.equal(cards.dropRepeatedWhy(rest, null), rest);
    assert.equal(cards.dropRepeatedWhy(why, why), "", "nothing left");
  });

  it("falls back to the template's story, from the task, which passes its own checks", () => {
    const f = storyFacts({ task: `Write the brief. Then more ${EM_DASH} details.` });
    const story = cards.templateStory(f);
    assert.match(story, /to do one task the way Muse Spark 1\.3 does it: Write the brief\. That way the task can run on a model you host yourself\.$/);
    assert.equal(story.includes(EM_DASH), false);
    assert.equal(cards.storyProblem(story, f), null);
    assert.equal(cards.cleanStory(`  A ${EM_DASH} B\n\n\n\nC  `), "A, B\n\nC");
  });

  it("puts the counts and the result in the card's own sentence, from the records", () => {
    const result = (baseWins: number, ties: number) =>
      cards.resultText({ summary: { ...summary, items: 8, tunedWins: 8 - baseWins - ties, baseWins, ties, avgTunedScore: 7.25, avgBaseScore: 6.5 }, dataset: facts().dataset });
    assert.equal(
      cards.resultText(facts()),
      "Muse Spark 1.3 wrote the dataset's 490 examples: 450 to train on and 40 held out. On 40 held-out prompts, judged blind by Muse Spark 1.3, the tuned model was better on 40 of 40, with an average score of 8.88 out of 10 against 1.95 for the base model.",
    );
    assert.match(result(0, 1), /better on 7 of 8, and 1 tied, with an average score of 7\.25 out of 10 against 6\.5 for the base model\.$/);
    assert.match(result(2, 0), /better on 6 of 8, and the base model on 2, with/);
    assert.match(result(2, 1), /better on 5 of 8, the base model on 2, and 1 tied, with/);
  });
});

describe("a Derivative of Muse Spark Open's model card (an adapter on r30b)", () => {
  const derived = () => cards.modelCard(facts({ template: recipeTemplate, revision: recipeTemplate.revision }));

  it("declares Apache 2.0 and the Muse Model License, and says Built with Muse Spark Open under the title", () => {
    const card = derived();
    assert.ok(
      card.startsWith(
        "---\nbase_model: OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit\nbase_model_relation: adapter\nlibrary_name: peft\npipeline_tag: text-generation\nlicense: other\nlicense_name: apache-2.0-and-muse-model-license\nlicense_link: MUSE_MODEL_LICENSE.md\n",
      ),
    );
    assert.ok(card.includes("- built-with-muse-spark-open\n"));
    const built = card.indexOf("**Built with Muse Spark Open.** This adapter was trained from [OfflineBase/Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Glimmer-30B-2026-Knowledge)");
    assert.ok(built > card.indexOf("\n# ") && built < card.indexOf("## Why this exists"), "prominently, right under the title");
    for (const point of USAGE_POINTS) assert.ok(card.includes(`- ${point}`), point);
    assert.ok(card.includes("A LoRA adapter for Muse Glimmer 30B with 2026 knowledge (`OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit`)"));
    assert.ok(!card.includes(EM_DASH));
  });

  it("compares it with the 2026 Glimmer it started from, never 'base Glimmer'", () => {
    const card = derived();
    assert.ok(card.includes("| | The 2026 Glimmer it started from (r30b) | Tuned (this adapter) |"));
    assert.ok(card.includes("with an average score of 8.88 out of 10 against 1.95 for the 2026 Glimmer it started from."));
    assert.ok(card.includes("The 2026 Glimmer it started from:\n"));
    assert.ok(card.includes("name: Judge win rate vs the 2026 Glimmer it started from"));
    assert.ok(!card.includes("Base Muse Glimmer 30B"));
    assert.ok(
      card.includes(
        "| Base model | [OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit](https://huggingface.co/OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit) at revision `6f12bf5288dd4d83374e1d6cab3b6b80da258eb1`, the 4-bit (bitsandbytes) quantization of [OfflineBase/Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Glimmer-30B-2026-Knowledge): Muse Muse's fine-tune of [meta-models/Muse-Glimmer-30B](https://huggingface.co/meta-models/Muse-Glimmer-30B) with 2026 knowledge |",
      ),
    );
  });

  it("states both licenses, the files they ship in, the Usage Policy's duties and the $20 million clause", () => {
    const license = derived().split("## License\n")[1]!.split("## Provenance")[0]!.trimStart();
    for (const file of ["`LICENSE`", "`MUSE_MODEL_LICENSE.md`", "`USAGE_POLICY.md`", "`NOTICE`"]) assert.ok(license.includes(file), file);
    assert.match(license, /^Apache 2\.0 and the Muse Model License\./);
    assert.match(license, /must show "Built with Muse Spark Open"/);
    assert.match(license, /isn't for anyone under 18, its outputs must never be presented as written by a person/);
    assert.match(license, /made-up answers and going along with false premises/);
    assert.match(license, /\$20 million in 12 months/);
    assert.match(license, /Not an official Meta product/);
  });

  it("follows the flag too, for a card whose template names another base", () => {
    assert.ok(cards.modelCard(facts({ sparkOpen: true })).includes("**Built with Muse Spark Open.**"));
    assert.ok(!cards.modelCard(facts()).includes("Muse Spark Open"), "a plain Glimmer adapter's card is as it was");
  });
});

describe("the model card", () => {
  const card = cards.modelCard(facts());

  it("has the front matter the Hub's validator took, with the eval in model-index", () => {
    const repo = facts().datasetRepo;
    assert.equal(
      frontMatter(card),
      [
        "base_model: unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit",
        "base_model_relation: adapter",
        "library_name: peft",
        "pipeline_tag: text-generation",
        "license: apache-2.0",
        "tags:",
        "- lora",
        "- peft",
        "- unsloth",
        "- trl",
        "- sft",
        "- muse-muse",
        "datasets:",
        `- ${repo}`,
        "model-index:",
        "- name: muse-glimmer-30b-brief-writer-lora-83d71f74",
        "  results:",
        "  - task:",
        "      type: text-generation",
        "      name: Blind pairwise vs base",
        "    dataset:",
        `      name: "Muse Muse's brief writer held-out prompts"`,
        `      type: ${repo}`,
        "      split: eval",
        "    metrics:",
        "    - name: Judge win rate vs base",
        "      type: win_rate",
        "      value: 1",
        "    - name: Average judge score, tuned (1 to 10)",
        "      type: judge_score",
        "      value: 8.88",
        "    - name: Average judge score, base (1 to 10)",
        "      type: judge_score",
        "      value: 1.95",
        "    source:",
        "      name: Muse Muse blind eval",
        `      url: https://muse-muse.vercel.app/fine-tuning/${JOB}`,
      ].join("\n"),
      "no language tag: the task has a character outside ASCII",
    );
    const english = frontMatter(cards.modelCard(facts({ dataset: { ...facts().dataset, task: "Plain words only." } })));
    assert.match(english, /^license: apache-2.0\nlanguage:\n- en\ntags:/m);
  });

  it("tells why it exists first, then what it does, the results, the training, use, data, limits, license, provenance", () => {
    const heads = [...card.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, ["Why this exists", "What it does", "Results", "How it was trained", "How to use it", "Data", "Limits", "License", "Provenance"]);
    const why = card.slice(card.indexOf("## Why this exists"), card.indexOf("## What it does"));
    assert.ok(why.indexOf("We wanted the brief writer") < why.indexOf("Muse Muse turns an idea"), "the admin's why leads, the story follows");
    assert.ok(why.indexOf("Muse Muse turns an idea") < why.indexOf(cards.resultText(facts())), "then the records' counts and result");
    assert.match(card, /^# muse-glimmer-30b-brief-writer-lora-83d71f74$/m);
    assert.match(card, /Not an official Meta product\./);
    assert.equal(card.includes(EM_DASH), false, "no em dash, even from the task, the why or the answers");
  });

  it("puts only the records' numbers in the results, with the blind order and an example", () => {
    assert.match(card, /\| Better on \| 0 of 40 \| 40 of 40 \|/);
    assert.match(card, /\| Average score \(1 to 10\) \| 1\.95 \| 8\.88 \|/);
    assert.match(card, /\| Answers unfinished within 1024 new tokens \| 1 \| 0 \|/);
    assert.match(card, /Ties: 0\. Win rate: 100% for the tuned model\. Judging cost \$0\.15\./);
    assert.match(card, /the base model's first on even items and second on odd ones/);
    assert.match(card, /Held-out item 1, where the judge saw the base model's answer as A\. It scored the base model 2 and the tuned model 9/);
    assert.match(card, /```text\nName: Pier Gull Counter\nTagline: Count every seagull \| in your pier video\.\n```/, "verbatim in a fence");
    assert.match(card, /```text\nI can, t view video files directly\.\n```/, "but never an em dash");
  });

  it("shows the judge's note as text, so a note can't add a link, an image or a heading", () => {
    const note = 'Great! <img src="//evil.example/p.png"> See [this](https://evil.example) # and `code`.';
    const out = cards.modelCard(facts({ example: { ...facts().example!, note } }));
    const line = out.split("\n").find((l) => l.startsWith("Held-out item"))!;
    assert.ok(line.includes('&lt;img src="//evil.example/p.png"&gt;'), line);
    assert.ok(line.includes("\\[this\\](https://evil.example) \\# and \\`code\\`"), line);
    assert.doesNotMatch(line, /<img|[^\\]\]\(/, "no tag, and no link that isn't escaped");
  });

  it("says how it was trained from the job, its metrics and the recipe", () => {
    const section = card.slice(card.indexOf("## How it was trained"), card.indexOf("## How to use it"));
    assert.match(section, new RegExp(`at revision \`${template.revision}\``));
    assert.match(section, /\| LoRA rank \| 16 \(alpha 16, dropout 0\) \|/);
    assert.match(section, /\| Learning rate \| 0\.0002, linear schedule, 5 warmup steps, adamw_8bit, weight decay 0\.001 \|/);
    assert.match(section, /\| Steps \| 120, batch 1 with gradient accumulation 4 \|/);
    assert.match(section, /\| Training examples \| 450 \|/);
    assert.match(section, /\| System prompt \(student\) \| `You are Muse Muse's brief writer\.` \(one line, in place of the dataset's task prompt\) \|/);
    assert.match(section, /\| GPU \| NVIDIA A100-SXM4-40GB, 1x A100 SXM4 \(40 GB\) on Lambda \|/);
    assert.match(section, /\| GPU time \| 42 minutes, from launch to shutdown \|/);
    assert.match(section, /\| GPU cost \| \$1\.39 \|/);
    assert.match(section, /\| Final training loss \| 0\.5188 \|/);
    assert.doesNotMatch(card, /lambda\/nfs|blob\.vercel-storage|us-east-1/, "no path or URL of the platform's own");
  });

  it("shows how to prompt it exactly as training and eval did, with transformers and with Unsloth", () => {
    const section = card.slice(card.indexOf("## How to use it"), card.indexOf("## Data"));
    assert.equal((section.match(/```python/g) ?? []).length, 2);
    for (const line of [
      'BASE = "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit"',
      `REVISION = "${template.revision}"`,
      `ADAPTER = "${facts().modelRepo}"`,
      `SYSTEM = "You are Muse Muse's brief writer."`,
      'messages, tokenize=False, add_generation_prompt=True, reasoning_strength="low"',
      'text = text.removeprefix(tokenizer.bos_token) + " to=user<|message|>"',
      "out = model.generate(**inputs, max_new_tokens=1024, do_sample=False)",
      'for end in ("<|eot|>", "<|eom|>", "<|end_of_text|>"):',
      "from transformers import AutoModelForMultimodalLM, AutoProcessor",
      'model = AutoModelForMultimodalLM.from_pretrained(BASE, revision=REVISION, device_map="auto")',
      "model = PeftModel.from_pretrained(model, ADAPTER)",
      "model, processor = FastModel.from_pretrained(model_name=BASE, revision=REVISION, max_seq_length=2048)",
      "model = PeftModel.from_pretrained(model, ADAPTER, is_trainable=False)",
    ]) {
      assert.ok(section.includes(line), line);
    }
    const python = spawnSync("python3", ["--version"]);
    if (python.status !== 0) return;
    // Both snippets are valid Python.
    for (const block of section.matchAll(/```python\n([\s\S]*?)\n```/g)) {
      const res = spawnSync("python3", ["-I", "-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: block[1] });
      assert.equal(res.status, 0, res.stderr.toString());
    }
  });

  it("states the license, the Usage Policy and its age note, and that Meta didn't endorse it", () => {
    assert.match(card, /Apache 2\.0, the license of the base model: the full text is in `LICENSE`/);
    assert.match(card, /\[Usage Policy\]\(https:\/\/huggingface\.co\/meta-models\/Muse-Glimmer-30B\/blob\/main\/USAGE_POLICY\.md\)/);
    assert.match(card, /"is not intended for individuals under the age of 18"/);
    assert.match(card, /it didn't make, review or endorse this adapter/);
    assert.match(card, new RegExp(`The run's public page, with every eval item: https://muse-muse\\.vercel\\.app/fine-tuning/${JOB}`));
    assert.match(card, /\[muse-org\/muse-muse-brief-writer-17c76f2c\]\(https:\/\/huggingface\.co\/datasets\/muse-org\//);
  });

  it("shows a full student prompt's system message in a fence, and says the base answered under it", () => {
    const system = `You are an assistant for this task: Write the brief ${EM_DASH} name, tagline.\n\nAnswer the user's message directly and well.`;
    const full = cards.modelCard(facts({ job: { ...facts().job, studentPrompt: "full" }, system }));
    assert.match(full, /Both models answered under the dataset's whole task prompt/);
    assert.match(full, new RegExp(`\\| System prompt \\(student\\) \\| The dataset's own task prompt \\(${system.length} characters, under What it does\\) \\|`));
    const does = full.slice(full.indexOf("## What it does"), full.indexOf("## Results"));
    assert.ok(does.includes("```text\nYou are an assistant for this task: Write the brief, name, tagline.\n\nAnswer the user's message directly and well.\n```"), does);
    assert.equal(full.includes(EM_DASH), false);
    // The Python keeps the message exactly as training used it, with the em dash as an escape.
    assert.ok(full.includes(`SYSTEM = "You are an assistant for this task: Write the brief \\u2014 name, tagline.\\n\\nAnswer the user's message directly and well."`));
  });
});

describe("the dataset card and files", () => {
  const card = cards.datasetCard(facts());

  it("has the dataset front matter and a default config over train and eval", () => {
    assert.equal(
      frontMatter(card),
      [
        `pretty_name: "Muse Muse's brief writer"`,
        "license: other",
        "license_name: meta-model-api-outputs",
        "license_link: LICENSE.md",
        "task_categories:",
        "- text-generation",
        "size_categories:",
        "- n<1K",
        "annotations_creators:",
        "- machine-generated",
        "language_creators:",
        "- machine-generated",
        "source_datasets:",
        "- original",
        "tags:",
        "- synthetic",
        "- sft",
        "- distillation",
        "- muse-muse",
        "configs:",
        "- config_name: default",
        "  data_files:",
        "  - split: train",
        "    path: data/train.jsonl",
        "  - split: eval",
        "    path: data/eval.jsonl",
      ].join("\n"),
    );
    assert.equal(cards.sizeCategory(999), "n<1K");
    assert.equal(cards.sizeCategory(1000), "1K<n<10K");
  });

  it("tells the story, the task, the fields, the split, the counts and the cost, and that Spark wrote it", () => {
    const heads = [...card.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, ["Why this exists", "The task", "What's in it", "How it was made", "Models trained on it", "License", "Provenance"]);
    assert.ok(card.includes(cards.resultText(facts())), "the same counts and result as the model card");
    assert.match(card, /\| train \| `data\/train\.jsonl` \| 450 \|/);
    assert.match(card, /\| eval \| `data\/eval\.jsonl` \| 40 \|/);
    assert.match(card, /40 examples were held out for eval and 450 kept for training/);
    assert.match(card, /shares at least 70% of its words with a held-out prompt was left out of train/);
    assert.match(card, /Writing it cost \$1\.62 on Meta's Model API\./);
    assert.match(card, /Muse Spark 1\.3 wrote all of the text, prompts and answers, through Meta's Model API, for Muse Muse, so Meta's terms for that API's outputs govern it/);
    assert.doesNotMatch(card, /apache/i, "Spark's text isn't ours to put under Apache 2.0");
    assert.match(card, /> Write the brief Muse Muse builds from/);
    assert.equal(card.includes(EM_DASH), false);
  });

  it("lists every model published from it, this one first, and says whose story it tells", () => {
    const one = card.slice(card.indexOf("## Models trained on it"), card.indexOf("## License"));
    assert.deepEqual(one.match(/^- .+$/gm), [
      `- [${facts().modelRepo}](https://huggingface.co/${facts().modelRepo}), from the run "Spark teaches Glimmer: brief writer (short prompt)": https://muse-muse.vercel.app/fine-tuning/${JOB}`,
    ]);
    assert.doesNotMatch(card, /the latest model published from it/, "one model: no need to say whose story");
    const other = { repo: "muse-org/muse-glimmer-30b-brief-writer-lora-1a2b3c4d", jobId: "1a2b3c4d-0000-4000-8000-000000000001", title: "Run 1" };
    const two = cards.datasetCard(facts(), [other, { repo: facts().modelRepo, jobId: JOB, title: "itself, listed once" }]);
    const list = two.slice(two.indexOf("## Models trained on it"), two.indexOf("## License")).match(/^- .+$/gm)!;
    assert.equal(list.length, 2);
    assert.ok(list[0]!.includes(facts().modelRepo) && list[1]!.includes(other.repo), "this job's first, then the others");
    assert.match(two, new RegExp(`As the card of \\[${facts().modelRepo}\\]\\([^)]+\\), the latest model published from it, tells it:`));
    assert.match(two, /2 Muse Glimmer 30B LoRA adapters trained on it are published/);
  });

  it("exports train and eval as JSONL in one messages format", () => {
    const train = [
      {
        messages: [
          { role: "system" as const, content: "You are an assistant for this task: briefs" },
          { role: "user" as const, content: "count gulls" },
          { role: "assistant" as const, content: `**Name:** Gull Counter ${EM_DASH} v1` },
        ],
      },
    ];
    const t = cards.trainJsonl(train).trimEnd().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(t, train, "as trained on, em dash and all: the data is the data");
    const system = cards.datasetSystem(train, "ignored");
    assert.equal(system, "You are an assistant for this task: briefs");
    assert.match(cards.datasetSystem([], "Bake."), /^You are an assistant for this task: Bake\./);
    const e = cards.evalJsonl([{ prompt: "p1", reference: "r1" }], system).trimEnd().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(e, [{ messages: [{ role: "system", content: system }, { role: "user", content: "p1" }, { role: "assistant", content: "r1" }] }]);
    assert.ok(cards.trainJsonl(train).endsWith("\n"));
  });

  it("keeps a run record with only public facts", () => {
    const items = cards.runItems(events());
    const record = cards.runRecord(facts(), items, "spark");
    const text = JSON.stringify(record);
    assert.doesNotMatch(text, /lambda\/nfs|blob\.vercel-storage|instanceId|instanceIp|tokenHash|region/);
    assert.deepEqual(Object.keys((record.job as { metrics: object }).metrics).sort(), ["base_unfinished", "gpu", "max_steps", "peak_vram_gb", "steps", "stopped_early", "train_examples", "train_loss_final", "tuned_unfinished"]);
    assert.equal((record.eval as { items: unknown[] }).items.length, 2);
    assert.deepEqual((record.base as { revision: string }).revision, template.revision);
  });
});

function events(): TrainEventView[] {
  const at = "2026-10-28T03:40:00.000Z";
  return [
    { id: 1, type: "eval", payload: { type: "eval", index: 1, prompt: "p1", reference: "r1", base: "b1", tuned: "t1" }, at },
    { id: 2, type: "eval", payload: { type: "eval", index: 0, prompt: "p0", reference: "r0", base: "b0", tuned: "t0" }, at },
    { id: 3, type: "eval", payload: { type: "eval", index: 0, prompt: "again", reference: "", base: "", tuned: "" }, at },
    { id: 4, type: "judgement", payload: { type: "judgement", index: 0, baseScore: 5, tunedScore: 5, better: "tie", note: "Same." }, at },
    { id: 5, type: "judgement", payload: { type: "judgement", index: 1, baseScore: 2, tunedScore: 9, better: "tuned", note: "Full brief." }, at },
  ];
}

describe("the models a card names, from the records", () => {
  const wonderDataset = { ...facts().dataset, writerModel: "muse-wonder-1.0" };
  /** Every text a publish writes for a job: both cards, the dataset's license and the run's record. */
  const everything = (f: cards.CardFacts, storyBy: "spark" | "template" = "spark", storyModel: string | null = null) =>
    [
      cards.modelCard(f),
      cards.datasetCard(f),
      cards.datasetLicense(f.dataset.writerModel ?? null),
      JSON.stringify(cards.runRecord(f, cards.runItems(events()), storyBy, storyModel)),
    ].join("\n");

  it("says Muse Spark 1.3 everywhere for the tuned run, whose records name no model (history isn't relabeled)", () => {
    const f = facts();
    assert.equal(f.dataset.writerModel, undefined);
    assert.equal(f.judgeModel, undefined);
    const text = everything(f);
    assert.doesNotMatch(text, /Wonder/, "nothing of the run is credited to Muse Wonder");
    const card = cards.modelCard(f);
    assert.match(card, /that learned one task from Muse Spark 1\.3: Write the brief Muse Muse builds from/);
    assert.match(card, /Muse Spark 1\.3 wrote the dataset's 490 examples: .* judged blind by Muse Spark 1\.3, the tuned model was better on 40 of 40/);
    assert.match(card, /Muse Spark 1\.3 \(`muse-spark-1\.3`\) judged each pair blind: .* against Muse Spark 1\.3's own reference answer/);
    assert.match(card, /It was trained to answer the way Muse Spark 1\.3 answered those prompts\./);
    assert.match(card, /Muse Spark 1\.3 wrote the training answers, the references and the verdicts, and a judge can favor answers like its own\./);
    assert.match(card, /Meta made Muse Glimmer 30B and Muse Spark 1\.3; it didn't make/);
    assert.match(cards.datasetCard(f), /^Training data that Muse Spark 1\.3 wrote for one task/m);
    assert.match(cards.datasetLicense(), /^Muse Spark 1\.3 wrote every prompt and answer in this dataset/m);
    const record = cards.runRecord(f, [], "spark");
    assert.equal((record.dataset as { writer: string }).writer, "muse-spark-1.3");
    assert.equal((record.eval as { judge: string }).judge, "muse-spark-1.3");
    assert.deepEqual(record.story, { why: f.why, by: "spark", model: "muse-spark-1.3" }, "a saved story with no model was Muse Spark 1.3's");
    // Null on the record reads the same as absent.
    assert.equal(cards.modelCard(facts({ judgeModel: null, dataset: { ...f.dataset, writerModel: null } })), card);
  });

  it("says Muse Wonder everywhere for a dataset Muse Wonder wrote and a run it judged", () => {
    const f = facts({ dataset: wonderDataset, judgeModel: "muse-wonder-1.0" });
    const text = everything(f, "spark", "muse-wonder-1.0");
    assert.doesNotMatch(text, /Muse Spark|Spark 1\.3|muse-spark|"by":"spark"/, "no Muse Spark 1.3 in a card for Muse Wonder's work");
    const card = cards.modelCard(f);
    assert.match(card, /that learned one task from Muse Wonder: Write the brief Muse Muse builds from/);
    assert.match(cards.resultText(f), /^Muse Wonder wrote the dataset's 490 examples: .* judged blind by Muse Wonder, the tuned model/);
    assert.match(card, /Muse Wonder \(`muse-wonder-1\.0`\) judged each pair blind: .* against Muse Wonder's own reference answer/);
    assert.match(card, /It was trained to answer the way Muse Wonder answered those prompts\./);
    assert.match(card, /held-out prompts that Muse Wonder wrote through Meta's Model API/);
    assert.match(card, /The training data is Muse Wonder's output through Meta's Model API/);
    assert.match(card, /Meta made Muse Glimmer 30B and Muse Wonder; it didn't make/);
    const dataCard = cards.datasetCard(f);
    assert.match(dataCard, /^Training data that Muse Wonder wrote for one task/m);
    assert.match(dataCard, /- `assistant`: Muse Wonder's answer\./);
    assert.match(dataCard, /^Muse Wonder wrote the prompts in batches/m);
    assert.match(dataCard, /^Muse Wonder wrote all of the text, prompts and answers/m);
    assert.match(cards.datasetLicense("muse-wonder-1.0"), /^Muse Wonder wrote every prompt and answer in this dataset[^]*Meta made Muse Wonder;/m);
    const record = cards.runRecord(f, [], "spark", "muse-wonder-1.0");
    assert.equal((record.dataset as { writer: string }).writer, "muse-wonder-1.0");
    assert.equal((record.eval as { judge: string }).judge, "muse-wonder-1.0");
    assert.deepEqual(record.story, { why: f.why, by: "model", model: "muse-wonder-1.0" }, "never \"spark\" for Muse Wonder's story");
    assert.deepEqual(cards.runRecord(f, [], "template").story, { why: f.why, by: "template" }, "the template's story has no model");
  });

  it("names each model for its own part when Muse Spark 1.3 wrote the dataset and Muse Wonder judged the run", () => {
    const f = facts({ judgeModel: "muse-wonder-1.0" });
    const card = cards.modelCard(f);
    assert.match(cards.resultText(f), /^Muse Spark 1\.3 wrote the dataset's 490 examples: .* judged blind by Muse Wonder, the tuned model/);
    assert.match(card, /Muse Wonder \(`muse-wonder-1\.0`\) judged each pair blind: .* against Muse Spark 1\.3's reference answer, and said/);
    assert.doesNotMatch(card, /own reference answer/, "the judge didn't write the references");
    assert.match(card, /Muse Spark 1\.3 wrote the training answers and the references, and Muse Wonder the verdicts\./);
    assert.match(card, /Meta made Muse Glimmer 30B, Muse Spark 1\.3 and Muse Wonder; it didn't make/);
    assert.match(card, /that learned one task from Muse Spark 1\.3:/);
    const record = cards.runRecord(f, [], "template");
    assert.deepEqual([(record.dataset as { writer: string }).writer, (record.eval as { judge: string }).judge], ["muse-spark-1.3", "muse-wonder-1.0"]);
    assert.equal(card.includes(EM_DASH), false);
  });

  it("asks Muse Wonder for a new story, about the dataset's own writer", () => {
    assert.equal(cards.STORY_MODEL, "muse-wonder-1.0", "Muse Wonder tells new stories, never Muse Spark 1.3");
    assert.doesNotMatch(cards.STORY_INSTRUCTIONS, /Spark|Wonder/, "the instructions name no model; the facts do");
    const req = cards.storyRequest(storyFacts({ writerModel: "muse-wonder-1.0" }));
    assert.match(req, /^Muse Wonder, Meta's hosted model, wrote the dataset, the prompts and the answers\.$/m);
    assert.match(req, /The lab has Muse Wonder write a dataset for one task, and Muse Glimmer 30B learns to do the task the way Muse Wonder does\./);
    assert.doesNotMatch(req, /Muse Spark|Spark 1\.3/);
    assert.match(cards.templateStory(storyFacts({ writerModel: "muse-wonder-1.0" })), /the way Muse Wonder does it:/);
    assert.match(cards.templateStory(storyFacts()), /the way Muse Spark 1\.3 does it:/, "a dataset with no writer recorded");
    assert.equal(cards.storyProblem("It teaches Muse Glimmer 30B what Muse Wonder 1.0 does.", storyFacts()), null, "the version is part of the name");
  });
});

describe("the eval items and the example", () => {
  it("reads the first eval and judgement per index, in order, and picks a win with a note", () => {
    const items = cards.runItems(events());
    assert.deepEqual(items.map((i) => [i.index, i.prompt, i.judgement?.better]), [[0, "p0", "tie"], [1, "p1", "tuned"]]);
    assert.deepEqual(cards.pickExample(items), { index: 1, prompt: "p1", base: "b1", tuned: "t1", baseScore: 2, tunedScore: 9, better: "tuned", note: "Full brief." });
    assert.equal(cards.pickExample(items.map((i) => ({ ...i, judgement: null }))), null);
    assert.equal(cards.pickExample(items.slice(0, 1))!.index, 0, "no win: the first judged one");
  });
});

describe("the hub state's rules", () => {
  const now = new Date("2026-10-28T04:00:00.000Z");
  const file = (path: string, n: number) => ({ path, size: n * 100, sha256: String(n).repeat(64).slice(0, 64) });
  const plan = (over: Partial<Parameters<typeof cards.withPlan>[1]> = {}) => ({
    uploaderJobId: JOB,
    modelRepo: "muse-org/m",
    files: [file("adapter_model.safetensors", 1), file("tokenizer.json", 2)],
    small: { "adapter_config.json": Buffer.from("{}").toString("base64") },
    present: [],
    ...over,
  });

  it("replaces the plan before with a plan again, keeping what the Hub has, and starts over for another job's GPU", () => {
    const first = cards.withPlan(null, plan({ present: [file("tokenizer.json", 2).sha256] }), now);
    assert.equal(first.status, "uploading");
    assert.deepEqual(first.uploaded, [file("tokenizer.json", 2).sha256], "the Hub had it");
    assert.equal(cards.hubUploaded(first), false);
    // The whole plan again (runner.py's after an expired URL): nothing of the one before is added to it.
    const again = cards.withPlan({ ...first, why: "Kept.", claim: "stale" }, plan({ small: { "adapter_config.json": "e30=", "chat_template.jinja": "e30=" } }), now);
    assert.deepEqual(again.files!.map((f) => f.path), ["adapter_model.safetensors", "tokenizer.json"]);
    assert.deepEqual(Object.keys(again.small!), ["adapter_config.json", "chat_template.jinja"]);
    assert.deepEqual(again.uploaded, [file("tokenizer.json", 2).sha256], "still in the plan, so still uploaded");
    assert.deepEqual([again.why, again.claim], ["Kept.", null]);
    const fewer = cards.withPlan(again, plan({ files: [file("adapter_model.safetensors", 3)], small: {} }), now);
    assert.deepEqual(fewer.files!.map((f) => [f.path, f.sha256[0]]), [["adapter_model.safetensors", "3"]], "no file of the plan before is kept");
    assert.deepEqual([fewer.small, fewer.uploaded], [{}, []]);
    const other = cards.withPlan(again, plan({ uploaderJobId: "other", files: [file("adapter_model.safetensors", 4)], small: {} }), now);
    assert.deepEqual(other.files!.map((f) => f.path), ["adapter_model.safetensors"]);
    assert.deepEqual(other.small, {});
    assert.deepEqual(other.uploaded, []);
  });

  it("turns uploaded once every file is in, and failed with the first failure's reason", () => {
    const planned = cards.withPlan(null, plan(), now);
    const half = cards.withDone(planned, { uploaded: [file("adapter_model.safetensors", 1).sha256, "f".repeat(64)], failed: [] }, now);
    assert.equal(half.status, "uploading");
    assert.deepEqual(half.uploaded, [file("adapter_model.safetensors", 1).sha256], "an oid outside the plan is ignored");
    const all = cards.withDone(half, { uploaded: [file("tokenizer.json", 2).sha256], failed: [] }, now);
    assert.equal(all.status, "uploaded");
    assert.equal(cards.hubUploaded(all), true);
    const failed = cards.withDone(planned, { uploaded: [], failed: [{ path: "tokenizer.json", error: "HTTP 500" }, { path: "x", error: "y" }] }, now);
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "The GPU couldn't upload tokenizer.json to Hugging Face: HTTP 500 (and 1 more)");
    assert.equal(cards.hubUploaded({ ...all, small: {} }), false, "no adapter_config.json");
  });

  it("holds a fresh publishing claim, and lets one a dead workflow left go after 30 minutes", () => {
    const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    assert.equal(hubBusy({ status: "publishing", updatedAt: at(5) }, now.getTime()), true);
    assert.equal(hubBusy({ status: "publishing", updatedAt: at(31) }, now.getTime()), false);
    assert.equal(hubBusy({ status: "uploaded", updatedAt: at(1) }, now.getTime()), false);
    assert.equal(hubBusy(null, now.getTime()), false);
    assert.equal(toHubView({ status: "publishing", updatedAt: at(31) }, null, now).stale, true, "the page offers Retry");
    assert.equal(toHubView({ status: "publishing", updatedAt: at(5) }, null, now).stale, false);
  });

  it("publishes only a judged glimmer-lora job that succeeded and wasn't a dry run", () => {
    const job = { recipe: "glimmer-lora" as const, status: "succeeded" as const, params: { dryRun: 0 }, terminatedAt: now, evalSummary: summary };
    assert.equal(cards.hubJobProblem(job), null);
    assert.match(cards.hubJobProblem({ ...job, recipe: "smoke" })!, /Only Muse Glimmer LoRA/);
    assert.match(cards.hubJobProblem({ ...job, params: { dryRun: 1 } })!, /dry run/);
    assert.match(cards.hubJobProblem({ ...job, status: "failed" })!, /didn't succeed/);
    assert.match(cards.hubJobProblem({ ...job, evalSummary: null })!, /isn't judged yet/);
    assert.match(cards.hubJobProblem({ ...job, terminatedAt: null })!, /isn't judged yet/);
    const unjudged = { ...summary, items: 0, note: "Judging skipped: MODEL_API_KEY isn't set." };
    assert.match(cards.hubJobProblem({ ...job, evalSummary: unjudged })!, /wasn't judged \(Judging skipped: MODEL_API_KEY isn't set\)/);
  });

  it("reads the why from Publish first (a cleared one too), then the job's param, with no em dash, and the publish param", () => {
    assert.equal(effectiveWhy({ status: "waiting", why: `Saved ${EM_DASH} here.` }, { why: "Param." }), "Saved, here.");
    assert.equal(effectiveWhy({ status: "waiting", why: null }, { why: " Param. " }), "Param.");
    assert.equal(effectiveWhy({ status: "waiting" }, { why: "Param." }), "Param.", "never set with Publish");
    assert.equal(effectiveWhy({ status: "waiting", why: "" }, { why: "Param." }), null, "cleared with Publish, which wins over the param");
    assert.equal(effectiveWhy(null, {}), null);
    assert.equal(effectiveWhy(null, { why: "x".repeat(3000) })!.length, 2000);
    assert.equal(cards.publishOff({ publish: 0 }), true);
    assert.equal(cards.publishOff({ publish: 1 }), false);
    assert.equal(cards.publishOff({}), false);
  });

  it("shows admins where it stands, never the small files, the story or what it cost", () => {
    const state: HubState = {
      ...cards.withDone(cards.withPlan(null, plan(), now), { uploaded: [file("adapter_model.safetensors", 1).sha256], failed: [] }, now),
      why: "Why.",
      story: "A story.",
      storyBy: "spark",
      storyCostUsd: 0.003,
    };
    const view = toHubView({ ...state, claim: "claim-id-0001" }, { why: "The param's." }, now);
    assert.deepEqual(view, {
      status: "uploading",
      reason: null,
      modelRepo: "muse-org/m",
      datasetRepo: null,
      modelUrl: null,
      datasetUrl: null,
      why: "Why.",
      storyBy: "spark",
      storyModel: "muse-spark-1.3",
      public: false,
      stale: false,
      filesUploaded: 1,
      filesTotal: 2,
      publishJobId: null,
      publishedAt: null,
    });
    assert.doesNotMatch(JSON.stringify(view), /e30=|A story|0\.003|claim-id/);
    assert.equal(toHubView({ status: "waiting" }, { why: "The param's." }, now).why, "The param's.", "the why the card prints");
    assert.equal(toHubView({ ...state, storyModel: "muse-wonder-1.0" }, null, now).storyModel, "muse-wonder-1.0");
    assert.equal(toHubView({ ...state, storyBy: "template" }, null, now).storyModel, null, "the template's story has no model");
  });
});
