#!/bin/bash
# Stage 2 NanoQuant on the GH200 while stage 1's two runs finish there (docs/KNOWLEDGE_RUN_LOG.md, Oct 31).
#
#   nohup bash nq_stage2_slots.sh > ~/k/models/stage2-nanoquant/logs/slots.out 2>&1 &
#
# Instead of nq_rerun_stage2.sh's pipeline (both settings after stage 1 is done), each stage 2 setting takes the GPU
# slot the same setting's stage 1 run frees, so the GPU keeps two block-wise jobs on it the whole time.
# Every step that puts a whole model on the 96 GB GPU holds stage 1's gpu.lock: prepare and the BF16 scoring here
# (flock), and quantize's statistics and distillation phases (stage 2's gpu.lock is a link to stage 1's). So two whole
# models are never on the GPU at once, whichever run gets there first.
#
# Needs ~/k/runs/stage2/out/adapter with a .complete marker (stage2_handoff.sh on the Mac writes both, after checking
# the sha256 against train-1), and ~/k/models/stage2-nanoquant/data/{train.jsonl,eval-probes.jsonl,forget.jsonl,
# new-probes.jsonl}: stage 2's training file (calibration only, never the probes), the fixed 1,500, the 40 old facts
# and the 1,000 stage 2 probes from passages stage 1 never saw. Each setting is scored on 300 of the 1,500 (as in
# stage 1) and 300 of the 1,000.
set -uo pipefail
K=$HOME/k
S1=$K/models/stage1-nanoquant
ROOT=$K/models/stage2-nanoquant
LOCK=$S1/gpu.lock
NQ=$K/nq/nq_run.stage2.sh                # a frozen copy of nq_run.sh, so edits to the code folder can't change it
C=$K/nq/code
PY=$K/nq/venv/bin/python
BASE=$K/hf/hub/models--meta-models--Muse-Glimmer-30B/snapshots/cec94fcfd6512f2cfe708138c32533b346ea4f69
export NQ_NAME=stage2 NQ_ADAPTER=$K/runs/stage2/out/adapter NQ_CALIB_JSONL=$ROOT/data/train.jsonl
export HF_HOME=$K/hf PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false
NEW=$ROOT/data/new-probes.jsonl
FORGET=$ROOT/data/forget.jsonl
mkdir -p "$ROOT/logs"
log() { echo "SLOTS $(date -u +%FT%TZ) $*" | tee -a "$ROOT/logs/run.log"; }

for f in train.jsonl eval-probes.jsonl forget.jsonl new-probes.jsonl; do
  [ -s "$ROOT/data/$f" ] || { log "missing $ROOT/data/$f"; exit 1; }
done
[ -f "$ROOT/settings.env" ] || cp "$S1/settings.env" "$ROOT/settings.env"   # stage 1's epochs, samples and probes
[ -f "$NQ" ] || cp "$C/nq_run.sh" "$NQ"
ln -sfn "$LOCK" "$ROOT/gpu.lock"

log "waiting for $NQ_ADAPTER/.complete"
until [ -f "$NQ_ADAPTER/.complete" ]; do sleep 30; done

if ! "$PY" -c "import json,sys; sys.exit(0 if json.load(open('$ROOT/merge-report.json')).get('ok') else 1)" 2>/dev/null; then
  bash "$NQ" merge > "$ROOT/logs/merge.log" 2>&1 || { log "merge failed, see logs/merge.log"; exit 1; }
  "$PY" -c "import json,sys; sys.exit(0 if json.load(open('$ROOT/merge-report.json')).get('ok') else 1)" \
    || { log "merge check not ok, see merge-report.json"; exit 1; }
fi
log "merged; prepare and BF16 scoring wait for $LOCK"
if [ ! -f "$ROOT/calib/stats.pt" ] || [ ! -f "$ROOT/calib/teacher.pt" ]; then
  flock "$LOCK" bash "$NQ" prepare > "$ROOT/logs/prepare.log" 2>&1 || { log "prepare failed, see logs/prepare.log"; exit 1; }
fi
[ -d "$ROOT/bf16-merged" ] || flock "$LOCK" bash "$NQ" bf16 > "$ROOT/logs/bf16.log" 2>&1 || log "bf16 scoring failed (continuing)"
[ -d "$ROOT/bf16-merged-new" ] || flock "$LOCK" "$PY" -I -u "$C/nq_score.py" --base "$ROOT/merged-bf16" --probes "$NEW" \
  --forget "$FORGET" --n-probes 300 --out "$ROOT/bf16-merged-new" --label stage2-bf16-new > "$ROOT/logs/bf16-new.log" 2>&1 \
  || log "bf16 scoring on the new probes failed (continuing)"
log "prepared"

# A setting's slot is free once stage 1's quantize run at the same bits has exited (its scoring after that is small).
stage1_running() { pgrep -f "nq_glimmer.py quantize .*--bits $1 .*--out $S1/nq-$1 " > /dev/null; }
setting() {
  local B=$1
  while stage1_running "$B"; do sleep 60; done
  log "slot $B free; quantize"
  bash "$NQ" quantize "$B" > "$ROOT/logs/quantize-$B.log" 2>&1 || { log "quantize $B failed, see logs/quantize-$B.log"; return 1; }
  bash "$NQ" score "$B" > "$ROOT/logs/score-$B.log" 2>&1 || log "score $B failed"
  "$PY" -I -u "$C/nq_score.py" --base "$BASE" --tokenizer "$ROOT/merged-bf16" --nq "$ROOT/nq-$B/nq-text.safetensors" \
    --probes "$NEW" --forget "$FORGET" --n-probes 300 --out "$ROOT/nq-$B/score-new" --label "stage2-nq-$B-new" \
    --kernel-dtype bfloat16 > "$ROOT/logs/score-new-$B.log" 2>&1 || log "score $B on the new probes failed"
  log "done $B"
}
setting 0.55 &
sleep 120
setting 0.8 &
wait
log "all done"
