#!/bin/bash
# Runs train_glimmer.py on every GPU of a muse-knowledge-train machine (box_setup.sh first) and copies the run to S3.
#   run_multi.sh NAME DATA_DIR S3_DEST PER_GPU_BATCH GRAD_ACCUM EPOCHS EVAL_PROBES [MAX_EXAMPLES] [AUTO_OFF]
# Effective batch = PER_GPU_BATCH x GRAD_ACCUM x GPUs. Checkpoints (every SAVE_STEPS steps) and the log go to S3_DEST
# every 2 minutes; at the end the adapter, answers and metrics go too. A run restarted with the same NAME (or on a new
# machine, from S3_DEST/checkpoints) resumes. AUTO_OFF=1 powers the machine off (terminate) after the final copy, or
# 20 minutes after a failure, or when the log hasn't moved for 40 minutes. EC2 only: a Lambda machine keeps billing
# when powered off, so there AUTO_OFF stays 0 and train_multi.py's watch on the Mac is the kill switch.
# Lambda machines have no AWS credentials: KNOWLEDGE_NO_S3=1 skips every S3 copy (the Mac pulls the run instead).
# Optional environment:
#   KNOWLEDGE_INIT_ADAPTER=DIR  start from these LoRA weights (stage 2 from a stage 1 adapter or checkpoint folder);
#                               fresh optimizer and schedule
#   BASE_JSON=FILE              reuse these base answers (copied to ckpt/base.json if the run has none yet)
#   SAVE_STEPS=N (250)  TUNED_EVAL=0|1 (1)  LR=X (1e-4)  KNOWLEDGE_GRAD_CKPT=unsloth|true|false (unsloth)
#   KNOWLEDGE_SAVE_LIMIT=N (unset: 2; 0 keeps every checkpoint)  KNOWLEDGE_SCHEDULE=cosine|constant (unset: cosine)
set -uo pipefail
K=/home/ubuntu/k
source $K/box.env
NAME=$1; DATA=$2; DEST=${3%/}; B=$4; A=$5; EP=$6; PROBES=$7; MAXEX=${8:-0}; AUTO_OFF=${9:-0}
R=$K/runs/$NAME; mkdir -p $R/out $R/ckpt
echo "{\"epochs\": $EP, \"learning_rate\": ${LR:-1e-4}, \"lora_rank\": 64, \"batch_size\": $B, \"grad_accum\": $A, \"eval_probes\": $PROBES, \"max_examples\": $MAXEX, \"save_steps\": ${SAVE_STEPS:-250}, \"tuned_eval\": ${TUNED_EVAL:-1}}" > $R/hyper.json
NO_S3=${KNOWLEDGE_NO_S3:-0}
s3(){ [ "$NO_S3" = 1 ] || aws s3 "$@" --only-show-errors; }
if [ -z "$(ls -A $R/ckpt 2>/dev/null)" ]; then s3 sync $DEST/checkpoints/ $R/ckpt/ || true; fi
if [ -n "${BASE_JSON:-}" ] && [ ! -f $R/ckpt/base.json ]; then cp "$BASE_JSON" $R/ckpt/base.json; fi
if [ -n "${KNOWLEDGE_INIT_ADAPTER:-}" ] && [ ! -f "$KNOWLEDGE_INIT_ADAPTER/adapter_model.safetensors" ]; then
  echo "MUSE no adapter_model.safetensors in $KNOWLEDGE_INIT_ADAPTER" | tee -a $R/log.txt; exit 1
fi
if [ "$MODE" = bf16 ]; then MODEL_ENV="KNOWLEDGE_MODEL=$MODEL_PATH KNOWLEDGE_4BIT=0"; else MODEL_ENV="KNOWLEDGE_4BIT=1"; fi
LAUNCH="$K/venv/bin/python train_glimmer.py"
[ "$GPUS" -gt 1 ] && LAUNCH="$K/venv/bin/torchrun --standalone --nproc_per_node $GPUS train_glimmer.py"
cd $K
env $MODEL_ENV HF_HOME=$K/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false KNOWLEDGE_GRAD_CKPT=${KNOWLEDGE_GRAD_CKPT:-unsloth} \
  KNOWLEDGE_INIT_ADAPTER=${KNOWLEDGE_INIT_ADAPTER:-} OMP_NUM_THREADS=${OMP_NUM_THREADS:-8} \
  KNOWLEDGE_SAVE_LIMIT=${KNOWLEDGE_SAVE_LIMIT:-} KNOWLEDGE_SCHEDULE=${KNOWLEDGE_SCHEDULE:-} \
  KNOWLEDGE_DATA=$DATA KNOWLEDGE_OUT=$R/out KNOWLEDGE_CKPT=$R/ckpt KNOWLEDGE_HYPER=$R/hyper.json \
  $LAUNCH >> $R/log.txt 2>&1 < /dev/null &
PID=$!
echo $PID > $R/pid
copy(){ s3 sync $R/ckpt/ $DEST/checkpoints/ --exclude "*/global_step*"; s3 cp $R/log.txt $DEST/log.txt; s3 cp $R/hyper.json $DEST/hyper.json; }
while kill -0 $PID 2>/dev/null; do
  sleep 120
  copy
  if [ "$AUTO_OFF" = 1 ] && [ $(( $(date +%s) - $(stat -c %Y $R/log.txt) )) -gt 2400 ]; then
    echo "MUSE stalled: no log output for 40 minutes; powering off" >> $R/log.txt; kill $PID; sleep 30; copy; sudo shutdown -h now
  fi
done
wait $PID; CODE=$?
echo "EXIT $CODE" >> $R/log.txt
copy
s3 sync $R/out/ $DEST/
[ -f $R/ckpt/base.json ] && s3 cp $R/ckpt/base.json $DEST/base.json
s3 cp $R/log.txt $DEST/log.txt
if [ "$AUTO_OFF" = 1 ]; then
  [ "$CODE" = 0 ] || sleep 1200
  sudo shutdown -h now
fi
