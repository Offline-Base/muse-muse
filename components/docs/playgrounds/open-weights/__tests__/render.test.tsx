/**
 * The open-weight pages' DemoSpecs as the docs page mounts them: every slug in the group has one, its props survive
 * the trip from server to client (plain JSON), its component server-renders the controls it shows before anything
 * runs (with the Contributor notice where a live stand-in opens first), and its copy-prompt text fits the 4,000
 * characters with the page's task and starter code intact. The CSS module is the only stand-in (a load hook makes
 * every class name itself). Nothing reaches the network: effects don't run in a server render.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/open-weights/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const EM_DASH = String.fromCharCode(0x2014);
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/open-weights").openWeightsDemos;
let NO_META_KEY: string;
let prompt: typeof import("@/lib/docs/agent-prompt");
let pages: typeof import("@/lib/docs/pages");

function clean(out: string): string {
  assert.equal(out.includes(EM_DASH), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

/** The group's slugs as lib/docs/demos/index.ts lists them, read as text so other groups' files aren't loaded. */
function groupSlugs(): string[] {
  const src = readFileSync("lib/docs/demos/index.ts", "utf8");
  const block = /"open-weights": \[([\s\S]*?)\]/.exec(src);
  assert.ok(block, "the open-weights group in DEMO_GROUPS");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const el = <P extends object>(c: ComponentType<P>, props: P) => createElement(c as ComponentType<object>, props);

/** The visible text, for matching code that the syntax colors split into spans. Entities stay encoded, as in the markup. */
function visible(out: string): string {
  return out.replace(/<[^>]+>/g, "");
}

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (e) => clean(renderToString(e).replace(/<!-- -->/g, ""));
  const mod = await import("@/lib/docs/demos/open-weights");
  demos = mod.openWeightsDemos;
  NO_META_KEY = mod.NO_META_KEY;
  prompt = await import("@/lib/docs/agent-prompt");
  pages = await import("@/lib/docs/pages");
});

/** What each page's demo shows before anything runs. */
const MARKERS: Record<string, RegExp[]> = {
  "open-weight-models": [/What will you run it on\?/, /Start with Muse Glimmer/, /Muse-Glimmer-30B-KQuant-17GB-Q4_K_M\.gguf/],
  "muse-spark-open": [/Which checkpoint\? What do you have\?/, /Fits: NVFP4 on one 4-GPU node/, /hf download meta-models\/Muse-Spark-Open-816B-A42B-NVFP4/],
  "muse-spark-open/get-the-model": [/127/, /hf download meta-models\/Muse-Spark-Open-816B-A42B-NVFP4 --local-dir \.\/muse-spark-open-nvfp4/, /transformers 5\.19/],
  "muse-spark-open/prompting": [/What the model sees/, /Reasoning strength: 512\./, /Knowledge cutoff: 2026-01-04\./, /Try it on hosted Muse Spark/],
  "muse-spark-open/settings": [/Config generator/, /--context-length 131072/, /Compare strengths live/],
  "muse-spark-open/deploy": [/Runtime/, /--speculative-draft-model-path RadixArk\/Muse-Spark-Open-DFlash2/, /Try the request/],
  "muse-spark-open/hardware-platforms": [/GB300 NVL \(SM103\)/, /about 134 GB of weights per GPU/],
  "muse-spark-open/post-training": [/DistributedConfig\(fsdp_size=64, ep_size=8\)/, /131,072 tokens per step/],
  "muse-glimmer": [/Which checkpoint\? What will you serve it with\?/, /Muse-Glimmer-30B-GGUF/],
  "muse-glimmer/get-the-model": [/--include &quot;Muse-Glimmer-30B-KQuant-17GB-Q4_K_M\.gguf&quot;/, /transformers 5\.15/],
  "muse-glimmer/prompting": [/# Valid recipients: &quot;self&quot;, &quot;user&quot;\./, /Reasoning strength: high\./],
  "muse-glimmer/quantization": [/K-Quant-17GB fits/, /19 GiB/, /--hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M\.gguf/],
  "muse-glimmer/spec-decode": [/-md dflash-Muse-Glimmer-30B-Q4_K_M\.gguf --spec-type draft-dflash \\\n\s+-ngld 99 --spec-draft-n-max 4/],
  "muse-glimmer/deploy": [/vllm\/vllm-openai:muse-glimmer/, /--reasoning-parser muse_glimmer/],
  "muse-glimmer/hardware-platforms": [/Platforms and fit/, /288 GB HBM3e per GPU/, /B300 throughput/],
  "muse-glimmer/post-training": [/muse-glimmer-30b-qlora\.yaml/, /sample_packing: false/],
  "cookbook/run-locally": [/Muse Spark Open on Mac/, /Related guides on the model pages/],
  "cookbook/post-training": [/RL with TorchTitan/, /SFT with TorchTitan/],
  "cookbook/muse-spark-open-mac": [/6 Thunderbolt 5 links and 12 cables/, /ssh mac-studio-4\.local &#x27;echo ok&#x27;/, /About 134\.3 GB of weights of 256 GB/],
  "cookbook/muse-spark-open-torchtitan-rl": [/Score a group live/, /Room to finish: no signal/, /Too small a budget: truncation/, NOTICE],
  "cookbook/muse-spark-open-torchtitan-sft": [/NGPU=1 MODULE=sft CONFIG=muse_spark_debugmodel_sft \.\/run_train\.sh/, /lr=1e-5/],
};

describe("open-weights DemoSpecs", () => {
  it("cover every slug in the group, and only those", () => {
    assert.deepEqual(Object.keys(demos).sort(), groupSlugs().sort());
  });

  it("pass props that are plain JSON", () => {
    for (const [slug, spec] of Object.entries(demos)) {
      assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, slug);
    }
  });

  it("have titles and blurbs with no em dash", () => {
    for (const [slug, spec] of Object.entries(demos)) {
      assert.ok(spec.title.length > 10, slug);
      assert.ok(spec.blurb && spec.blurb.length > 20, slug);
      for (const text of [spec.title, spec.blurb ?? "", spec.agentPrompt.task, ...(spec.agentPrompt.facts ?? []), ...(spec.agentPrompt.checklist ?? []), ...Object.values(spec.agentPrompt.snippets ?? {})]) {
        assert.equal(text.includes(EM_DASH), false, `${slug}: ${text.slice(0, 60)}`);
      }
      assert.doesNotMatch(JSON.stringify(spec.agentPrompt.snippets), /"muse-spark-1\.3"/, `${slug}: snippets use the Contributor id or no Model API model`);
    }
  });

  for (const slug of Object.keys(MARKERS)) {
    it(`renders ${slug}`, () => {
      const spec = demos[slug];
      assert.ok(spec, slug);
      const out = html(el(spec.Component, { ...spec.props, slug }));
      const text = visible(out);
      for (const m of MARKERS[slug]) assert.ok(m.test(out) || m.test(text), `${slug}: ${m}`);
    });
  }
});

describe("what the demos print", () => {
  it("download the overview's checkpoint into the cache the serve command reads, not a second copy", () => {
    const spec = demos["muse-spark-open"];
    const text = visible(html(el(spec.Component, { ...spec.props, slug: "muse-spark-open" })));
    assert.ok(text.includes("hf download meta-models/Muse-Spark-Open-816B-A42B-NVFP4") && text.includes("This fills the Hugging Face cache"));
    assert.ok(!text.includes("--local-dir"), "the serve command names the repository, so a --local-dir copy would download twice");
    assert.ok(text.includes("--model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4"));
    const glimmer = demos["muse-glimmer"];
    const g = visible(html(el(glimmer.Component, { ...glimmer.props, slug: "muse-glimmer" })));
    assert.ok(g.includes("Download (optional)") && g.includes("llama serve -hf fetches the text model"), "llama.cpp's download is optional");
  });

  it("write snippets that run as they are", () => {
    const post = demos["muse-spark-open/post-training"].agentPrompt.snippets!.curl!;
    assert.ok(post.startsWith("#!/bin/bash\n"), "sbatch needs the shebang");
    for (const line of ["#SBATCH --ntasks-per-node=1", "#SBATCH --mem=0", 'MASTER=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -1)', "MASTER_IP=$(getent ahostsv4", '--rdzv_endpoint "$MASTER_IP:29700"']) {
      assert.ok(post.includes(line), line);
    }
    const spec = demos["muse-glimmer/spec-decode"].agentPrompt.snippets!.curl!;
    assert.ok(spec.indexOf('--include "dflash-Muse-Glimmer-30B-Q4_K_M.gguf"') >= 0 && spec.indexOf('--include "dflash-') < spec.indexOf("-md dflash-"), "the draft is downloaded before -md uses it");
    const aiperf = demos["muse-glimmer/hardware-platforms"].agentPrompt.snippets!.curl!;
    for (const flag of ["--num-prefix-prompts 1 --prefix-prompt-length 32768", "--num-dataset-entries 10240", "--use-server-token-count", "--extra-inputs 'ignore_eos:true'", "--concurrency '1,8,64'"]) {
      assert.ok(aiperf.includes(flag), flag);
    }
    const sha = demos["muse-spark-open/get-the-model"].agentPrompt.snippets!.python!;
    assert.ok(!sha.includes("read_bytes"), "a BF16 shard is about 25 GB: hash it in chunks");
    assert.ok(sha.includes('iter(lambda: fh.read(1 << 24), b"")'));
    const quant = demos["muse-glimmer/quantization"].agentPrompt.snippets!.python!;
    assert.ok(quant.includes("total_gib >= 31") && !quant.includes("free"), "a 32 GB card reports about 31.8 GiB");
    const sft = demos["cookbook/muse-spark-open-torchtitan-sft"].agentPrompt;
    assert.ok(sft.snippets!.curl!.includes("MODULE=my_sft CONFIG=my_text_sft ./run_train.sh"), "the full run calls the recipe function the task adds");
  });
});

describe("copy prompts", () => {
  it("open their facts with the self-hosting note, which no trimming drops", () => {
    const ran = {
      method: "POST" as const,
      path: "chat/completions",
      model: "muse-spark-1.3-contributor",
      status: 200,
      body: {
        model: "muse-spark-1.3-contributor",
        messages: [
          { role: "system", content: "You are a code reviewer. Flag correctness bugs before style issues." },
          { role: "user", content: "What's the weather in Paris, Rome, and Tokyo? Use the tool for each city, then summarize in one line." },
        ],
        tools: [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
        reasoning_effort: "low",
        max_tokens: 1500,
        stream: true,
        stream_options: { include_usage: true },
      },
      outcome: "tool_calls: get_weather({\"city\":\"Paris\"}), get_weather({\"city\":\"Rome\"}), get_weather({\"city\":\"Tokyo\"})",
    };
    for (const [slug, spec] of Object.entries(demos)) {
      assert.equal(spec.agentPrompt.facts?.[0], NO_META_KEY, slug);
      const page = pages.docsPage(slug)!;
      for (const language of ["python", "typescript", "curl"] as const) {
        for (const lastRequest of [null, ran]) {
          const text = prompt.buildAgentPrompt({ page, spec: spec.agentPrompt, agent: "claude-code", language, lastRequest });
          assert.ok(text.includes(NO_META_KEY), `${slug} ${language}${lastRequest ? " with a last request" : ""}`);
          assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language}: ${text.length}`);
        }
        const plain = prompt.buildAgentPrompt({ page, spec: spec.agentPrompt, agent: "claude-code", language, lastRequest: null });
        assert.ok(!plain.includes("(trimmed)"), `${slug} ${language}: nothing trimmed without a last request`);
      }
    }
  });

  it("fit 4,000 characters in every agent and language, with the task, the page's Markdown and the starter code", () => {
    for (const [slug, spec] of Object.entries(demos)) {
      const page = pages.docsPage(slug);
      assert.ok(page, slug);
      for (const agent of ["claude-code", "codex", "other"] as const) {
        for (const language of ["python", "typescript", "curl"] as const) {
          const text = prompt.buildAgentPrompt({ page, spec: spec.agentPrompt, agent, language, lastRequest: null });
          assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language}: ${text.length}`);
          assert.equal(text.includes(EM_DASH), false);
          assert.ok(text.includes(page.markdownUrl), `${slug}: Markdown URL`);
          assert.ok(text.includes(spec.agentPrompt.task.slice(0, 80)), `${slug}: task`);
          const first = (spec.agentPrompt.snippets?.[language] ?? "").split("\n")[0];
          if (first) assert.ok(text.includes(first), `${slug} ${language}: starter code`);
        }
      }
    }
  });
});
