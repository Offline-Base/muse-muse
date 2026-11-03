# Third-party notices

Muse Privacy is built on the models, tools and libraries below. Each one stays under its own license. This repo does not copy their code or weights: model files are downloaded by whoever runs the device and are never committed (`models/` and `*.gguf` are gitignored), and the libraries are installed by uv or npm from their own packages. Muse Privacy's own code is under the Apache License 2.0 with the rest of the Muse Muse repo (LICENSE and NOTICE at the repo root, added Nov 2, 2026).

License names were checked on Oct 30, 2026 against the pages linked in each row. The rows for the SAM sidecar's weights and packages and for pdftotext were added on Oct 31 from the sidecar's README, the installed package metadata and poppler's own files, with no page fetched, so check them against the linked pages too. Read the license itself before you redistribute a model file or use one commercially.

## Models

| Model | What it does here | License | Source |
|---|---|---|---|
| Muse Glimmer 30B (Meta), with its GGUF files and the DFlash drafter | The router and every private step in the shipping mode (`GLIMMER_BACKEND=llama_server`) | Apache License 2.0. The GGUF card says all released artifacts are under Apache 2.0, which covers the drafter | [model card](https://huggingface.co/meta-models/Muse-Glimmer-30B), [GGUF card](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF) |
| `mradermacher/Muse-Glimmer-30B-i1-GGUF` (i1-IQ1_S), a third party's quant of the model above | The 1-bit file for the Jetson Orin Nano and the same-quant control in the Glimmer eval | Apache License 2.0 (card metadata) | [model card](https://huggingface.co/mradermacher/Muse-Glimmer-30B-i1-GGUF) |
| Liquid AI LFM3-VL-2B (GGUF from `LiquidAI/LFM3-VL-2B-GGUF`) | Name and topic checks, grading and summaries on 127.0.0.1:8083; with `DEVICE_ONLY=1`, every step | LFM Open License v1.0. Commercial use is limited for companies at or above an annual revenue threshold of 10 million US dollars; read the license before any commercial use | [model card](https://huggingface.co/LiquidAI/LFM3-VL-2B), [license](https://huggingface.co/LiquidAI/LFM3-VL-2B/blob/main/LICENSE) |
| Liquid AI LFM3-1.7B (GGUF from `LiquidAI/LFM3-1.7B-GGUF`) | The fallback on the Jetson gateway, when it is set up | LFM Open License v1.0, as above | [model card](https://huggingface.co/LiquidAI/LFM3-1.7B) |
| EmbeddingGemma 2 (`google/embeddinggemma-2`, GGUF from `ggml-org/embeddinggemma-2-GGUF`) | Search embeddings on 127.0.0.1:8084 when `SEARCH_EMBEDDINGS=1` | Apache License 2.0 per both cards' metadata. Google's card links that name to its Gemma 4 license page, so read that page before you redistribute the weights | [model card](https://huggingface.co/google/embeddinggemma-2), [GGUF card](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF), [linked license page](https://ai.google.dev/gemma/docs/gemma_4_license) |
| SAM 3.1 (`facebook/sam3.1`, Meta) | Finds faces, signatures, ID cards and barcodes on page images and covers them before the device reads the page (sidecars/sam/, base/regions.py). Built and off by default: `SAM_ENABLED=1` turns it on. No weights or sidecar environment are installed yet, and the mlx predictor has never run | SAM License. Its use restrictions (section 1.b.v) include trade controls, military or warfare end uses, guns and illegal weapons, and "any activities subject to the International Traffic in Arms Regulations (ITAR)". Access to the weights is gated on Hugging Face | [model card](https://huggingface.co/facebook/sam3.1), [license](https://github.com/facebookresearch/sam3/blob/main/LICENSE) |
| `mlx-community/sam3.1-bf16`, a third party's MLX conversion of SAM 3.1 | The weights `scripts/start_sam.sh` loads by default (`SAM_MODEL_ID`); nothing is downloaded until Ethan says yes. The README's smaller fallback, `mlx-community/sam3-8bit`, is SAM 3 | Not checked here. A conversion of SAM 3.1 stays under the SAM License above; read its card before downloading | [model card](https://huggingface.co/mlx-community/sam3.1-bf16) |

## Services

These are services the project talks to, not software it ships. Their terms of service apply.

| Service | What it does here | Terms |
|---|---|---|
| Meta Model API (Muse Spark 1.3) | Wrote the invented eval data (eval/synthetic.jsonl); used only for the eval harness and invented data, never user data (base/spark.py refuses it) | [Meta Model API Terms of Service](https://dev.meta.ai/legal/terms-of-service) |
| The Muse app (Meta) | Calls the connector's tools through the relay | Meta's terms for the Muse app, shown in the app |
| OpenRouter | A development mode only, for invented data (`GLIMMER_BACKEND=openrouter`); off when `DEVICE_ONLY=1` | [OpenRouter Terms of Service](https://openrouter.ai/terms) |
| Cloudflare Workers | Hosts the relay (relay/) | [Cloudflare terms](https://www.cloudflare.com/terms/) |

## Tools

| Tool | What it does here | License | Source |
|---|---|---|---|
| llama.cpp (`llama-server`) | Serves every local model on 127.0.0.1 | MIT License | [license](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) |
| uv | Python environments and the commands in this repo | Apache License 2.0 or MIT, at your option | [repo](https://github.com/astral-sh/uv) |
| CircuitPython | Firmware for the status light (hardware/light/code.py) | MIT License | [license](https://github.com/adafruit/circuitpython/blob/main/LICENSE) |
| Adafruit CircuitPython NeoPixel | The status light's LED ring driver | MIT License | [license](https://github.com/adafruit/Adafruit_CircuitPython_NeoPixel/blob/main/LICENSE) |
| build123d | The enclosure's CAD model (hardware/enclosure/, its own environment) | Apache License 2.0 | [license](https://github.com/gumyr/build123d/blob/dev/LICENSE) |
| trimesh | Enclosure mesh checks | MIT License | [license](https://github.com/mikedh/trimesh/blob/main/LICENSE.md) |
| NumPy | Enclosure math | BSD-3-Clause AND 0BSD AND MIT AND CC0-1.0 (its pyproject.toml) | [pyproject.toml](https://github.com/numpy/numpy/blob/main/pyproject.toml) |
| Poppler `pdftotext` | Reads the text layer of PDFs on the device (base/workspace/index.py, `PDFTOTEXT_BIN`); the user installs it, this repo does not | GNU General Public License (poppler's README; its COPYING file is version 2). It runs as a separate program, and this repo neither ships nor links it | [poppler](https://poppler.freedesktop.org/) |

## Python dependencies (pyproject.toml)

Versions and licenses are read from the installed package metadata (`License-Expression`, else the license classifier, else `License`) in this repo's uv environment. Each package's own dependencies keep their own licenses; this command lists every installed package with its license field:

```
uv run python -c "import importlib.metadata as m; [print(d.metadata['Name'], d.version, d.metadata.get('License-Expression') or '; '.join(c for c in d.metadata.get_all('Classifier') or [] if c.startswith('License')) or (d.metadata.get('License') or '?').split(chr(10))[0][:60]) for d in m.distributions()]"
```

| Package | Version | License | Group |
|---|---|---|---|
| fastapi | 0.162.0 | MIT | runtime |
| uvicorn | 0.54.0 | BSD-3-Clause | runtime |
| httpx | 0.28.1 | BSD-3-Clause | runtime |
| pydantic | 2.14.1 | MIT | runtime |
| pyyaml | 6.0.3 | MIT | runtime |
| mcp | 2.3.0 | MIT | runtime |
| websockets | 17.3 | BSD-3-Clause | runtime |
| matplotlib | 3.11.2 | Matplotlib License, based on the PSF license (classifier: Python Software Foundation License) | runtime |
| pyserial | 3.5 | BSD (classifier: BSD License) | runtime |
| onnxruntime | 1.31.1 | MIT (classifier: MIT License) | runtime |
| tokenizers | 0.23.3 | Apache-2.0 (classifier: Apache Software License) | runtime |
| pytest | 9.1.1 | MIT | dev |
| pytest-asyncio | 1.4.1 | Apache-2.0 | dev |
| respx | 0.23.1 | BSD-3-Clause | dev |
| ruff | 0.17.3 | MIT | dev |

## SAM sidecar dependencies (sidecars/sam/pyproject.toml)

The sidecar has its own environment, which is not locked or installed yet (it waits on Ethan's yes), so no version is fixed. fastapi and uvicorn there are the packages in the table above. mlx-vlm brings mlx, transformers, datasets and opencv, each under its own license.

| Package | Version | License | Group |
|---|---|---|---|
| mlx-vlm | not locked (0.4.3 or newer) | MIT (sidecars/sam/README.md) | sidecar |
| pillow | not locked (11 or newer) | MIT-CMU (the License-Expression of pillow 13.0.0, which matplotlib installs in this repo's environment) | sidecar |

## Relay dependencies (relay/package.json)

From the `license` fields in relay/package-lock.json.

| Package | Version | License | Group |
|---|---|---|---|
| @cloudflare/workers-oauth-provider | 1.2.4 | MIT | runtime |
| @cloudflare/vitest-pool-workers | 0.22.0 | MIT | dev |
| @cloudflare/workers-types | 5.20261002.1 | MIT OR Apache-2.0 | dev |
| typescript | 5.9.3 | Apache-2.0 | dev |
| vitest | 4.1.11 | MIT | dev |
| wrangler | 4.147.0 | MIT OR Apache-2.0 | dev |
