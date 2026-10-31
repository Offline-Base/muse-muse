#!/bin/bash
# LittleBit QAT of the tuned Glimmer on one 8-GPU machine. NON-COMMERCIAL ONLY (LittleBit is CC BY-NC 4.0; README.md).
#
#   MODEL=<merged BF16 Glimmer> TRAIN="<train jsonl> [<train jsonl>...]" PROBES=<eval-probes.jsonl> FORGET=<forget.jsonl> \
#     bash run_8gpu.sh BITS [EPOCHS]
#
# Steps, each skipped when already done and resumed when stopped part way:
#   0. the BF16 reference eval of MODEL on GPU 7 (probes, forget checks, WikiText-2), alongside step 1
#   1. data: TRAIN rendered in Glimmer's chat format + LittleBit's c4_wiki, 2,048-token blocks (once per WORK)
#   2. init: Dual-SVID + Joint-ITQ, layers sharded over the GPUs, FP32 factors saved (once per BITS)
#   3. train: deepspeed, ZeRO-3, LittleBit's KD + layer-to-layer loss against the BF16 teacher; a checkpoint every
#      SAVE_STEPS, and a stopped run resumes from the newest one; the packed model goes to RUN/model
#   4. eval of RUN/model on GPU 0
#
# Settings (environment): WORK (~/lbrun), NGPU (8), GENERAL_RATIO (-1 = all of c4_wiki, as LittleBit's recipe; R = R
# c4_wiki blocks per block of our text), BATCH (4 per GPU), LR (4e-5), MAX_STEPS (-1 = by EPOCHS), SAVE_STEPS (300),
# MAX_HOURS (training time limit for this call, default 0 = none; resume by running the same command again),
# FAST (0 = LittleBit's own ZeRO-3 configs with params and optimizer on CPU, the path tested on one GPU;
#       1 = ds_student_fast.json + ds_teacher_fast.json, params on the GPUs, optimizer on CPU, untested on 8 GPUs).
# Needs about 1 TB of RAM at 0.55 bits (every rank loads the BF16 model and the FP32 init once) and about 500 GB of
# disk for the two checkpoints kept at 0.55 bits (about 235 GB each).
set -euo pipefail
BITS=${1:?usage: run_8gpu.sh BITS [EPOCHS]}
EPOCHS=${2:-5}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LB_HOME=${LB_HOME:-$HOME/lb}
export LITTLEBIT_DIR=$LB_HOME/LittleBit GLIMMER_JOB_DIR=${GLIMMER_JOB_DIR:-$(dirname "$HERE")}
export HF_HOME=${HF_HOME:-$HOME/hf} TOKENIZERS_PARALLELISM=false PATH=$LB_HOME/venv/bin:$PATH
PY=$LB_HOME/venv/bin/python
MODEL=${MODEL:?set MODEL to the merged BF16 Glimmer folder}
TRAIN=${TRAIN:?set TRAIN to the training JSONL file(s)}
PROBES=${PROBES:?set PROBES to eval-probes.jsonl}
FORGET=${FORGET:?set FORGET to forget.jsonl}
WORK=${WORK:-$HOME/lbrun}
NGPU=${NGPU:-8}
RUN=$WORK/runs/lb-$BITS
INIT=$WORK/init-$BITS
mkdir -p "$WORK/logs" "$RUN"
test -f "$GLIMMER_JOB_DIR/train_glimmer.py" || { echo "train_glimmer.py isn't in $GLIMMER_JOB_DIR (set GLIMMER_JOB_DIR)"; exit 1; }
test -f "$LB_HOME/venv/.muse-ready" || { echo "run setup.sh first"; exit 1; }
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$WORK/logs/run.log"; }

FP_PID=""
if [ ! -f "$WORK/eval-fp/metrics.json" ]; then
  say "0. BF16 reference eval of $MODEL on GPU $((NGPU - 1)) (background)"
  CUDA_VISIBLE_DEVICES=$((NGPU - 1)) "$PY" "$HERE/eval_littlebit.py" --fp --base "$MODEL" --probes "$PROBES" --forget "$FORGET" \
    --out "$WORK/eval-fp" > "$WORK/logs/eval-fp.log" 2>&1 &
  FP_PID=$!
fi

if [ ! -f "$WORK/data/muse_data.json" ]; then
  say "1. data"
  args=(); for f in $TRAIN; do args+=(--train "$f"); done
  "$PY" "$HERE/glimmer_littlebit.py" data --model "$MODEL" "${args[@]}" --exclude "$PROBES" --exclude "$FORGET" \
    --general_ratio "${GENERAL_RATIO:--1}" --num_proc 32 --out "$WORK/data" > "$WORK/logs/data.log" 2>&1
fi
grep -h '"event": "data"' "$WORK/logs/data.log" | tail -1 | cut -c1-400 || true

LAYERS=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['text_config']['num_hidden_layers'])" "$MODEL/config.json")
if [ "$(ls "$INIT"/layer-*.safetensors 2>/dev/null | wc -l)" -lt "$LAYERS" ]; then
  say "2. init $BITS bits, $LAYERS layers over $NGPU GPUs"
  mkdir -p "$INIT"
  # Shard 0 writes init.json first, so the others find the settings to check against.
  pids=()
  for k in $(seq 0 $((NGPU - 1))); do
    CUDA_VISIBLE_DEVICES=$k "$PY" "$HERE/glimmer_littlebit.py" init --model "$MODEL" --out "$INIT" --eff_bit "$BITS" \
      --shard "$k/$NGPU" > "$WORK/logs/init-$BITS-$k.log" 2>&1 &
    pids+=($!)
    if [ "$k" = 0 ]; then sleep 20; fi
  done
  for p in "${pids[@]}"; do wait "$p"; done
  test "$(ls "$INIT"/layer-*.safetensors | wc -l)" -ge "$LAYERS"
fi

if [ -n "$FP_PID" ]; then
  say "waiting for the BF16 reference eval"
  wait "$FP_PID" || say "BF16 reference eval failed (see logs/eval-fp.log)"
fi

if [ ! -f "$RUN/model/littlebit_config.json" ]; then
  DS=$LITTLEBIT_DIR/configs/zero3.json; TDS=$LITTLEBIT_DIR/configs/zero3_inference.json
  if [ "${FAST:-0}" = 1 ]; then DS=$HERE/ds_student_fast.json; TDS=$HERE/ds_teacher_fast.json; fi
  say "3. train $BITS bits, $EPOCHS epochs, batch ${BATCH:-4} x $NGPU GPUs, ds $(basename "$DS")"
  limit=()
  if [ "${MAX_HOURS:-0}" != 0 ]; then limit=(timeout --signal=TERM --kill-after=10m "${MAX_HOURS}h"); fi
  "${limit[@]}" deepspeed --num_gpus "$NGPU" "$HERE/glimmer_littlebit.py" train --model "$MODEL" --data "$WORK/data" --init "$INIT" \
    --eff_bit "$BITS" --epochs "$EPOCHS" --batch "${BATCH:-4}" --lr "${LR:-4e-5}" --max_steps "${MAX_STEPS:--1}" \
    --save_steps "${SAVE_STEPS:-300}" --out "$RUN" --ds_config "$DS" --teacher_ds_config "$TDS" >> "$RUN/train.log" 2>&1 \
    || { say "train stopped (exit $?); run the same command again to resume from the newest checkpoint"; exit 1; }
fi

say "4. eval $RUN/model"
CUDA_VISIBLE_DEVICES=0 "$PY" "$HERE/eval_littlebit.py" --model "$RUN/model" --base "$MODEL" --probes "$PROBES" --forget "$FORGET" \
  --out "$RUN/eval" > "$RUN/eval.log" 2>&1
say "done: $(cat "$RUN/eval/metrics.json" | tr -d '\n' | cut -c1-600)"
