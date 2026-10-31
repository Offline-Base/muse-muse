#!/bin/bash
# NanoQuant sub-1-bit run for a tuned Muse Glimmer 30B on the GH200 (docs/KNOWLEDGE_UPDATE.md).
#
#   bash nq_run.sh watch      wait for the training run to exit and write metrics.json, then merge (CPU) and gputest
#   bash nq_run.sh merge      merge the LoRA adapter into the BF16 base on CPU (merge_adapter.py, with its checks)
#   bash nq_run.sh gputest    the whole pipeline on the base model cut to 2 layers, tiny settings (proves the code)
#   bash nq_run.sh prepare    calibration rows, NanoQuant statistics and BF16 teacher logits from the merged model
#   bash nq_run.sh bf16       score the merged BF16 model through the same harness (probes, old facts, PPL, speed)
#   bash nq_run.sh quantize B quantize the merged model at B bits per weight (e.g. 0.8) into $ROOT/nq-B
#   bash nq_run.sh score B    score $ROOT/nq-B through NanoQuant's GEMV kernels
#   bash nq_run.sh pipeline   prepare, bf16, then quantize 0.8 and 0.55 side by side, scoring each when it's done
#
# Stage 2 later: NQ_NAME=stage2 NQ_ADAPTER=~/k/runs/stage2/out/adapter NQ_TRAIN_PID_PATTERN=... bash nq_run.sh watch
# (all paths below derive from NQ_NAME; the calibration text and probes come from NQ_DATA).
set -uo pipefail
K=$HOME/k
NAME=${NQ_NAME:-stage1}
ROOT=${NQ_ROOT:-$K/models/$NAME-nanoquant}
RUN=${NQ_RUN:-$K/runs/$NAME}
ADAPTER=${NQ_ADAPTER:-$RUN/out/adapter}
BASE=${NQ_BASE:-$K/hf/hub/models--meta-models--Muse-Glimmer-30B/snapshots/cec94fcfd6512f2cfe708138c32533b346ea4f69}
DATA=${NQ_DATA:-$ROOT/data}
CALIB_JSONL=${NQ_CALIB_JSONL:-$DATA/train-stage1-frozen.jsonl}   # training text for calibration, never the probes
PROBES=${NQ_PROBES:-$DATA/eval-probes.jsonl}
FORGET=${NQ_FORGET:-$DATA/forget.jsonl}
MERGED=$ROOT/merged-bf16
CAL=$ROOT/calib
C=$K/nq/code
PY=$K/nq/venv/bin/python
TRAIN_PATTERN=${NQ_TRAIN_PID_PATTERN:-venv/bin/python train_glimmer.py}
[ -f "$ROOT/settings.env" ] && . "$ROOT/settings.env"
SAMPLES=${NQ_SAMPLES:-128}
SEQLEN=${NQ_SEQLEN:-2048}
NONFACT=${NQ_NONFACT_EPOCHS:-8}
FACT=${NQ_FACT_EPOCHS:-8}
KD=${NQ_KD_EPOCHS:-8}
ADMM=${NQ_ADMM_ITERS:-400}
N_PROBES=${NQ_N_PROBES:-300}
export HF_HOME=$K/hf PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false
mkdir -p "$ROOT/logs" "$CAL"
log() { echo "RUN $(date -u +%FT%TZ) $*" | tee -a "$ROOT/logs/run.log"; }

calib_args() {  # $1 = model folder
  echo --model "$1" --calib-jsonl "$CALIB_JSONL" --calib-cache "$CAL/calib.pt" \
       --stats "$CAL/stats.pt" --teacher "$CAL/teacher.pt" --samples "$SAMPLES" --seqlen "$SEQLEN"
}

case "${1:-}" in
watch)
  log "waiting for training ($TRAIN_PATTERN) to exit and $RUN/out/metrics.json"
  while pgrep -f "$TRAIN_PATTERN" > /dev/null || [ ! -f "$RUN/out/metrics.json" ]; do
    if ! pgrep -f "$TRAIN_PATTERN" > /dev/null && [ ! -f "$RUN/out/metrics.json" ]; then
      log "training exited without metrics.json; stopping"; exit 1
    fi
    sleep 60
  done
  log "training done: $(cat "$RUN/out/metrics.json" | head -c 400)"
  bash "$0" merge > "$ROOT/logs/merge.log" 2>&1 &
  M=$!
  bash "$0" gputest > "$ROOT/logs/gputest.log" 2>&1 &
  G=$!
  wait $M; MS=$?
  wait $G; GS=$?
  log "merge exit $MS, gputest exit $GS"
  ;;
merge)
  log "merge $ADAPTER into $BASE -> $MERGED"
  "$PY" -I -u "$C/merge_adapter.py" --base "$BASE" --adapter "$ADAPTER" --out "$MERGED" --report "$ROOT/merge-report.json"
  S=$?; log "merge exit $S"; exit $S
  ;;
gputest)
  T=$ROOT/gputest
  mkdir -p "$T"
  log "gputest: 2-layer base model, 32 rows, 1 epoch each step"
  "$PY" -I -u "$C/nq_glimmer.py" prepare --model "$BASE" --layers 2 --calib-jsonl "$CALIB_JSONL" \
    --calib-cache "$T/calib.pt" --stats "$T/stats.pt" --teacher "$T/teacher.pt" --samples 32 --seqlen "$SEQLEN" || exit 1
  "$PY" -I -u "$C/nq_glimmer.py" quantize --model "$BASE" --layers 2 --calib-cache "$T/calib.pt" --stats "$T/stats.pt" \
    --teacher "$T/teacher.pt" --samples 32 --seqlen "$SEQLEN" --bits 0.8 --nonfact-epochs 1 --fact-epochs 1 --kd-epochs 1 \
    --admm-iters "$ADMM" --out "$T/nq-0.8" || exit 1
  "$PY" -I -u "$C/nq_score.py" --base "$BASE" --layers 2 --nq "$T/nq-0.8/nq-full.pt" --probes "$PROBES" \
    --forget "$FORGET" --n-probes 32 --out "$T/score" --bench --bench-static --ppl || exit 1
  "$PY" -I -u "$C/nq_score.py" --base "$BASE" --layers 2 --nq "$T/nq-0.8/nq-text.safetensors" --probes "$PROBES" \
    --forget "$FORGET" --out "$T/score-fp16-check" --kernel-dtype float16 --check-only || exit 1
  rm -f "$T/teacher.pt"
  log "gputest ok"
  ;;
prepare)
  log "prepare from $MERGED"
  "$PY" -I -u "$C/nq_glimmer.py" prepare $(calib_args "$MERGED")
  ;;
bf16)
  log "score merged BF16"
  "$PY" -I -u "$C/nq_score.py" --base "$MERGED" --probes "$PROBES" --forget "$FORGET" \
    --n-probes "$N_PROBES" --out "$ROOT/bf16-merged" --label "$NAME-bf16" --bench --ppl
  ;;
quantize)
  B=$2
  log "quantize $B bits (nonfact $NONFACT, fact $FACT, kd $KD, admm $ADMM, samples $SAMPLES)"
  "$PY" -I -u "$C/nq_glimmer.py" quantize $(calib_args "$MERGED") --bits "$B" --nonfact-epochs "$NONFACT" \
    --fact-epochs "$FACT" --kd-epochs "$KD" --admm-iters "$ADMM" --out "$ROOT/nq-$B" --gpu-lock "$ROOT/gpu.lock" ${NQ_RESUME:+--resume}
  S=$?; log "quantize $B exit $S"; exit $S
  ;;
score)
  B=$2
  log "score nq-$B"
  "$PY" -I -u "$C/nq_score.py" --base "$BASE" --tokenizer "$MERGED" --nq "$ROOT/nq-$B/nq-text.safetensors" \
    --probes "$PROBES" --forget "$FORGET" --n-probes "$N_PROBES" --out "$ROOT/nq-$B/score" \
    --label "$NAME-nq-$B" --kernel-dtype "${NQ_KERNEL_DTYPE:-bfloat16}" --bench ${NQ_BENCH_STATIC:+--bench-static} --ppl
  ;;
pipeline)
  bash "$0" prepare > "$ROOT/logs/prepare.log" 2>&1 || { log "prepare failed"; exit 1; }
  bash "$0" bf16 > "$ROOT/logs/bf16.log" 2>&1 || log "bf16 scoring failed (continuing)"
  for B in 0.8 0.55; do
    ( bash "$0" quantize $B > "$ROOT/logs/quantize-$B.log" 2>&1 && bash "$0" score $B > "$ROOT/logs/score-$B.log" 2>&1 ) &
    sleep 120
  done
  wait
  log "pipeline done"
  ;;
*)
  sed -n 2,14p "$0"; exit 2
  ;;
esac
