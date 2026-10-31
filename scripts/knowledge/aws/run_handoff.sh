#!/bin/bash
# A finished run's adapter from muse-knowledge-train-1 to writer-1's llama.cpp pipeline, piped through this Mac (the
# machines hold no keys to each other). stage2_handoff.sh generalized, without the GH200 (terminated Oct 31).
#
#   nohup bash scripts/knowledge/aws/run_handoff.sh RUN >> .data/knowledge/logs/RUN-handoff.log 2>&1 &
#
# Waits for train_glimmer.py's adapter_saved event, streams the adapter folder from train-1 to writer-1's ~/q/RUN/adapter
# (tar over two ssh sessions, so nothing lands on this Mac's disk: on Oct 31 a 1.7 GB local copy took the laptop
# under 4 GB free), checks its sha256 against train-1, makes the NFS output folder (models/ is root-owned, so
# quantize.sh's copy_out fails without it), then starts quantize.sh RUN with the 2,500 stage 2 probes.
# quantize.sh's GPU steps take ~/q/gpu.lock, so they wait for anything else holding it.
set -euo pipefail
RUN=${1:?usage: run_handoff.sh RUN}
[[ $RUN =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "RUN: letters, digits, . _ - only"; exit 1; }
OPTS=(-i ~/.ssh/muse-muse-lambda -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
TRAIN=ubuntu@163.192.200.51
WR=ubuntu@132.145.195.77
SRC=/home/ubuntu/k/runs/$RUN/out/adapter
DEST=/home/ubuntu/q/$RUN/adapter
NFS=/lambda/nfs/muse-muse-cache-us-east-1/models/$RUN
FILES="adapter_model.safetensors adapter_config.json"
log() { echo "[$(date -u +%FT%TZ)] handoff $RUN $*"; }
r() { local h=$1; shift; ssh "${OPTS[@]}" "$h" "$@"; }

log "waiting for adapter_saved in train-1's log"
until r $TRAIN "grep -q '\"event\": \"adapter_saved\"' ~/k/runs/$RUN/log.txt" 2>/dev/null; do sleep 60; done
sleep 30  # the tokenizer files are written just after the event
WANT=$(r $TRAIN "cd $SRC && sha256sum $FILES")
log "adapter saved, sha256 $(echo "$WANT" | head -1 | cut -c1-16); streaming it train-1 -> writer-1"
r $WR "mkdir -p $DEST && rm -f $DEST/.complete"
r $TRAIN "cd $SRC && tar cf - ." | r $WR "cd $DEST && tar xf -"
THERE=$(r $WR "cd $DEST && sha256sum $FILES")
[ "$THERE" = "$WANT" ] || { log "sha256 differs on writer-1: $THERE"; exit 1; }
r $WR "touch $DEST/.complete; sudo mkdir -p $NFS && sudo chown ubuntu:ubuntu $NFS"
log "adapter on writer-1:$DEST; NFS folder ready"

r $WR "mkdir -p ~/q/logs && cd ~/q && (nohup env PROBES=/home/ubuntu/q/data-stage2/stage2-eval-probes.jsonl bash ~/q/job/quantize.sh $RUN $DEST 2500 > ~/q/logs/$RUN.out 2>&1 < /dev/null &)"
log "writer-1: quantize.sh $RUN started (2,500 probes)"
log "done"
