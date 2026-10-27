# Cloud speed

Command: `uv run python -m scripts.bench_speed --label cloud --runs 5 --out eval/reports/final`

Glimmer on the cloud (openrouter, `meta/muse-glimmer-30b`), not this device: do not quote it as device speed. Reasoning strength low, strict JSON, invented demo data. Tokens per second is completion tokens (reasoning included) over the whole call's wall time, so it includes prompt processing.

| Step | Latency (ms) | Tokens/s | Calls |
|---|---:|---:|---:|
| Router decision | 1917 | 70.6 | 5 |
| Second pass for names | 1310 | 132.0 | 5 |
| Request topics | 805 | 116.6 | 5 |
| Grade one essay | 3832 | 138.2 | 5 |

Raw rows: raw/cloud_speed.jsonl next to this report.

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0175 for this run (20 calls, about 40 s of wall time).
