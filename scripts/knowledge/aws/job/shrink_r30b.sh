#!/bin/bash
# writer-1: after quantize.sh stage-b-r30b has scored its IQ1_S, rerun the shrink bench's four default mixes on r30b's BF16
# with its imatrix, keeping iq1s-out-q4 and iq2-io-lowest. Stops if disk is short.
set -uo pipefail
R=/home/ubuntu/q/stage-b-r30b
log() { echo "[$(date -u +%FT%TZ)] shrink-r30b $*"; }
log "waiting for $R/scores/IQ1_S.json"
until [ -s $R/scores/IQ1_S.json ]; do
  pgrep -f "quantize.sh stage-b-r30b" >/dev/null || { [ -s $R/scores/IQ1_S.json ] || { log "quantize.sh ended without IQ1_S.json"; exit 1; }; }
  sleep 60
done
free=$(df --output=avail -B1G / | tail -1 | tr -d ' ')
log "IQ1_S scored; ${free} GB free"
[ "$free" -ge 22 ] || { log "under 22 GB free; not starting"; exit 1; }
BF16=$R/glimmer-stage-b-r30b-BF16.gguf IMATRIX=$R/imatrix.gguf STOCK=$R/scores W=/home/ubuntu/q/shrink-r30b \
  KEEP="iq1s-out-q4 iq2-io-lowest" PORT=8097 THREADS=24 bash /home/ubuntu/q/job/shrink_bench.sh
log "shrink_bench exit $?"
