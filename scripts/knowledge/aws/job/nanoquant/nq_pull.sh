#!/bin/bash
# Run on the Mac. Copies the NanoQuant results from the GH200 to the Mac (.data/knowledge/models/<name>-nanoquant/), small files plus
# the compact quantized weights (nq-text.safetensors), then to S3 from the Mac. Usage: pull_nq.sh [name] [settings...]
set -euo pipefail
NAME=${1:-stage1}; shift || true
SETTINGS=${*:-0.8 0.55}
H=ubuntu@192.222.56.131
KEY=~/.ssh/muse-muse-lambda
R=/home/ubuntu/k/models/$NAME-nanoquant
L=/Users/ethancastro/muse-muse/.data/knowledge/models/$NAME-nanoquant
S3=s3://muse-knowledge-916979311153/knowledge/models/$NAME-nanoquant
mkdir -p "$L/code" "$L/logs" "$L/calib"
rsync -a -e "ssh -i $KEY" "$H:k/nq/code/" "$L/code/" --exclude __pycache__
rsync -a -e "ssh -i $KEY" "$H:$R/logs/" "$L/logs/"
rsync -a -e "ssh -i $KEY" --include "calib.pt" --include "stats.pt" --exclude "*" "$H:$R/calib/" "$L/calib/"
rsync -a -e "ssh -i $KEY" --include "*.json" --exclude "*" "$H:$R/" "$L/" || true
for d in bf16-merged gputest; do
  rsync -a -e "ssh -i $KEY" --exclude "*.pt" --exclude "teacher*" --exclude "work" --exclude "*.safetensors" "$H:$R/$d" "$L/" 2>/dev/null || true
done
for B in $SETTINGS; do
  mkdir -p "$L/nq-$B"
  rsync -a -e "ssh -i $KEY" --exclude "work" --exclude "nq-full.pt" "$H:$R/nq-$B/" "$L/nq-$B/"
done
du -sh "$L"; df -h /Users/ethancastro | tail -1
aws s3 cp --recursive "$L" "$S3" --profile offlinebase --only-show-errors
aws s3 ls --recursive "$S3" --profile offlinebase --summarize | tail -3
