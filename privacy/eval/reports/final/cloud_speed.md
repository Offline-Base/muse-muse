# Cloud speed

Command: `uv run python -m scripts.bench_speed --label cloud --runs 5 --out eval/reports/final`

Glimmer on the cloud (openrouter, `meta/muse-glimmer-30b`), not this device: do not quote it as device speed. Reasoning strength low, strict JSON, invented demo data. Tokens per second is completion tokens (reasoning included) over the whole call's wall time, so it includes prompt processing.

| Step | Latency (ms) | Tokens/s | Calls |
|---|---:|---:|---:|
| Router decision | 1640 | 80.2 | 5 |
| Second pass for names | 7521 | 43.9 | 5 |
| Request topics | 3031 | 33.6 | 5 |
| Grade one essay | 29030 | 18.0 | 5 |

Raw rows: raw/cloud_speed.jsonl next to this report.

## Against the last run

The run in commit 8afe137 (earlier the same day) had the same steps and prompts. Completion tokens per call are about the same, but three steps were much slower this time, so OpenRouter served them more slowly; no request setting changed. Mean of the raw rows, then and now:

| Step | Completion tokens | Latency (ms) | Tokens/s |
|---|---:|---:|---:|
| Router decision | 135 -> 130 | 1917 -> 1640 | 70.6 -> 80.2 |
| Second pass for names | 173 -> 206 | 1310 -> 7521 | 132.0 -> 43.9 |
| Request topics | 93 -> 90 | 805 -> 3031 | 116.6 -> 33.6 |
| Grade one essay | 527 -> 491 | 3832 -> 29030 | 138.2 -> 18.0 |

Within this run the latency also swung: the name pass took 2391 ms on one call and 11584 ms on another. Cloud latency is not stable enough to quote as one number.

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0057 for this run (20 calls, 3 min 26 s of wall time, 11:54:18 to 11:57:44 ET); 30 s later the key showed $0.0009 more. Between two runs, with none of them going, the key's usage still rose $0.0065 in 3 min 27 s (11:50:51 to 11:54:18 ET), so other use of the key or late billing can add a few cents to any window.
