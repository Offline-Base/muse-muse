#!/bin/bash
# Size-against-knowledge bench for a Muse Glimmer BF16 GGUF: builds custom bit mixes with llama-quantize and scores each on a
# fixed probe subset, paired with the stock files. One command reruns it on a final model:
#
#   BF16=/path/final-BF16.gguf IMATRIX=/path/imatrix.gguf STOCK=/path/scores shrink_bench.sh [candidate ...]
#   shrink_bench.sh --list            names, sizes (dry run, nothing written)
#   shrink_bench.sh --table           just rebuild the table from the scores so far
#
# With no names it runs DEFAULT below. Each candidate: quantize at nice 10 (skipped if its score exists), dump bytes by
# tensor kind, score under $Q/gpu.lock with score_gguf.py (--n-probes $N), read memory with one slot under the lock, then delete
# the GGUF unless the name is in $KEEP. Two copies can run side by side on different names with PORT and THREADS set.
set -euo pipefail

Q=${Q:-/home/ubuntu/q}
LCPP=${LCPP:-/home/ubuntu/writer/llama.cpp-b11970}
BIN=$LCPP/build/bin
PY=${PY:-$Q/pyenv2/venv/bin/python}
BF16=${BF16:-$Q/stage2/glimmer-stage2-BF16.gguf}
IMATRIX=${IMATRIX:-$Q/stage2/imatrix.gguf}
STOCK=${STOCK:-$Q/stage2/scores}
BASE_SCORES=${BASE_SCORES:-$Q/base/scores}
BASE_HF=${BASE_HF:-$Q/base-hf}
PROBES=${PROBES:-$Q/data-stage2/stage2-eval-probes.jsonl}
FORGET=${FORGET:-/lambda/nfs/muse-muse-cache-us-east-1/runs/stage1/data/forget.jsonl}
SCORER=${SCORER:-$Q/job/score_gguf.py}
W=${W:-$Q/shrink}
N=${N:-600}
PORT=${PORT:-8096}
THREADS=${THREADS:-$(nproc)}
N_LAYER=${N_LAYER:-52}
KEEP=${KEEP:-}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$W/scores" "$W/logs" "$W/mem" "$W/bytes"
export PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$W/bench.log"; }

# ends K: a regex for the first K and last K blocks.
ends() {
  local k=$1 i out=""
  for ((i = 0; i < k; i++)); do out+="$i|$((N_LAYER - 1 - i))|"; done
  echo "blk\\.(${out%|})\\."
}
# mids K: a regex for K blocks around the middle, for layer pruning.
mids() {
  local k=$1 i out="" m
  m=$((N_LAYER / 2 - k / 2))
  for ((i = 0; i < k; i++)); do out+="$((m + i)),"; done
  echo "${out%,}"
}

# args NAME: sets FT (preset) and A (extra llama-quantize args). Tensor patterns are regexes, the first match wins.
args() {
  A=()
  case $1 in
    # I/O tensors. They have no imatrix entries, so IQ1_S and IQ2_XXS can't be used on them; IQ1_M can.
    iq1s-io-lowest)   FT=IQ1_S;   A=(--output-tensor-type iq1_m --token-embedding-type iq1_m);;
    iq1s-out-q2)      FT=IQ1_S;   A=(--output-tensor-type q2_k --token-embedding-type iq1_m);;
    iq1s-out-q4)      FT=IQ1_S;   A=(--output-tensor-type q4_k --token-embedding-type iq1_m);;
    iq1s-io-high)     FT=IQ1_S;   A=(--output-tensor-type q8_0 --token-embedding-type q4_k);;
    # Attention and layer mixes on IQ1_S.
    iq1s-attn-iq2)    FT=IQ1_S;   A=(--tensor-type attn_q=iq2_xxs --tensor-type attn_k=iq2_xxs --tensor-type attn_v=iq2_xxs);;
    iq1s-ends4-iq2)   FT=IQ1_S;   A=(--tensor-type "$(ends 4)=iq2_xxs");;
    iq1s-ends8-iq2)   FT=IQ1_S;   A=(--tensor-type "$(ends 8)=iq2_xxs");;
    iq1s-ends4-q4)    FT=IQ1_S;   A=(--tensor-type "$(ends 4)=q4_k");;
    # IQ2_XXS with the I/O cut down, and pure presets with no mixture.
    iq2-out-q4)       FT=IQ2_XXS; A=(--output-tensor-type q4_k);;
    iq2-out-q2)       FT=IQ2_XXS; A=(--output-tensor-type q2_k --token-embedding-type iq1_m);;
    iq2-io-lowest)    FT=IQ2_XXS; A=(--output-tensor-type iq1_m --token-embedding-type iq1_m);;
    # Everything at the preset type, no mixture: the floor of the IQ family.
    iq1s-pure-lowest) FT=IQ1_S;   A=(--pure --output-tensor-type iq1_m --token-embedding-type iq1_m);;
    iq1s-pure-out-q2) FT=IQ1_S;   A=(--pure --output-tensor-type q2_k --token-embedding-type iq1_m);;
    # IQ2_XXS with one MLP part dropped to IQ1_S: which part can give up bits. MLP is 65% of the weights.
    iq2-gate1)        FT=IQ2_XXS; A=(--output-tensor-type q2_k --token-embedding-type iq1_m --tensor-type ffn_gate=iq1_s);;
    iq2-up1)          FT=IQ2_XXS; A=(--output-tensor-type q2_k --token-embedding-type iq1_m --tensor-type ffn_up=iq1_s);;
    iq2-down1)        FT=IQ2_XXS; A=(--output-tensor-type q2_k --token-embedding-type iq1_m --tensor-type ffn_down=iq1_s);;
    # Q1_0 (1.125 bits): the lowest type this llama.cpp has. Rule-based, so it ignores the imatrix.
    q1-pure)          FT=Q1_0;    A=(--pure --output-tensor-type q1_0 --token-embedding-type q1_0);;
    q1-io-keep)       FT=Q1_0;    A=(--pure --output-tensor-type q5_k --token-embedding-type q2_k);;
    # One cheap measurement: drop two middle layers.
    iq1s-prune2)      FT=IQ1_S;   A=(--prune-layers "$(mids 2)");;
    *) return 1;;
  esac
}
LOCAL_CANDS=${LOCAL_CANDS:-}
[ -z "$LOCAL_CANDS" ] || . "$LOCAL_CANDS"   # optional file: `extra_args NAME` adds or overrides candidates.
ALL="iq1s-io-lowest iq1s-out-q2 iq1s-out-q4 iq1s-io-high iq1s-attn-iq2 iq1s-ends4-iq2 iq1s-ends8-iq2 iq1s-ends4-q4 iq2-out-q4 iq2-out-q2 iq2-io-lowest iq1s-pure-lowest iq1s-pure-out-q2 iq2-gate1 iq2-up1 iq2-down1 q1-pure q1-io-keep iq1s-prune2"
DEFAULT=${DEFAULT:-$ALL}

resolve() { if declare -F extra_args > /dev/null && extra_args "$1"; then return 0; fi; args "$1"; }

quantize() { # NAME OUT
  resolve "$1"
  nice -n 10 "$BIN/llama-quantize" --imatrix "$IMATRIX" "${A[@]}" "$BF16" "$2.part" "$FT" "$THREADS" > "$W/logs/quant-$1.log" 2>&1
  mv "$2.part" "$2"
}

# Memory with one slot and a small context, as a device would run it: GPU MiB above the idle reading and the server's
# resident set, after one short generation. Called with the GPU lock held.
mem_probe() { # GGUF OUT PORT
  local gguf=$1 out=$2 port=$3 base used pid rss i
  base=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
  "$BIN/llama-server" -m "$gguf" --port "$port" --host 127.0.0.1 -ngl 999 -fa on -np 1 -c 2048 --no-webui > "$out.server.log" 2>&1 &
  pid=$!
  for ((i = 0; i < 600; i++)); do curl -sf "http://127.0.0.1:$port/health" > /dev/null && break; sleep 1; done
  curl -sf "http://127.0.0.1:$port/completion" -H 'Content-Type: application/json' -d '{"prompt":"The capital of France is","n_predict":32,"temperature":0}' > /dev/null || true
  used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
  rss=$(awk '/VmRSS/ {print $2}' "/proc/$pid/status")
  kill "$pid"; wait "$pid" 2> /dev/null || true
  echo "{\"gpu_idle_mib\": $base, \"gpu_used_mib\": $used, \"gpu_model_mib\": $((used - base)), \"rss_kb\": $rss, \"ctx\": 2048, \"slots\": 1}" > "$out"
}

case ${1:-} in
  --mem-locked) shift; mem_probe "$@"; exit 0;;
  --list)
    for c in $DEFAULT; do
      resolve "$c"
      printf '%-18s %-8s ' "$c" "$FT"
      "$BIN/llama-quantize" --dry-run --imatrix "$IMATRIX" "${A[@]}" "$BF16" "$FT" 2>&1 | grep -E 'quant size|error|invalid|Unknown' | head -2 | cut -c30-
    done
    exit 0;;
  --table)
    "$PY" -I "$HERE/shrink_table.py" --dir "$W" --stock "$STOCK" --base "$BASE_SCORES" --n "$N" | tee "$W/table.md"
    exit 0;;
esac

CANDS=("$@")
[ ${#CANDS[@]} -gt 0 ] || read -r -a CANDS <<< "$DEFAULT"
for c in "${CANDS[@]}"; do
  out=$W/$c.gguf
  score=$W/scores/$c.json
  if [ -e "$score" ] && [ -e "$W/mem/$c.json" ]; then log "skip $c (scored)"; continue; fi
  resolve "$c" || { log "unknown candidate $c"; continue; }
  if [ ! -e "$score" ] || [ ! -e "$W/mem/$c.json" ]; then
    if [ ! -e "$out" ]; then
      log "quantize $c: $FT ${A[*]}"
      t0=$(date +%s)
      quantize "$c" "$out" || { log "FAILED quantize $c, see logs/quant-$c.log"; rm -f "$out.part"; continue; }
      log "quantized $c in $(( $(date +%s) - t0 ))s, $(du -BM "$out" | cut -f1)"
    fi
    "$PY" -I "$HERE/gguf_bytes.py" "$out" --json "$W/bytes/$c.json" > "$W/bytes/$c.txt"
    if [ ! -e "$score" ]; then
      log "score $c (waiting for the GPU lock)"
      flock "$Q/gpu.lock" "$PY" -I "$SCORER" --gguf "$out" --label "$c" --out "$score" --tokenizer "$BASE_HF" --probes "$PROBES" \
        --forget "$FORGET" --n-probes "$N" --port "$PORT" > "$W/logs/score-$c.log" 2>&1 \
        || { log "FAILED score $c, see logs/score-$c.log"; [[ " $KEEP " == *" $c "* ]] || rm -f "$out"; continue; }
    fi
    flock "$Q/gpu.lock" "$0" --mem-locked "$out" "$W/mem/$c.json" "$PORT" || log "FAILED mem probe $c"
  fi
  log "scored $c: $("$PY" -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['gb'],'GB',d['probe_right'],'/',d['n_probes'],'old',d['forget_right'],'/',d['n_forget'],'decode',d['decode_tokens_per_second_single'],'tok/s')" "$score")"
  [[ " $KEEP " == *" $c "* ]] || rm -f "$out"
  "$0" --table > /dev/null 2>&1 || true
done
log "lane done: ${CANDS[*]}"
