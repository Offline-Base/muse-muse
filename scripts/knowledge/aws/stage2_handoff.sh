#!/bin/bash
# Stage 2's adapter from muse-knowledge-train-1 to writer-1 (llama.cpp pipeline) and the GH200 (NanoQuant), through
# this Mac, since the machines hold no keys to each other (docs/KNOWLEDGE_RUN_LOG.md, Oct 31).
#
#   nohup bash scripts/knowledge/aws/stage2_handoff.sh >> .data/knowledge/logs/stage2-handoff.log 2>&1 &
#
# Waits for train_glimmer.py's adapter_saved event, which comes about 25 minutes before its final answers, pulls the
# adapter into the folder the train_multi sync uses, checks its sha256 against train-1, then pushes it to writer-1
# first (its pipeline makes the files that run on Macs and Jetsons) and the GH200, checks it on each, and marks it
# complete. On writer-1 it starts quantize.sh once the honesty test has let go of the GPU; on the GH200,
# nanoquant/nq_stage2_slots.sh is already waiting for the marker. The upload from here is about 2.5 MB/s, so each push
# of the 1.7 GB adapter takes about 11 minutes.
set -euo pipefail
OPTS=(-i ~/.ssh/muse-muse-lambda -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
TRAIN=${TRAIN_HOST:?set TRAIN_HOST to train-1 as ubuntu@<address>}
WR=${WRITER_HOST:?set WRITER_HOST to writer-1 as ubuntu@<address>}
GH=${GH200_HOST:?set GH200_HOST to the GH200 as ubuntu@<address>}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
LOCAL=$REPO/.data/knowledge/runs/stage2-multi/out/adapter
SRC=/home/ubuntu/k/runs/stage2-multi/out/adapter
FILES="adapter_model.safetensors adapter_config.json"
log() { echo "[$(date -u +%FT%TZ)] handoff $*"; }
r() { local h=$1; shift; ssh "${OPTS[@]}" "$h" "$@"; }

log "waiting for adapter_saved in train-1's stage2-multi log"
until r $TRAIN 'grep -q "\"event\": \"adapter_saved\"" ~/k/runs/stage2-multi/log.txt' 2>/dev/null; do sleep 60; done
log "adapter saved; pulling it here"
mkdir -p "$LOCAL"
rsync -a -e "ssh ${OPTS[*]}" "$TRAIN:$SRC/" "$LOCAL/"
WANT=$(r $TRAIN "cd $SRC && sha256sum $FILES")
GOT=$(cd "$LOCAL" && shasum -a 256 $FILES)
[ "$WANT" = "$GOT" ] || { log "sha256 differs here: $GOT vs $WANT"; exit 1; }
log "here, sha256 $(echo "$WANT" | head -1 | cut -c1-16)"

push() {  # push HOST DEST: copy, check against train-1's sha256, then write the .complete marker
  local h=$1 dest=$2 there
  r $h "mkdir -p $dest && rm -f $dest/.complete"
  rsync -a -e "ssh ${OPTS[*]}" "$LOCAL/" "$h:$dest/"
  there=$(r $h "cd $dest && sha256sum $FILES")
  [ "$there" = "$WANT" ] || { log "sha256 differs on $h: $there"; return 1; }
  r $h "touch $dest/.complete"
  log "adapter on $h:$dest"
}

push $WR /home/ubuntu/q/stage2/adapter
# The honesty test's llama-server doesn't take quantize.sh's gpu.lock, so wait for it to finish before starting.
while r $WR 'pgrep -f [s]core_honesty.py > /dev/null'; do log "writer-1: honesty test still running; waiting"; sleep 60; done
r $WR 'cd ~/q && (nohup env PROBES=/home/ubuntu/q/data-stage2/stage2-eval-probes.jsonl bash ~/q/job/quantize.sh stage2 /home/ubuntu/q/stage2/adapter 2500 > ~/q/logs/stage2.out 2>&1 < /dev/null &)'
log "writer-1: quantize.sh stage2 started (2,500 probes)"

push $GH /home/ubuntu/k/runs/stage2/out/adapter
log "GH200: adapter in place for nq_stage2_slots.sh"
log "done"
