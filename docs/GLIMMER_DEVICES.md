# Muse Glimmer on a Jetson and on a phone

Written Nov 3, 2026, about 10:30 AM ET, branch `tg-p-glimmer-devices`. It covers the one-bit Muse Glimmer 30B on jetson-02 and on Android phones: what runs, the best settings, what may be said in the video, and the steps left for the owner and Hussam.

Everything here is Meta's Muse Glimmer 30B (our knowledge-run tune, r30b stage b). Made-up data only. Nothing was run on the laptop. No service, config or file on a board was changed, and nothing was billed.

## The short answer

| Where | File | Speed | Answers | Status |
|---|---|---|---|---|
| jetson-02, Jetson Orin Nano 8 GB, GPU | `muse-glimmer-stage-b-r30b-iq1s-io-lowest.gguf`, 5.75 GB | 5.2 to 5.5 tokens a second; 3.3 to 4.5 with a JSON schema | Short answers. "17 * 23" right 3 of 5 times across setups (2 of 2 with the server's defaults). Wrong on most multi-step or judgment questions | Running now (Nov 3), through the fleet |
| Galaxy S25, 12 GB, CPU (AWS Device Farm) | `muse-glimmer-stage-b-r30b-IQ1_S.gguf`, 6.53 GB | 1.94 tokens a second; prompts 2.4 a second | 3 of 3 simple questions right | Measured Nov 1, adb shell, not an app |
| Galaxy S25, 12 GB, CPU | `muse-glimmer-stage-b-r30b-IQ2_XXS.gguf`, 7.96 GB | 1.89 tokens a second | 3 of 3 | Measured Nov 1 |
| Pixel 9 Pro, 16 GB, CPU | stage 2 IQ2_XXS, 7.96 GB | 0.95 tokens a second | 3 of 3 | Measured Oct 31 |

- **The loop is fixed at the request level.** The way to stop it is to skip the thinking channel: the reasoning-off template jetson-02 already serves. Nothing else we tried makes reasoning work at one bit.
- **The wrong answers are not fixable at the request level.** System prompts, JSON schemas and a two-call thinking budget didn't make the answers reliably right. The one-bit file itself is the limit.
- **No better file fits jetson-02 today,** and none needs to be made: every candidate is already public on our Hugging Face repo, and the only one that might be better (6.21 GB) needs RAM the board doesn't have free.
- **A phone has run Glimmer, measured.** Nobody has filmed it, and no app runs it.

## 1. Why it loops, and what fixes it

**The cause.** Glimmer's chat template ends with `<|start|>assistant`. The model then picks its channel: ` to=self` (private reasoning) or ` to=user` (the answer). With Meta's template it always reasons first (Meta's deploy guide: "Reasoning can't be turned off here"). At one bit, the reasoning turns into repetition and never closes. So the reply runs to `max_tokens`, and llama.cpp's Muse Glimmer parser answers HTTP 500 ("does not match the expected peg-native format"), because the output never reaches the answer channel. `--reasoning-budget 256` didn't stop it (Nov 3, 2:50 AM run, docs/BUILD_LOG.md). Meta's recommended sampling (temperature 1.0, top_p 0.95, top_k 64) makes one-bit output worse: with reasoning skipped it gave `* * *` loops. Meta's sampling advice is written for its own files, the smallest of which is 16.8 GB. Ours is 5.75 GB.

**The fix that works.** `tuned-reasoning-off.jinja` (in the repo at `scripts/knowledge/aws/job/` and on the Hub) ends the prompt with `<|start|>assistant to=user<|message|>`, so the model writes the answer straight away. llama-server needs `--reasoning-format none` with it, and `stop` on `<|eot|>` and `<|end_of_text|>`, never `<|eom|>`. jetson-02's `jetson-llama` drop-in already does all of this, with temperature 0.2, top_p 0.95, top_k 64, repeat penalty 1.1 and `-n 128`. This departs from Meta's guidance (no reasoning, low temperature), and we say so.

**What we tried today on top of that.** 12 requests on jetson-02 through the control plane (`run_command` running a script from stdin that called the running server on 127.0.0.1:11435, nothing written to the board), plus 2 through `ask_fleet_model` (the route products use). 4 made-up prompts. Each request took under 41 s. The raw rows are in `docs/log/bench/2026-11-03/glimmer-jetson-02-requests.jsonl`.

Prompts:
- **math:** "What is 17 * 23? Answer with the number only." (391)
- **vans:** 3 vans, 40 boxes each, 100 boxes, all leave together: the fewest trips? (1)
- **cold:** controller 3 C, independent probe 9 C, door shut, JSON status and reason (should be "alert": a 6 C disagreement)
- **warehouse:** three things to check before locking up a small food bank warehouse at night

| Setup | math | vans | cold | Speed |
|---|---|---|---|---|
| No-think, no system prompt, temp 0.2 (the server's defaults; Nov 3, 2:50 AM and today through the fleet) | 391, right, 2 of 2 | not tried | `"ok"`, wrong (valid JSON) | 5.2 to 6.1 tok/s, 9 to 32 tokens |
| No-think plus a careful system prompt (task, format, length; the cold-room rule spelled out) | "I can't answer that", wrong | repeated the prompt, cut at 128 | worked it out in the open ("9 - 3 = 6. That's > 2?"), cut at 128 before the JSON | 5.2 to 5.3 tok/s |
| No-think plus `json_schema` (answer field; for vans and cold, a reason field first) | `{"answer": 17}`, wrong | `{"trips": 1}`, right, empty reason | `{"reason": "...", "status": "ok"}`, wrong | 4.0 to 4.5 tok/s, 5 to 7 s |
| Two-call thinking budget: call 1 opens `to=self` (temp 0.6, 100 tokens, stop at `<|eom|>`), call 2 adds the thoughts and opens `to=user` (temp 0.2, 96 tokens) | 391, right, 12.8 s | rambled, cut at 196 tokens (heading toward 1) | thought "alert", then answered "ok" under the schema | 5.3 tok/s |
| No-think, no system prompt, through `ask_fleet_model` | 391, right, 9 tokens (20 s to first token: it queued behind the request before it) | | | 6.1 tok/s |
| The same, warehouse | three numbered checks (temperature, inventory, door and lock), readable, two odd phrases ("the freezer's running empty", "confirm zero motion alarms are armed") | | | 5.4 tok/s, 91 tokens, 2.0 s to first token |

What this shows:
- **A system prompt hurts.** With one, the model repeated the prompt on 2 of 3. Leave the system message out, as Meta's template default does.
- **A JSON schema always gives valid JSON** (llama.cpp enforces it as a grammar) and costs about 20% of the speed. It doesn't make the content right.
- **The two-call budget is the only way to get any reasoning,** and it helps only on a one-step question. On the cold room the answer contradicted its own thought. Not worth the extra call.
- **The model can't be trusted with a decision.** On the cold room it was wrong in 4 of 4 setups today (and in every earlier one). The edge fallback should stay "rules in code", as the readiness audit says.

Available memory read 444 to 495 MB before and after each batch. The guard's lowest reading since it started is 344 MB, logged before these tests. It kills the server under 300 MB.

## 2. The best settings found

For a short chat (the video, or a product's fleet route):

```text
llama-server --model muse-glimmer-stage-b-r30b-iq1s-io-lowest.gguf -ngl 999 -c 4096 -np 1 -b 256 -ub 256 \
  --jinja --chat-template-file tuned-reasoning-off.jinja --reasoning-format none \
  --temp 0.2 --top-p 0.95 --top-k 64 --repeat-penalty 1.1 -n 128 -r '<|eot|>' -r '<|end_of_text|>' --cache-ram 0
```

That is jetson-02's current drop-in, unchanged. Per request: no system message, a one-line question, `max_tokens` 128 or less, `stop: ["<|eot|>", "<|end_of_text|>"]`. For anything a program reads, add `response_format: {type: "json_schema", ...}`, and check the values in code.

Don't use: Meta's sampling (temperature 1.0) at one bit, the file's own template (reasoning on), `--reasoning-budget`, a system prompt, or answers over about 128 tokens (the fleet route waits 100 s; 128 tokens take about 25 s).

## 3. Is there a better file?

All of these are public in `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF` (listed today with the Hub's free API). Scores are from the model card: the first 600 of the 2,500 test questions for the custom mixes, 40 old facts, A100 speed.

| File | Size | 600 test | Old facts | A100 tok/s | Fits jetson-02 (7.5 GB, about 0.45 GB free with the 5.75 GB file loaded)? |
|---|---|---|---|---|---|
| iq1s-io-lowest (running now) | 5.75 GB | 7.2% | 35/40 | 68.1 | Yes, tight |
| iq1s-out-q4 (output at Q4_K) | 6.21 GB | 8.0% | 38/40 | 68.7 | Only if Hussam frees about 0.5 GB more RAM. Not measured. It would leave about 0 MB, under the guard's 300 MB |
| IQ1_S (stock mix) | 6.53 GB | 8.7% | 36/40 | 67.3 | No |
| IQ1_M | 7.06 GB | 14.5% | 37/40 | 57.7 | No |
| iq2-io-lowest | 7.18 GB | 16.7% | 39/40 | 59.6 | No |
| IQ2_XXS | 7.96 GB | 18.5% | 40/40 | 59.5 | No (bigger than the board's RAM) |
| Meta's base Glimmer, IQ1_S (untuned, ours to quantize) | 6.53 GB | 1.6% on the 2,500 | 30/40 | 68.6 | No. And it looped on 57 of 60 greedy prompts, against 9 of 60 for ours |

- **Keep the file that runs.** Our tune survives one bit far better than Meta's base (8.3% against 1.6% on the 2,500), so the untuned file is no backup.
- **iq1s-out-q4 is the only plausible upgrade:** 3 more old facts, the same speed. It costs $0 (public file), about 30 minutes to download over the office Wi-Fi, and a RAM risk. Not worth it before the deadline.
- **A requantize isn't needed.** If one were wanted (for example IQ1_S with an importance matrix from chat answers instead of training text), it would be a hand-launched Lambda A10 at $1.29 an hour, about 1.4 hours of machine for about $1.75 to $2.60 (docs/CHAIN_RUN.md, from the Nov 1 run), with no proof it helps. Not recommended.
- The model card's "On devices" section says no Glimmer has run on a Jetson. That was true when written and is stale since Nov 3 (owner step O3).

## 4. Phones

**What fits.** A dense 30B model reads all its weights for every token, so the whole file must sit in RAM. The device harness budgets 70% of RAM on Android (`~/muse-muse-devices/docs/DEVICES.md`, read-only), so a 5.75 to 6.53 GB file needs a 12 GB phone or larger. 8 GB phones can't hold it. iPhones are out: at most 12 GB, a lower per-app cap, and no command-line llama.cpp.

**What ran** (AWS Device Farm, project `muse-muse-devices`, results in `~/muse-muse-devices/devices/results/devicefarm/`, llama.cpp b11669, `--temp 0`, the reasoning-off template, three fixed prompts: capital, a sum, a paint color):

| Phone | File | CPU tok/s | Phone GPU (OpenCL) tok/s | Prompt tok/s | Answers | Peak memory | Run |
|---|---|---|---|---|---|---|---|
| Galaxy S25 (SM8750, Android 16), 12 GB | r30b IQ1_S, 6.53 GB | 1.94 | 1.59 | 2.37 | 3 of 3 | 7.09 GiB | Nov 1, 03:11 to 03:22 UTC; 11 minutes of kit time, plus 13 minutes to download and 3.5 to push |
| Galaxy S25, 12 GB | r30b IQ2_XXS, 7.96 GB | 1.89 | | 2.22 | 3 of 3 | 7.65 GiB | Nov 1, 02:26 UTC |
| Galaxy S25, 12 GB | stage 2 IQ1_S | 1.86 | 1.59 | 2.38 | 2 of 3 | | Oct 31 |
| Pixel 9 Pro, 16 GB | stage 2 IQ2_XXS | 0.95 | | 1.72 | 3 of 3 | | Oct 31 |

- These ran from `adb shell`, not in an app. An app gets less memory, so this is an upper bound.
- The phone is compute-bound, not memory-bound: the 2-bit file is as fast as the 1-bit one and much better (18.5% against 8.7%, 40/40 old facts). **Use IQ2_XXS on a 12 GB phone.** The 5.75 GB file jetson-02 runs was never tried on a phone.
- A 500-token prompt takes about 3.5 minutes to read at 2.4 tokens a second. One-line questions only.
- These runs are in the model card, but weren't in docs/BUILD_LOG.md until today.

**A cheap plan to show it.**

- **P0, $0, 10 minutes (recommended).** A still card in the video from the Nov 1 S25 result: "Measured on a real Galaxy S25 in AWS Device Farm: one-bit Muse Glimmer 30B, about 2 tokens a second, 3 of 3 simple questions." The result folder has the phone's exact output.
- **P1, re-measure today, about $4.60 expected, $12.75 worst case (owner, about 35 minutes of waiting).** The same harness on the S25 with the 2-bit file. Device Farm bills $0.17 a device minute; on Oct 28 the account had 620 trial minutes, which may cover it (the plan command prints what's left). The Nov 1 run took about 27 metered minutes. The worst case is the job limit: 5 + 70 minutes for one file.

  ```bash
  aws sso login --profile base-test
  cd ~/muse-muse-devices
  npx tsx scripts/devices/devicefarm.ts plan --device "Samsung Galaxy S25" --subjects r30b-iq2_xxs --backends cpu --max-devices 1 --max-usd 13
  npx tsx scripts/devices/devicefarm.ts run --yes --device "Samsung Galaxy S25" --subjects r30b-iq2_xxs --backends cpu --max-devices 1 --max-usd 13
  ```

  `~/muse-muse-devices` has uncommitted harness edits from Oct 31; this doc didn't touch them. The run has video capture off, and the screen would show nothing anyway: the model runs in a shell.
- **P2, a filmed chat on a phone: not ready, skip.** It needs an Android app built on llama.cpp b10353 or newer (the first with the `muse-glimmer` architecture), installed in a Device Farm remote access session ($0.17 a minute) or on a real 12 GB phone. No such app is built or checked, and Qualcomm Device Cloud has never run a job for us (`devices/results/qdc/` doesn't exist). The jetson-02 clip is the better film.

## 5. What may be said in the video

May say (all measured):
- "Muse Glimmer 30B, Meta's model, cut to one bit (5.75 GB), answering on an 8 GB Jetson Orin Nano at about 5 tokens a second." With: "Short answers. It's often wrong."
- "Meta's smallest Glimmer file is 16.8 GB." (docs/MESSAGING.md, checked)
- "On a 12 GB Galaxy S25 in AWS Device Farm, the one-bit file ran at about 2 tokens a second and got 3 of 3 simple questions right." With the date, Nov 1.

Don't say:
- That it reasons, thinks, decides, judges the cold room, reads documents or runs well on 8 GB.
- That it runs with Meta's recommended settings. It doesn't: those loop.
- That it runs on your phone, in an app, or on an iPhone. Or that the 5.75 GB file ran on a phone.
- "Tuned on a board", or "as good as the cloud".

**The clip, if the owner keeps it (shot 10 or the optional 4 seconds in docs/VIDEO.md):** ask "What is 17 * 23? Answer with the number only." through the product's fleet route or `ask_fleet_model`, pinned to jetson-02, with no system prompt. It answers in about 2 seconds after the first token (9 tokens) and was right 2 of 2 times with these settings. Second choice: the warehouse checklist (about 19 s in real time; trim it, keep the speed honest). Lower third, as in docs/VIDEO.md: "Muse Glimmer 30B, one-bit (IQ1_S). Built with Muse Spark Open. 18 and over." If a take is wrong, show the right one with the "often wrong" line, never a claim that it's reliable. The readiness audit advised cutting this clip. These results don't change its quality, only make the take reliable, so the call stays the owner's.

## 6. Steps left

**Owner (Ethan)**

| Step | Time | Cost |
|---|---|---|
| O1. Keep or cut the jetson-02 Glimmer clip (section 5). If kept, film the math prompt at the 7 to 9 PM board slot in docs/VIDEO.md | 5 minutes to decide, about 10 to film | $0 |
| O2. Phone: use the P0 card. Run P1 only if a same-day phone number matters | P0 10 minutes; P1 about 35 minutes, mostly waiting | P0 $0; P1 about $4.60 expected, $12.75 at most, maybe covered by trial minutes |
| O3. The Hub card's "On devices" section says no Jetson run yet. Update it to the Nov 3 run (5.75 GB, 5.2 to 5.5 tokens a second, short and often-wrong answers). Publishing to the Hub is yours | 10 minutes | $0 |
| O4. No requantize and no file swap before the deadline (section 3) | | $0 |

**Hussam (the boards are his; nothing here was changed)**

| Step | Time | Cost |
|---|---|---|
| H1. Keep `jetson-llama` up on jetson-02 for the clip. It is started but not enabled, so after a reboot start it again through the fleet (`systemctl start jetson-llama`, about 100 s to load). The memory guard is transient too: restart it the same way he did on Nov 3 | 2 minutes, plus the load | $0 |
| H2. Leave the drop-in as it is. Today's tries found nothing better than its settings | | $0 |
| H3. Optional, not before the deadline: swap to `muse-glimmer-stage-b-r30b-iq1s-out-q4.gguf` (6.21 GB, public, sha256 on the Hub page). Free about 6.3 GB of disk first (the board has 185 MB free; his `/home/jetson-02/train` is 6.2 GB), stop `muse-device` and Ollama for RAM, point `glimmer.conf` at the new file, restart, and stop if available memory drops under 300 MB | About 1 hour | $0 |
| H4. Optional: if longer answers are wanted, raise `-n` to at most 400 (the fleet route waits 100 s; 400 tokens take about 80 s) | 2 minutes | $0 |

Never jetson-05. Never Glimmer on the laptop.
