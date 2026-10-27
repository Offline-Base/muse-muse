# Prior work

Muse Privacy was built in this repository during the Meta Global AI Developer Hackathon, which began on Oct 26, 2026. The first commit is from Oct 27, 2026 at 01:29 ET. Nothing here is imported, vendored or copied from another repository. Earlier Offline Base projects by the same author were read for ideas, and each module that took an idea from one is listed below.

**Still to do (Ethan):** read the Official Rules and check this page against them, in particular what they say about pre-existing code, open-source libraries, published model weights and AI coding tools. Then delete this paragraph.

## Before Oct 26

These existed before the event, in separate repositories, and are not part of this submission's code:

| Earlier project | What it is | What we took as inspiration |
|---|---|---|
| decision-guard (Offline-Base) | A local model that checks text before it is sent | The idea of exact checks (Luhn card numbers, one-time codes) that override a model, rewritten in Python for base/guard.py |
| base-router-subagent, branch base-agent-v0.1 (Offline-Base) | A local memory MCP server with a Cloudflare relay | The relay shape (device dials out to a Worker, OAuth, one-time pairing codes), rewritten for relay/ and base/connector/ |
| decision-tree (Offline-Base) | A small device with a status light | The idea of streaming state to a light, rewritten for base/events.py, base/light.py and hardware/light/ |

## Built during the event

Everything in this repository: the device code in `base/`, the relay in `relay/`, the eval harness, eval set, invented roster, essays and records, the simulation and chart scripts, the Jetson deploy files, the light firmware and the enclosure model. See the git history.

## Made with other tools and models during the event

| What | Made with | Notes |
|---|---|---|
| The code and docs | Claude Code (Anthropic's coding agent), directed by Ethan | Every commit carries a Co-Authored-By line. Muse Code has not been used for any part yet; the plan is to use it for at least one piece and say which here. |
| `eval/synthetic.jsonl` (2,000 practice items) | Muse Spark 1.3 through the Meta Model API (`scripts/make_synthetic.py`) | The plan wanted Muse to write this set on its VM; the Spark API was the plan's fallback. `eval/reports/synthetic.md` has the commands and checks. |
| `eval/reports/grading_crosscheck.md` (a second grading of the 24 invented essays) | Muse Spark 1.3 through the Meta Model API (`scripts/grade_crosscheck.py`) | Spark got the same grading prompt, rubric and essays as Glimmer, with names and identifiers swapped for tags, and its scores are compared with Glimmer's. A second opinion, not ground truth; scores only are kept. |
| `eval/tasks.jsonl`, `eval/holdout.jsonl`, `eval/roster.json`, `demo/` | Written during the event for this repo | All invented. `eval/DATASET.md` describes them. |

## Not ours, used as published

| What | Where it comes from | How we use it |
|---|---|---|
| Muse Glimmer weights | Meta's `meta-models/Muse-Glimmer-30B-GGUF` (Q4_K_M) and the bf16 base `meta-models/Muse-Glimmer-30B` | The laptop model, and the base for the router LoRA script. Not downloaded or run yet. |
| 1-bit Glimmer for the Jetson | `mradermacher/Muse-Glimmer-30B-i1-GGUF` (i1-IQ1_S, IQ1_M), a third party's importance-matrix quants | The plan was to quantize Glimmer ourselves; on Oct 27 Ethan chose the published quant instead (docs/DECISIONS.md). |
| Muse Glimmer on OpenRouter (`meta/muse-glimmer-30b`) | OpenRouter | Development and every measured number so far, on invented data only. |
| Open-source libraries | Python: FastAPI, uvicorn, httpx, pydantic, PyYAML, the MCP Python SDK (`mcp`), websockets, matplotlib, pyserial, pytest, respx, ruff. Relay: `@cloudflare/workers-oauth-provider`, wrangler, vitest, TypeScript. Enclosure: build123d, trimesh, numpy. Firmware: CircuitPython and Adafruit's NeoPixel library. llama.cpp (llama-server) on the devices. | Dependencies, pinned in `pyproject.toml`, `uv.lock`, `relay/package.json` and `hardware/enclosure/pyproject.toml`. |
