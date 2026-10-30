# Open-weight models {#open-weight-models}

Most of the models in these docs are hosted on Meta Model API — you call them over the API and Meta runs the infrastructure. Meta also publishes **open-weight** models that you download and run on your own hardware, so you own the weights, the runtime, and the data.

This section covers the open-weight releases. For the hosted API models and how to choose between them, see [Models](https://dev.meta.ai/docs/models).

## Hosted API or open weights {#hosted-or-open-weights}

|                                | Hosted on Meta Model API                          | Open-weight (self-hosted)                                                     |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| How you run it                 | Call the API; Meta runs the servers               | Download the weights and run the servers yourself                             |
| Where prompts and responses go | Meta Model API                                    | Your own infrastructure                                                       |
| What you need                  | An API key                                        | A serving runtime (such as SGLang or vLLM) and your own GPUs or cloud compute |
| Where to start                 | [Quickstart](https://dev.meta.ai/docs/quickstart) | The **Get the model** page for the model below                                |

You can also call open-weight models through third-party inference providers instead of running them yourself. Each model's page lists its hosted providers.

## Available open-weight models {#available-open-weight-models}

- [Muse Spark Open](https://dev.meta.ai/docs/muse-spark-open): Meta's 816B-parameter mixture-of-experts model with 42B active parameters, for agentic and coding work, with text, image, audio, and video input. Ships as BF16 and NVFP4 checkpoints.
- [Muse Glimmer](https://dev.meta.ai/docs/muse-glimmer): Meta's 30B open-weight multimodal model, distilled from Muse Spark and built for local and edge deployment.

## Next steps {#next-steps}

Pick a model above and follow its **Get the model** page to download the weights and serve them, or see [Models](https://dev.meta.ai/docs/models) for the full lineup, including the models hosted on Meta Model API.
