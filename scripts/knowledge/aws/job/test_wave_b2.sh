#!/bin/bash
# B2's test wave on train-1 (8x A100 80GB), the final plan's Q1t, with the serving-settings tests A1 and A2 on the reference run.
#   bash test_wave_b2.sh RUN [REF]        RUN: B2's run name (~/k/runs/RUN); REF: the reference run, stage-b-r30b by default
#   DRY=1 bash test_wave_b2.sh RUN        prints the plan and every command, starts nothing, needs no GPU or box.env
# Start it detached once B2 is training (it waits for the adapter):
#   cd ~/k/stage-b || exit 1; setsid nohup bash test_wave_b2.sh RUN > ~/k/runs/RUN/tests-b2.log 2>&1 < /dev/null &
#
# GPU 0 stays with B2's own tuned answers (train_glimmer.py's rank 0 answers the 2,500 and the old facts after saving the
# adapter, into ~/k/runs/RUN/out/answers.json) and joins the pool when it is free. GPUs 1 to 7 take, in this order:
#   ch           the full channel check, no time cap (--minutes 0), then its gates with --final (vision is not measured here,
#                so --final exits 1 on that line alone; ch-gates.txt says which lines passed)
#   know-low     score_probes_reasoning.py at low, paired with the tuned answers (waits for answers.json)
#   know-medium  the same at medium
#   dev          the dev set prefilled, with the named controls and the cutoff questions
#   salient      measure_known.py on salient_probes.jsonl, then merged
#   dev-on       the dev set with reasoning on, at low
# then, on REF, as GPUs free up (each a separate model load, so one GPU each):
#   A1  the prompt arms: P0 as trained; P0h strength high; P1 P0's system text plus the cutoff and date lines; P2 no system
#       message, cutoff and date as template kwargs; P3 no system message, template defaults (strength default). Each arm runs
#       measure_known.py on the 2,500 and score_honesty_bf16.py on dev's 120, 300 controls and the 20 cutoff questions, greedy.
#       P4 (Muse Privacy's own system text) runs only if P4_SYSTEM_FILE names a file holding it (P4_STRENGTH, low by default):
#       the text isn't in the repo. Before the GPUs start, measure_known.py --render-only writes each arm's rendered system
#       block to a1/ARM.prompt.json, so the arm is read only after checking what it rendered.
#   A2  sampling at 1.0/0.95/64 and 0.6/0.95/64: measure_known.py on the 600-probe subset (score_gguf.py's: the 2,500 shuffled
#       with random.Random(7), first 600) with --repeat 3 --seed 1 (seeds 1, 2, 3), and dev (with controls and cutoff
#       questions) once per seed.
# A job that needs a file (know-*: the tuned answers) waits for it, up to NEEDS_MIN minutes from the wave's start, while
# other jobs fill the GPUs. A GPU is used only when nvidia-smi shows nothing on it.
#
# Outputs: ~/k/runs/RUN/tests-b2/ (a1/ and a2/ for the reference run's arms), logs/NAME.log, status.tsv (one line per job:
# name, GPU, start, end, exit), and done.txt: ALLDONE (or STOPPED) on its first line, then each job's exit code. If
# compare_stage_b.py and stage_b_lib.py sit in ~/k/stage-b, gates.txt is the H1 to H9 report on B2 against REF (stage 2's
# answers from ~/k/runs/stage2-multi/out/answers.json); otherwise run it on the Mac. A file named STOP in ~/k or in the
# output folder stops new jobs from starting; running ones finish.
# Environment: PROBES and FORGET (the 2,500 and the 40 old facts; ~/k/data-stage2-multi/), CH_BASE (base's full channel run),
# WAVE_GPUS ("0 1 2 3 4 5 6 7"), POLL (20 s), WAIT_MIN (240: how long to wait for the adapter), NEEDS_MIN (120),
# PREFLIGHT_MIN (45: how long a failed preflight is retried, for files copied after this script),
# SKIP_A1=1, SKIP_A2=1, START_NOW=1 (the adapter is already there; don't wait for the training log's adapter_saved line).
set -uo pipefail
RUN=${1:?usage: test_wave_b2.sh RUN [REF]}
REF=${2:-stage-b-r30b}
DRY=${DRY:-0}
K=${K:-$HOME/k}
if [ -f "$K/box.env" ]; then
  source "$K/box.env"
elif [ "$DRY" = 1 ]; then
  MODEL_PATH='$MODEL_PATH'
else
  echo "WAVE no $K/box.env"; exit 1
fi
SB=$K/stage-b
R=$K/runs/$RUN
A=$R/out/adapter
RA=$K/runs/$REF/out/adapter
O=$R/tests-b2
PROBES=${PROBES:-$K/data-stage2-multi/probes.jsonl}
FORGET=${FORGET:-$K/data-stage2-multi/forget.jsonl}
CH_BASE=${CH_BASE:-$K/runs/stage-b-r30/tests/ch-base.json}
STAGE2_ANSWERS=${STAGE2_ANSWERS:-$K/runs/stage2-multi/out/answers.json}
POOL=${WAVE_GPUS:-0 1 2 3 4 5 6 7}
POLL=${POLL:-20}
WAIT_MIN=${WAIT_MIN:-240}
NEEDS_MIN=${NEEDS_MIN:-120}
PREFLIGHT_MIN=${PREFLIGHT_MIN:-45}
# The 2,500 on the Mac (.data/knowledge/dataset/stage2-eval-probes.jsonl); a different file is reported, not refused.
PROBES_SHA=6703716fc7fd6133cbd5c7cbd3501da26130fffbc93e6976e9046f9d6fea4b9b
PY=$K/venv/bin/python
E="env KNOWLEDGE_MODEL=$MODEL_PATH KNOWLEDGE_4BIT=0 HF_HOME=$K/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false"
H="--probes stage-b-honesty-dev.jsonl --controls-file eval-probes.jsonl --cutoff-questions cutoff_questions.jsonl"
HN="$H --named-controls stage-b-named-controls.jsonl"
P1_SYSTEM=$'You are a helpful assistant.\nKnowledge cutoff: 2026-10-29.\nCurrent date: 2026-11-01.'
export P1_SYSTEM

say() { echo "[$(date -u +%FT%TZ)] WAVE $*"; }

# The job table: NAME, NEEDS (a file that must exist first, or -), and the command, run in ~/k/stage-b, with @GPU@ for the GPU.
NAMES=(); NEEDS=(); CMDS=()
job() { NAMES+=("$1"); NEEDS+=("$2"); CMDS+=("$3"); }

b2_jobs() {
  job ch - "$E $PY check_channels_bf16.py --adapter $A --label $RUN --out $O/ch.json --tokenizer $MODEL_PATH --allow-code-exec --minutes 0 --gpu @GPU@; rc=\$?; $PY check_channels_bf16.py --gates $O/ch.json --base $CH_BASE --final > $O/ch-gates.txt 2>&1; echo \$? > $O/ch-gates.exit; exit \$rc"
  for s in low medium; do
    job know-$s $R/out/answers.json "$E $PY score_probes_reasoning.py --adapter $A --tokenizer $MODEL_PATH --label $RUN-$s --out $O/know-$s.json --probes $PROBES --forget $FORGET --prefilled $R/out/answers.json:tuned --strengths $s --gpu @GPU@"
  done
  job dev - "$E $PY score_honesty_bf16.py --adapter $A --label $RUN --out $O/dev.json $HN --gpu @GPU@"
  job salient - "$E $PY measure_known.py --adapter $A --questions salient_probes.jsonl --out $O/salient.jsonl --gpu @GPU@ && $PY measure_known.py --merge --questions salient_probes.jsonl --out $O/salient.jsonl --shards 1"
  job dev-on - "$E $PY score_honesty_bf16.py --adapter $A --label $RUN-on --out $O/dev-on.json $H --named-controls stage-b-named-controls.jsonl --reasoning-on --tokenizer $MODEL_PATH --strength low --gpu @GPU@"
}

# A1's arms: name and measure_known.py / score_honesty_bf16.py flags (the same flags work in both).
ARMS=(P0 P0h P1 P2 P3)
arm_flags() {
  case $1 in
    P0) echo "--strength low" ;;
    P0h) echo "--strength high" ;;
    P1) echo "--system \"\$P1_SYSTEM\" --strength low" ;;
    P2) echo "--no-system --knowledge-cutoff 2026-10-29 --current-date 2026-11-01 --strength low" ;;
    P3) echo "--no-system --strength default" ;;
    P4) echo "--system-file $(printf %q "$P4_SYSTEM_FILE") --strength ${P4_STRENGTH:-low}" ;;
  esac
}
if [ -n "${P4_SYSTEM_FILE:-}" ]; then ARMS+=(P4); fi

a1_jobs() {
  local arm f
  for arm in "${ARMS[@]}"; do
    f=$(arm_flags $arm)
    job a1-$arm-2500 - "$E $PY measure_known.py --adapter $RA --questions $PROBES --out $O/a1/$arm.jsonl $f --gpu @GPU@ && $PY measure_known.py --merge --questions $PROBES --out $O/a1/$arm.jsonl --shards 1"
  done
  for arm in "${ARMS[@]}"; do
    f=$(arm_flags $arm)
    job a1-$arm-dev - "$E $PY score_honesty_bf16.py --adapter $RA --label $REF-$arm --out $O/a1/$arm-dev.json $H $f --gpu @GPU@"
  done
}

SAMPLES=("t1.0 --temperature 1.0 --top-p 0.95 --top-k 64" "t0.6 --temperature 0.6 --top-p 0.95 --top-k 64")
a2_jobs() {
  local s name flags seed
  for s in "${SAMPLES[@]}"; do
    name=${s%% *}; flags=${s#* }
    job a2-$name-600 - "$E $PY measure_known.py --adapter $RA --questions $O/a2/probes600.jsonl --out $O/a2/$name-600.jsonl $flags --seed 1 --repeat 3 --gpu @GPU@ && $PY measure_known.py --merge --questions $O/a2/probes600.jsonl --out $O/a2/$name-600.jsonl --shards 1"
  done
  for s in "${SAMPLES[@]}"; do
    name=${s%% *}; flags=${s#* }
    for seed in 1 2 3; do
      job a2-$name-dev-s$seed - "$E $PY score_honesty_bf16.py --adapter $RA --label $REF-$name-s$seed --out $O/a2/$name-dev-s$seed.json $H $flags --seed $seed --gpu @GPU@"
    done
  done
}

# ---- preflight -------------------------------------------------------------------------------------------------------
preflight() {
  local bad=0 f
  for f in measure_known.py score_honesty_bf16.py check_channels_bf16.py score_probes_reasoning.py train_glimmer.py \
           salient_probes.jsonl stage-b-honesty-dev.jsonl eval-probes.jsonl cutoff_questions.jsonl stage-b-named-controls.jsonl; do
    [ -f "$SB/$f" ] || { say "missing $SB/$f"; bad=1; }
  done
  grep -q -- "--no-system" "$SB/measure_known.py" 2>/dev/null || { say "$SB/measure_known.py has no --no-system: copy the new one"; bad=1; }
  grep -q "add_prompt_args" "$SB/score_honesty_bf16.py" 2>/dev/null || { say "$SB/score_honesty_bf16.py has no prompt flags: copy the new one"; bad=1; }
  for f in "$PROBES" "$FORGET" "$CH_BASE" "$RA/adapter_model.safetensors"; do
    [ -f "$f" ] || { say "missing $f"; bad=1; }
  done
  [ -n "${P4_SYSTEM_FILE:-}" ] && [ ! -f "$P4_SYSTEM_FILE" ] && { say "missing P4_SYSTEM_FILE $P4_SYSTEM_FILE"; bad=1; }
  [ "$bad" = 0 ] || return 1
  [ "$(wc -l < "$PROBES")" -eq 2500 ] || { say "$PROBES has $(wc -l < "$PROBES") lines, not 2,500"; bad=1; }
  [ "$(wc -l < "$FORGET")" -eq 40 ] || { say "$FORGET has $(wc -l < "$FORGET") lines, not 40"; bad=1; }
  local sha; sha=$( (sha256sum "$PROBES" 2>/dev/null || shasum -a 256 "$PROBES") | cut -c1-64)
  [ "$sha" = "$PROBES_SHA" ] || say "note: $PROBES sha256 $sha is not the Mac's stage2-eval-probes.jsonl ($PROBES_SHA); the 600 subset is drawn from this file"
  return $bad
}

make_subset() {
  $PY - "$PROBES" "$O/a2/probes600.jsonl" <<'EOF'
import json, random, sys
rows = [line for line in open(sys.argv[1]) if line.strip()]
random.Random(7).shuffle(rows)
open(sys.argv[2], "w").writelines(rows[:600])
print(f"WAVE subset: {min(600, len(rows))} of {len(rows)} probes")
EOF
}

render_arms() {
  local arm
  for arm in "${ARMS[@]}"; do
    eval "$PY measure_known.py --render-only --tokenizer $RA $(arm_flags $arm)" > "$O/a1/$arm.prompt.json" 2> "$O/a1/$arm.prompt.err" \
      || say "render-only failed for $arm (see a1/$arm.prompt.err); its jobs run anyway"
  done
  grep -q 'Knowledge cutoff: 2026-10-29' "$O/a1/P2.prompt.json" 2>/dev/null || say "check: P2's rendered block lacks the 2026-10-29 cutoff line"
  grep -q 'Knowledge cutoff: 2026-10-29' "$O/a1/P1.prompt.json" 2>/dev/null || say "check: P1's rendered block lacks the 2026-10-29 cutoff line"
  grep -q 'Reasoning strength: high' "$O/a1/P0h.prompt.json" 2>/dev/null || say "check: P0h's rendered block lacks strength high"
}

# ---- waiting for B2's adapter ----------------------------------------------------------------------------------------
# B2's training has ended: an EXIT line in its log, or its pid file (start-run's) names a process that is gone.
train_ended() {
  grep -q '^EXIT ' "$R/log.txt" 2>/dev/null && return 0
  local pid; pid=$(cat "$R/pid" 2>/dev/null)
  [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null
}

wait_adapter() {
  local began=$(date +%s) gone=0
  while :; do
    if [ -f "$A/adapter_model.safetensors" ] && { [ "${START_NOW:-0}" = 1 ] || grep -q '"adapter_saved"' "$R/log.txt" 2>/dev/null \
         || grep -q '^EXIT 0$' "$R/log.txt" 2>/dev/null; }; then
      say "B2 adapter ready: $A"; return 0
    fi
    if grep -q '^EXIT [1-9]' "$R/log.txt" 2>/dev/null; then say "B2 training exited non-zero before an adapter: B2's jobs are dropped"; return 1; fi
    # Ended with no EXIT line (killed): seen gone on two polls in a row with no adapter, the adapter isn't coming.
    if train_ended; then gone=$((gone + 1)); else gone=0; fi
    if [ "$gone" -ge 2 ]; then say "B2 training ended without an adapter: B2's jobs are dropped"; return 1; fi
    if [ $(( $(date +%s) - began )) -gt $(( WAIT_MIN * 60 )) ]; then say "no B2 adapter after $WAIT_MIN minutes: B2's jobs are dropped"; return 1; fi
    stopped && return 1
    sleep "$POLL"
  done
}

stopped() { [ -f "$K/STOP" ] || [ -f "$O/STOP" ]; }

gpu_idle() { [ -z "$(nvidia-smi -i "$1" --query-compute-apps=pid --format=csv,noheader 2>/dev/null | tr -d '[:space:]')" ]; }

# ---- dry run ---------------------------------------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
  echo "DRY RUN: nothing starts. RUN=$RUN REF=$REF outputs under $O"
  echo "P1_SYSTEM=$(printf %q "$P1_SYSTEM")"
  echo "preflight: files in $SB, $PROBES (2,500 lines), $FORGET (40), $CH_BASE, $RA"
  echo "wait for: $A/adapter_model.safetensors and an adapter_saved line in $R/log.txt"
  echo "subset: $O/a2/probes600.jsonl (random.Random(7) over $PROBES, first 600)"
  for arm in "${ARMS[@]}"; do echo "render: $PY measure_known.py --render-only --tokenizer $RA $(arm_flags $arm) > $O/a1/$arm.prompt.json"; done
  b2_jobs; [ "${SKIP_A1:-0}" = 1 ] || a1_jobs; [ "${SKIP_A2:-0}" = 1 ] || a2_jobs
  # Assumed order of GPUs freeing: 1 to 7 at the start, GPU 0 once the tuned answers are written, then first in, first out.
  slots=(1 2 3 4 5 6 7 0)
  n=0
  for i in "${!NAMES[@]}"; do
    g=${slots[$((n % ${#slots[@]}))]}; n=$((n + 1))
    printf 'job %-18s gpu %s needs %s\n  cd %s && %s\n' "${NAMES[$i]}" "$g" "${NEEDS[$i]}" "$SB" "${CMDS[$i]//@GPU@/$g}"
  done
  echo "jobs: ${#NAMES[@]}"
  exit 0
fi

# ---- the wave ----------------------------------------------------------------------------------------------------------
mkdir -p "$O/logs" "$O/a1" "$O/a2"
cd "$SB" || exit 1
# The queue starts this script as soon as the file is on train-1, which can be before the other new files are copied.
# So a failed preflight is retried every POLL seconds for up to PREFLIGHT_MIN minutes (the plan's 45-minute rule), logging
# only when what is missing changes, and gives up only then (or at STOP).
pf_began=$(date +%s); pf_said=""
while :; do
  pf_out=$(preflight 2>&1) && { [ -n "$pf_out" ] && echo "$pf_out"; break; }
  pf_key=$(printf '%s\n' "$pf_out" | sed 's/^\[[^]]*\] //')  # without the timestamps
  [ "$pf_key" != "$pf_said" ] && { echo "$pf_out"; say "preflight not passed yet; retrying for up to ${PREFLIGHT_MIN} minutes"; pf_said=$pf_key; }
  if stopped || [ $(( $(date +%s) - pf_began )) -gt $(( PREFLIGHT_MIN * 60 )) ]; then
    say "preflight failed; nothing started"; echo STOPPED > "$O/done.txt"; echo "preflight failed" >> "$O/done.txt"; exit 1
  fi
  sleep "$POLL"
done
B2=1
wait_adapter || B2=0
[ "$B2" = 1 ] && b2_jobs
if [ "${SKIP_A1:-0}" != 1 ]; then render_arms; a1_jobs; fi
if [ "${SKIP_A2:-0}" != 1 ]; then make_subset && a2_jobs; fi
say "${#NAMES[@]} jobs on GPUs $POOL"
printf 'name\tgpu\tstart\tend\texit\n' > "$O/status.tsv"
STATE=(); PIDS=(); GPU_OF=(); START=()
for i in "${!NAMES[@]}"; do STATE[$i]=pending; done
BUSY=()  # BUSY[g] = index of the job on GPU g, or empty
began=$(date +%s)
while :; do
  running=0; pending=0
  for i in "${!NAMES[@]}"; do
    if [ "${STATE[$i]}" = running ]; then
      if kill -0 "${PIDS[$i]}" 2>/dev/null; then running=$((running + 1)); continue; fi
      wait "${PIDS[$i]}"; rc=$?
      STATE[$i]=done; g=${GPU_OF[$i]}; BUSY[$g]=
      printf '%s\t%s\t%s\t%s\t%s\n' "${NAMES[$i]}" "$g" "${START[$i]}" "$(date -u +%FT%TZ)" "$rc" >> "$O/status.tsv"
      say "${NAMES[$i]} on GPU $g exited $rc"
    elif [ "${STATE[$i]}" = pending ]; then
      pending=$((pending + 1))
    fi
  done
  if stopped && [ "$pending" -gt 0 ]; then
    say "STOP file: $pending pending jobs dropped"
    for i in "${!NAMES[@]}"; do [ "${STATE[$i]}" = pending ] && STATE[$i]=stopped; done
    pending=0
  fi
  [ "$running" -eq 0 ] && [ "$pending" -eq 0 ] && break
  for g in $POOL; do
    [ -n "${BUSY[$g]:-}" ] && continue
    gpu_idle "$g" || continue
    for i in "${!NAMES[@]}"; do
      [ "${STATE[$i]}" = pending ] || continue
      need=${NEEDS[$i]}
      if [ "$need" != - ] && [ ! -f "$need" ]; then
        # The needed file (B2's tuned answers) is written before its training process ends, so once the run has ended
        # without it, it never comes: skip at once instead of holding train-1 for NEEDS_MIN.
        if [ $(( $(date +%s) - began )) -gt $(( NEEDS_MIN * 60 )) ] || { train_ended && [ ! -f "$need" ]; }; then
          STATE[$i]=skipped; say "${NAMES[$i]} skipped: $need never appeared"
          printf '%s\t-\t-\t%s\tskipped\n' "${NAMES[$i]}" "$(date -u +%FT%TZ)" >> "$O/status.tsv"
        fi
        continue
      fi
      cmd=${CMDS[$i]//@GPU@/$g}
      START[$i]=$(date -u +%FT%TZ)
      ( echo "[${START[$i]}] GPU $g: $cmd"; eval "$cmd" ) >> "$O/logs/${NAMES[$i]}.log" 2>&1 < /dev/null &
      PIDS[$i]=$!; GPU_OF[$i]=$g; STATE[$i]=running; BUSY[$g]=$i
      say "${NAMES[$i]} started on GPU $g (pid ${PIDS[$i]})"
      break
    done
  done
  sleep "$POLL"
done

if [ "$B2" = 1 ] && [ -f "$SB/compare_stage_b.py" ] && [ -f "$SB/stage_b_lib.py" ] && [ -f "$R/out/answers.json" ] && [ -f "$STAGE2_ANSWERS" ]; then
  # REF's dev file from its own wave, else A1's P0 arm (the same prompt, dev set, controls and cutoff questions), else none.
  REFDEV=$K/runs/$REF/tests/dev.json; [ -f "$REFDEV" ] || REFDEV=$O/a1/P0-dev.json; [ -f "$REFDEV" ] || REFDEV=-
  REFSAL=$K/runs/$REF/tests/salient.jsonl; [ -f "$REFSAL" ] || REFSAL=$REFSAL.shard-0-of-1.jsonl
  EXTRA=()
  [ -f "$REFSAL" ] && [ -f "$O/salient.jsonl" ] && EXTRA+=(--salient "$REF" "$REFSAL" --salient "$RUN" "$O/salient.jsonl")
  [ -f "$O/ch.json" ] && EXTRA+=(--channels "$RUN" "$O/ch.json" --channels-base "$CH_BASE")
  DEV=-; [ -f "$O/dev.json" ] && DEV=$O/dev.json
  $PY compare_stage_b.py --reference "$STAGE2_ANSWERS" --baseline "$REF" --run "$REF" "$K/runs/$REF/out/answers.json" "$REFDEV" \
    --run "$RUN" "$R/out/answers.json" "$DEV" ${EXTRA[@]+"${EXTRA[@]}"} --probes "$PROBES" --json "$O/gates.json" > "$O/gates.txt" 2>&1
  say "gates report: $O/gates.txt (exit $?)"
else
  say "no gates report here (needs compare_stage_b.py and stage_b_lib.py in $SB, both answers files); run compare_stage_b.py on the Mac"
fi

{
  if stopped; then echo STOPPED; else echo ALLDONE; fi
  for i in "${!NAMES[@]}"; do echo "${NAMES[$i]} ${STATE[$i]}"; done
  tail -n +2 "$O/status.tsv" | awk -F'\t' '{print $1, "exit", $5}'
} > "$O/done.txt"
say "done: $(head -1 "$O/done.txt"), $(tail -n +2 "$O/status.tsv" | awk -F'\t' '$5 != "0"' | wc -l) jobs not exit 0"
