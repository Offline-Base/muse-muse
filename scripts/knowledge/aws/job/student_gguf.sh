#!/bin/bash
# Package the Jetson student as GGUF and score every file (docs/KNOWLEDGE_UPDATE.md, Jetson; STUDENT.md has the
# commands). Runs on the training machine after train_student.py, with its venv; run_student.sh calls it with GGUF=1.
#
#   student_gguf.sh <run> <merged_dir> [N]   train_student.py's merged BF16 folder: BF16 GGUF, Q8_0, an imatrix from
#                                            training text, Q4_K_M with it; Q8_0 and Q4_K_M scored on N probes
#                                            (default 2500) and the 40 old-fact checks; table.md beside the run's BF16
#                                            metrics (and the base files', when $BASE_SCORES has them)
#   student_gguf.sh base <model_dir> [N]     the same for the untouched student, the yardstick for the tuned files
#   student_gguf.sh build                    only the llama.cpp build, at the lowest CPU and disk priority with
#                                            $BUILD_JOBS jobs (12) and no GPU use, safe beside a running stage
#
# Q4_K_M keeps the layout of NVIDIA's file the fleet runs (token_embd and per_layer_token_embd at Q8_0, 6,180,446,208
# bytes for the base), so size and speed compare with jetson-infra docs/fleet.md; Q4_K_M_STOCK=1 adds a plain Q4_K_M
# too (about 5.0 GB). Text only, no mmproj. llama.cpp b11970 is cloned and built first when $LCPP has no finished build.
# Everything runs on one GPU, GPU 0 unless CUDA_VISIBLE_DEVICES says otherwise, on an 8-GPU machine too: the smoke test's
# timings, the board-like path, and the GPU whose memory the scores report.
# Every step skips when its output exists, so a rerun resumes. The GGUFs stay on this machine in $W; the scores, the
# table, sizes, checksums and step logs go to $SCORES, small files that train_multi.py lambda-sync brings to the Mac.
# Nothing here needs a credential: llama.cpp comes from GitHub, and HF_TOKEN is unset.
set -euo pipefail

RUN=${1:?run name, base or build}
if [ "$RUN" = build ]; then HF=; else HF=${2:?the merged folder, or the model folder for base}; fi
NPROBES=${3:-2500}
K=${K:-/home/ubuntu/k}
JOB=$(cd "$(dirname "$0")" && pwd)
TAG=b11970
LCPP=${LCPP:-$K/llama.cpp-$TAG}
BIN=$LCPP/build/bin
# The training venv (run_student.sh passes the one it used; its log says which).
PY=${PY:-$K/venv/bin/python}
DATA=${DATA:-$K/data-student}
PROBES=${PROBES:-$DATA/probes.jsonl}
FORGET=${FORGET:-$DATA/forget.jsonl}
TRAIN=${TRAIN:-$DATA/train.jsonl}
FIXED=${FIXED:-$DATA/eval-probes.jsonl}
NAME=$RUN
[ "$RUN" = base ] && NAME=student-base
[ "$RUN" = build ] && NAME=student-build
W=${W:-$K/models/$NAME}
SCORES=${SCORES:-$K/runs/$NAME/gguf}
METRICS=${METRICS:-$K/runs/$NAME/out/metrics.json}
PORT=${PORT:-8092}
THREADS=$(nproc)
mkdir -p "$W" "$SCORES/scores" "$SCORES/logs"
export PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
export CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-0}
unset HF_TOKEN HUGGING_FACE_HUB_TOKEN
export PATH=$HOME/.local/bin:$PATH
[ -d /usr/local/cuda/bin ] && export PATH=/usr/local/cuda/bin:$PATH

log() { echo "[$(date -u +%FT%TZ)] $NAME $*" | tee -a "$SCORES/pipeline.log"; }
# step NAME OUTPUT CMD...: runs CMD unless OUTPUT exists; CMD may write OUTPUT.part, which is renamed when it succeeds.
step() {
  local name=$1 out=$2; shift 2
  if [ -e "$out" ]; then log "skip $name ($out exists)"; return 0; fi
  log "start $name"
  local t0 rc=0; t0=$(date +%s)
  "$@" > "$SCORES/logs/$name.log" 2>&1 || rc=$?
  [ $rc = 0 ] || { log "FAILED $name (exit $rc), see $SCORES/logs/$name.log"; return 1; }
  [ -e "$out.part" ] && mv "$out.part" "$out"
  [ -e "$out" ] || { log "FAILED $name: no $out"; return 1; }
  local secs=$(( $(date +%s) - t0 ))
  echo "{\"step\": \"$name\", \"seconds\": $secs, \"out\": \"$out\"}" >> "$SCORES/steps.jsonl"
  log "done $name in ${secs}s"
}

# llama.cpp at the pinned release, CUDA for this machine's GPU only (a quicker build), the three tools used here. A
# function called from step's `||` runs without set -e, so each command that matters says what happens when it fails.
# No GPU is used: nvidia-smi only reads the compute capability, and CMake only compiles.
BUILT=$LCPP/build/tools-built
build() {
  if [ ! -d "$LCPP/.git" ]; then
    rm -rf "$LCPP.clone"
    git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp "$LCPP.clone" || return 1
    mv "$LCPP.clone" "$LCPP" || return 1
  fi
  local cap cmake=cmake jobs=$THREADS tool; local prio=(env)
  [ "$RUN" = build ] && { prio=(nice -n 19 ionice -c 3); jobs=${BUILD_JOBS:-12}; }
  cap=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d .) && [ -n "$cap" ] || return 1
  # A machine without CMake gets PyPI's build of it in a venv of its own: the training venv may be a running stage's.
  if ! command -v cmake >/dev/null; then
    cmake=$K/cmake-venv/bin/cmake
    if [ ! -x "$cmake" ]; then
      command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/0.13.1/install.sh | sh || return 1
      uv venv -q "$K/cmake-venv" --python 3.12 && uv pip install -q --python "$K/cmake-venv/bin/python" cmake==3.31.6 || return 1
    fi
  fi
  "${prio[@]}" "$cmake" -S "$LCPP" -B "$LCPP/build" -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$cap" -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF || return 1
  "${prio[@]}" "$cmake" --build "$LCPP/build" -j "$jobs" --target llama-server llama-quantize llama-imatrix || return 1
  for tool in llama-server llama-quantize llama-imatrix; do [ -x "$BIN/$tool" ] || { echo "no $BIN/$tool"; return 1; }; done
  touch "$BUILT"
}
step build "$BUILT" build
COMMIT=$(git -C "$LCPP" rev-parse HEAD)
# b11970 is 52202132 (Oct 28); a different commit is logged, not fatal.
case $COMMIT in 52202132*) log "llama.cpp $TAG at $COMMIT";; *) log "WARNING llama.cpp $TAG is at $COMMIT, not 52202132";; esac
if [ "$RUN" = build ]; then log "finished: built in $BIN"; exit 0; fi

MODEL_TYPE=$("$PY" -I -c "import json, sys; print(json.load(open(sys.argv[1])).get('model_type', ''))" "$HF/config.json")
log "pipeline: hf=$HF model_type=$MODEL_TYPE probes=$NPROBES threads=$THREADS w=$W scores=$SCORES"

F="$W/$NAME"
BF16="$F-BF16.gguf"
# Text only: the converter's text model skips the vision and audio towers.
step convert "$BF16" "$PY" "$LCPP/convert_hf_to_gguf.py" "$HF" --outtype bf16 --outfile "$BF16.part"
step q8_0 "$F-Q8_0.gguf" "$BIN/llama-quantize" "$BF16" "$F-Q8_0.gguf.part" Q8_0 "$THREADS"
step calibration "$W/calib.txt" "$PY" -I "$JOB/score_student_gguf.py" calib --train "$TRAIN" --tokenizer "$HF" \
  --probes "$PROBES" --forget "$FORGET" --out "$W/calib.txt.part" --report "$SCORES/calibration.json"
step imatrix "$W/imatrix.gguf" "$BIN/llama-imatrix" -m "$F-Q8_0.gguf" -f "$W/calib.txt" -o "$W/imatrix.gguf.part" \
  -ngl 999 -c 512 -b 2048 -ub 512 --parse-special --no-ppl --output-format gguf

LAYOUT=()
if [ "$MODEL_TYPE" = gemma4 ]; then LAYOUT=(--token-embedding-type q8_0 --tensor-type per_layer_token_embd=q8_0); fi
step quant_Q4_K_M "$F-Q4_K_M.gguf" "$BIN/llama-quantize" --imatrix "$W/imatrix.gguf" "${LAYOUT[@]}" "$BF16" "$F-Q4_K_M.gguf.part" Q4_K_M "$THREADS"
SCORE="Q8_0 Q4_K_M"
if [ "${Q4_K_M_STOCK:-0}" = 1 ]; then
  step quant_Q4_K_M-stock "$F-Q4_K_M-stock.gguf" "$BIN/llama-quantize" --imatrix "$W/imatrix.gguf" "$BF16" "$F-Q4_K_M-stock.gguf.part" Q4_K_M "$THREADS"
  SCORE="$SCORE Q4_K_M-stock"
fi
ls -l "$W"/*.gguf > "$SCORES/gguf-sizes.txt"

for t in $SCORE; do
  step "score_$t" "$SCORES/scores/$t.json" "$PY" -I "$JOB/score_student_gguf.py" score --gguf "$F-$t.gguf" --label "$NAME $t" \
    --out "$SCORES/scores/$t.json" --server-log "$W/score-$t.server.log" --tokenizer "$HF" --probes "$PROBES" --forget "$FORGET" \
    --train "$TRAIN" --fixed-probes "$FIXED" --n-probes "$NPROBES" --server "$BIN/llama-server" --port "$PORT"
done
# Checksums of the files a board would get, for the deploy record.
[ -e "$SCORES/sha256.txt" ] || (cd "$W" && sha256sum "$NAME-Q4_K_M.gguf" "$NAME-Q8_0.gguf" > "$SCORES/sha256.txt.part" && mv "$SCORES/sha256.txt.part" "$SCORES/sha256.txt")

BASE_SCORES=${BASE_SCORES:-$K/runs/student-base/gguf}
BESIDE=()
if [ "$RUN" != base ] && [ -d "$BASE_SCORES/scores" ]; then BESIDE=(--base-dir "$BASE_SCORES"); fi
"$PY" -I "$JOB/score_student_gguf.py" table --dir "$SCORES" --metrics "$METRICS" "${BESIDE[@]}" | tee -a "$SCORES/pipeline.log"
log "finished: GGUFs in $W, scores and table in $SCORES"
