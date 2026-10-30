# Muse Glimmer {#muse-glimmer}

[Muse Glimmer](https://dev.meta.ai/docs/models#muse-glimmer) is Meta's 30-billion-parameter open-source multimodal model, distilled from [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) and built for local agentic workflows. Run it on your own hardware through supported runtimes. It ships with open weights, reads text and images, and reasons step by step before it answers.

Point your existing tooling at a local Muse Glimmer server and keep building — you own the weights, the runtime, and the data.

## Model variants {#model-variants}

| Model        | Parameters | Architecture                                        | Context window                                    |
| ------------ | ---------- | --------------------------------------------------- | ------------------------------------------------- |
| Muse Glimmer | 30B        | Dense, multimodal (text + image input; text output) | 128K tokens by default; longer contexts supported |

## Architecture {#architecture}

Muse Glimmer is a dense, decoder-only multimodal transformer with a built-in vision encoder. It is trained from Muse Spark's outputs rather than from scratch. It accepts text and image input, produces text output, and has a default context window of 128K tokens with support for longer contexts.

## Supported languages {#supported-languages}

Muse Glimmer was trained on data from more than 100 languages.

## License {#license}

Muse Glimmer weights are released under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

## Launch partners {#launch-partners}

The Muse Glimmer launch ecosystem includes:

- AMD
- Arm
- Dell
- Fireworks AI
- Hugging Face
- Intel
- llama.cpp
- LM Studio
- NVIDIA
- Ollama
- OpenRouter
- SGLang and RadixArk
- Together AI
- Unsloth
- vLLM and Inferact

## Get started {#get-started}

- [Get the model](https://dev.meta.ai/docs/muse-glimmer/get-the-model): Download weights from Hugging Face and verify your setup.
- [Prompting guide](https://dev.meta.ai/docs/muse-glimmer/prompting): Chat template, system prompts, and best practices for Muse Glimmer.
- [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy): Pick a runtime: vLLM, SGLang, llama.cpp, Ollama, and more.

## Next steps {#next-steps}

Now that you know what Muse Glimmer offers, [get the model](https://dev.meta.ai/docs/muse-glimmer/get-the-model) and run your first inference. If you're ready to optimize, explore [quantization](https://dev.meta.ai/docs/muse-glimmer/quantization) to fit the model on smaller hardware, or [speculative decoding](https://dev.meta.ai/docs/muse-glimmer/spec-decode) to accelerate generation. To adapt Muse Glimmer to your domain, see [post-training](https://dev.meta.ai/docs/muse-glimmer/post-training).
