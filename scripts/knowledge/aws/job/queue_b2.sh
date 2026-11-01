#!/bin/bash
# Tonight's train-1 queue (the final plan's "train-1" table and cut rules): one script on the machine runs every step in order,
# so a dead session on the Mac doesn't stop the night.
#   Q1   B2 from stage2-multi (lr 5e-5, cosine, 1 epoch, r30b's base answers)
#   Q1t  test_wave_b2.sh on B2 (started beside the run: it waits for the adapter and keeps GPU 0 for B2's tuned answers)
#   Q2   the dose run from stage2-multi (lr 2e-4, constant after 3% warmup, 5 epochs, a save each epoch, every save kept)
#   Q2t  the dose evals: epoch 0 (stage 2) to 5 and base on the 1,840 questions, one model per GPU, then dose_gate.py (D1)
#   go (D1 holds):   Q3 Stage A+ for E epochs; Q4 its tuned answers on GPU 0 and measure_known on the 40,000 on GPUs 1 to 7;
#                    Q5 the B2' set (hooks/assemble_b2p.sh); Q6 B2' from Stage A+ with its test wave; Q6t the shipped-config
#                    check (hooks/shipped_check.sh); then, with TAIL=1, the dose from base at lr 1e-4 (design data only)
#   no-go:           Q3' B2b if the decision file says B2 missed exactly one honesty gate (h4 or h3h9), with its test wave,
#                    then the shipped-config check; without B2b, only the check
# Then it writes queue/FINISHED: train-1 has nothing left, so the Mac copies the adapters (adapter_to_s3.py --from train-1)
# and terminates it. The queue never terminates the machine itself.
#
# Start it on train-1, detached, from ~/k (it reads train_multi.py, check_by_kind.py, dose_gate.py, train_glimmer.py and
# grade_recall.py there, and measure_known.py and test_wave_b2.sh in ~/k/stage-b):
#   cd ~/k || exit 1; setsid nohup bash queue_b2.sh > queue/queue.out 2>&1 < /dev/null &
#   DRY=1 bash queue_b2.sh       prints every step and command and starts nothing (DRY_GO=0 for the no-go branch,
#                                DRY_B2B=h4|h3h9|none for its decision, DRY_E=N for E); it needs no GPU and can run on the Mac
#
# Rules it keeps:
# - Every launch is `train_multi.py start-run --local --no-sync` (the same start, GPU check and environment as from the Mac,
#   with no sync: the Mac is short of disk).
# - No training set launches unless check_by_kind.py passes: its report's by_kind within TOL (2%) of the step's table in
#   queue/tables/ (b2.json and dose.json get the plan's numbers if absent; stage-a-plus.json, b2p.json and b2b.json must be
#   written for their sets), and the file's own rows matching its report. A failing set is waited on like a missing one.
# - The 45-minute rule: a step whose code, data, table or decision isn't ready within WAIT_MAX (2,700 s) of the queue
#   reaching it is skipped, and so is what depends on it. The dose and Stage A+ are skipped outright once DOSE_DEADLINE
#   (12:30 AM EDT, 04:30 UTC) passes before the dose starts.
# - A training run that exits non-zero isn't retried; its dependents are skipped.
# - A file named STOP in queue/ or in ~/k: nothing more starts and the queue exits; a running training run or wave keeps
#   running (kill it by its PID in ~/k/runs/RUN/pid). ~/k/STOP also stops the wave's new jobs (test_wave_b2.sh reads it).
# - Rerun after a crash of the queue itself: a step marked done in queue/state/ is not run again.
# Inputs the main session puts on train-1 first (paths are settings below): ~/k/data-b2 (train.jsonl shuffled, probes.jsonl,
# forget.jsonl, report.json), ~/k/data-dose (make_dose_set.py's folder), and for the branches ~/k/data-stage-a-plus,
# queue/hooks/assemble_b2p.sh, queue/hooks/shipped_check.sh, queue/b2b.decision. The log is queue/queue.log: steps, counts
# and paths only.
set -uo pipefail
K=${K:-/home/ubuntu/k}
Q=${QUEUE_DIR:-$K/queue}
DRY=${DRY:-0}
NAME=${TRAIN_NAME:-muse-knowledge-train-1}
WAIT_MAX=${WAIT_MAX:-2700}
POLL=${POLL:-30}
TOL=${TOL:-0.02}
DOSE_DEADLINE=${DOSE_DEADLINE:-2026-11-01T04:30:00Z}
LATE_B2P=${LATE_B2P:-2026-11-01T13:00:00Z}
TAIL=${TAIL:-0}
RUN_B2=${RUN_B2:-stage-b-b2}
RUN_DOSE=${RUN_DOSE:-dose}
RUN_A=${RUN_A:-stage-a-plus}
RUN_B2P=${RUN_B2P:-stage-b-b2p}
RUN_B2B=${RUN_B2B:-stage-b-b2b}
RUN_TAIL=${RUN_TAIL:-dose-base}
REF=${REF:-stage-b-r30b}
DATA_B2=${DATA_B2:-$K/data-b2}
DATA_DOSE=${DATA_DOSE:-$K/data-dose}
DATA_A=${DATA_A:-$K/data-stage-a-plus}
DATA_B2P=${DATA_B2P:-$K/data-b2p}
DATA_B2B=${DATA_B2B:-$K/data-b2b}
STAGE_A_KEY=${STAGE_A_KEY:-kind}
BASE_JSON=${BASE_JSON:-$K/runs/$REF/ckpt/base.json}  # r30b's base answers: stage 2's, on the 2,500
SB=$K/stage-b
WAVE=${WAVE:-$SB/test_wave_b2.sh}
STAGE_B_QUESTIONS=${STAGE_B_QUESTIONS:-$SB/stage-b-questions.jsonl}
PY3=${PY3:-python3}
VPY=$K/venv/bin/python
TABLES=$Q/tables
HOOKS=$Q/hooks
STATE=$Q/state
LOG=$Q/queue.log
HERE=$(cd "$(dirname "$0")" && pwd)
JOBS=$K  # train_multi.py, check_by_kind.py and dose_gate.py
[ "$DRY" = 1 ] && [ ! -f "$JOBS/check_by_kind.py" ] && JOBS=$HERE
[ "$DRY" = 1 ] && [ ! -f "$JOBS/train_multi.py" ] && [ -f "$HERE/../train_multi.py" ] && TM_PATH=$HERE/../train_multi.py
TM_PATH=${TM_PATH:-$JOBS/train_multi.py}

log() { local line; line="$(date -u +%FT%TZ) QUEUE $*"; echo "$line"; [ "$DRY" = 1 ] || echo "$line" >> "$LOG"; }
now() { date -u +%s; }
epoch_of() { $PY3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$1"; }
json_get() { $PY3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[k]
print(d)' "$1" "$2" 2>/dev/null; }
run() { if [ "$DRY" = 1 ]; then echo "DRY: $*"; else "$@"; fi; }
mark() { [ "$DRY" = 1 ] || { echo "$2" > "$STATE/$1.done"; printf '%s\t%s\t%s\n' "$1" "$2" "$(date -u +%FT%TZ)" >> "$STATE/summary.tsv"; }; log "STEP $1: $2"; }
was_done() { [ "$DRY" != 1 ] && [ -f "$STATE/$1.done" ] && { log "STEP $1 already marked $(cat "$STATE/$1.done"); not run again"; return 0; }; return 1; }
status_of() { cat "$STATE/$1.done" 2>/dev/null; }
stopped() { [ -e "$Q/STOP" ] || [ -e "$K/STOP" ]; }

finish() {
  local why=$1
  log "FINISHED ($why). Steps: $(cut -f1,2 "$STATE/summary.tsv" 2>/dev/null | tr '\t\n' ': ' )"
  log "Nothing is left for train-1: from the Mac, adapter_to_s3.py --from train-1 for each new run, then train_multi.py stop --name $NAME"
  [ "$DRY" = 1 ] || { echo "$why" > "$Q/FINISHED"; rm -f "$Q/queue.pid"; }
}

check_stop() {
  if stopped; then
    log "STOP file found: nothing more starts and the queue exits; a running run or wave keeps running (kill it by PID)"
    finish "stopped"
    exit 0
  fi
}

# wait_for DESC CHECK [UNTIL_EPOCH]: CHECK is a function that prints why it isn't ready and returns non-zero, or returns 0.
wait_for() {
  local desc=$1 fn=$2 until why said=""
  until=$(( $(now) + WAIT_MAX ))
  if [ -n "${3:-}" ] && [ "$3" -lt "$until" ]; then until=$3; fi
  if [ "$DRY" = 1 ]; then
    why=$($fn 2>&1) && log "DRY ready now: $desc${why:+ ($why)}" || log "DRY would wait up to $(( (until - $(now)) / 60 )) min for $desc (now: $why)"
    return 0
  fi
  while :; do
    check_stop
    if why=$($fn 2>&1); then log "ready: $desc${why:+ ($why)}"; return 0; fi
    if [ "$why" != "$said" ]; then log "waiting for $desc: $why"; said=$why; fi
    if [ "$(now)" -ge "$until" ]; then log "not ready in time ($desc): $why"; return 1; fi
    sleep "$POLL"
  done
}

table_file() {
  # The step's planned by_kind: queue/tables/NAME.json, or the plan's numbers for b2 and dose (written there if absent).
  local name=$1 f=$TABLES/$1.json default=""
  [ -s "$f" ] && { echo "$f"; return 0; }
  case $name in
    b2) default='{"by_kind": {"reasoning": 18000, "false_premise+after_cutoff+unknowable": 5810, "cutoff_restated": 990, "measured_wrong": 1600, "measured_right": 8440, "replay": 4200, "contrast": 20960}, "total": 60000}' ;;
    dose) default='{"by_kind": {"meta": 3750, "ai_first_party": 3750, "events": 3750, "ccnews": 3750}, "total": 15000}' ;;
  esac
  [ -n "$default" ] || return 1
  if [ "$DRY" = 1 ]; then f=$(mktemp -t "queue-table-$name.XXXX"); fi
  echo "$default" > "$f"
  echo "$f"
}

# set_ready DATA TABLE_NAME KEY [MORE_FILES...]: the files are there and check_by_kind.py passes.
set_ready() {
  local data=$1 name=$2 key=$3 table out rc f
  shift 3
  for f in "$data/train.jsonl" "$data/probes.jsonl" "$data/forget.jsonl" "$data/report.json" "$@"; do
    [ -s "$f" ] || { echo "missing $f"; return 1; }
  done
  table=$(table_file "$name") || { echo "no table $TABLES/$name.json"; return 1; }
  out=$($PY3 "$JOBS/check_by_kind.py" --train "$data/train.jsonl" --report "$data/report.json" --table "$table" --key "$key" --tol "$TOL" 2>&1); rc=$?
  [ "$DRY" = 1 ] || echo "$out" > "$STATE/bykind-$name.txt"
  if [ $rc != 0 ]; then echo "by_kind check refused it: $(echo "$out" | grep -E '^(FAIL|Traceback)' | head -4 | tr '\n' ';')"; return 1; fi
  echo "$(echo "$out" | tail -1)"
}

file_ready() { local f; for f in "$@"; do [ -s "$f" ] || { echo "missing $f"; return 1; }; done; }

# ---- training -------------------------------------------------------------------------------------------------------
gpus_busy() {  # start-run's own check: anything on a GPU, or a job that will be. Always prints a count and succeeds: under
  # pipefail, pgrep finding nothing (exit 1) or grep counting 0 (exit 1) must not read as "free" while nvidia-smi lists a process.
  { nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>&1
    pgrep -af '[t]rain_glimmer.py|[t]rain_student.py|[g]limmer_littlebit.py|[m]easure_known.py --adapter|[s]core_honesty_bf16.py|[c]heck_channels_bf16.py|[s]core_probes_reasoning.py' || true; } | grep -c . || true
}

wait_gpus() {
  # Busy GPUs aren't train-1 waiting for code, so this has no time limit; it ends when they're free or at STOP.
  local n said=""
  while n=$(gpus_busy); [ "${n:-0}" != 0 ]; do
    check_stop
    [ -z "$said" ] && { log "waiting for the GPUs before $1: $n processes hold them"; said=1; }
    sleep "$POLL"
  done
}

# start_training RUN ARGS...: the caller may set START_RECHECK (its set's ready function, run again once the GPUs are free, so a
# set replaced while the queue waited for them is checked again before it trains) and START_DEADLINE (epoch seconds: no start
# after it, for the dose's 12:30 AM rule).
start_training() {
  local run=$1 why r=$K/runs/$1
  shift
  if [ "$DRY" = 1 ]; then
    $PY3 "$TM_PATH" start-run --local --no-sync --dry-run --name "$NAME" --run "$run" "$@" | sed -n '2,$p'
    return 0
  fi
  if grep -q '^EXIT 0$' "$r/log.txt" 2>/dev/null; then log "$run already finished (EXIT 0); not started again"; return 0; fi
  # A rerun of the queue while the run still trains: wait on that run, never start a second one over it.
  if alive "$run"; then log "$run is already running (pid $(cat "$r/pid")); waiting on it, not starting it again"; return 0; fi
  if grep -q '^EXIT ' "$r/log.txt" 2>/dev/null; then log "$run ended earlier with $(grep '^EXIT ' "$r/log.txt" | tail -1); not retried tonight"; return 1; fi
  # train_glimmer.py resumes from any checkpoint-* in the run's folder: an earlier attempt's would train on in place of this set.
  if compgen -G "$r/ckpt/checkpoint-*" > /dev/null; then log "$run has checkpoints from an earlier attempt in $r/ckpt; not started (move them or rename the run)"; return 1; fi
  wait_gpus "$run"
  check_stop
  if [ -n "${START_DEADLINE:-}" ] && [ "$(now)" -ge "$START_DEADLINE" ]; then log "$run: the GPUs freed only after its start deadline; not started"; return 1; fi
  if [ -n "${START_RECHECK:-}" ] && ! why=$($START_RECHECK 2>&1); then
    # Changed while the queue waited for the GPUs: waited on again like a set that isn't ready (45 minutes, and the deadline).
    log "$run: its set no longer passes its check after the GPU wait ($why)"
    wait_for "$run's set to pass its check again" "$START_RECHECK" "${START_DEADLINE:-}" || { log "$run not started"; return 1; }
  fi
  if ! $PY3 "$TM_PATH" start-run --local --no-sync --name "$NAME" --run "$run" "$@" >> "$LOG" 2>&1; then
    log "start-run $run refused or failed (see the lines above)"
    return 1
  fi
  log "started $run (pid $(cat "$K/runs/$run/pid" 2>/dev/null))"
}

alive() { local pid; pid=$(cat "$K/runs/$1/pid" 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }

late_warning() {
  [ "$1" = "$RUN_B2P" ] || return 0
  if [ "$(now)" -ge "$LATE_AT" ] && [ ! -f "$STATE/late-warned" ]; then
    log "B2' still training at 8 AM EST: raise its watch deadline (at most noon EST) in .data/aws/train-multi.json on the Mac"
    touch "$STATE/late-warned"
  fi
}

exit_code() {  # run_multi.sh writes "EXIT N" once the training process ends
  # Its loop sleeps 120 s between checks, so the line can come a full 120 s after the process is gone: wait up to 300 s, or a
  # good run would read as a crash with "EXIT none".
  local run=$1
  for _ in $(seq 1 60); do
    grep -q '^EXIT ' "$K/runs/$run/log.txt" 2>/dev/null && break
    sleep 5
  done
  grep '^EXIT ' "$K/runs/$run/log.txt" 2>/dev/null | tail -1 | cut -d' ' -f2
}

wait_training() {
  local run=$1 rc
  if [ "$DRY" = 1 ]; then log "DRY would wait for $run to end (its EXIT line in ~/k/runs/$run/log.txt)"; return 0; fi
  while alive "$run"; do check_stop; late_warning "$run"; sleep "$POLL"; done
  rc=$(exit_code "$run")
  if [ "$rc" = 0 ]; then log "$run ended: EXIT 0"; return 0; fi
  log "CRASH: $run ended with EXIT ${rc:-none}; not retried tonight"
  return 1
}

wait_adapter() {  # B2's adapter is saved (rank 0 then answers the 2,500 on GPU 0) or the run ended without one
  local run=$1 r=$K/runs/$1
  if [ "$DRY" = 1 ]; then log "DRY would wait for $run's adapter ($r/out/adapter, adapter_saved in its log)"; return 0; fi
  while :; do
    check_stop
    if [ -s "$r/out/adapter/adapter_model.safetensors" ] && grep -q '"adapter_saved"' "$r/log.txt" 2>/dev/null; then log "$run adapter saved"; return 0; fi
    alive "$run" || { log "$run ended before saving an adapter"; return 1; }
    sleep "$POLL"
  done
}

# ---- test waves -----------------------------------------------------------------------------------------------------
wave_ready() { file_ready "$WAVE"; }

start_wave() {  # RUN [ENV=VALUE ...]: test_wave_b2.sh from ~/k/stage-b, detached, as its header says
  local run=$1
  shift
  if [ "$DRY" = 1 ]; then
    echo "DRY: cd $SB && env K=$K $* setsid nohup bash $WAVE $run $REF > $K/runs/$run/tests-b2.log 2>&1 < /dev/null &"
    return 0
  fi
  mkdir -p "$K/runs/$run"
  ( cd "$SB" && exec env K="$K" "$@" setsid nohup bash "$WAVE" "$run" "$REF" > "$K/runs/$run/tests-b2.log" 2>&1 < /dev/null ) &
  echo $! > "$STATE/wave-$run.pid"
  log "test wave on $run started (pid $!, $* ; log ~/k/runs/$run/tests-b2.log)"
}

wait_wave() {
  local run=$1 pid
  if [ "$DRY" = 1 ]; then log "DRY would wait for the wave on $run (~/k/runs/$run/tests-b2/done.txt)"; return 0; fi
  pid=$(cat "$STATE/wave-$run.pid" 2>/dev/null)
  while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do check_stop; sleep "$POLL"; done
  log "test wave on $run ended: $(head -1 "$K/runs/$run/tests-b2/done.txt" 2>/dev/null || echo 'no done.txt')"
}

# run_with_wave STEP RUN [WAVE_ENV...]: the run is started; the wave goes beside it as soon as its script is there (it waits
# for the adapter itself). If the script only arrives after the run, the 45-minute rule applies from the run's end.
run_with_wave() {
  local step=$1 run=$2 started=0 rc=0
  shift 2
  if [ "$DRY" = 1 ]; then
    start_wave "$run" "$@"; wait_training "$run"; wait_wave "$run"
    return 0
  fi
  # A rerun of the queue: a wave already going or finished for this run isn't started twice.
  if { [ -f "$STATE/wave-$run.pid" ] && kill -0 "$(cat "$STATE/wave-$run.pid")" 2>/dev/null; } || [ -f "$K/runs/$run/tests-b2/done.txt" ]; then
    log "test wave on $run already started earlier; not started again"; started=1
  fi
  while alive "$run"; do
    check_stop
    if [ $started = 0 ] && wave_ready > /dev/null 2>&1; then start_wave "$run" "$@"; started=1; fi
    late_warning "$run"
    sleep "$POLL"
  done
  wait_training "$run" || rc=1
  if [ $started = 0 ]; then
    if [ $rc = 0 ] && wait_for "the test-wave script ($WAVE)" wave_ready; then
      start_wave "$run" START_NOW=1 "$@"; started=1
    else
      mark "${step}t" "skipped: $([ $rc = 0 ] && echo 'no test-wave script in time' || echo 'the run crashed')"
    fi
  fi
  if [ $started = 1 ]; then wait_wave "$run"; mark "${step}t" "done: $(head -1 "$K/runs/$run/tests-b2/done.txt" 2>/dev/null || echo 'no done.txt')"; fi
  return $rc
}

# ---- measurements ---------------------------------------------------------------------------------------------------
model_env() {
  if [ -f "$K/box.env" ]; then source "$K/box.env"; fi
  if [ "${MODE:-bf16}" = bf16 ]; then echo "KNOWLEDGE_MODEL=${MODEL_PATH:-\$MODEL_PATH} KNOWLEDGE_4BIT=0"; else echo "KNOWLEDGE_4BIT=1"; fi
}

measure() {  # ADAPTER QUESTIONS OUT GPU SHARD SHARDS: one measure_known.py process, in the background
  local menv
  menv=$(model_env)
  if [ "$DRY" = 1 ]; then
    echo "DRY: cd $SB && env $menv HF_HOME=$K/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false $VPY measure_known.py --adapter $1 --questions $2 --out $3 --gpu $4 --shard $5 --shards $6 >> $3.shard-$5.log 2>&1 &"
    return 0
  fi
  mkdir -p "$(dirname "$3")"
  ( cd "$SB" && exec env $menv HF_HOME=$K/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=8 \
      "$VPY" measure_known.py --adapter "$1" --questions "$2" --out "$3" --gpu "$4" --shard "$5" --shards "$6" ) >> "$3.shard-$5.log" 2>&1 < /dev/null &
  echo $!
}

merge() {  # QUESTIONS OUT SHARDS
  run bash -c "cd '$SB' && '$VPY' measure_known.py --merge --questions '$1' --out '$2' --shards '$3' >> '$2.merge.log' 2>&1"
}

# dose_evals RUN EVDIR EPOCH0_ADAPTER: epoch 0, the run's five saves and base, one GPU each, then D1. Returns dose_gate's code.
dose_evals() {
  local run=$1 ev=$2 zero=$3 qs=$DATA_DOSE/questions.jsonl ckpts=() e g pids=() names=() p models rc chpid="" save
  if [ "$DRY" = 1 ]; then
    ckpts=(checkpoint-469 checkpoint-938 checkpoint-1407 checkpoint-1876 checkpoint-2345)
  else
    while IFS= read -r p; do [ -n "$p" ] && ckpts+=("$p"); done < <(for p in "$K/runs/$run/ckpt"/checkpoint-*; do [ -d "$p" ] && basename "$p"; done | sort -t- -k2 -n)
    if [ "${#ckpts[@]}" -ne 5 ]; then log "$run has ${#ckpts[@]} checkpoints, not 5: no D1"; return 1; fi
    for p in "${ckpts[@]}"; do [ -s "$K/runs/$run/ckpt/$p/adapter_model.safetensors" ] || { log "$run/$p has no adapter: no D1"; return 1; }; done
    # Each save should end an epoch (report run.save_steps apart); if the trainer dropped rows they drift a little: say so.
    save=$(json_get "$DATA_DOSE/report.json" run.save_steps)
    for e in 1 2 3 4 5; do
      [ "${ckpts[$((e - 1))]}" = "checkpoint-$((e * ${save:-469}))" ] || log "note: $run's save $e is ${ckpts[$((e - 1))]}, not checkpoint-$((e * ${save:-469})); epochs are read by save order"
    done
    mkdir -p "$ev"
  fi
  # The plan's "P(=self) on epoch 5, reported only": the channel check, time-capped, on the GPU the evals leave free. Not part of D1.
  if [ "$zero" != none ] && [ "${DOSE_CH:-1}" = 1 ]; then
    if [ "$DRY" = 1 ]; then
      echo "DRY: cd $SB && env \$MODEL_ENV $VPY check_channels_bf16.py --adapter $K/runs/$run/ckpt/${ckpts[4]} --label $run-epoch5 --out $ev/ch-epoch5.json --tokenizer \$MODEL_PATH --allow-code-exec --minutes ${DOSE_CH_MIN:-14} --gpu 7 >> $ev/ch-epoch5.log 2>&1 &"
    elif [ -f "$SB/check_channels_bf16.py" ]; then
      # shellcheck disable=SC1091,SC2046  # model_env's words are NAME=VALUE pairs, split on purpose as measure() does
      ( source "$K/box.env"; cd "$SB" && exec env $(model_env) HF_HOME="$K/hf" HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=8 \
          "$VPY" check_channels_bf16.py --adapter "$K/runs/$run/ckpt/${ckpts[4]}" --label "$run-epoch5" --out "$ev/ch-epoch5.json" \
          --tokenizer "$MODEL_PATH" --allow-code-exec --minutes "${DOSE_CH_MIN:-14}" --gpu 7 ) >> "$ev/ch-epoch5.log" 2>&1 < /dev/null &
      chpid=$!
      log "P(=self) check on $run's epoch 5 on GPU 7 (pid $chpid, reported only)"
    else
      log "no $SB/check_channels_bf16.py: P(=self) on epoch 5 not measured (reported only)"
    fi
  fi
  models=("0=$zero")
  for e in 1 2 3 4 5; do models+=("$e=$K/runs/$run/ckpt/${ckpts[$((e - 1))]}"); done
  [ "$zero" != none ] && models+=("base=none")
  g=0
  for p in "${models[@]}"; do
    e=${p%%=*}
    names+=("$e")
    if [ "$e" = base ]; then out=$ev/base.jsonl; else out=$ev/epoch$e.jsonl; fi
    pid=$(measure "${p#*=}" "$qs" "$out" "$g" 0 1)
    [ "$DRY" = 1 ] && echo "$pid" || pids+=("$pid")
    g=$((g + 1))
  done
  if [ "$DRY" != 1 ]; then
    log "dose evals on $run: ${#pids[@]} models on GPUs 0 to $((g - 1)) (pids ${pids[*]})"
    for p in "${pids[@]}"; do while kill -0 "$p" 2>/dev/null; do check_stop; sleep "$POLL"; done; done
  fi
  for e in "${names[@]}"; do
    if [ "$e" = base ]; then out=$ev/base.jsonl; else out=$ev/epoch$e.jsonl; fi
    merge "$qs" "$out" 1 || log "merge of $out failed (base is reported only; an epoch missing stops D1)"
  done
  if [ "$DRY" = 1 ]; then echo "DRY: $PY3 $JOBS/dose_gate.py --questions $qs --dir $ev --out $ev/d1.json"; return 0; fi
  $PY3 "$JOBS/dose_gate.py" --questions "$qs" --dir "$ev" --out "$ev/d1.json" > "$ev/d1.txt" 2>&1; rc=$?
  log "D1 on $run: $(tail -1 "$ev/d1.txt") (exit $rc; table in $ev/d1.txt)"
  if [ -n "${chpid:-}" ]; then
    while kill -0 "$chpid" 2>/dev/null; do check_stop; sleep "$POLL"; done
    log "P(=self) check on $run's epoch 5 ended (reported only; $ev/ch-epoch5.json)"
  fi
  return $rc
}

run_hook() {  # NAME [ARGS...]: queue/hooks/NAME.sh, written by the main session, run in the foreground
  local name=$1 h=$HOOKS/$1.sh
  shift
  if [ "$DRY" = 1 ]; then echo "DRY: K=$K bash $h $*  > $STATE/hook-$name.log 2>&1"; return 0; fi
  log "hook $name: bash $h $*"
  K=$K RUN_A=$RUN_A RUN_B2=$RUN_B2 bash "$h" "$@" > "$STATE/hook-$name.log" 2>&1
  local rc=$?
  log "hook $name exited $rc (log $STATE/hook-$name.log)"
  return $rc
}

# ---- the steps ------------------------------------------------------------------------------------------------------
ready_b2() { set_ready "$DATA_B2" b2 kind "$BASE_JSON" "$K/runs/stage2-multi/out/adapter/adapter_model.safetensors"; }
ready_dose() {
  set_ready "$DATA_DOSE" dose dose_group "$DATA_DOSE/questions.jsonl" "$BASE_JSON" "$K/runs/stage2-multi/out/adapter/adapter_model.safetensors" || return 1
  report_sha_ok "$DATA_DOSE" train questions
}
# report_sha_ok DIR NAME...: DIR/NAME.jsonl has the sha256 its report.json gives (make_dose_set.py's "sha256"), so a set changed
# or half copied after it was built can't pass on its counts alone.
report_sha_ok() {
  local dir=$1
  shift
  $PY3 -c 'import hashlib, json, os, sys
d, names = sys.argv[1], sys.argv[2:]
want = json.load(open(os.path.join(d, "report.json"))).get("sha256") or {}
for n in names:
    h = hashlib.sha256()
    with open(os.path.join(d, n + ".jsonl"), "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if not isinstance(want, dict) or want.get(n) != h.hexdigest():
        print(f"{n}.jsonl sha256 {h.hexdigest()[:12]} is not the report'"'"'s"); sys.exit(1)
print("sha256 of " + ", ".join(names) + " match the report")' "$dir" "$@"
}
ready_a() {
  set_ready "$DATA_A" stage-a-plus "$STAGE_A_KEY" || return 1
  local want
  want=$(json_get "$DATA_A/report.json" epochs)
  if [ -n "$want" ] && [ "$want" != "$E" ]; then echo "its report says $want epochs, D1 picked $E"; return 1; fi
}
ready_b2p() { set_ready "$DATA_B2P" b2p kind; }
ready_b2b() { set_ready "$DATA_B2B" b2b kind; }
hook_b2p() { file_ready "$HOOKS/assemble_b2p.sh"; }
hook_shipped() { file_ready "$HOOKS/shipped_check.sh"; }
ready_decision() {
  local d
  d=$(head -1 "$Q/b2b.decision" 2>/dev/null | tr -d '[:space:]')
  case $d in h4|h3h9|none) echo "$d"; return 0 ;; "") echo "no $Q/b2b.decision yet"; return 1 ;; *) echo "b2b.decision says '$d', not h4, h3h9 or none"; return 1 ;; esac
}
ready_measure() { file_ready "$STAGE_B_QUESTIONS" "$K/runs/$RUN_A/out/adapter/adapter_model.safetensors"; }

step_q1() {
  local START_RECHECK=ready_b2
  was_done Q1 && return 0
  if ! wait_for "B2's set in $DATA_B2, checked against tables/b2.json" ready_b2; then mark Q1 "skipped: set not ready or refused"; mark Q1t "skipped: no B2"; return 1; fi
  if ! start_training "$RUN_B2" --data-dir "$DATA_B2" --init-adapter stage2-multi --base-json "$BASE_JSON" --lr 5e-5 --eval-probes 2500 --save-steps 500; then
    mark Q1 "skipped: start-run refused"; mark Q1t "skipped: no B2"; return 1
  fi
  if run_with_wave Q1 "$RUN_B2"; then mark Q1 "done"; return 0; fi
  mark Q1 "crashed"
  return 1
}

step_q2() {
  # On a rerun: done stays done, a crash isn't retried (cut rules), and only a skip (data late, deadline) is tried again.
  case "$(status_of Q2)" in
    done) log "STEP Q2 already marked done; not run again"; return 0 ;;
    skipped*|"") ;;
    *) log "STEP Q2 already marked $(status_of Q2); not retried"; return 1 ;;
  esac
  local deadline START_RECHECK=ready_dose START_DEADLINE
  deadline=$(epoch_of "$DOSE_DEADLINE")
  START_DEADLINE=$deadline
  if [ "$DRY" != 1 ] && [ "$(now)" -ge "$deadline" ]; then mark Q2 "skipped: past $DOSE_DEADLINE; the dose and Stage A+ move to N0"; return 1; fi
  if ! wait_for "the dose set in $DATA_DOSE, checked against tables/dose.json" ready_dose "$deadline"; then
    mark Q2 "skipped: not ready by $DOSE_DEADLINE or within $((WAIT_MAX / 60)) min; the dose and Stage A+ move to N0"; return 1
  fi
  local save
  save=$(json_get "$DATA_DOSE/report.json" run.save_steps); save=${save:-469}
  if ! start_training "$RUN_DOSE" --data-dir "$DATA_DOSE" --init-adapter stage2-multi --base-json "$BASE_JSON" --lr 2e-4 --schedule constant \
      --epochs 5 --save-steps "$save" --save-limit 0 --tuned-eval 0 --eval-probes 2500; then
    mark Q2 "skipped: start-run refused"; return 1
  fi
  if wait_training "$RUN_DOSE"; then mark Q2 "done"; return 0; fi
  mark Q2 crashed
  return 1
}

step_q2t() {  # exit 0 go, 2 no-go, 1 no verdict
  local ev=$K/runs/$RUN_DOSE/evals rc
  # A rerun: a verdict stands; only a skip (no dose run then) is tried again, now that the dose may have run.
  if [[ "$(status_of Q2t)" != skipped* ]] && was_done Q2t; then [ -f "$ev/d1.json" ] && [ "$(json_get "$ev/d1.json" go)" = True ] && return 0; return 2; fi
  dose_evals "$RUN_DOSE" "$ev" "$K/runs/stage2-multi/out/adapter"; rc=$?
  if [ "$DRY" = 1 ]; then [ "${DRY_GO:-1}" = 1 ] && return 0 || return 2; fi
  case $rc in 0) mark Q2t "D1 go, E $(json_get "$ev/d1.json" E)" ;; 2) mark Q2t "D1 no-go" ;; *) mark Q2t "no verdict (exit $rc)" ;; esac
  return $rc
}

base_from_answers() {  # Stage A+'s tuned answers as B2's base answers, so B2' compares against its own start
  local src=$K/runs/$RUN_A/out/answers.json out=$K/runs/$RUN_A/tuned-as-base.json
  [ "$DRY" = 1 ] && { echo "DRY: $out from $src (tuned probes and forget)" >&2; echo "$out"; return 0; }
  $PY3 -c 'import json, sys
d = json.load(open(sys.argv[1]))["tuned"]
json.dump({"probes": d["probes"], "forget": d["forget"], "answered_by": sys.argv[3]}, open(sys.argv[2], "w"))' "$src" "$out" "$RUN_A" || return 1
  echo "$out"
}

go_branch() {
  if [ "$DRY" = 1 ]; then E=${DRY_E:-3}; else E=$(json_get "$K/runs/$RUN_DOSE/evals/d1.json" E); fi
  log "go branch: D1 holds, E = $E"
  local START_RECHECK=ready_a
  # Q3 and Q4
  if ! was_done Q3; then
    if ! wait_for "the Stage A+ set in $DATA_A for $E epochs, checked against tables/stage-a-plus.json" ready_a; then mark Q3 "skipped: set not ready or refused"; return 1; fi
    start_training "$RUN_A" --data-dir "$DATA_A" --init-adapter stage2-multi --base-json "$BASE_JSON" --lr 2e-4 --schedule constant \
      --epochs "$E" --save-steps 1000 --eval-probes 2500 || { mark Q3 "skipped: start-run refused"; return 1; }
    local mpids=() s menv
    if wait_adapter "$RUN_A" && wait_for "the 40,000 Stage B questions ($STAGE_B_QUESTIONS)" ready_measure; then
      for s in 0 1 2 3 4 5 6; do
        p=$(measure "$K/runs/$RUN_A/out/adapter" "$STAGE_B_QUESTIONS" "$K/runs/$RUN_A/measure/measured.jsonl" $((s + 1)) "$s" 7)
        [ "$DRY" = 1 ] && echo "$p" || mpids+=("$p")
      done
      log "Q4: measure_known on the 40,000 on GPUs 1 to 7 (pids ${mpids[*]:-}), Stage A+'s tuned answers on GPU 0"
    fi
    if ! wait_training "$RUN_A"; then mark Q3 crashed; mark Q4 "skipped: Stage A+ crashed"; return 1; fi
    mark Q3 "done"
    if [ "$DRY" != 1 ]; then for p in "${mpids[@]}"; do while kill -0 "$p" 2>/dev/null; do check_stop; sleep "$POLL"; done; done; fi
    merge "$STAGE_B_QUESTIONS" "$K/runs/$RUN_A/measure/measured.jsonl" 7 && mark Q4 "done: $K/runs/$RUN_A/measure/measured.jsonl" || { mark Q4 "measure incomplete"; return 1; }
  fi
  # A rerun after Stage A+ or its measurement was skipped or crashed stops here too: was_done above says only that it was marked.
  if [ "$DRY" != 1 ] && ! { [[ "$(status_of Q3)" == done* ]] && [[ "$(status_of Q4)" == done* ]]; }; then
    log "Stage A+ ($(status_of Q3)) or its measurement ($(status_of Q4)) didn't finish: no B2'"; return 1
  fi
  # Q5: the B2' set, by the main session's hook (assemble_stage_b.py with flags from plan_sizes and B2's result)
  if ! was_done Q5; then
    wait_for "hooks/assemble_b2p.sh" hook_b2p || { mark Q5 "skipped: no hook in time"; return 1; }
    run_hook assemble_b2p "$K/runs/$RUN_A/measure/measured.jsonl" "$DATA_B2P" || { mark Q5 "hook failed"; return 1; }
    wait_for "the B2' set in $DATA_B2P, checked against tables/b2p.json" ready_b2p || { mark Q5 "set refused or missing"; return 1; }
    mark Q5 "done"
  fi
  if [ "$DRY" != 1 ] && [[ "$(status_of Q5)" != done* ]]; then log "the B2' set ($(status_of Q5)) isn't done: no B2'"; return 1; fi
  # Q6 and Q6t
  if ! was_done Q6; then
    local base
    base=$(base_from_answers) || { mark Q6 "skipped: no Stage A+ answers"; return 1; }
    START_RECHECK=ready_b2p
    start_training "$RUN_B2P" --data-dir "$DATA_B2P" --init-adapter "$RUN_A" --base-json "$base" --lr 5e-5 --eval-probes 2500 --save-steps 500 \
      || { mark Q6 "skipped: start-run refused"; return 1; }
    if run_with_wave Q6 "$RUN_B2P" SKIP_A1=1 SKIP_A2=1; then mark Q6 "done"; else mark Q6 crashed; return 1; fi
  fi
  shipped_check "$REF" "$RUN_B2" "$RUN_B2P"
  if [ "$TAIL" = 1 ]; then tail_dose; fi
}

shipped_check() {  # REF and the candidates that finished (a run whose step isn't done is left out; DRY lists every one)
  local runs=() r st
  was_done shipped && return 0
  for r in "$@"; do
    case $r in "$RUN_B2") st=Q1 ;; "$RUN_B2P") st=Q6 ;; "$RUN_B2B") st=Q3b ;; *) st="" ;; esac
    if [ -z "$st" ] || [ "$DRY" = 1 ] || [[ "$(status_of "$st")" == done* ]]; then runs+=("$r"); fi
  done
  if wait_for "hooks/shipped_check.sh" hook_shipped; then
    run_hook shipped_check "${runs[@]}" && mark shipped "done: ${runs[*]}" || mark shipped "hook failed"
  else
    mark shipped "skipped: no hook in time"
  fi
}

tail_dose() {
  local START_RECHECK=ready_dose
  was_done tail && return 0
  ready_dose > /dev/null 2>&1 || [ "$DRY" = 1 ] || { mark tail "skipped: dose set not ready"; return 0; }
  local save
  save=$(json_get "$DATA_DOSE/report.json" run.save_steps); save=${save:-469}
  start_training "$RUN_TAIL" --data-dir "$DATA_DOSE" --lr 1e-4 --schedule constant --epochs 5 --save-steps "$save" --save-limit 0 --tuned-eval 0 --eval-probes 40 \
    || { mark tail "skipped: start-run refused"; return 0; }
  wait_training "$RUN_TAIL" || { mark tail crashed; return 0; }
  dose_evals "$RUN_TAIL" "$K/runs/$RUN_TAIL/evals" none
  mark tail "done (design data for N2; nothing ships from it)"
}

nogo_branch() {
  local d START_RECHECK=ready_b2b
  if [ "$(status_of Q1)" != "done" ] && [ "$DRY" != 1 ]; then
    log "no-go branch: B2 didn't finish, so no B2b"
    shipped_check "$REF"
    return 0
  fi
  if [ "$DRY" = 1 ]; then d=${DRY_B2B:-none}; log "DRY decision: $d";
  elif wait_for "the B2b decision in $Q/b2b.decision (h4, h3h9 or none)" ready_decision; then d=$(ready_decision);
  else d=none; log "no B2b decision in time: no B2b"; fi
  if [ "$d" = h4 ] || [ "$d" = h3h9 ]; then
    if ! was_done Q3b; then
      if wait_for "the B2b set ($d) in $DATA_B2B, checked against tables/b2b.json" ready_b2b && \
         start_training "$RUN_B2B" --data-dir "$DATA_B2B" --init-adapter stage2-multi --base-json "$BASE_JSON" --lr 5e-5 --eval-probes 2500 --save-steps 500; then
        if run_with_wave Q3b "$RUN_B2B" SKIP_A1=1 SKIP_A2=1; then mark Q3b "done ($d)"; else mark Q3b "crashed ($d)"; fi
      else
        mark Q3b "skipped: set not ready or refused ($d)"
      fi
    fi
    [ "$(status_of Q3b)" = "done ($d)" ] && { shipped_check "$REF" "$RUN_B2" "$RUN_B2B"; return 0; }
  else
    mark Q3b "not run: decision $d"
  fi
  shipped_check "$REF" "$RUN_B2"
}

# ---- main -----------------------------------------------------------------------------------------------------------
if [ "$DRY" != 1 ]; then
  mkdir -p "$Q" "$STATE" "$TABLES" "$HOOKS"
  if [ -f "$Q/queue.pid" ] && kill -0 "$(cat "$Q/queue.pid")" 2>/dev/null; then echo "queue already running (pid $(cat "$Q/queue.pid"))"; exit 1; fi
  echo $$ > "$Q/queue.pid"
  rm -f "$Q/FINISHED"
else
  echo "DRY RUN: nothing starts. K=$K, queue folder $Q, branch $([ "${DRY_GO:-1}" = 1 ] && echo go || echo no-go)"
fi
LATE_AT=$(epoch_of "$LATE_B2P")
log "queue start: B2 $RUN_B2, dose $RUN_DOSE, Stage A+ $RUN_A, B2' $RUN_B2P, B2b $RUN_B2B, reference $REF; wait limit $((WAIT_MAX / 60)) min, dose deadline $DOSE_DEADLINE, tolerance $TOL"
check_stop
step_q1
check_stop
if step_q2; then
  step_q2t; d1=$?
else
  d1=1
  was_done Q2t || mark Q2t "skipped: no dose run"
fi
check_stop
if [ "$d1" = 0 ]; then
  # Stage A+ or B2' failing leaves B2 (if it passed) or r30b to ship, so the shipped-config check still runs on what finished.
  go_branch || { log "go branch ended early (see the steps above)"; check_stop; shipped_check "$REF" "$RUN_B2" "$RUN_B2P"; }
else
  log "no-go branch (D1 $([ "$d1" = 2 ] && echo failed || echo 'has no verdict'))"
  nogo_branch
fi
finish "done"
