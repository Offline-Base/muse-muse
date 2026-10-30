# Open-weight demos

The demos for the 21 open-weight pages (`lib/docs/demos/open-weights.ts`): Muse Spark Open, Muse Glimmer, and the cookbook's run-locally and post-training recipes. These models run on the reader's own hardware, so most demos are builders, calculators and labs made from the pages' own numbers; where a request helps, a clearly labeled stand-in sends it to hosted Muse Spark through the docs proxy (`StandIn`). Every component is a client component with plain JSON props, built on the kit (`components/docs/kit`, `kit.css` classes) plus `ow.module.css`.

## Components

| Component | Props | Pages | What it does |
|---|---|---|---|
| `OpenWeightPicker` | `hardware?` (`"gpu24"`, `"blackwell4"`, ...) | open-weight-models | Hardware and needs in, a verdict per model with checkpoint, runtime and first command out |
| `ModelOverview` | `model: "spark" \| "glimmer"` | muse-spark-open, muse-glimmer | Quick facts and a "which checkpoint" chooser (by hardware for Spark Open, by runtime for Glimmer) |
| `DownloadBuilder` | `model` | both get-the-model pages | Download commands per checkpoint or build, a disk check, shard-count or SHA-256 verification against the Hub, the tokenizer check |
| `ChatTemplateLab` | `model`, `start?` (a preset id) | both prompting pages | Conversation editor, the documented chat template with special tokens and a token count, the issues the page warns about, the server request and the apply_chat_template call; a stand-in tab that can feed tool calls back in |
| `SettingsLab` | none | muse-spark-open/settings | Serve and request settings, KV growth by context, a live side-by-side of two reasoning levels, a stop-token checker |
| `DeployBuilder` | `model` | both deploy pages | Every runtime on the page as options to commands (`deploy-spark.ts`, `deploy-glimmer.ts`), the troubleshooting checks, client code for the started server, and a stand-in run |
| `HardwarePlanner` | `model` | both hardware-platforms pages | Per-GPU weight shares and sample commands (Spark Open), platform specs, what fits, the B300 sweep and troubleshooting (Glimmer) |
| `GgufPlanner` | none | muse-glimmer/quantization | GGUF pick by memory with the page's measured budget, the llama serve command, quantize-it-yourself |
| `DflashBuilder` | none | muse-glimmer/spec-decode | DFlash flags per runtime, reusing the deploy builders with speculative decoding on |
| `TrainingPlanner` | `model` | both post-training pages | Config builders per framework with the page's ranges, a memory calculator, a row checker, and (Glimmer) a live GRPO group |
| `GrpoLab` | `page: "torchtitan-rl" \| "glimmer"` | cookbook/muse-spark-open-torchtitan-rl (and inside TrainingPlanner) | Sample a group on hosted Muse Spark, score it with the recipe's reward, read the advantages; a reward playground; the recipe builder |
| `SftLab` | none | cookbook/muse-spark-open-torchtitan-sft | Recipe builder, the loss mask, media placeholder counts, the row checker |
| `RecipeBrowser` | `collection: "run-locally" \| "post-training"` | the two cookbook section pages | Filterable recipe cards with needs and first commands |
| `MacClusterPlanner` | none | cookbook/muse-spark-open-mac | Two or four Mac Studios: shares, links, checklist, commands, and a stand-in for the prompt |
| `DatasetCheck` | `formats` | inside TrainingPlanner and SftLab | JSONL rows checked against each trainer's format |
| `StandIn` | `standsFor`, `messages`, `prompt?`, `effort?`, `maxTokens?`, `tools?`, `parallelToolCalls?`, `extra?`, `dropped?`, `note?`, `disabled?`, `reasoningField?`, `onReply?`, `children?` | the live tabs | One Chat Completions request on hosted Muse Spark, labeled as a stand-in, with the Contributor notice, Run and Stop, ErrorBox and Show code. The prompting labs send docs samples (`STANDIN_SAMPLE` in template.ts) for the page's example media and hold Run (`disabled`) while they load |

## Pure modules

`facts.ts` (the pages' numbers), `template.ts` (chat template renderer), `deploy.ts` plus `deploy-spark.ts` and `deploy-glimmer.ts` (runtimes and client code), `download.ts`, `settings.ts`, `hardware.ts`, `spark-hardware.ts` (the Spark planner's layout and command, kept the same), `gguf.ts`, `training.ts`, `torchtitan.ts`, `rewards.ts`, `dataset.ts`, `recipes.ts`, `mac.ts`, `picker.ts`, `standin-body.ts`, `shell.ts`. Each names the page its values come from and labels anything derived.

Shared on purpose, so a builder, its copy prompt and the cookbook cards can't drift: `amdCommand` (the whole AMD block, exports and `COMMON_ARGS` included), `ggufDraftDownload` (the DFlash draft that `-md` reads from disk), `sparkTrlLaunch` (the full Slurm script), `aiperfCommand`. The copy prompts open their facts with `NO_META_KEY` (lib/docs/demos/open-weights.ts), first so the prompt's trimming can't drop it.

## Tests

```
npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/open-weights/__tests__/*.test.ts components/docs/playgrounds/open-weights/__tests__/*.test.tsx
```

`fixtures/` holds small real replies from hosted Muse Spark (replies only, no headers), recorded through the local docs proxy on Oct 30, 2026.
