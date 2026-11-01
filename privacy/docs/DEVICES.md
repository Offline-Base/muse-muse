# Devices and cost

Which devices Muse Privacy has been measured on, and what each would cost. Numbers about a device are copied from the report named next to them, and each report has its command at the top. A device without a report says "not measured". How to run the bench is in docs/DEVICE_BENCH.md. All test data is invented.

## Device matrix

Today's setup is device only: LFM3-VL-2B on the laptop, with the policy deciding. Glimmer has not been measured on any device, and the Glimmer numbers elsewhere in eval/reports came from a cloud endpoint, so they say nothing about a device.

| Device | Model | Status | Report |
|---|---|---|---|
| Mac (Apple M4 Max, 36 GB), plugged in | LFM3-VL-2B | measured, runs every step | eval/reports/device_mac-lfm.md, eval/reports/device_smoke_lfm_loosen_default.md |
| Mac, on battery | LFM3-VL-2B | not measured | none yet (`device_mac-lfm-battery.md`) |
| Mac | Glimmer | not measured | none yet (`device_mac-glimmer1b.md`) |
| A 16 GB laptop | LFM3-VL-2B | not measured | none yet |
| Jetson Orin Nano | LFM3-VL-2B or Glimmer | not measured | none yet (`device_jetson-*.md`) |
| Raspberry Pi 5 (8 GB or 16 GB) | LFM3-VL-2B or Glimmer | not measured | none yet (`device_pi5-*.md`) |
| AWS Device Farm (phones) | any | not measured | none, and none planned |

## What the Mac measured

From eval/reports/device_mac-lfm.md (one run, plugged in, invented class, 2 other llama-server processes running):

| What | Value |
|---|---|
| Model file, vision projector | 1.02 GB, 0.19 GB |
| Load time | 0.8 s |
| llama-bench, generation (tg128) | 210.4 tokens/s |
| llama-bench, prompt (pp512) | 3253.9 tokens/s |
| Layers on the GPU | 25/25 |
| Router decision, mean of 3 | 349 ms |
| Name pass over the essay folder, per essay | 232 ms |
| Grade one essay, mean of 3 | 1486 ms |
| ask_device answer | 13.8 s |
| Grading job, 24 essays | 32.7 s |
| Bench's memory check | about 2.6 GB of 36.00 GB with a 1 GB margin |

From eval/reports/device_smoke_lfm_loosen_default.md (the connector's tools on a copy of the invented class, two runs in one report):

| What | Toggles: none | Toggles: ferpa |
|---|---|---|
| Grade 24 essays, start to result | 41.1 s | 35.9 s |
| ask_device, result | 16.7 s | 17.6 s |
| Private values in any tool output | none | none |
| All device only | True | True |

The same setup's router quality is in eval/reports/floors_fresh_200_b.md (82.5%, 0 leaks, 75 approval requests on invented items). The bench and the smoke time different things and ran at different times, so their grading times do not need to match.

## What is needed to measure the rest

Nothing here has been run. Each step is done by the author on the board's own console, never over a network from the laptop. The full steps are in docs/DEVICE_BENCH.md.

| Device | Status | What is needed | Report it writes |
|---|---|---|---|
| Mac, on battery | not measured | Unplug, then run `scripts/bench_device.py --label mac-lfm-battery --expect-power battery --runs 1 --essays 6`, with the model files | `eval/reports/device_mac-lfm-battery.md` |
| Mac, Glimmer | not measured | The Glimmer file, passed by `scripts/plug_in_model.py --check`, then `scripts/bench_device.py --label mac-glimmer1b --kind glimmer` | `eval/reports/device_mac-glimmer1b.md` |
| A 16 GB laptop | not measured | A 16 GB laptop, then the Mac steps with its own label. No such laptop has been tried | a new `device_<label>.md` |
| Jetson Orin Nano | not measured | A board that serves no other demo, a USB stick with the `scripts/make_bundle.py` bundle and the model files, llama.cpp b11972 built on the board, then `scripts/bench_device.py --label jetson-lfm` and `--label jetson-glimmer1b` | `eval/reports/device_jetson-*.md` |
| Raspberry Pi 5 | not measured | A Pi 5 with its active cooler, the same bundle on a USB stick, llama.cpp b11972 built for the CPU, then `scripts/bench_device.py --ngl 0 --label pi5-8-lfm` or `--label pi5-16-lfm` | `eval/reports/device_pi5-*.md` |
| AWS Device Farm | not measured | An AWS account, a test package that builds llama.cpp for a phone, and a script this repo does not have. A phone is not a Muse Privacy device, so this would only show whether a model loads; it was dropped from the plan | none |

## Memory by process

The cost of a device depends on the memory all of its processes need together. Only one has been measured, so the total is unknown.

| Process | Peak memory | Source |
|---|---|---|
| llama-server with LFM3-VL-2B | 1.70 GB resident (ps; Metal buffers may not count), with model buffers 1246 MiB, KV cache buffers 200 MiB and compute buffers 513 MiB | eval/reports/device_mac-lfm.md |
| Muse Privacy app and connector | not measured | none yet |
| Embedder (when SEARCH_EMBEDDINGS=1) | not measured | none yet |
| SAM helper (when SAM_ENABLED=1) | not measured | none yet |
| All together | unknown | needs the rows above |

## Cost per device

Prices are what the named page said on the date given. They move: the first source below reports the Jetson kit going from $249 to $399. New-device prices are for the board alone unless the source says otherwise.

| Device | New hardware | Source and date | Status of running it |
|---|---|---|---|
| The Mac measured above, already owned | $0 | no purchase | measured |
| A 16 GB laptop, already owned | $0, projected | no purchase | not measured |
| Jetson Orin Nano Super Developer Kit | $399 | CNX Software, "NVIDIA increases the price of Jetson modules and devkits by up to 101%", July 22, 2026, https://cnx-software.com/2026/07/22/nvidia-increases-the-price-of-jetson-modules-and-devkits-by-up-to-101 (read Oct 31, 2026) | not measured |
| Raspberry Pi 5, 8 GB | $180.00, in stock at one retailer | SparkFun, https://www.sparkfun.com/raspberry-pi-5-8gb.html (read Oct 31, 2026). A secondary list page gives $175 as of Oct 12, 2026: https://raspberry.tips/en/raspberrypi-infos/raspberry-pi-prices-lifecycle | not measured |
| Raspberry Pi 5, 16 GB | $305 | Raspberry Pi, https://www.raspberrypi.com/products/raspberry-pi-5/ (read Oct 31, 2026) | not measured |
| AWS Device Farm | $0.17 per device minute | AWS, https://aws.amazon.com/device-farm/pricing/ (read Oct 31, 2026) | not measured |

Unknown, because no source was read: a new laptop, storage, a power supply and a cooler for a board, electricity, and any Muse subscription.

## Per-school figure (an assumption)

Everything in this table is an assumption, not a quote or a measurement. It shows the arithmetic so anyone can swap in their own inputs.

Inputs, all assumptions: 30 teachers in a school, an invented round number; one device per teacher; the board prices above; nothing else bought; and that the device runs Muse Privacy at a usable speed, which is measured only for the Mac.

| Setup (assumption) | Teachers (assumption) | Price per device (from the table above) | New hardware per school (assumption) |
|---|---|---|---|
| Laptops already owned, projected | 30 | $0 | $0 |
| Jetson Orin Nano Super Developer Kit | 30 | $399 | $11,970 |
| Raspberry Pi 5, 8 GB | 30 | $180 | $5,400 |
| Raspberry Pi 5, 16 GB | 30 | $305 | $9,150 |
