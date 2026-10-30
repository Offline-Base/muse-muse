/**
 * The open-weight builders' pure logic, pinned to the mirrored pages: the chat template renderer against the
 * prompting guides' printed prompts, each runtime's default command against its deploy page, the calculators against
 * the hardware and quantization pages' numbers, and the data, reward and training helpers. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/open-weights/__tests__/logic.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { command, shq, py } from "@/components/docs/playgrounds/open-weights/shell";
import {
  GLIMMER_PRESETS,
  SPARK_PRESETS,
  plainText,
  renderTemplate,
  serverRequest,
  snippetFor,
  tallyTokens,
  estimateTextTokens,
  type ConvMessage,
  type RenderOptions,
} from "@/components/docs/playgrounds/open-weights/template";
import { clientCode, defaultsOf } from "@/components/docs/playgrounds/open-weights/deploy";
import { SPARK_RUNTIMES, defaultSparkPlan, sparkRuntime } from "@/components/docs/playgrounds/open-weights/deploy-spark";
import { GLIMMER_RUNTIMES, defaultGlimmerPlan, glimmerRuntime, planText, sglangMemFraction } from "@/components/docs/playgrounds/open-weights/deploy-glimmer";
import { META_DOWNLOAD_FILES, glimmerDownload, sparkDownload } from "@/components/docs/playgrounds/open-weights/download";
import { checkStops, kvGrowth, kvShareOfDense } from "@/components/docs/playgrounds/open-weights/settings";
import { GLIMMER_PLATFORMS, amdCommand, glimmerFits, macShare, sparkFit, aiperfCommand } from "@/components/docs/playgrounds/open-weights/hardware";
import { ggufBudget, ggufDraftDownload, ggufServe, maxContextFor, pickGguf, quantizeYourself } from "@/components/docs/playgrounds/open-weights/gguf";
import { MATH_PROBLEMS, SCHEME_LABEL, grpoAdvantages, lastBoxed, readGroup, rewardAnalyst, rewardBoxed, rewardExact, sameAnswer } from "@/components/docs/playgrounds/open-weights/rewards";
import { PAGE_CTX, sparkLayout, sparkNvidiaCommand } from "@/components/docs/playgrounds/open-weights/spark-hardware";
import { SAMPLE_ROWS, checkDataset } from "@/components/docs/playgrounds/open-weights/dataset";
import { SPARK_TRL_DEFAULTS, fireworksPlan, fullParamMemory, glimmerTrl, GLIMMER_TRL_DEFAULTS, sparkTrl, sparkTrlLaunch, milesPlan, MILES_DEFAULTS, titanRlPlan, TITANRL_DEFAULTS } from "@/components/docs/playgrounds/open-weights/training";
import { MASK_PRESETS, audioTokens, imagePatchTokens, lossMask, rlPlan, RL_DEFAULTS, sftIsCustom, sftPlan, SFT_DEFAULTS, sciNum } from "@/components/docs/playgrounds/open-weights/torchtitan";
import { macPlan, MAC_DEFAULTS } from "@/components/docs/playgrounds/open-weights/mac";
import { recommend } from "@/components/docs/playgrounds/open-weights/picker";
import { POST_TRAINING, RUN_LOCALLY, filterCards } from "@/components/docs/playgrounds/open-weights/recipes";

const EM_DASH = String.fromCharCode(0x2014);

function opts(model: "spark" | "glimmer", over: Partial<RenderOptions> = {}): RenderOptions {
  return { model, effort: model === "spark" ? "xhigh" : "high", currentDate: "2026-10-15", tools: [], addGenerationPrompt: true, ...over };
}

function preset(list: typeof SPARK_PRESETS, id: string) {
  const p = list.find((x) => x.id === id);
  assert.ok(p, id);
  return p;
}

describe("shell helpers", () => {
  it("quotes only what needs quoting", () => {
    assert.equal(shq("./muse-spark-open"), "./muse-spark-open");
    assert.equal(shq("it's"), "'it'\\''s'");
    assert.equal(shq('{"a":1}'), `'{"a":1}'`);
  });
  it("writes one flag per line and skips the falsy ones", () => {
    assert.equal(command("sglang serve", ["--a 1", false, null, "--b"]), "sglang serve \\\n  --a 1 \\\n  --b");
    assert.equal(command("ollama run x", []), "ollama run x");
  });
  it("writes Python literals", () => {
    assert.equal(py({ a: true, b: null, c: [1, "x"] }), '{"a": True, "b": None, "c": [1, "x"]}');
  });
});

describe("chat template: Muse Spark Open", () => {
  it("renders the system prompt example the way the page prints it", () => {
    const p = preset(SPARK_PRESETS, "system");
    const r = renderTemplate(p.messages, opts("spark", { effort: p.effort, currentDate: p.currentDate! }));
    const text = plainText(r.segments);
    assert.ok(
      text.startsWith(
        "<|begin_of_text|><|start|>system<|message|>You are a helpful AI assistant.\n\nKnowledge cutoff: 2026-01-04.\n\nCurrent date: 2026-10-15.\n\nYou are a code reviewer. Flag correctness bugs before style issues.\n\nReasoning strength: 512.\n\nUse the appropriate recipient for each message:\n",
      ),
      text,
    );
    assert.ok(text.includes("<|eot|><|start|>user<|message|>Review this function for off-by-one errors: ...<|eot|><|start|>assistant"));
    assert.ok(r.segments.some((s) => s.kind === "elided"), "the recipient lines are marked, not invented");
  });

  it("writes the numeric strength for each level", () => {
    const msgs: ConvMessage[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
    for (const [effort, n] of [["low", 8], ["medium", 32], ["high", 256], ["xhigh", 512]] as const) {
      assert.ok(plainText(renderTemplate(msgs, opts("spark", { effort })).segments).includes(`Reasoning strength: ${n}.`));
    }
  });

  it("leaves the strength to a system prompt that sets one", () => {
    const p = preset(SPARK_PRESETS, "strength-line");
    const r = renderTemplate(p.messages, opts("spark", { effort: "low" }));
    const text = plainText(r.segments);
    assert.equal((text.match(/Reasoning strength:/g) ?? []).length, 1);
    assert.ok(text.includes("Reasoning strength: 256."));
    assert.ok(r.issues.some((i) => /takes|leaves its own line out/.test(i.text)));
  });

  it("flags a strength line written with the level name", () => {
    const r = renderTemplate([{ role: "system", content: "Be brief.\n\nReasoning strength: high." }], opts("spark"));
    assert.ok(r.issues.some((i) => i.level === "warn" && /number/.test(i.text)));
  });

  it("renders the three parallel calls with <|eom|> between them and the results in call order", () => {
    const p = preset(SPARK_PRESETS, "tools");
    const r = renderTemplate(p.messages, opts("spark", { effort: p.effort, tools: [{ name: "get_weather" }] }));
    const text = plainText(r.segments);
    assert.ok(
      text.includes(
        '<|start|>assistant to=get_weather<|message|><atem:function_calls>\n<atem:invoke name="get_weather">\n<atem:parameter name="city">Paris</atem:parameter>\n</atem:invoke>\n</atem:function_calls><|eom|><|start|>assistant to=get_weather<|message|>',
      ),
    );
    assert.ok(text.includes('<atem:parameter name="city">Tokyo</atem:parameter>\n</atem:invoke>\n</atem:function_calls><|eot|><|start|>tool get_weather<|message|><tool_output name="get_weather">\nsunny\n</tool_output><|eot|>'));
    assert.equal((text.match(/<\|eom\|>/g) ?? []).length, 2);
    assert.ok(text.indexOf("sunny") < text.indexOf("rain") && text.indexOf("rain") < text.indexOf("cloudy"));
    assert.ok(r.issues.some((i) => /order of the calls/.test(i.text)));
  });

  it("writes the media placeholders in the order of the parts", () => {
    const p = preset(SPARK_PRESETS, "media");
    const text = plainText(renderTemplate(p.messages, opts("spark")).segments);
    assert.ok(text.includes("<|start|>user<|message|><|patch|><|video|><|audio|>Answer the question in the recording.<|eot|>"));
  });

  it("catches a tool result for a call nobody made, and calls left unanswered", () => {
    const r = renderTemplate(
      [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        { role: "assistant", toolCalls: [{ id: "a", name: "get_weather", arguments: { city: "Rome" } }] },
        { role: "tool", toolCallId: "b", content: "rain" },
      ],
      opts("spark", { tools: [{ name: "get_weather" }] }),
    );
    assert.ok(r.issues.some((i) => i.level === "error" && /tool_call_id/.test(i.text)));
    assert.ok(r.issues.some((i) => /no result yet/.test(i.text)));
  });

  it("counts special tokens exactly and the rest as an estimate", () => {
    const p = preset(SPARK_PRESETS, "system");
    const t = tallyTokens(renderTemplate(p.messages, opts("spark")).segments);
    // <|begin_of_text|>, then <|start|> <|message|> <|eot|> for system and user, then <|start|> for the generation prompt.
    assert.equal(t.special, 8);
    assert.ok(t.text > 30 && t.text < 120, String(t.text));
    assert.equal(t.elided, 1);
    assert.equal(estimateTextTokens("Hello, world."), 4);
  });

  it("writes the server request and the apply_chat_template call", () => {
    const p = preset(SPARK_PRESETS, "tools");
    const o = opts("spark", { effort: "low", tools: [{ name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object" } }] });
    const body = serverRequest(p.messages, o) as { reasoning_effort: string; messages: Array<{ tool_calls?: Array<{ function: { arguments: unknown } }> }> };
    assert.equal(body.reasoning_effort, "low");
    assert.equal(typeof body.messages[1].tool_calls?.[0].function.arguments, "string", "a server takes arguments as a JSON string");
    const code = snippetFor(p.messages, o);
    assert.ok(code.includes('reasoning_effort="low"') && code.includes("tools=tools"));
    assert.ok(code.includes('"arguments": {"city": "Paris"}'), "apply_chat_template takes arguments as a dictionary");
  });
});

describe("chat template: Muse Glimmer", () => {
  it("renders the page's example exactly", () => {
    const p = preset(GLIMMER_PRESETS, "system");
    const text = plainText(renderTemplate(p.messages, opts("glimmer", { effort: "high" })).segments);
    assert.equal(
      text,
      '<|begin_of_text|><|start|>system<|message|>You are a helpful assistant.\n\nReasoning strength: high.\n\n# Valid recipients: "self", "user".<|eot|><|start|>user<|message|>Explain speculative decoding in two sentences.<|eot|><|start|>assistant',
    );
  });

  it("writes the strength by name, replays reasoning as a to=self turn, and uses <|image|>", () => {
    const multi = preset(GLIMMER_PRESETS, "multi");
    const text = plainText(renderTemplate(multi.messages, opts("glimmer", { effort: "medium" })).segments);
    assert.ok(text.includes("Reasoning strength: medium."));
    assert.ok(text.includes("<|start|>assistant to=self<|message|>The user asks for France's capital. That is Paris.<|eom|><|start|>assistant to=user<|message|>The capital of France is Paris.<|eot|>"));
    const img = plainText(renderTemplate(preset(GLIMMER_PRESETS, "image").messages, opts("glimmer")).segments);
    assert.ok(img.includes("<|start|>user<|message|><|image|>What trend does this chart show?<|eot|>"));
  });

  it("refuses parallel calls and audio or video parts", () => {
    const r = renderTemplate(
      [
        { role: "user", parts: [{ type: "audio" }, { type: "text", text: "Weather in Paris and Rome?" }] },
        {
          role: "assistant",
          toolCalls: [
            { id: "1", name: "get_weather", arguments: { city: "Paris" } },
            { id: "2", name: "get_weather", arguments: { city: "Rome" } },
          ],
        },
      ],
      opts("glimmer", { tools: [{ name: "get_weather" }] }),
    );
    assert.ok(r.issues.some((i) => i.level === "error" && /one tool call per turn/.test(i.text)));
    assert.ok(r.issues.some((i) => i.level === "error" && /audio/.test(i.text)));
  });

  it("marks the default system line elided when there is no system prompt", () => {
    const r = renderTemplate(preset(GLIMMER_PRESETS, "no-system").messages, opts("glimmer", { effort: "low" }));
    assert.equal(r.segments.filter((s) => s.kind === "elided").length, 1);
    const body = serverRequest(preset(GLIMMER_PRESETS, "no-system").messages, opts("glimmer", { effort: "low" })) as { chat_template_kwargs: unknown };
    assert.deepEqual(body.chat_template_kwargs, { reasoning_strength: "low" });
    assert.ok(snippetFor(preset(GLIMMER_PRESETS, "image").messages, opts("glimmer")).includes("AutoProcessor"));
  });

  it("writes media parts the way the processor takes them, and the server's way in the request", () => {
    const glimmer = snippetFor(preset(GLIMMER_PRESETS, "image").messages, opts("glimmer"));
    assert.ok(glimmer.includes('{"type": "image", "url": "https://example.com/chart.png"}'), "the page's AutoProcessor example");
    assert.ok(!glimmer.includes("image_url"));
    const spark = snippetFor(preset(SPARK_PRESETS, "media").messages, opts("spark"));
    for (const kind of ["image", "video", "audio"]) assert.ok(spark.includes(`{"type": "${kind}", "url": `), kind);
    assert.ok(!/_url"/.test(spark), "no OpenAI server-style parts in the processor call");
    const server = JSON.stringify(serverRequest(preset(SPARK_PRESETS, "media").messages, opts("spark")));
    assert.ok(server.includes('"type":"image_url","image_url":{"url":"https://example.com/chart.png"}') && server.includes('"type":"audio_url"'), "the server request keeps the page's parts");
  });
});

describe("deploy builders", () => {
  it("reproduce the SGLang NVFP4 command from muse-spark-open/deploy", () => {
    const serve = defaultSparkPlan("sglang").steps.find((s) => s.title.startsWith("Start the server"))!.code;
    assert.equal(
      serve,
      [
        "sglang serve \\",
        "  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \\",
        "  --tp-size 4 \\",
        "  --ep-size 4 \\",
        "  --quantization modelopt_fp4 \\",
        "  --moe-runner-backend flashinfer_trtllm \\",
        "  --mem-fraction-static 0.8 \\",
        "  --host 0.0.0.0 \\",
        "  --port 30000 \\",
        "  --enable-layernorm-sp \\",
        "  --enable-megamoe-for-layernorm-sp \\",
        "  --speculative-algorithm DFLASH \\",
        "  --speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2 \\",
        "  --speculative-draft-attention-backend fa4 \\",
        "  --speculative-num-draft-tokens 8 \\",
        "  --mm-feature-transport cpu \\",
        "  --enable-hierarchical-cache \\",
        "  --hicache-size 200 \\",
        "  --reasoning-parser muse \\",
        "  --tool-call-parser muse",
      ].join("\n"),
    );
  });

  it("switch SGLang to BF16 and to disaggregated serving", () => {
    const r = sparkRuntime("sglang");
    const bf16 = r.build({ ...defaultsOf(r.options), checkpoint: "bf16", spec: false, hicache: false });
    const text = planText(bf16);
    assert.ok(text.includes("--tp-size 8 \\\n  --ep-size 8 \\\n  --dtype bfloat16 \\\n  --mem-fraction-static 0.85"));
    assert.ok(!text.includes("DFLASH") && !text.includes("hicache"));
    const pd = r.build({ ...defaultsOf(r.options), mode: "pd", pdHardware: "b300" });
    const pdText = planText(pd);
    assert.ok(pdText.includes("--disaggregation-mode prefill") && pdText.includes("--disaggregation-mode decode"));
    assert.ok(pdText.includes("CUDA_VISIBLE_DEVICES=4,5,6,7"));
    assert.ok(pdText.includes("--prefill http://127.0.0.1:30001 8998"));
    assert.equal(pd.client?.baseUrl, "http://127.0.0.1:8000/v1");
  });

  it("reproduce vLLM and TensorRT-LLM, and refuse a 16-bit KV cache on GB300", () => {
    const vllm = planText(defaultSparkPlan("vllm"));
    assert.ok(vllm.includes("export VLLM_USE_RUST_FRONTEND=1\n\nvllm serve meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \\\n    --tensor-parallel-size 4 \\\n    --enable-expert-parallel \\\n    --max-model-len 1048576"));
    const vr = sparkRuntime("vllm");
    const amd = vr.build({ ...defaultsOf(vr.options), vendor: "amd", checkpoint: "bf16" });
    assert.ok(planText(amd).includes("export VLLM_ROCM_USE_AITER=1") && planText(amd).includes("vllm/vllm-openai-rocm:muse-spark-open"));
    assert.equal(amd.client?.baseUrl, "http://127.0.0.1:8006/v1");
    assert.equal(vr.build({ ...defaultsOf(vr.options), vendor: "amd" }).errors.length, 1, "NVFP4 is NVIDIA's format");
    const trt = defaultSparkPlan("trtllm");
    assert.ok(planText(trt).includes("max_seq_len: 49152") && planText(trt).includes("  dtype: fp8"));
    assert.equal(trt.errors.length, 0);
    const r = sparkRuntime("trtllm");
    assert.equal(r.build({ ...defaultsOf(r.options), kvDtype: "auto" }).errors.length, 1);
    assert.equal(r.build({ ...defaultsOf(r.options), kvDtype: "auto", gpu: "b300" }).errors.length, 0);
  });

  it("give every runtime a plan, and the started server's client", () => {
    for (const r of [...SPARK_RUNTIMES, ...GLIMMER_RUNTIMES]) {
      const plan = r.build(defaultsOf(r.options));
      assert.ok(plan.steps.length > 0, r.id);
      for (const s of plan.steps) assert.equal(s.code.includes(EM_DASH), false, `${r.id}: ${s.title}`);
      for (const t of [...plan.notes, ...plan.warnings, ...plan.errors]) assert.equal(t.includes(EM_DASH), false, t);
    }
  });

  it("write client code that reaches the local server the page describes", () => {
    const llama = defaultSparkPlan("llamacpp");
    const code = clientCode(llama.client!, "What is 17 * 23?", false);
    assert.ok(code.python.includes('base_url="http://127.0.0.1:8080/v1"') && code.python.includes('os.environ["LLAMA_API_KEY"]'));
    assert.ok(code.curl.startsWith("curl -s --noproxy '*' http://127.0.0.1:8080/v1/chat/completions"));
    const sglang = clientCode(defaultSparkPlan("sglang").client!, "Briefly explain: what is SGLang?", true);
    assert.ok(sglang.python.includes("model = client.models.list().data[0].id"));
    assert.ok(sglang.python.includes('reasoning_effort="high"') && sglang.python.includes("stream=True"));
    assert.ok(sglang.typescript.includes("const model: string = (await listed.json()).data[0].id;"));
    const unsloth = clientCode(defaultSparkPlan("unsloth").client!, "Explain mixture-of-experts models in three sentences.", false);
    assert.ok(unsloth.python.includes('extra_body={') && unsloth.python.includes('"min_p": 0.0'));
    assert.ok(unsloth.curl.includes('\\"model\\": \\"$UNSLOTH_MODEL_ID\\"'));
  });

  it("reproduce Muse Glimmer's vLLM, SGLang and llama.cpp commands, with the troubleshooting rules", () => {
    assert.ok(planText(defaultGlimmerPlan("vllm")).includes("vllm/vllm-openai:muse-glimmer \\\n  meta-models/Muse-Glimmer-30B \\\n  --served-model-name muse-glimmer \\\n  --tensor-parallel-size 1 \\\n  --enable-auto-tool-choice"));
    const sg = glimmerRuntime("sglang");
    const nvfp4 = planText(sg.build({ ...defaultsOf(sg.options), format: "nvfp4", dflash: true }));
    assert.ok(nvfp4.includes("--language-model-only \\\n  --kv-cache-dtype fp8_e4m3"));
    assert.ok(nvfp4.includes("--speculative-draft-model-quantization fp8"));
    const gguf = planText(sg.build({ ...defaultsOf(sg.options), format: "gguf", dflash: true, languageOnly: true }));
    assert.ok(!gguf.includes("--language-model-only"), "SGLang rejects it on GGUF");
    assert.ok(gguf.includes("--speculative-draft-load-format auto"));
    assert.equal(sglangMemFraction("bf16", "dgx", false), 0.75);
    assert.equal(sglangMemFraction("nvfp4", "dgx", true), 0.38);
    assert.equal(sglangMemFraction("nvfp4", "rtx5090", false), 0.9);
    const llama = glimmerRuntime("llamacpp");
    const slots = llama.build({ ...defaultsOf(llama.options), np: 4 });
    assert.ok(slots.warnings.some((w) => /32,768-token slot/.test(w)), "131,072 over 4 slots is 32,768 each");
    assert.ok(planText(slots).includes("n_ctx_slot = 32768"));
    const draft = llama.build({ ...defaultsOf(llama.options), dflash: true });
    const titles = draft.steps.map((x) => x.title);
    assert.ok(titles.indexOf("Download the DFlash draft") >= 0 && titles.indexOf("Download the DFlash draft") < titles.indexOf("Start the server"));
    assert.equal(draft.steps.find((x) => x.title === "Download the DFlash draft")?.code, ggufDraftDownload());
  });

  it("name prebuilt ExecuTorch exports the way the repository does", () => {
    const ex = glimmerRuntime("executorch");
    const plan = ex.build({ ...defaultsOf(ex.options), modality: "text-image", decoding: "dflash", backend: "mlx", quant: "k-quant-dynamic" });
    const text = planText(plan);
    assert.ok(text.includes("EXPORT_DIR=muse-glimmer-k-quant-dynamic-128K-text-image-dflash-metal"));
    assert.ok(!text.includes("--data-path"), "metal exports have no .ptd");
    assert.ok(text.includes('--pos-embed-path "exports/$EXPORT_DIR/pos_embed.bin"'));
    assert.ok(plan.steps[0].title.includes("23.8 GB"));
  });
});

describe("downloads", () => {
  it("write the Hugging Face commands and the page's shard counts", () => {
    const p = sparkDownload({ checkpoint: "nvfp4", source: "hf", folder: "./muse-spark-open-nvfp4", verify: "count" });
    const text = p.steps.map((s) => s.code).join("\n");
    assert.ok(text.includes("hf download meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --local-dir ./muse-spark-open-nvfp4"));
    assert.ok(text.includes("the page lists 127"));
    const meta = sparkDownload({ checkpoint: "bf16", source: "meta", folder: "./muse-spark-open", verify: "sha256" });
    assert.ok(meta.steps.some((s) => s.note?.includes("65 weight shards")));
    assert.ok(meta.steps.some((s) => s.code.includes("files_metadata=True") && s.code.includes("f.lfs.sha256")));
    // A Meta download holds what Meta's list has, not the Hub's README.md or .gitattributes: check only those files.
    const metaCheck = meta.steps.find((s) => s.code.includes("files_metadata=True"))!.code;
    assert.ok(metaCheck.includes(`patterns = ${JSON.stringify(META_DOWNLOAD_FILES)}`) && metaCheck.includes("fnmatch.fnmatch"));
    assert.ok(["*.safetensors", "LICENSE.md"].every((x) => META_DOWNLOAD_FILES.includes(x)));
    const hfCheck = sparkDownload({ checkpoint: "bf16", source: "hf", folder: "./muse-spark-open", verify: "sha256" }).steps.find((s) => s.code.includes("files_metadata=True"))!.code;
    assert.ok(hfCheck.includes("files = info.siblings"), "hf download fetches every file, so every one is checked");
  });
  it("fetch only the GGUF files picked, and one ExecuTorch export", () => {
    const p = glimmerDownload({ items: ["kquant17", "mmproj", "pte"], pte: { quant: "k-quant-17G", modality: "text", decoding: "solo", backend: "sm80+ptx" }, verify: true });
    const text = p.steps.map((s) => s.code).join("\n");
    assert.ok(text.includes('--include "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf" \\\n  --include "mmproj-Muse-Glimmer-30B-Q4_K_M.gguf"'));
    assert.ok(text.includes("EXPORT_DIR=muse-glimmer-k-quant-17G-128K-text-solo-sm80+ptx"));
    assert.ok(p.warnings.some((w) => /372 GB/.test(w)));
    assert.equal(Math.round((p.totalGb ?? 0) * 10) / 10, 16.8 + 1.4 + 19.8);
  });
});

describe("settings, hardware and quantization numbers", () => {
  it("work out the KV cache from 16 full-attention layers of 62", () => {
    assert.ok(Math.abs(kvShareOfDense(1_048_576) - 0.2595) < 0.001);
    assert.ok(kvGrowth(32768, 1_048_576) > 27 && kvGrowth(32768, 1_048_576) < 28);
  });
  it("check stop lists", () => {
    assert.deepEqual(checkStops("[200001, 200008]").checks.map((c) => c.level), ["ok", "ok"]);
    const bad = checkStops("<|eot|>, <|eom|>");
    assert.equal(bad.checks[0].level, "error");
    assert.ok(bad.checks.some((c) => c.level === "warn" && /200001/.test(c.text)));
    assert.deepEqual(checkStops('{"eos_token_id": [200001, 200008]}').ids, [200001, 200008]);
  });
  it("split the checkpoints across GPUs and Macs", () => {
    assert.ok(sparkFit("nvfp4", 4).fits && Math.round(sparkFit("nvfp4", 4).perGpuGb) === 134);
    assert.equal(sparkFit("bf16", 4).fits, false);
    assert.equal(sparkFit("bf16", 8).expertsPerGpu, 32);
    assert.deepEqual(macShare(4), { perMacGb: 134.25, memGb: 256, percent: 52 });
    assert.ok(amdCommand("mxfp4-latency").includes("VLLM_KV_CACHE_LAYOUT=LBHNC") && amdCommand("bf16").includes("--max-num-batched-tokens 4096 --gpu-memory-utilization 0.95"));
    assert.ok(aiperfCommand([1, 2]).includes("--concurrency '1,2'") && aiperfCommand([1, 2]).includes("--request-count '10,20'"));
  });
  it("describe the layout the Spark command uses, at the page's own context", () => {
    const eight = sparkLayout("nvfp4", 8, "sglang");
    assert.equal(eight.used, 4);
    assert.equal(eight.spare, 4);
    assert.equal(eight.expertsPerGpu, 64);
    assert.equal(Math.round(eight.fit.perGpuGb), 134);
    const sglang = sparkNvidiaCommand("sglang", "nvfp4", "b300", PAGE_CTX.sglang);
    assert.ok(sglang.includes("--tp-size 4") && sglang.includes("--ep-size 4"), "the numbers and the command agree on TP4/EP4");
    assert.ok(!sglang.includes("--context-length"), "the page's SGLang command leaves the context to the server");
    assert.equal(sglang, defaultSparkPlan("sglang").steps.find((x) => x.title.startsWith("Start the server"))!.code);
    const vllm = sparkNvidiaCommand("vllm", "nvfp4", "b300", PAGE_CTX.vllm);
    assert.ok(vllm.includes("--max-model-len 1048576") && vllm.includes("--tensor-parallel-size 4"));
    assert.ok(sparkNvidiaCommand("trtllm", "nvfp4", "gb300", PAGE_CTX.trtllm).includes("max_seq_len: 49152"));
    assert.ok(sparkNvidiaCommand("sglang", "nvfp4", "b300", 131072).includes("--context-length 131072"));
    const small = sparkLayout("bf16", 4, "vllm");
    assert.equal(small.fit.fits, false, "BF16 needs 8 GPUs");
    assert.equal(small.expertsPerGpu, 32, "the command's TP8/EP8");
    assert.equal(sparkLayout("bf16", 8, "trtllm").layout.id, "nvfp4", "TensorRT-LLM's validated configuration is NVFP4");
  });

  it("match the quantization page's 19.0 GiB budget and pick the file the page recommends", () => {
    const b = ggufBudget({ file: "kquant17", vision: true, dflash: false, ctx: 131072 });
    assert.equal(Math.round(b.totalGib * 10) / 10, 19);
    assert.equal(pickGguf(24, { vision: true, dflash: false, ctx: 131072 }).file, "kquant17");
    assert.equal(pickGguf(32, { vision: true, dflash: true, ctx: 131072 }).file, "dynamic");
    assert.equal(pickGguf(16, { vision: true, dflash: false, ctx: 131072 }).file, null);
    assert.ok(maxContextFor(18, { file: "kquant17", vision: false, dflash: false }) > 8192);
    assert.equal(ggufServe({ file: "kquant17", vision: true, dflash: false, ctx: 131072, np: 1, port: 8080 }), "llama serve -hf meta-models/Muse-Glimmer-30B-GGUF \\\n  --hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \\\n  --port 8080");
    assert.ok(quantizeYourself("Q3_K_M").includes("muse-glimmer-30b-q3_k_m.gguf \\\n  Q3_K_M"));
    assert.equal(ggufDraftDownload(), 'hf download meta-models/Muse-Glimmer-30B-GGUF --local-dir . \\\n  --include "dflash-Muse-Glimmer-30B-Q4_K_M.gguf"');
    const fits = glimmerFits(24);
    assert.equal(fits.find((f) => f.format === "bf16")?.fits, false);
    assert.equal(fits.find((f) => f.format === "kquant17")?.fits, true);
    const on = (id: string) => {
      const p = GLIMMER_PLATFORMS.find((x) => x.id === id)!;
      return Object.fromEntries(glimmerFits(p.memoryGb, true, p).map((f) => [f.format, f.fits]));
    };
    assert.equal(on("arc").bf16, true, "Intel verified bf16 on two 32 GB Arc cards, under vLLM's 72 GB budget");
    assert.equal(on("b300").mlx, false, "MLX is Apple silicon only");
    assert.equal(on("apple").bf16, false);
    assert.equal(on("apple").mlx, true);
    assert.equal(on("h200").nvfp4, false, "SGLang doesn't list NVFP4 for H200");
    assert.equal(on("rtx5090").nvfp4, true);
  });
});

describe("rewards", () => {
  it("read the last \\boxed{} answer, braces and all", () => {
    assert.equal(lastBoxed("first \\boxed{1} then \\boxed{\\frac{1}{2}}"), "\\frac{1}{2}");
    assert.equal(lastBoxed("none"), null);
    assert.equal(rewardBoxed("Answer: \\boxed{391}", "391").reward, 1);
    assert.equal(rewardBoxed("Answer: \\boxed{390}", "391").reward, 0);
    assert.ok(sameAnswer("$1,024$", "1024") && sameAnswer("\\frac{1}{2}", "0.5"));
    assert.equal(rewardExact("4", " 4 ").reward, 1);
  });
  it("grade the data-analyst tiers and the group advantages", () => {
    assert.equal(rewardAnalyst("wrongNumber", 2).reward, 0.15);
    const g = grpoAdvantages([1, 0, 1, 0]);
    assert.equal(g.mean, 0.5);
    assert.ok(Math.abs(g.advantages[0] - 1) < 1e-4 && Math.abs(g.advantages[1] + 1) < 1e-4);
    assert.equal(grpoAdvantages([1, 1, 1, 1]).noSignal, true);
  });
  it("say when a group's spread is only truncation", () => {
    const cut = (reward: number) => ({ reward, finish: "length" });
    const done = (reward: number) => ({ reward, finish: "stop" });
    assert.equal(readGroup([done(1), cut(0), done(1), cut(0)]).kind, "truncation");
    const mixed = readGroup([done(1), done(0), done(1), cut(0)]);
    assert.equal(mixed.kind, "mixed");
    assert.equal(mixed.truncatedLow, 1);
    assert.equal(mixed.low, 2);
    assert.equal(readGroup([done(1), done(1)]).kind, "noSignal");
    assert.equal(readGroup([cut(0), cut(0)]).allTruncated, true);
  });
  it("default the live group to a budget the rollouts finish in, and label the tight one as truncation", () => {
    assert.equal(MATH_PROBLEMS[0].id, "room");
    assert.ok(MATH_PROBLEMS[0].budget >= 2000);
    const tight = MATH_PROBLEMS.find((x) => x.id === "tight")!;
    assert.match(tight.label, /truncation/);
    for (const label of Object.values(SCHEME_LABEL)) assert.ok(label.length <= 24, `${label}: one pill on a 390 px phone`);
  });
});

describe("dataset checks", () => {
  it("pass the pages' rows and catch the broken ones", () => {
    const tt = checkDataset(SAMPLE_ROWS["torchtitan-sft"], "torchtitan-sft");
    assert.equal(tt.valid, 3);
    assert.ok(tt.rows[3].errors.some((e) => /WAV/.test(e)) && tt.rows[3].errors.some((e) => /assistant/.test(e)));
    const chat = checkDataset(SAMPLE_ROWS.chat, "chat");
    assert.equal(chat.invalid, 1);
    const ax = checkDataset(SAMPLE_ROWS.axolotl, "axolotl");
    assert.ok(ax.rows[2].warnings.some((w) => /first image/.test(w)) && ax.rows[2].warnings.some((w) => /before the question/.test(w)));
    assert.equal(checkDataset(SAMPLE_ROWS.dpo, "dpo").invalid, 1);
    assert.equal(checkDataset(SAMPLE_ROWS["miles-vlm"], "miles-vlm").invalid, 1);
    assert.equal(checkDataset(SAMPLE_ROWS["fireworks-rl"], "fireworks-rl").invalid, 1);
    assert.ok(checkDataset(SAMPLE_ROWS["miles-math"], "miles-math").rows[2].errors.some((e) => /label/.test(e)));
    assert.ok(checkDataset("{nope", "chat").rows[0].errors[0].startsWith("Not valid JSON"));
  });
});

describe("training builders", () => {
  it("write TRL's sharding and the page's tokens per step", () => {
    const p = sparkTrl(SPARK_TRL_DEFAULTS);
    assert.ok(p.steps[1].code.includes("DistributedConfig(fsdp_size=64, ep_size=8)"));
    assert.ok(p.summary.includes("131,072 tokens per step"));
    assert.equal(sparkTrl({ ...SPARK_TRL_DEFAULTS, epSize: 3 }).errors.length, 1);
    const launch = sparkTrlLaunch();
    assert.ok(launch.startsWith("#!/bin/bash\n#SBATCH --nodes=8\n#SBATCH --gres=gpu:8\n#SBATCH --ntasks-per-node=1\n#SBATCH --mem=0\n"));
    assert.ok(launch.includes("MASTER_IP=$(getent ahostsv4"));
    assert.equal(p.steps[2].code, launch, "the builder and the copy prompt print the same script");
    assert.equal(POST_TRAINING.cards.find((c) => c.id === "trl-spark")?.command, launch, "and so does the cookbook card");
  });
  it("validate Fireworks names and Miles saves", () => {
    assert.equal(fireworksPlan({ rank: 128, outputModelId: "Bad_Name", samplerName: "a-very-long-sampler-name" }).errors.length, 3);
    const m = milesPlan({ ...MILES_DEFAULTS, saveInterval: 10 });
    assert.ok(m.steps.some((s) => s.code.includes("iter_0000009")));
  });
  it("check Muse Glimmer's guidance ranges and memory", () => {
    assert.equal(glimmerTrl(GLIMMER_TRL_DEFAULTS.lora).warnings.length, 0);
    assert.ok(glimmerTrl({ ...GLIMMER_TRL_DEFAULTS.lora, lr: 1e-3 }).warnings.length > 0);
    assert.deepEqual(fullParamMemory(8), { weights: 7.5, grads: 7.5, adam: 30, total: 45 });
    assert.equal(titanRlPlan({ ...TITANRL_DEFAULTS, generatorTp: 4 }).errors.length, 1);
  });
  it("mark which tokens train in the SFT recipe, and count media placeholders", () => {
    const seg = lossMask(MASK_PRESETS[0].messages);
    assert.equal(seg.filter((s) => s.trained).map((s) => s.text).join(""), " to=user<|message|>4<|eot|>");
    assert.equal(imagePatchTokens(448, 448), 256);
    assert.equal(audioTokens(2), 25);
    assert.ok(sftPlan(SFT_DEFAULTS).steps.some((s) => s.code.includes("NGPU=1 MODULE=sft CONFIG=muse_spark_debugmodel_sft ./run_train.sh")));
    assert.ok(sftPlan(SFT_DEFAULTS).steps.some((s) => s.code.includes("lr=1e-5")));
    // At the page's values the full run is sft.py's shipped config; with another lr, the reader's own function runs.
    const shipped = sftPlan({ ...SFT_DEFAULTS, run: "full" });
    assert.ok(shipped.steps.some((s) => s.code.includes('export MUSE_SPARK_SFT_DATA="/data/dolly/train.jsonl"\nMODULE=sft CONFIG=muse_spark_816b_a42b_sft ./run_train.sh')));
    assert.equal(sftIsCustom({ ...SFT_DEFAULTS, lr: 2e-5 }), true);
    assert.equal(sftIsCustom({ ...SFT_DEFAULTS, modality: "media", effort: "low" }), false, "the media recipe has no effort knob");
    const own = sftPlan({ ...SFT_DEFAULTS, run: "full", lr: 2e-5 });
    assert.equal(own.steps[own.steps.length - 1].code, "MODULE=my_sft CONFIG=my_text_sft ./run_train.sh");
    assert.ok(own.steps.some((s) => s.code.includes("# my_sft.py") && s.code.includes("lr=2e-5")));
    const media = sftPlan({ ...SFT_DEFAULTS, modality: "media", run: "full", lr: 3e-5 });
    assert.equal(media.steps[media.steps.length - 1].code, "MODULE=my_sft CONFIG=my_media_sft ./run_train.sh");
    const smoke = sftPlan({ ...SFT_DEFAULTS, lr: 2e-5 }).steps.find((s) => s.title.startsWith("Smoke run"))!;
    assert.ok(smoke.code.includes("CONFIG=muse_spark_debugmodel_sft"));
    assert.match(smoke.note ?? "", /doesn't use your JSONL files or the lr, current_date and reasoning_effort above/);
    assert.equal(sciNum(1.25e-6), "1.25e-6");
    assert.ok(rlPlan({ ...RL_DEFAULTS, run: "longer" }).steps.some((s) => s.code.includes("num_training_steps=150")));
  });
});

describe("Mac planner, picker and recipe browser", () => {
  it("plan four Macs with a direct link between every pair", () => {
    const p = macPlan(MAC_DEFAULTS);
    assert.equal(p.pairs.length, 6);
    assert.equal(p.cables, 12);
    assert.equal(p.portsPerMac, 6);
    assert.equal(p.shareGb, 134.25);
    assert.ok(p.steps[0].code.includes("ssh mac-studio-4.local 'echo ok'"));
    assert.equal(macPlan({ ...MAC_DEFAULTS, macs: 2, hosts: ["a.local", "a.local"] }).warnings.length, 1);
  });
  it("recommend from the hardware and the needs", () => {
    const none = { audioVideo: false, images: false, longContext: false, apache: false };
    assert.equal(recommend("gpu24", none).pick, "glimmer");
    assert.equal(recommend("blackwell4", none).pick, "spark");
    assert.equal(recommend("blackwell4", { ...none, apache: true }).pick, "glimmer");
    assert.equal(recommend("gpu24", { ...none, audioVideo: true }).pick, "neither");
    assert.equal(recommend("macs", { ...none, audioVideo: true }).pick, "spark");
    // Without GPUs, the pick is never a model its own verdict rules out.
    assert.equal(recommend("none", { ...none, audioVideo: true, apache: true }).pick, "neither");
    assert.equal(recommend("none", { ...none, apache: true }).pick, "glimmer");
    assert.equal(recommend("none", { ...none, audioVideo: true }).pick, "spark");
    assert.equal(recommend("none", none).pick, "glimmer");
  });
  it("hand over the AMD command with the variables it expands", () => {
    const amd = recommend("amd8", { audioVideo: false, images: false, longContext: false, apache: false }).spark.command!;
    assert.equal(amd, amdCommand("mxfp4"));
    assert.ok(amd.startsWith("export VLLM_ROCM_USE_AITER=1\n"));
    assert.ok(amd.indexOf('COMMON_ARGS="') < amd.indexOf("$COMMON_ARGS") && amd.indexOf("CG='") < amd.indexOf("$CG"), "defined before use");
  });
  it("filter the cookbook cards", () => {
    assert.ok(filterCards(RUN_LOCALLY, "mac").every((c) => c.tags.includes("mac")));
    assert.equal(filterCards(POST_TRAINING, "all").filter((c) => c.inSection).length, 2);
    assert.equal(filterCards(POST_TRAINING, "rl", "Muse Glimmer").length, 2);
  });
});
