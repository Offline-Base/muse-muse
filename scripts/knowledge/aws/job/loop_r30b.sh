#!/bin/bash
# writer-1: repetition-loop check (loop_check.py) on r30b's files, each under ~/q/gpu.lock. Stock files once r30b's IQ1_S is
# scored; the shrink bench's kept mixes once it ends. r30's IQ1_S checks the tool against the DFlash helper's finding.
set -uo pipefail
Q=/home/ubuntu/q; R=$Q/stage-b-r30b; O=$Q/loops-r30b; mkdir -p $O
log() { echo "[$(date -u +%FT%TZ)] loops-r30b $*"; }
one() {  # label gguf
  [ -s "$O/$1.json" ] && { log "skip $1"; return; }
  [ -f "$2" ] || { log "missing $2"; return; }
  log "wait lock $1"
  flock $Q/gpu.lock timeout -k 15 1500 python3 -I $Q/job/loop_check.py --gguf "$2" --label "$1" --out "$O/$1.json" --seeds 1 --port 18741 \
    > "$O/$1.log" 2>&1
  rc=$?; pkill -f "llama-server .*--port 18741" 2>/dev/null; sleep 2
  log "done $1 rc=$rc $(grep ^LOOPS "$O/$1.log" | cut -c1-400)"
}
log "waiting for $R/scores/IQ1_S.json"
until [ -s $R/scores/IQ1_S.json ]; do sleep 60; done
one r30b-IQ1_S $R/glimmer-stage-b-r30b-IQ1_S.gguf
one r30-IQ1_S $Q/stage-b-r30/glimmer-stage-b-r30-IQ1_S.gguf
one r30b-IQ2_XXS $R/glimmer-stage-b-r30b-IQ2_XXS.gguf
one base-IQ1_S $Q/base/glimmer-base-IQ1_S.gguf
one r30b-Q4_K_M $R/glimmer-stage-b-r30b-Q4_K_M.gguf
one r30b-IQ1_M $R/glimmer-stage-b-r30b-IQ1_M.gguf
log "waiting for the shrink bench to end"
until grep -q "shrink_bench exit" $Q/logs/shrink-r30b.out 2>/dev/null || ! pgrep -f shrink_r30b.sh >/dev/null; do sleep 60; done
one r30b-iq2-io-lowest $Q/shrink-r30b/iq2-io-lowest.gguf
one r30b-iq1s-out-q4 $Q/shrink-r30b/iq1s-out-q4.gguf
log ALLDONE
