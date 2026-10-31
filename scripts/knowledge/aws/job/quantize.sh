#!/bin/bash
# Quantize a Muse Glimmer 30B knowledge run to GGUF and score every file (docs/KNOWLEDGE_UPDATE.md, Glimmer outputs).
# Runs on one GPU machine with llama.cpp built (llama-quantize, llama-imatrix, llama-server) and the training venv.
#
#   quantize.sh base                          the untouched base: BF16 GGUF, mmproj, Q8_0, its own imatrix, Q4_K_M and
#                                             IQ1_S, scored on all probes (the yardstick for what quantizing alone costs)
#   quantize.sh <run> <adapter_dir> [N]       merge the adapter into the BF16 base (merge_adapter.py, with its checks),
#                                             BF16 GGUF, Q8_0, imatrix on the Q8_0 (fits the GPU), Q4_K_M, then
#                                             IQ2_XXS, IQ1_M and IQ1_S with the imatrix; score each on N probes
#                                             (default 1500) and the 40 old-fact checks; write table.md
#
# Every step skips when its output exists, so a rerun resumes. Work is on local disk; copy_out() puts the merged
# weights, all GGUFs, the imatrix, scores and table on the shared file system under $NFS/<run>/.
# Two lanes run at once: the CPU lane quantizes, the GPU lane runs the imatrix and then scores each file as it lands.
set -euo pipefail

RUN=${1:?run name}
ADAPTER=${2:-}
NPROBES=${3:-1500}
Q=${Q:-/home/ubuntu/q}
LCPP=${LCPP:-/home/ubuntu/writer/llama.cpp-b11970}
BIN=$LCPP/build/bin
# A Python on local disk (make_venv.sh), not the shared venvs: one was retired mid-run by another job.
PY=${PY:-/home/ubuntu/q/pyenv2/venv/bin/python}
NFS=${NFS:-/lambda/nfs/muse-muse-cache-us-east-1/models}
BASE_HF=${BASE_HF:-$Q/base-hf}
DATA=${DATA:-/lambda/nfs/muse-muse-cache-us-east-1/runs/stage1/data}
PROBES=${PROBES:-$DATA/probes.jsonl}
FORGET=${FORGET:-$DATA/forget.jsonl}
TRAIN=${TRAIN:-$DATA/train.jsonl}
CALIB=${CALIB:-$Q/calib/calib.txt}
PORT=${PORT:-8091}
JOB=$(cd "$(dirname "$0")" && pwd)
THREADS=$(nproc)
W=$Q/$RUN
mkdir -p "$W/scores" "$Q/logs"
export PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false

log() { echo "[$(date -u +%FT%TZ)] $RUN $*" | tee -a "$W/pipeline.log"; }
# step NAME OUTPUT CMD...: runs CMD unless OUTPUT exists; CMD writes OUTPUT.part, which is renamed when it succeeds.
step() {
  local name=$1 out=$2; shift 2
  if [ -e "$out" ]; then log "skip $name ($out exists)"; return 0; fi
  log "start $name"
  local t0; t0=$(date +%s)
  local rc=0
  "$@" > "$W/$name.log" 2>&1 || rc=$?
  [ $rc = 0 ] || { log "FAILED $name (exit $rc), see $W/$name.log"; return 1; }
  [ -e "$out.part" ] && mv "$out.part" "$out"
  [ -e "$out" ] || { log "FAILED $name: no $out"; return 1; }
  local secs=$(( $(date +%s) - t0 ))
  echo "{\"step\": \"$name\", \"seconds\": $secs, \"out\": \"$out\"}" >> "$W/steps.jsonl"
  log "done $name in ${secs}s"
}

if [ "$RUN" = base ]; then
  HF=$BASE_HF
  QUANTS="Q4_K_M IQ1_S"
  SCORE="Q4_K_M IQ1_S"
  NPROBES=1500
else
  [ -n "$ADAPTER" ] || { echo "usage: quantize.sh <run> <adapter_dir> [n_probes]"; exit 2; }
  HF=$W/merged
  QUANTS="Q4_K_M IQ2_XXS IQ1_M IQ1_S"
  SCORE="Q8_0 Q4_K_M IQ2_XXS IQ1_M IQ1_S"
  merge() {
    "$PY" -I "$JOB/merge_adapter.py" --base "$BASE_HF" --adapter "$ADAPTER" --out "$W/merged.part" --report "$W/merge-check.json"
  }
  step merge "$W/merged" merge
fi
log "pipeline: hf=$HF quants=$QUANTS score=$SCORE probes=$NPROBES threads=$THREADS"

F="$W/glimmer-$RUN"
BF16="$F-BF16.gguf"
# Text only: the text converter skips the vision tensors; the projector is converted once, from the base.
step convert "$BF16" "$PY" "$LCPP/convert_hf_to_gguf.py" "$HF" --outtype bf16 --outfile "$BF16.part"
if [ "$RUN" = base ]; then
  step mmproj "$W/mmproj-glimmer-base-F16.gguf" "$PY" "$LCPP/convert_hf_to_gguf.py" "$HF" --mmproj --outtype f16 --outfile "$W/mmproj-glimmer-base-F16.gguf.part"
fi
step q8_0 "$F-Q8_0.gguf" "$BIN/llama-quantize" "$BF16" "$F-Q8_0.gguf.part" Q8_0 "$THREADS"
step calibration "$CALIB" "$PY" -I "$JOB/make_calibration.py" --train "$TRAIN" --tokenizer "$BASE_HF" --probes "$PROBES" --forget "$FORGET" --out "$CALIB.part" --tokens 400000
[ -e "$CALIB.part.json" ] && mv "$CALIB.part.json" "$CALIB.json"

quantize_one() {
  local t=$1 extra=()
  case $t in IQ*) extra=(--imatrix "$W/imatrix.gguf");; esac
  step "quant_$t" "$F-$t.gguf" "$BIN/llama-quantize" "${extra[@]}" "$BF16" "$F-$t.gguf.part" "$t" "$THREADS"
}

# CPU lane: Q4_K_M needs no imatrix, so it starts at once; the IQ quants wait for the imatrix.
cpu_lane() {
  for t in $QUANTS; do
    case $t in IQ*) while [ ! -e "$W/imatrix.gguf" ]; do [ -e "$W/imatrix.failed" ] && return 1; sleep 10; done;; esac
    quantize_one "$t"
  done
}
cpu_lane &
CPU_PID=$!

# GPU lane: imatrix on the Q8_0, then each scored file as soon as it exists. One GPU job at a time across runs
# (a Q8_0 server takes about 33 of the A100's 40 GB), so GPU steps hold $Q/gpu.lock.
# llama-imatrix spends most of its time on the CPU, adding up activations copied off the GPU, and slows about 4x when
# quantizing runs beside it. imatrix-mt.patch (applied to the b11970 tree here) splits that sum across threads; it
# gave a bit-identical imatrix to the stock binary on 32 chunks and about 20% less time per pass.
imatrix() {
  flock "$Q/gpu.lock" "$BIN/llama-imatrix" -m "$F-Q8_0.gguf" -f "$CALIB" -o "$W/imatrix.gguf.part" -ngl 999 -c 512 -b 2048 -ub 512 \
    --parse-special --no-ppl --output-format gguf
}
step imatrix "$W/imatrix.gguf" imatrix || { touch "$W/imatrix.failed"; wait $CPU_PID || true; exit 1; }
for t in $SCORE; do
  while [ ! -e "$F-$t.gguf" ]; do
    kill -0 $CPU_PID 2>/dev/null || [ -e "$F-$t.gguf" ] || { log "CPU lane ended without $t"; exit 1; }
    sleep 15
  done
  step "score_$t" "$W/scores/$t.json" flock "$Q/gpu.lock" "$PY" -I "$JOB/score_gguf.py" --gguf "$F-$t.gguf" --label "$RUN $t" \
    --out "$W/scores/$t.json" --tokenizer "$BASE_HF" --probes "$PROBES" --forget "$FORGET" --n-probes "$NPROBES" --port "$PORT"
done
wait $CPU_PID

# BASE_BF16: the training run's ckpt/base.json; TUNED_ANSWERS: its out/answers.json (both optional).
if [ "$RUN" != base ]; then
  "$PY" -I "$JOB/make_table.py" --run "$RUN" --dir "$W" --base-dir "$Q/base" ${BASE_BF16:+--base-bf16 "$BASE_BF16"} \
    ${TUNED_ANSWERS:+--tuned-answers "$TUNED_ANSWERS"} ${TUNED_METRICS:+--tuned-bf16 "$TUNED_METRICS"} | tee -a "$W/pipeline.log"
fi

# Shared file system: every GGUF, the merged weights, the imatrix, the scores and the table.
if [ "${COPY_OUT:-1}" = 1 ]; then
  log "start copy_out to $NFS/$RUN"
  mkdir -p "$NFS/$RUN"
  rsync -a --exclude '*.part' --exclude '*.server.log' "$W/" "$NFS/$RUN/"
  log "done copy_out"
fi
log "finished"
