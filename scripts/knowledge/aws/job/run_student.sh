#!/bin/bash
# Runs the Jetson student (train_student.py) on a Lambda GPU machine and, with GGUF=1, packages it (student_gguf.sh):
# muse-knowledge-train-1 (8x A100 80GB) after stage 2, or a 1-GPU muse-knowledge-student-* machine for the smoke test.
#   run_student.sh NAME DATA_DIR [EPOCHS] [MAX_EXAMPLES] [EVAL_PROBES]
# DATA_DIR holds train.jsonl (the student set), probes.jsonl (stage2-eval-probes.jsonl), forget.jsonl and
# eval-probes.jsonl (the fixed 1,500, for the probe split). The code sits in its own folder (~/k/student), so the
# train_glimmer.py a running stage uses is never replaced. Start it detached (setsid nohup, STUDENT.md). It refuses
# while any process holds a GPU or a training script runs, so it can't disturb stage 2 or another run.
#
# No credentials anywhere: the venv comes from PyPI and the PyTorch index with run.sh's pins (train-1's $K/venv is
# reused when it has them, and never rebuilt), and the weights download anonymously (HF_TOKEN unset). GPUs with 40 GB
# or more train a BF16 LoRA, smaller ones QLoRA. Several GPUs run under torchrun, one GPU (or GPUS=1) as one process.
# Outputs: $K/runs/NAME/ holds only small files (log.txt, hyper.json, out/ with answers.json, metrics.json and
# merge-check.json, gguf/ with the scores and table), so train_multi.py lambda-sync can copy it to the Mac and S3
# without bringing weights. Weights stay here: checkpoints in $K/student-ckpt/NAME; the adapter, the merged model and
# the GGUFs in $K/models/NAME (STUDENT.md streams the adapter to S3 through the Mac, never onto its disk).
# Optional environment: LR (2e-4), LORA_RANK (128), LORA_ALPHA (the rank), BATCH (4 per GPU), ACCUM (0: effective
# batch 32), SAVE_STEPS (2000), TUNED_EVAL (1), MERGE (1), MAX_START_LOSS (8; 0 is off), MASKING (unsloth|own),
# GGUF=1, GGUF_PROBES, Q4_K_M_STOCK=1, STUDENT_PROFILE (bolt), STUDENT_4BIT, GPUS, FORCE=1 (start although a GPU is
# busy).
set -uo pipefail
K=/home/ubuntu/k
NAME=${1:?run name}; DATA=${2:?data folder}; EP=${3:-2}; MAXEX=${4:-0}; PROBES=${5:-2500}
JOB=$(cd "$(dirname "$0")" && pwd)
R=$K/runs/$NAME; CK=$K/student-ckpt/$NAME; M=$K/models/$NAME
mkdir -p "$R/out" "$CK" "$M"
LOG=$R/log.txt
say(){ echo "MUSE setup $(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
export PATH=$HOME/.local/bin:$PATH HF_HUB_DISABLE_TELEMETRY=1
unset HF_TOKEN HUGGING_FACE_HUB_TOKEN HF_HUB_OFFLINE
PROFILE=${STUDENT_PROFILE:-bolt}

for f in train.jsonl probes.jsonl forget.jsonl; do [ -s "$DATA/$f" ] || { say "no $DATA/$f"; exit 1; }; done
for f in train_glimmer.py score_gguf.py train_student.py score_student_gguf.py student_gguf.sh; do
  [ -s "$JOB/$f" ] || { say "no $JOB/$f (copy the student code over first)"; exit 1; }
done
# [t] keeps pgrep from matching its own command line.
BUSY=$(nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader; pgrep -af '[t]rain_glimmer.py|[t]rain_student.py|[g]limmer_littlebit.py' || true)
if [ -n "$BUSY" ] && [ "${FORCE:-0}" != 1 ]; then say "busy, not starting $NAME: $(echo "$BUSY" | head -3 | tr '\n' ' ')"; exit 1; fi
FREE=$(df -BG --output=avail "$K" | tail -1 | tr -dc 0-9)
NEED=60; [ "${GGUF:-0}" = 1 ] && NEED=110
[ "$FREE" -ge $NEED ] || { say "only ${FREE} GB free in $K, $NAME needs $NEED"; exit 1; }

GPU_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
NGPU=${GPUS:-$(nvidia-smi -L | wc -l)}
if [ "$NGPU" = 1 ]; then export CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-0}; fi
if [ -z "${STUDENT_4BIT:-}" ]; then if [ "$GPU_MB" -ge 40000 ]; then STUDENT_4BIT=0; else STUDENT_4BIT=1; fi; fi
say "$NAME: $NGPU GPU(s) x ${GPU_MB} MiB, 4-bit $STUDENT_4BIT, profile $PROFILE, data $DATA, epochs $EP, max_examples $MAXEX, probes $PROBES, ${FREE} GB free"

# The training venv: $K/venv when it has run.sh's pins (train-1's, built by box_setup.sh), built there on a fresh
# machine, or $K/venv-student when $K/venv exists with other pins (someone else's venv is never touched).
pins_ok(){ "$1" -c "import importlib.metadata as m; assert (m.version('unsloth'), m.version('transformers'), m.version('trl')) == ('2026.10.9', '5.15.0', '0.22.2')" 2>/dev/null; }
VENV=$K/venv
if ! pins_ok "$VENV/bin/python"; then
  [ -e "$VENV" ] && VENV=$K/venv-student
  if ! pins_ok "$VENV/bin/python"; then
    say "venv: building $VENV"
    command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/0.13.1/install.sh | sh
    P=$VENV/bin/python
    { uv venv -q "$VENV" --python 3.12 \
      && uv pip install -q --python "$P" torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35 --index-url https://download.pytorch.org/whl/cu128 \
      && uv pip install -q --python "$P" unsloth==2026.10.9 unsloth_zoo==2026.10.9 peft==0.21.2 accelerate==1.15.0 bitsandbytes==0.50.2 datasets==4.8.5 \
      && uv pip install -q --python "$P" --no-deps torchao==0.18.0 \
      && uv pip install -q --python "$P" transformers==5.15.0 \
      && uv pip install -q --python "$P" --no-deps trl==0.22.2; } >> "$LOG" 2>&1
    pins_ok "$P" || { say "venv build failed"; exit 1; }
  fi
fi
PY=$VENV/bin/python
say "venv $VENV"

# The weights at the pinned revision, anonymously (train_student.py download prints the local folder).
say "weights: $PROFILE"
MODEL_PATH=$(cd "$K" && HF_HOME=$K/hf STUDENT_PROFILE=$PROFILE "$PY" "$JOB/train_student.py" download 2>> "$R/weights.log" | tail -1)
[ -d "$MODEL_PATH" ] || { say "weights download failed, see $R/weights.log"; exit 1; }
say "weights in $MODEL_PATH ($(du -shL "$MODEL_PATH" | cut -f1))"

cat > "$R/hyper.json" <<EOF
{"epochs": $EP, "learning_rate": ${LR:-2e-4}, "lora_rank": ${LORA_RANK:-128}, "lora_alpha": ${LORA_ALPHA:-${LORA_RANK:-128}}, "batch_size": ${BATCH:-4}, "grad_accum": ${ACCUM:-0}, "eval_probes": $PROBES, "max_examples": $MAXEX, "save_steps": ${SAVE_STEPS:-2000}, "tuned_eval": ${TUNED_EVAL:-1}, "merge": ${MERGE:-1}, "max_start_loss": ${MAX_START_LOSS:-8}, "masking": "${MASKING:-unsloth}"}
EOF
LAUNCH=("$PY" "$JOB/train_student.py")
[ "$NGPU" -gt 1 ] && LAUNCH=("$VENV/bin/torchrun" --standalone --nproc_per_node "$NGPU" "$JOB/train_student.py")
cd "$K"
env HF_HOME=$K/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=${OMP_NUM_THREADS:-8} \
  KNOWLEDGE_GRAD_CKPT=${KNOWLEDGE_GRAD_CKPT:-unsloth} STUDENT_PROFILE=$PROFILE STUDENT_MODEL=$MODEL_PATH STUDENT_4BIT=$STUDENT_4BIT \
  KNOWLEDGE_DATA=$DATA KNOWLEDGE_OUT=$R/out KNOWLEDGE_CKPT=$CK KNOWLEDGE_HYPER=$R/hyper.json STUDENT_ADAPTER=$M/adapter STUDENT_MERGED=$M/merged \
  "${LAUNCH[@]}" >> "$LOG" 2>&1 < /dev/null &
PID=$!
echo $PID > "$R/pid"
wait $PID; CODE=$?
echo "EXIT $CODE" >> "$LOG"

if [ "$CODE" = 0 ] && [ "${GGUF:-0}" = 1 ]; then
  K=$K PY=$PY DATA=$DATA Q4_K_M_STOCK=${Q4_K_M_STOCK:-0} bash "$JOB/student_gguf.sh" "$NAME" "$M/merged" "${GGUF_PROBES:-$PROBES}" >> "$LOG" 2>&1
  CODE=$?
  echo "GGUF EXIT $CODE" >> "$LOG"
fi
exit $CODE
