# Third-party notices

Muse Privacy is built on the models, tools and libraries below. Each one stays under its own license. This repo does not copy their code or weights: model files are downloaded by whoever runs the device and are never committed (`models/` and `*.gguf` are gitignored), and the libraries are installed by uv or npm from their own packages. Muse Privacy's own code has no LICENSE file yet; Ethan chooses one before the repo goes public.

License names were checked on Oct 30, 2026 against the pages linked in each row. Read the license itself before you redistribute a model file or use one commercially.

## Models

| Model | What it does here | License | Source |
|---|---|---|---|
| Muse Glimmer 30B (Meta), with its GGUF files and the DFlash drafter | The router and every private step in the shipping mode (`GLIMMER_BACKEND=llama_server`) | Apache License 2.0. The GGUF card says all released artifacts are under Apache 2.0, which covers the drafter | [model card](https://huggingface.co/meta-models/Muse-Glimmer-30B), [GGUF card](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF) |
| `mradermacher/Muse-Glimmer-30B-i1-GGUF` (i1-IQ1_S), a third party's quant of the model above | The 1-bit file for the Jetson Orin Nano and the same-quant control in the Glimmer eval | Apache License 2.0 (card metadata) | [model card](https://huggingface.co/mradermacher/Muse-Glimmer-30B-i1-GGUF) |
| Liquid AI LFM3-VL-2B (GGUF from `LiquidAI/LFM3-VL-2B-GGUF`) | Name and topic checks, grading and summaries on 127.0.0.1:8083; with `DEVICE_ONLY=1`, every step | LFM Open License v1.0. Commercial use is limited for companies at or above an annual revenue threshold of 10 million US dollars; read the license before any commercial use | [model card](https://huggingface.co/LiquidAI/LFM3-VL-2B), [license](https://huggingface.co/LiquidAI/LFM3-VL-2B/blob/main/LICENSE) |
| Liquid AI LFM3-1.7B (GGUF from `LiquidAI/LFM3-1.7B-GGUF`) | The fallback on the Jetson gateway, when it is set up | LFM Open License v1.0, as above | [model card](https://huggingface.co/LiquidAI/LFM3-1.7B) |
| EmbeddingGemma 2 (`google/embeddinggemma-2`, GGUF from `ggml-org/embeddinggemma-2-GGUF`) | Search embeddings on 127.0.0.1:8084 when `SEARCH_EMBEDDINGS=1` | Apache License 2.0 per both cards' metadata. Google's card links that name to its Gemma 4 license page, so read that page before you redistribute the weights | [model card](https://huggingface.co/google/embeddinggemma-2), [GGUF card](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF), [linked license page](https://ai.google.dev/gemma/docs/gemma_4_license) |
| SAM 3.1 (`facebook/sam3.1`, Meta) | Planned: covering faces and signatures on scanned pages before the device reads them. Not part of this commit | SAM License. Its use restrictions (section 1.b.v) include trade controls, military or warfare end uses, guns and illegal weapons, and "any activities subject to the International Traffic in Arms Regulations (ITAR)". Access to the weights is gated on Hugging Face | [model card](https://huggingface.co/facebook/sam3.1), [license](https://github.com/facebookresearch/sam3/blob/main/LICENSE) |

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
| pytest | 9.1.1 | MIT | dev |
| pytest-asyncio | 1.4.1 | Apache-2.0 | dev |
| respx | 0.23.1 | BSD-3-Clause | dev |
| ruff | 0.17.3 | MIT | dev |

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
