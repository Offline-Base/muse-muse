#!/bin/bash
# The smallest llama.cpp files of a Muse Glimmer run, for devices: Q1_0, TQ1_0 and Q2_0, each scored, then these and the
# run's stock IQ1_S and IQ2_XXS read for true memory need (4K and 8K context, no GPU layers and full offload) and asked plain
# questions. The smallest sensible file of them all gets the full probe set, if it lacks it, and a copy on the shared file
# system.
#
#   small_quants.sh <run> [BF16.gguf]     default BF16: $Q/<run>/glimmer-<run>-BF16.gguf
#
# Every step skips when its output exists, so a rerun resumes. Output: $Q/small/<run>/ (GGUFs, scores/, mem/, replies/,
# table.md). GPU steps hold $Q/gpu.lock; quantizing and the no-GPU memory runs don't need it and run beside them.
# Q1_0, TQ1_0 and Q2_0 ignore the imatrix (quantize_q1_0 and quantize_q2_0 call the plain row quantizer with or without
# weights, and quantize_tq*_0 discards them, in ggml-quants.c at b11970), so none is passed.
#
# TQ1_0 and TQ2_0 have no CUDA matrix product at b11970: under -ngl 999 the A100 sits idle at 0.17 tok/s (measured Oct 31), and
# a 600-probe score would hold the GPU lock for hours. So they are scored on the CPU, outside the lock, on CPU_N probes.
#
# Env: TYPES (default "Q1_0 TQ1_0 Q2_0"), CPU_N (default 60), EXTRA (stock files of the run to read memory for, default "IQ1_S IQ2_XXS"),
#      N (default 600), FULL_N (default 2500; 0 skips the full score), PUBLISH (1: copy the best to $NFS/<run>/), MEM (0 skips
#      memory and replies), PORT (default 8110, uses PORT to PORT+3), PROBES, FORGET, STOCK_SCORES.
set -euo pipefail

RUN=${1:?usage: small_quants.sh <run> [BF16.gguf]}
Q=${Q:-/home/ubuntu/q}
BF16=${2:-$Q/$RUN/glimmer-$RUN-BF16.gguf}
LCPP=${LCPP:-/home/ubuntu/writer/llama.cpp-b11970}
BIN=$LCPP/build/bin
PY=${PY:-$Q/pyenv2/venv/bin/python}
NFS=${NFS:-/lambda/nfs/muse-muse-cache-us-east-1/models}
BASE_HF=${BASE_HF:-$Q/base-hf}
PROBES=${PROBES:-$Q/data-stage2/stage2-eval-probes.jsonl}
FORGET=${FORGET:-/lambda/nfs/muse-muse-cache-us-east-1/runs/stage1/data/forget.jsonl}
STOCK_SCORES=${STOCK_SCORES:-$Q/$RUN/scores}
TYPES=${TYPES:-Q1_0 TQ1_0 Q2_0}
EXTRA=${EXTRA-IQ1_S IQ2_XXS}
N=${N:-600}
CPU_N=${CPU_N:-60}
FULL_N=${FULL_N:-2500}
PUBLISH=${PUBLISH:-1}
MEM=${MEM:-1}
PORT=${PORT:-8110}
JOB=$(cd "$(dirname "$0")" && pwd)
SCORER=${SCORER:-$JOB/score_gguf.py}
TEMPLATE=${TEMPLATE:-$JOB/tuned-reasoning-off.jinja}
THREADS=$(nproc)
W=$Q/small/$RUN
F=$W/glimmer-$RUN
mkdir -p "$W/scores" "$W/mem" "$W/replies" "$W/logs"
export PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false TRAIN_GLIMMER_DIR=${TRAIN_GLIMMER_DIR:-$(dirname "$SCORER")}

log() { echo "[$(date -u +%FT%TZ)] $RUN $*" | tee -a "$W/pipeline.log"; }
# step NAME OUTPUT CMD...: runs CMD unless OUTPUT exists; a failure is logged and doesn't stop the other files.
step() {
  local name=$1 out=$2 t0 rc=0; shift 2
  if [ -e "$out" ]; then log "skip $name"; return 0; fi
  log "start $name"; t0=$(date +%s)
  "$@" > "$W/logs/$name.log" 2>&1 || rc=$?
  [ -e "$out.part" ] && [ $rc = 0 ] && mv "$out.part" "$out"
  if [ $rc != 0 ] || [ ! -e "$out" ]; then log "FAILED $name (exit $rc), see $W/logs/$name.log"; return 1; fi
  log "done $name in $(( $(date +%s) - t0 ))s"
}
score() { # type gguf n out port
  step "score_$1_$3" "$4" flock "$Q/gpu.lock" "$PY" -I "$SCORER" --gguf "$2" --label "$RUN $1" --out "$4" --tokenizer "$BASE_HF" \
    --probes "$PROBES" --forget "$FORGET" --n-probes "$3" --port "$5"
}
gguf_of() { [ -e "$F-$1.gguf" ] && echo "$F-$1.gguf" || echo "$Q/$RUN/glimmer-$RUN-$1.gguf"; }

# Quantize.
for t in $TYPES; do
  step "quant_$t" "$F-$t.gguf" "$BIN/llama-quantize" "$BF16" "$F-$t.gguf.part" "$t" "$THREADS" || true
done

# Memory, no GPU: outside the lock, one run at a time so the speed is its own. Reruns of mem_need skip what they hold.
cpu_mem() {
  [ "$MEM" = 1 ] || return 0
  for t in $TYPES $EXTRA; do
    g=$(gguf_of "$t"); [ -e "$g" ] || continue
    "$PY" -I "$JOB/mem_need.py" --gguf "$g" --label "$RUN $t" --out "$W/mem/$t.json" --tokenizer "$BASE_HF" --modes cpu,cpu-mmap \
      --port $((PORT + 2)) >> "$W/logs/mem_cpu.log" 2>&1 || log "FAILED cpu memory $t"
  done
}
cpu_mem &
CPU_PID=$!

# GPU: score, then replies and full-offload memory, under the lock one step at a time so other jobs get turns.
for t in $TYPES; do
  g=$F-$t.gguf; [ -e "$g" ] || continue
  case $t in
    TQ*) step "score_${t}_cpu" "$W/scores/$t.json" env CUDA_VISIBLE_DEVICES= "$PY" -I "$SCORER" --gguf "$g" --label "$RUN $t cpu" --out "$W/scores/$t.json" \
           --tokenizer "$BASE_HF" --probes "$PROBES" --forget "$FORGET" --n-probes "$CPU_N" --parallel 8 --port $((PORT + 3)) || true;;
    *) score "$t" "$g" "$N" "$W/scores/$t.json" "$PORT" || true;;
  esac
done
if [ "$MEM" = 1 ]; then
  for t in $TYPES $EXTRA; do
    g=$(gguf_of "$t"); [ -e "$g" ] || continue
    step "replies_$t" "$W/replies/$t.json" flock "$Q/gpu.lock" "$PY" -I "$JOB/small_replies.py" --gguf "$g" --label "$RUN $t" \
      --out "$W/replies/$t.json" --tokenizer "$BASE_HF" --template "$TEMPLATE" --port $((PORT + 1)) || true
  done
  for t in $TYPES $EXTRA; do
    g=$(gguf_of "$t"); [ -e "$g" ] || continue
    flock "$Q/gpu.lock" "$PY" -I "$JOB/mem_need.py" --gguf "$g" --label "$RUN $t" --out "$W/mem/$t.gpu.json" --tokenizer "$BASE_HF" --modes gpu \
      --port $((PORT + 1)) >> "$W/logs/mem_gpu.log" 2>&1 || log "FAILED gpu memory $t"
  done
fi
wait $CPU_PID

# Both memory lanes write their own file; join them for the report.
join_mem() {
  "$PY" -I - "$W/mem" <<'PY'
import glob, json, os, sys
d = sys.argv[1]
for gpu in glob.glob(os.path.join(d, "*.gpu.json")):
    cpu = gpu[: -len(".gpu.json")] + ".json"
    with open(gpu) as f:
        g = json.load(f)
    c = g
    if os.path.exists(cpu):
        with open(cpu) as f:
            c = json.load(f)
        seen = {(r["mode"], r["ctx"]) for r in c["runs"]}
        c["runs"] += [r for r in g["runs"] if (r["mode"], r["ctx"]) not in seen]
    with open(cpu + ".tmp", "w") as f:
        json.dump(c, f, ensure_ascii=False, indent=1)
    os.replace(cpu + ".tmp", cpu)
PY
}
report() {
  local types extra
  types=$(echo $TYPES | tr ' ' ','); extra=$(echo $EXTRA | tr ' ' ',')
  "$PY" -I "$JOB/small_report.py" --dir "$W" --stock-scores "$STOCK_SCORES" --types "$types" --extra "$extra" | tee "$W/report.txt"
}
[ "$MEM" = 1 ] && join_mem
report
BEST=$(awk '/^BEST /{print $2}' "$W/report.txt")
log "smallest sensible: $BEST"
[ "$BEST" != none ] || { log "no file passed; nothing copied"; exit 0; }

# The smallest sensible file on all the probes (a stock file already has them), then a copy on the shared file system.
BEST_GGUF=$(gguf_of "$BEST")
if [ "$FULL_N" != 0 ] && [ ! -e "$STOCK_SCORES/$BEST.json" ]; then
  score "$BEST" "$BEST_GGUF" "$FULL_N" "$W/scores/$BEST-full.json" "$PORT" && report
fi
if [ "$PUBLISH" = 1 ]; then
  name=glimmer-$RUN-$BEST.gguf
  mkdir -p "$NFS/$RUN"
  if ! cmp -s "$BEST_GGUF" "$NFS/$RUN/$name"; then
    cp "$BEST_GGUF" "$NFS/$RUN/$name.part" && mv "$NFS/$RUN/$name.part" "$NFS/$RUN/$name"
  fi
  cp "$W/table.md" "$NFS/$RUN/small-table.md"
  log "$name on $NFS/$RUN/"
fi
log "finished"
