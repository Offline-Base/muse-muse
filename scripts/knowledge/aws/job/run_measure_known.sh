#!/bin/bash
# Stage B's measurement on a muse-knowledge-train machine: measure_known.py on every GPU, one process each, then the merge.
#   run_measure_known.sh ADAPTER_DIR QUESTIONS.jsonl OUT.jsonl
# Start it detached from the folder holding the scripts (~/k/stage-b, so the run's own ~/k/train_glimmer.py stays put):
#   cd ~/k/stage-b || exit 1; setsid nohup bash run_measure_known.sh ... > measure.log 2>&1 < /dev/null &
# Rerun the same line after a stop: every shard carries on. Each shard logs to OUT.shard-I.log. Refuses while anything else
# holds a GPU (run_student.sh's check: nvidia-smi and the known job names), since a process here and a training rank on the
# same GPU wouldn't both fit. train_multi.py start-run makes the same check the other way.
set -uo pipefail
K=/home/ubuntu/k
source $K/box.env
ADAPTER=$1; QUESTIONS=$2; OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
# [t] keeps pgrep from matching its own command line.
BUSY=$(nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader; pgrep -af '[t]rain_glimmer.py|[t]rain_student.py|[g]limmer_littlebit.py|[m]easure_known.py --adapter|[s]core_honesty_bf16.py' || true)
if [ -n "$BUSY" ]; then echo "MEASURE busy, not starting: $(echo "$BUSY" | head -3 | tr '\n' ' ')"; exit 1; fi
if [ "$MODE" = bf16 ]; then MODEL_ENV="KNOWLEDGE_MODEL=$MODEL_PATH KNOWLEDGE_4BIT=0"; else MODEL_ENV="KNOWLEDGE_4BIT=1"; fi
PIDS=()
for ((g = 0; g < GPUS; g++)); do
  env $MODEL_ENV HF_HOME=$K/hf HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=${OMP_NUM_THREADS:-8} \
    $K/venv/bin/python "$HERE/measure_known.py" --adapter "$ADAPTER" --questions "$QUESTIONS" --out "$OUT" \
    --gpu "$g" --shard "$g" --shards "$GPUS" >> "$OUT.shard-$g.log" 2>&1 < /dev/null &
  PIDS+=($!)
done
FAILED=0
for p in "${PIDS[@]}"; do wait "$p" || FAILED=$((FAILED + 1)); done
echo "MEASURE $FAILED of $GPUS shards failed"
$K/venv/bin/python "$HERE/measure_known.py" --merge --questions "$QUESTIONS" --out "$OUT" --shards "$GPUS"
