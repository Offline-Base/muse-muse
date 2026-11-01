# Cloud speed

Command: `uv run python -m scripts.bench_speed --label cloud --runs 5 --out eval/reports/final`

Glimmer on the cloud (openrouter, `meta/muse-glimmer-30b`), not this device: do not quote it as device speed. Reasoning strength low, strict JSON, invented demo data. Tokens per second is completion tokens (reasoning included) over the whole call's wall time, so it includes prompt processing.

| Step | Latency (ms) | Tokens/s | Calls |
|---|---:|---:|---:|
| Router decision | 2069 | 68.8 | 5 |
| Second pass for names | 2057 | 110.5 | 5 |
| Grade one essay | 4203 | 122.1 | 5 |

Raw rows: raw/cloud_speed.jsonl next to this report.
