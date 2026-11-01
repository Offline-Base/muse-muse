# Muse Glimmer: final plan (Oct 31 to after Nov 4)

Written Oct 31, 8:40 PM EDT. This is planning only: nothing was launched, bought or edited in the repo. It builds on plan-v1.md and applies both critiques; the critique points not taken are listed at the end, one line each. No model reasoning text was opened, only code, logs and count reports.

## The decision

- **r30b ships unless a candidate beats it on the same tests.**
  - Its Q4_K_M went out at 7:50 PM.
  - Its IQ2_XXS and IQ1_S land tonight, followed by the shrink-bench and loop checks.
  - Muse Privacy gets r30b's IQ1_S path and sha256 as soon as the file is scored.
- **Tonight, one queue runs on train-1.** It costs about $115 to $245 on top of 8:15 PM's spend.
  1. **B2, about 9:30 PM.** This is r30b's recipe with one targeted change against over-refusal: refusal rows come only from questions whose answer was never in training, and there are half as many of them. No new training code is needed.
  2. **The dose test, about 11:50 PM.** It asks whether repeating facts teaches more. It starts from stage 2 and runs 5 epochs at lr 2e-4 over 15,000 rows, with one checkpoint per epoch.
  3. **Stage A+, then B2'.** These run only if the dose gains at least 8 points (gate D1). Otherwise B2b runs, if B2 missed exactly one honesty gate, or the queue stops.
  - On the go branch, train-1 is terminated about 5:20 AM EST. The watch would stop it at 9 AM EST.
- **writer-2**, a second 1x A100 40GB (about $45), quantizes the candidates. writer-1 keeps r30b's files, the helpers and Muse Privacy.
- **Nov 1:**
  - GGUF gates on the leader;
  - serving settings: system line, strength, sampling and tools;
  - small files.
- **The pick is at 2 PM, Nov 1.** Swaps with reduced tests are allowed until Nov 2, 4 PM, and only environment swaps from Nov 3, noon.
- **After Nov 4:**
  - A core route at $800 to $1,080 fits what Lambda will have left, about $970 to $1,120.
  - The full route, about $1,600 to $2,400, needs your call.

## What changed from the draft

- **train-1 is already busy.**
  - Since 8:15 PM, GPUs 0 to 3 have been running r30b's final BF16 tests: the full channel check with no time cap, and the 190-item honesty test on r30b, base and stage 2.
  - They end about 9 PM.
  - This also gives r30b the complete channel gate it lacked (at 7:41 PM it had reached 212 of 300 items).
- **No header labels before Nov 4.**
  - On 42,000 direct rows, they would mostly teach the model to answer directly at low strength.
  - They can't help tool calls. No training row has tools, and the header labels would strengthen ` to=user` at exactly the token where a tool call needs ` to=<tool>`.
  - Their one likely win, reasoning on at low strength, is not how knowledge is served.
  - They move to N2, together with tool rows.
- **B2's flags were wrong.**
  - --honest-share applies before mix_reasoning keeps a uniform 70% (r30b asked for 0.25 and got 0.1748), so 0.13 would have trained at 9.1%.
  - The flags below are corrected.
  - The queue refuses any set whose by_kind is more than 2% off its table.
- **B2 changes which rows teach refusal, not only how many.**
- **The dose that gates Stage A+ starts from stage 2.** It is scored on probes whose answer actually appears in a dose row, and it includes a news group.
- **Gates:**
  - New: H9, wrong answers stated as fact on the 2,500, and H10, the 190 run once per finalist.
  - H4 is measured against stage 2's own answers.
  - Non-inferiority margins replace point thresholds.
  - P3 is reported only.
  - For Stage A+ candidates, P2 counts only no-context items.
- **The draft's findings stand.**
  - Training never showed a cutoff or date line, because the template writes them only when there is no system message.
  - The watch's 14:00 UTC deadline is 9 AM EST.
  - The reasoning-off template forbids tool calls.
- **New finding:** tuned-reasoning-off.jinja renders "Reasoning strength: high." unless the caller sends a strength (line 84), but every direct training row said low. A1 tests this.

## Tonight

Times are ET. Clocks fall back at 2 AM, so the hour from 1:00 to 2:00 AM happens twice. train-1 bills $22.32/h and each writer $1.99/h.

### train-1

One script on the machine, job/queue_b2.sh, runs the steps. It logs each step, honors a STOP file, and refuses to launch a training set whose report misses its table by more than 2%.
- Every run uses start-run --no-sync, because the Mac has 14 GB free.
- Before train-1 is terminated, each run's adapter goes to S3 with adapter_to_s3.py --from train-1.

| Step | When | What | Cost | Decides |
|---|---|---|---|---|
| T0 | Running, to about 9:00 PM | r30b's final BF16 tests | | r30b's full H2 and its 190 reference |
| Q1 | 9:30 to 10:55 PM | B2 from stage2-multi, lr 5e-5, 1,875 steps | $32 | |
| Q1t | 10:55 to 11:45 PM | GPU 0: B2's tuned answers. GPUs 1 to 7, the test wave: full channel check (--final --minutes 0); score_probes_reasoning at low and at medium, one GPU each; dev prefilled with named controls and cutoff questions; salient; dev with reasoning on at low. A1 and A2 on r30b use GPUs as they free | $19 | B2's BF16 gates; serving settings |
| Q2 | 11:50 PM to 12:37 AM EDT | Dose run from stage2-multi | $17 | |
| Q2t | 12:37 to 1:00 AM EDT | Dose evals: epoch 0 (stage 2) through epoch 5, plus base, each on 1,840 questions | $9 | D1 |
| Go: Q3 | 1:05 AM EDT to 2:05 AM EST | Stage A+ | $45 | |
| Go: Q4 | 2:05 to 2:40 AM EST | GPU 0: Stage A+'s tuned answers. GPUs 1 to 7: measure_known on the 40,000 Stage B questions | $13 | The measured rows for B2' |
| Go: Q5 | 2:40 to 2:55 AM EST | Assemble B2' on train-1 | $6 | by_kind check |
| Go: Q6 | 2:55 to 4:20 AM EST | B2' from Stage A+ | $32 | |
| Go: Q6t | 4:20 to 5:15 AM EST | B2' test wave, as in Q1t, plus the shipped-config check on r30b, B2 and B2' | $20 | B2' BF16 gates |
| Go: tail (optional) | 5:15 to 6:15 AM EST | Dose from base at lr 1e-4, as design data for N2 | $22 | Nothing ships from it |
| No-go: Q3' | 1:05 AM EDT to about 2:35 AM EST, tests included | B2b, only if B2 missed exactly one honesty gate (rule below), then the shipped-config check. Without B2b, only the check | $51, or $6 | B2b's BF16 gates |
| End | Go: about 5:20 AM EST (6:15 with the tail). No-go: about 2:35 AM EST with B2b, 1:20 AM EDT without | Terminate train-1 | | |

**Cut rules:**
- train-1 never waits more than 45 minutes for code.
  - A step that isn't ready by then is skipped.
  - If nothing is left, train-1 is terminated. Re-renting costs about an hour of setup, about $22; at 7:57 PM, 8x A100 80GB machines were free in two regions.
- If the dose can't start by 12:30 AM EDT, the dose and Stage A+ don't run tonight. Both move to N0.
- If Stage A+ or B2' crashes, it is not retried tonight.
- The 9 AM EST deadline is raised only if B2' is still training at 8 AM. Then it goes to noon EST at most, in .data/aws/train-multi.json.

### writer-1 and writer-2

| When | Machine | What |
|---|---|---|
| Now to about 10:30 PM | writer-1 | r30b quantize (the imatrix finished at 8:06 PM), then copy_out. The IQ1_S path and sha256 go to Muse Privacy and Muse Muse General, with the loop warning |
| About 10:30 PM to 12:30 AM | writer-1 | shrink_r30b.sh (keeps iq2-io-lowest and iq1s-out-q4), then loop_r30b.sh. After that, r30b's local merged, BF16 and Q8_0 files are deleted once each matches its NFS copy's size exactly |
| 10:15 PM | writer-2 (new, us-east-1, cache filesystem attached at launch) | Launch. llama.cpp b11970 from the NFS bin folder, or a 20-minute build. make_venv.sh. Scripts and calibration text come from the NFS. Added to idle_alert.py with a stop time of Nov 1, 8 PM |
| About 11:10 PM to 1:35 AM EDT | writer-2 | B2 quantize with r30b's calibration text, only if B2 passed its BF16 hard gates |
| About 1:40 AM EDT to 4:30 AM EST | writer-2 | B2's GGUF gates (see the Nov 1 list). Then B2's merged, BF16 and Q8_0 files are deleted after an exact size match |
| About 4:35 to 7:05 AM EST | writer-2 | B2' quantize (go branch) |

run_handoff.sh gets three changes:
- a target-host setting, for writer-2;
- a refusal to start quantize.sh with less than 200 GB free;
- a detached start.

The running cutoff and tools helper is left alone and not messaged.

### Code, in the order it is needed

**By about 9:20 PM, for B2:**
1. **trained_answer_split.py** (Mac, standard library only).
   - It checks the 2,500, the 40,000 Stage B questions and, later, the dose probes.
   - For each question, it marks whether the answer or an alias appears in any stage 1 or stage 2 training answer from the same passage.
   - It prints counts only.
   - On the 2,500 it should reproduce the critique's 1,917 trained and 583 never trained.
2. **assemble_stage_b.py:** --trained-answers FILE and --measured-wrong-untrained-only, plus a test_stage_b case.
3. **stage_b_lib.Screen:** both eval-probe files join the near index, for Stage B sets only, plus a test case.
4. **train_glimmer.py:** the error messages at lines 170 and 212 print the row index, row type and lengths, never text.

**By 10:15 PM, for writer-2:**

- **idle_alert.py:**
  - The terminated GH200 comes out. It reports $60 for that machine and fails an ssh check every 5 minutes.
  - writer-2 goes in, with its stop time.
- **run_handoff.sh:** the three changes listed above.

**By about 10:45 PM, for the test wave:**

5. **measure_known.py:**
   - --adapter none;
   - --system TEXT, or --no-system with --knowledge-cutoff and --current-date;
   - --strength;
   - --temperature, --top-p, --top-k, --seed and --repeat;
   - every setting recorded in the meta file.
6. **compare_stage_b.py:**
   - --reference, taking stage 2's answers, for H4;
   - r30b as the reference run;
   - H1 to H9 coded;
   - splits by topic group, by trained versus never-trained answer, and by paraphrase band.
7. **The test-wave script.**

**By about 11:30 PM, for the dose:**

8. **train_glimmer.py:**
   - KNOWLEDGE_SAVE_LIMIT (0 keeps every checkpoint) and KNOWLEDGE_SCHEDULE, with defaults unchanged;
   - run_multi.sh and start-run pass both through;
   - test_glimmer_labels.py on train-1 confirms the labels are byte-identical to r30b's.
9. **make_dose_set.py** (Mac) and **dose_gate.py.**
10. **queue_b2.sh.**

**By 1:00 AM EDT, for the go branch:**

11. **make_stage_a_plus.py** (standard library only). It runs on train-1 against the stage files already there.
12. **Copy to train-1**, with sha256 checks: assemble_stage_b.py's inputs and the trained-answer labels.

**Nov 1:**

13. **shrink_bench.sh:** the iq2s-io-lowest candidate.
14. **make_calibration.py:** v2.

Optional: average_adapters.py.

Every launch, result and decision goes into docs/KNOWLEDGE_RUN_LOG.md and is committed locally. No PR.

## Recipes

### B2

- **Setup:**
  - Starts from stage2-multi.
  - lr 5e-5, cosine with 3% warmup, 1 epoch, 1,875 steps.
  - r30b's labels: final channel on direct rows, whole turn on reasoning rows.
  - r30b's base answers are reused.
- **Flags:** `--honest-share 0.20 --measured-wrong-max 0.19 --measured .data/knowledge/runs/stage-b-measure/measured.jsonl --trained-answers <labels> --measured-wrong-untrained-only --reasoning stage-b-reasoning.jsonl --reasoning-share 0.30 --max-total 60000 --seed 20261031`, followed by r30b's seeded shuffle.
- **Expected set,** worked through plan_sizes and mix_reasoning on the real pools:

| Kind | B2 | r30b |
|---|---|---|
| Reasoning (the existing pool of 26,919 base-Glimmer rows, unread) | 18,000 | 18,000 |
| Written honest kinds (false premise, after cutoff, unknowable) | about 5,810 | 6,036 |
| Cutoff restated | about 990 | 801 |
| Measured wrong, trained as refusals | about 1,600, never-trained answers only | 3,652, any |
| Measured right | about 8,440 | 7,023 |
| Replay | about 4,200 | 4,091 |
| Contrast | about 20,960 | 20,397 |
| Honest share | 14.0% | 17.5% |

- **Why:**
  - r30b refuses about 7% of stage 2's right answers and 22% of its wrong ones.
  - Among wrong answers, it refuses about as often where the answer was trained (21.4%) as where it never was (23.8%).
  - Its refusal rows came from a single greedy miss on questions about trained passages, so they include facts the model half knows.
  - Teaching refusal only on answers the model never saw should cut refusals of facts it knows.
  - The written kinds, which drive made-up answers on dev, stay close to r30b's level.
- **If the pool is short:** if fewer than about 1,900 never-trained wrong rows survive the screen, the flags are recomputed with plan_sizes before launch.
- K=8 sampling to label known and unknown waits for N4.

### Dose test

- **dose-train:** 15,000 rows.
  - Every stage 1 and stage 2 fact row from passages drawn at random (seed 20261101), about 2,800 passages in all.
  - 3,750 rows from each of four groups: Meta, AI first-party, Wikipedia current events and CC-NEWS.
  - Passages that hold any of the 2,500, any of the 40,000 or any test-set item are left out.
  - Every row was trained before, so nothing new enters training.
- **Questions (1,840):**
  - 1,000 held-out probes on those passages whose answer appears in a dose row (coverable);
  - 300 whose answer doesn't, as a control that shouldn't move;
  - 500 training questions, verbatim;
  - the 40 old facts.
- **Run:**
  - From stage2-multi, lr 2e-4, constant after 3% warmup.
  - 5 epochs (2,345 steps), a save every 469 steps, all saves kept.
  - Evals cover epochs 0 to 5 and base, one model per GPU.
  - P(=self) on epoch 5 is reported only.
- **D1: Stage A+ goes ahead if all of these hold.**
  - The best epoch beats epoch 0 by at least 8 points, paired p < 0.05, on the 750 coverable probes from Meta, AI and events. CC-NEWS's 250 are reported, to size N2.
  - At least 5 of those points hold on probes below 0.4 similarity to any dose-row question.
  - The uncovered control drops by 2 points or less.
  - Old facts stay at 39/40 or better.
  - E is the smallest epoch within 2 points of the best.
- **Why 8 points:**
  - Stage A+ reaches only the Meta, AI and events share of the 2,500.
  - At that share, 8 points on covered probes is worth about +1 to +2 points on the 2,500, and more on the Meta 137.
  - That is about the least gain that can still show as a paired win after Stage B's usual 1-point loss.

### Stage A+ (go only)

- **Training:** from stage2-multi at lr 2e-4, constant after 3% warmup, for E epochs and 200,000 passes in all (40,000 rows at E=5, 66,666 at E=3).
- **Rows:** already trained in stages 1 and 2, taken as whole passages and chosen by source group only.
  - 85% of the file, filled in this order: Meta (up to 34,259 rows), then AI first-party (41,716), then Wikipedia current events (20,548), then CC-NEWS AI and Meta news.
  - 10% rehearsal from CC-NEWS, Wikipedia articles and other sources.
  - 5% replay.
- **Held out:** probe questions stay out and their passages stay in, as in stages 1 and 2.
- **Labels:** r30b's labels, with no reasoning rows. B2' repairs the channels the way r30b repaired stage 2 (P(=self) went from 1.2e-05 to 0.999998).
- **Reporting:** its tuned answers on the 2,500 are reported as the knowledge ceiling before Stage B.

### B2' (go only)

B2's recipe, starting from Stage A+. Its measured rows come from Stage A+'s answers to the 40,000, with the same trained-answer labels. If B2 failed H3, H4 or H9, B2' takes the matching B2b change instead.

### B2b (no-go only, and only if B2 missed exactly one honesty gate)

| B2 result | B2b change |
|---|---|
| H4 failed (still over-refusing) with at most 14 made up | Measured wrong cut to about 800 |
| H3 or H9 failed (too many made-up answers) | Measured wrong back to about 3,600, never-trained answers only |

The flags come from plan_sizes, and the queue checks by_kind.

### Optional free rider

If B2 and r30b land within 1 point on P1, their exact 50/50 average is scored on the 2,500 and dev in a spare GPU slot.
- The average is a rank-128 adapter built on CPU: B and A concatenated with sqrt(0.5) scaling, alpha 128.
- It ships only if it passes every gate.
- It is skipped if its script isn't ready.

## Gates

### Hard gates for a swap against r30b

Any failure means no swap.

| Gate | Requirement |
|---|---|
| H1 | Old facts at 39/40 or better on BF16, Q4_K_M and IQ2_XXS |
| H2 | Measured with --final: P(=self) and P(assistant) at least 0.99; at least 247 of 260 well formed; multi-step and skills within 3 of base; median and p90 reasoning length within 25% of base; at least 35 of 40 with reasoning off; vision 5/5 on Q4_K_M with the mmproj |
| H3 | Dev: at most 17 of 120 made up (r30b: 14) and at least 96 honest. The rule grader decides for every candidate except the two finalists, whose 120 replies are graded by hand (final channel only) |
| H4 | Refusals of stage 2's 755 right answers, scored against stage 2's own answers: not above r30b's 54 at one-sided p < 0.1. The target is 37 (5%) |
| H5 | Controls right not below r30b's 33.7%, and controls refused not above its 18.0%, both at one-sided p < 0.1 |
| H6 | At least 15 of the 20 cutoff questions answer Oct 28 or 29 |
| H7 | Tool calls on the bare prompt not below r30b's. Applies only if the tuned model serves tools (see A3) |
| H8 | Q4_K_M within 1 point of the candidate's BF16; IQ2_XXS and IQ1_S not below r30b's at one-sided p < 0.1; IQ1_S loop rate not above r30b's |
| H9 | Wrong answers stated as fact on the 2,500: at most r30b's 53.6% plus 2 points, paired. Reported separately on the 1,917 trained-answer probes and the 583 never-trained ones |
| H10 | The 190-item test, run once at decision time on the finalist's and r30b's Q4_K_M: audited made-up rate at most r30b's plus 5 points, audited honest rate at least r30b's minus 5 |

### Primary metrics

A swap needs a win on at least one primary metric at paired p < 0.05, and no loss of more than 1 standard error on any of them.

| Metric | Test set | r30b | Rule for Stage A+ candidates |
|---|---|---|---|
| P1 | The 2,500 | 29.0% | The win must also hold on probes below 0.4 similarity to their passage's trained questions |
| P1m | The Meta 137 | 35.8% | |
| P2 | Salient 246 | 69.1% | Only items whose answer is in no training row count (salient_report's answer_with_context=false) |
| P4 | IQ2_XXS and IQ1_S on the 2,500 | | |

P1 is reported by topic group, and split into trained-answer and never-trained probes.

**Reported, not gated:**
- Dev with reasoning on at low strength. r30b: 88 of 120 well formed, 33 made up.
- P(=self) and multi-step at low strength.
- The split between direct and to=self replies at each strength.

## Nov 1 to Nov 2

### Serving settings (decided by noon, Nov 1)

**A1: system line and strength.** Runs on train-1 in BF16 during Q1t, on r30b with greedy decoding. It covers 2,940 questions: the 2,500, dev's 120, 300 controls and the 20 cutoff questions. About $8.

| Prompt | System block | Strength |
|---|---|---|
| P0 | "You are a helpful assistant." (as in training) | low |
| P0h | The same | high (what tuned-reasoning-off.jinja sends by default) |
| P1 | P0 plus "Knowledge cutoff: 2026-10-29." and "Current date: 2026-11-01." | low |
| P2 | No system message; knowledge_cutoff and current_date passed as kwargs | low |
| P3 | No system message; template defaults (cutoff 2026-01-04) | default (high) |
| P4 | Muse Privacy's real system text | its own |

Rules:
- If P0h trails P0 by more than 1 point, or adds more than 2 made-up answers, the default strength in tuned-reasoning-off.jinja becomes low.
- P1's two lines are adopted if refusals fall by at least 2 points, made-up answers rise by at most 2 of 120, and H6 still holds.
- If P3 refuses more than P2, the default cutoff in the tuned templates becomes 2026-10-29.
- If P4 trails P0 by more than 2 points on any measure, Muse Privacy is told what to change.
- Otherwise P0 ships.
- The helper's cutoff test is read only after checking which system block it actually rendered.

**A2: sampling.** Runs in the same wave, on r30b in BF16: the 600-probe subset and dev, at 1.0/0.95/64 and at 0.6/0.95/64, with 3 seeds each. About $4.
- GGUF loop rates come from loop_r30b.sh, which already runs both greedy and Meta's sampling.
- Serving uses Meta's settings for chat and for reasoning on.
- Knowledge answers with reasoning off drop to temperature 0.6 only if 1.0 loses more than 2 points or adds more than 2 made-up answers.
- Gates stay greedy.
- The shipped-config check reruns the settings that will ship on r30b and the leaders (H3, H4, H6 and P1, 3 seeds).

**A3: tools.** The helper's result on the bare prompt decides.
- If r30b is within 3 points of base, nothing changes.
- If it is worse, tool turns go to base. There are two ways to do that:
  - **Preferred:** a second llama-server running base Q4_K_M. Both servers fit on one GH200, and both models are already scored.
  - **Fallback:** the adapter-scale route. The server runs base Q4_K_M plus the 838 MB adapter, with scale 0 held for a whole tool conversation.
    - Knowledge turns then go through the adapter at scale 1, a path that has never been scored.
    - That path decodes at 37.5 tok/s against 50.7, so before use it needs the 2,500, the old facts and dev scored on it (25 minutes of writer time).
- If neither route works, the demo has no tools.

**A6: DFlash.**
- The drafter stays off by default on the Mac and phone files (the 7:25 PM decision).
- Base Q4_K_M and r30b Q4_K_M go through the same test on writer-1, about 15 minutes each, so N7's trigger has a baseline.

### GGUF gates (Nov 1, about 7 AM to 1 PM EST)

- **writer-2:** the leader's Q4_K_M, IQ2_XXS and IQ1_S get:
  - dev honesty;
  - vision 5/5 with --mmproj;
  - the tool test on the bare prompt;
  - the loop check.
  B2's files are checked overnight.
- **writer-1:**
  - Muse Privacy's tests;
  - vision and the tool test on r30b;
  - the DFlash baselines;
  - H10, at about 1 PM.
- **Morning:** a hand grade of both finalists' 120 dev replies, reading the final channel only.

### Small files (A5, Nov 1, writer-2, about $10)

- **Phones (12 GB, so a file of at most about 7.2 GB):**
  - First choice: the pick's iq2-io-lowest (7.18 GB), if it is within 1 point of stock IQ2_XXS and passes the loop check.
  - Otherwise stock IQ2_XXS (7.96 GB). It ran on the S25, but it breaks the 70% rule.
- **Mac (16 GB):**
  - A new shrink_bench candidate, iq2s-io-lowest: IQ2_S with iq1_m input and output tensors, about 8.4 to 8.6 GB.
  - If it beats IQ2_XXS by 2 points or more, it is tested on the AWS Mac in a lab idle window.
- **Muse Privacy:** the pick's IQ1_S.
- **imatrix v2:** 1M tokens of the pick's own training text.
  - Leaves out reasoning rows, rows whose passage holds any of the 2,500, and event rows that hold salient answers.
  - Screened against every test set, and never previewed.
  - About 64 minutes, plus requants and scores.
  - New files are kept only on a paired gain of at least 1 point on the 2,500, with old facts at 39/40 or better and dev honesty and loop rate no worse.
- **8 GB devices:** no usable Glimmer file exists. The demo says so, and the LFM3 student comes after Nov 4.

### Delivery

- **Nov 1, 2 PM: the pick.**
  - The IQ1_S and phone-file paths go to Muse Privacy and Muse Muse General with their sha256s.
  - If the pick isn't r30b, run lab.py add glimmer-final.
- **Until Nov 2, 4 PM: later swaps.** A later winner can swap in with reduced tests, for example B2' if its GGUFs miss 2 PM. These tests are fixed now:
  - the 2,500 and old facts on Q4_K_M, IQ2_XXS and IQ1_S;
  - dev honesty, prefilled;
  - channel gates with --final, from its BF16 wave;
  - salient;
  - the IQ1_S loop check;
  - H9.
- **From Nov 3, noon:** environment swaps only.

## If something fails

- **The default:** r30b ships. That means Q4_K_M on the server, the phone file chosen in A5, and IQ1_S for Muse Privacy. A candidate replaces it only after passing every hard gate, so nothing tonight can make the shipped model worse.
- **r30b scores below 5/5 on vision, or its tools regressed:** the demo makes no vision claim for the tuned model, and tool turns follow A3.
- **B2 fails a BF16 gate:** B2 isn't quantized, and the queue continues.
- **The dose isn't ready by 12:30 AM EDT, or crashes:** Stage A+ doesn't run. B2b runs if its rule applies, and the dose moves to N0.
- **Stage A+ or B2' fails:** B2 ships if it passed, otherwise r30b.
- **No candidate finishes its GGUF gates by 2 PM:** r30b goes into Muse Privacy's full test sequence. A later winner can still swap in by Nov 2, 4 PM.
- **train-1 is lost:** whatever finished stands. Any Nov 1 to 2 follow-up runs on a GH200 at $2.29/h.
- **The classifier stops something:**
  - Before Nov 4, no new reasoning text is created. Only the existing 26,919 rows are used, unread.
  - Anything stopped goes to the owner.

## After Nov 4

### What our hardware can't run

- **Meta's Spark Open recipes:** they need 128 or more Blackwell GPUs, and Spark Open is shelved.
- **TitanRL's verified Glimmer GRPO:** it was verified on 8x H100 95 GB with FlashAttention-3 and peaks at 93 GiB.
  - Lambda's and AWS's H100s are 80 GB.
  - What fits is AWS p5en (H200, $63.30/h; no capacity on Oct 30) or 8x B200 (none free tonight).
  - So RL here means TRL with LoRA.
- **On-policy distillation and DFlash training:** no Glimmer recipe exists for either, so both would be new code.

Proven here: Unsloth BF16 LoRA under DDP, on 8x A100 80GB (61.9 to 63.7 GB per GPU) and on one GH200.

### Phases at measured rates

Rates on 8x A100:
- direct rows: 30 to 34 a second;
- rows with reasoning: about 5 a second;
- vLLM on train-1: about 40,000 reasoning replies an hour, 79% kept;
- measure_known: 40,000 questions in 31 minutes.

Every phase starts with a 1 to 2% pilot that measures its own rate.

| Phase | What | Machine | Hours | Cost |
|---|---|---|---|---|
| N0 | Eval v2: story-cluster split, 2,000 never-trained facts, monthly ladder, salient-2 frozen first, tool suite. Design arms: the dose from base, and a diversity arm (both writers' question sets once, against one set twice, on the 31,800 passages that have both). Base and r30b DFlash baselines, if not done | 8x A100 | 2 to 3 | $45 to $70 |
| N1 core | Facts clustered across sources from the existing Q&A (CPU); 8 to 12 contexts for each of 20,000 to 40,000 core facts (AI, Meta, top news); about 60,000 fact rows carrying Glimmer's own reasoning, by context distillation; about 10,000 tool trajectories | 8x A100, 8 vLLM servers | 6 to 8 | $135 to $180 |
| N2 core | Stage A v2: whole-turn labels on every assistant message (headers, reasoning, final, tool calls), a pinned system block, strengths low, medium and high, 2 epochs. A rank 64 against 128 pilot first | 8x A100 | 12 to 16 | $270 to $360 |
| N4 | Honesty with reasoning: K=8 known or unknown (measured with reasoning off), hint distillation, Stage B v2, then DPO on the merged SFT model with a fresh LoRA (beta 0.1, lr about 5e-6, about 20,000 pairs) | 8x A100 | 6 to 8 | $135 to $180 |
| N6 | Small files: a runtime r16 LoRA trained by logit distillation on the dequantized IQ2_XXS and IQ1_S, served with --lora and never folded in; imatrix v2 | 8x A100 for 2 h, writer for 10 h | | $65 to $90 |
| N8 | LFM3 1.7B student on train-student-honest.jsonl (577,806 Glimmer-only rows) | 1 GH200 | 6 to 8 | $15 to $20 |
| Evals | 4 to 5 candidates | 8x A100, writer | 6 to 8 | $135 to $180 |
| **Core total** | | | | **$800 to $1,080** |
| N3 | On-policy self-distillation, 2 to 3 rounds, run offline: vLLM samples the student, vLLM writes the teacher's top-20 prompt logprobs with the passage in context, and a new kd mode in train_glimmer.py trains on them | 8x A100 | 8 to 15 | $180 to $335 |
| N5 | RL calibration: TRL GRPO with vLLM in server mode, LoRA. Final-channel rewards: +1 right; +1 for an honest decline on an unanswerable question; 0 for declining an answerable one; -1 for a wrong answer stated as fact; -1 for a malformed reply; a length penalty | 8x A100 | 7 to 11, including a $35 to $70 port | $170 to $250 |
| N7 | DFlash retrain, only if N0's baseline shows acceptance fell by 30% or more | 8x A100 | 6 to 8 | $135 to $180 |
| Wider tiers | Middle facts (4 to 6 contexts) and tail facts (2 to 3) in N1 and N2 | 8x A100 | 13 to 25 more | $290 to $560 more |
| **Full total** | | | | **about $1,600 to $2,400** |

**Budget.**
- About $970 to $1,120 of Lambda is left after Nov 4. The core route fits; anything beyond it needs your call.
- The two ways to pay for more:
  - raise the Lambda limit;
  - put N3, N5 and N7 on AWS credits, about $2,000 left if Bedrock counts. Check capacity first with describe-capacity-block-offerings (read-only): on Oct 30, every on-demand 8-GPU type failed.
- First cuts, in order: N5, N7 (unless N0 shows a drop), N3.
- Lambda had 8x H100 80GB free at 7:57 PM at $31.92/h. If it runs this stack at about twice an A100's speed (not measured), it is about 28% cheaper per unit of work. A one-hour N2 pilot ($32) settles that.

**Build and smoke-test first:**
- a separate venv or container pairing current TRL with vLLM 0.32, leaving the SFT venv untouched;
- DPO on that stack;
- the kd mode's peak memory over 100 steps (a full-vocabulary normalizer at batch 4 x 2,048 is about 3.3 GB in BF16, so compute it in chunks or use batch 2 with 2 accumulation steps);
- gguf-py's i-quant dequantizing, with a reverse tensor-name map;
- DFlash GGUF conversion;
- LFM3 under Unsloth;
- a second rate in assemble_stage_b.py's estimator, for rows with reasoning.

**Method notes:**
- **N2:** the system block is pinned the same way in training and serving. Half the rows have no system message, with knowledge_cutoff 2026-10-29 and a per-row current_date. The other half carry app-style text containing both lines.
- **N4:** owner-gated because of the classifier. Claude writes only the hint templates.
- **N5:** RL shapes behavior and doesn't add facts, so N5 only calibrates.
- **Reasoning text:** every step that produces reasoning runs as a GPU script, unread, with counts-only reports.

## Cost

| Item | Cost |
|---|---|
| Lambda spent at 8:15 PM | about $985 |
| train-1 from 8:15 PM, by branch | no-go $115; no-go with B2b $165; go $225; go with the tail $245 |
| writer-2, Oct 31 10:15 PM to Nov 1 8 PM | about $45 |
| writer-1 to Nov 4, 9 PM | about $195 (about $65 less if it stops Nov 3 at noon) |
| Cache filesystem (535 GB) and the compare-lab GH200 for filming | about $40 to $60 |
| **Lambda total by Nov 4** | **about $1,380 to $1,530 of $2,500** |
| AWS before Nov 4 | Device Farm stays under its $40 cap; the lab Mac is Muse Muse General's |

Before each launch, spend is recomputed from idle_alert's status and .data/aws/train-multi.json.

## Risks

1. **Code on the critical path.** B2 needs four small changes by about 9:20 PM, and the dose needs its scripts by 11:30 PM. The cut rules cap idle time at 45 minutes.
2. **Overnight driving.** The on-machine queue, the STOP file, the detached handoffs and idle_alert cover a dead session. The Mac must stay awake and online, because the watches and handoffs run on it.
3. **Fewer refusals, more made-up answers.** B2 may raise wrong answers stated as fact. H9 and H3 catch that, and B2b has a fix for either direction.
4. **The dose and Stage A+ may overfit or forget.** D1 checks old facts and the uncovered control, B2' re-measures before its Stage B, and P1 is read by topic group and by similarity band.
5. **Leakage.** Rows are chosen by source group only. The Stage B near-screen includes the 2,500. For Stage A+ candidates, P2 counts only no-context items. imatrix v2 has the exclusions listed above.
6. **Grader errors.** The rule grader misgraded 7 of 16 adversarial replies. The finalists get a hand grade on dev, and the 190 gets a hand audit, final channel only.
7. **Gate settings differ from shipped settings.** A1, A2 and the shipped-config check cover this.
8. **writer disk and lock.** writer-2 takes the candidates. A quantize starts only with at least 200 GB free, and files are deleted only after an exact size match.
9. **Capacity.** Once train-1 is terminated, an 8x A100 may not come back. A GH200 is the fallback for Nov 1 to 2.
10. **Small files.** Below 2 bits, most new knowledge is lost: IQ1_S keeps about 8 to 9%. 8 GB devices can't run Glimmer.
11. **Device logins.** The base-test SSO expires about 2:41 AM Nov 1. The AWS Mac needs an idle window from Muse Muse General.
12. **The classifier, after Nov 4.** N1, N3, N4 and N7 generate Glimmer reasoning on GPUs, the earlier route. It may still be stopped; if so, the step stops and goes to the owner.
13. **Unverified tools after Nov 4.** Each needs a smoke test before its phase is rented.
14. **Licenses (unchanged by this plan).** Open questions remain on:
    - CC-NEWS;
    - whether Spark-written data makes the model a Muse Model License derivative;
    - Liquid's revenue-limited license for LFM.

## Rules kept

- **Off limits:**
  - the Meta Model API;
  - Fireworks;
  - muse-spark-1.3 as a writer;
  - any Spark Open plan.
- **Keys:**
  - The Lambda key stays on the Mac.
  - No HF token or other key goes on a GPU machine.
  - Transfers stream through the Mac.
- **Test sets:**
  - Test sets never go into training.
  - Selection is by source group only.
  - Reports print counts only.
- **The student:** Glimmer-lineage only, and it is LFM3 1.7B.
- **The owner's laptop:** no Glimmer runs on it.
- **Reasoning text:** Claude never reads, rewrites or relays model reasoning text.
  - Errors and reports print counts, indices and lengths.
  - Hand grading reads only the strict final-channel field, and skips rows without one.
  - Reasoning-on and tool tests report counts and parsed call names only.
- **Logging:**
  - Every step goes in docs/KNOWLEDGE_RUN_LOG.md and is committed locally.
  - No PR.

## Your decisions

1. **Tonight's queue.** It is within your standing limits and runs by default. Say stop if you'd rather keep the $115 to $245 for after Nov 4.
2. **Budget after Nov 4.** The core route (about $800 to $1,080) fits. The full route (about $1,600 to $2,400) needs a Lambda limit raise or AWS credits.
3. **Tools.** If the tuned model's tool calls regressed, may tool turns go to base Glimmer on a second server, with the demo saying so?
4. **Template defaults.** If A1 supports it, may tuned-reasoning-off.jinja default to strength low and cutoff 2026-10-29? KNOWLEDGE_UPDATE.md moves the cutoff only once the evals show the model knows the window, and today it scores 29% on the 2,500 and 69% on salient.
5. **Reasoning generation after Nov 4.** N1, N3, N4 and N7 generate Glimmer reasoning on GPUs. The classifier stopped that kind of step twice on Oct 31. Go ahead on that route, or skip those phases?
6. **Phone test on Nov 1.** A phone test of the pick needs you to sign in to base-test again after about 2:41 AM. Do you want one?
7. **writer-1.** Stop it Nov 3 at noon (saving about $65), unless Muse Privacy or Muse Muse General still need it?

## Critique points not taken

- **Reasoning rows in Stage A+ (method).** Not taken.
  - With header labels off, Stage A+ trains like stages 1 and 2. Their drift was already fixed by B2-style repair: P(=self) went from 1.2e-05 to 0.999998.
  - 20,000 reasoning rows at about 5 a second would add about an hour to the overnight critical path.
- **Stage A+ on stage_b_lib's SHARES (method).** Not taken.
  - At 200,000 passes, a 30% news share spreads over 400,000+ CC-NEWS rows and reaches only a few percent of news passages.
  - Instead, Stage A+ fills Meta, then AI, then events, and keeps 10% rehearsal from news and other sources.
  - The dose test's CC-NEWS group sizes news for N2.
- **Eval-probe near-screen for Stage A+ (method).** Not taken for Stage A+ only.
  - Stage A+ exists to repeat the rows that teach the passages P1 asks about, so the screen would remove its signal.
  - Instead, a Stage A+ win on P1 must hold below 0.4 similarity.
  - The screen does apply to B2, B2' and B2b.
- **K=8 re-measurement tonight (method).** Not run tonight.
  - The critique's own no-GPU fallback is used instead: never-trained answers found by string match.
  - K=8 needs new sampling code and about 40 minutes of train-1 before B2 could start.
  - K=8 stays in N4.
- **Header-label B2 in the no-go slot (feasibility).** Not taken.
  - Header labels on direct rows would likely shift routing at low strength, and they can't help tools.
  - Their one likely win isn't how knowledge is served.
  - They move to N2, with tool rows.
- **Low-strength checks as H2 gates, and D0 on CHAT_SHAPES (method).** Not gated.
  - No candidate before Nov 4 changes r30b's labels.
  - Reasoning on at low strength isn't a shipped path.
  - Both are reported now, and become gates for N2.
- **Starting B2-0 at once (feasibility).** Overtaken by events.
  - Since 8:15 PM, train-1's GPUs 0 to 3 have been running r30b's final tests, until about 9 PM.
  - B2 starts when its set is ready, about 9:30 PM.
  - The rest of that point is taken: no new training code for B2, the dose second, no header labels.
- **The dose from base tonight (feasibility).** Moved to an optional tail step, or to N0.
  - It doesn't change what ships.
  - It would add 45 to 60 minutes before D1.
- **--honest-share 0.186 for a 13% share (method).** Replaced by the critique's other option, 0.20 with --measured-wrong-max 0.19. That option cuts only measured-wrong rows and keeps the written kinds near r30b's level.
- **Changing mix_reasoning to keep every measured-right row (both critiques).** Not taken tonight.
  - With the 0.20 and 0.19 flags, measured-right already rises to about 8,440.
  - A code change on the critical path isn't worth the last 1,600 rows.
