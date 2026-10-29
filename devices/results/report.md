# Device results

0 runs of Muse Glimmer 30B files and 1 smoke run. Made by `npx tsx scripts/devices/report.ts --write` (docs/DEVICES.md "Reading results").

## What the picker says

- **12 GB phones:** No change (nothing tested).
- **16 GB phones:** No change (nothing tested).
- **24 GB phones:** No change (nothing tested).

## Smoke runs

These only show that the path works on a device; their ratings say nothing about Glimmer.

| Device | Where | RAM | File | Rating | Best backend | Generation | Prompt | Answers | Peak memory | Lowest free | Backends | Run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Mac16,5 (Apple M4 Max) | this Mac | 36 GB | smoke-smollm2-135m-q4_0 (92 MB) | usable | gpu | 461 t/s | 16136 t/s | 2/3 | 1 MB |  | gpu 461 t/s, 2/3 right; cpu 252 t/s, 2/3 right | [20261029T031655Z](local/apple-mac16-5-36gb/smoke-smollm2-135m-q4_0/20261029T031655Z) |
