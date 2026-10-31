#!/bin/bash
# Mac side of quantize.sh's storage step: bring a run's small outputs from the GPU machine to this Mac under
# .data/knowledge/models/<run>/ and put them, with the adapter, in s3://muse-knowledge-916979311153/knowledge/models/<run>/.
# Credentials stay on this Mac (the offlinebase profile); the GPU machines never see them.
#
#   store_run.sh <run> [gguf ...]    e.g. store_run.sh stage1 IQ1_S IQ1_M
#
# GGUFs named on the command line are streamed from the GPU machine through this Mac to S3 without landing on disk
# (this Mac's disk is nearly full); with STORE_GGUF_LOCAL=1 they are also kept under .data/knowledge/models/<run>/.
# Upload speed from here was measured at about 2.1 MB/s, so a 7 GB IQ1_S takes about an hour.
set -euo pipefail
RUN=${1:?run}; shift
KEY=~/.ssh/muse-muse-lambda
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
WR=ubuntu@$(cat "$REPO/.data/aws/writer1.ip")
Q=/home/ubuntu/q
LOCAL=$REPO/.data/knowledge/models/$RUN
S3=s3://muse-knowledge-916979311153/knowledge/models/$RUN
AWS=(aws --profile offlinebase)
mkdir -p "$LOCAL/scores"

# Small files: the table, the scores (with every reply), the merge check, step timings, the calibration report.
scp -q -i $KEY "$WR:$Q/$RUN/table.md" "$WR:$Q/$RUN/table.json" "$LOCAL/" 2>/dev/null || echo "no table yet"
scp -q -i $KEY "$WR:$Q/$RUN/scores/*.json" "$LOCAL/scores/" 2>/dev/null || echo "no scores yet"
scp -q -i $KEY "$WR:$Q/$RUN/merge-check.json" "$WR:$Q/$RUN/steps.jsonl" "$WR:$Q/$RUN/pipeline.log" "$LOCAL/" 2>/dev/null || true
# Optional: a speed-only pass (score_gguf.py --n-probes 0) after the scored runs, with nothing else on the CPU.
mkdir -p "$LOCAL/speed" && scp -q -i $KEY "$WR:$Q/$RUN/speed/*.json" "$LOCAL/speed/" 2>/dev/null || rmdir "$LOCAL/speed" 2>/dev/null || true
scp -q -i $KEY "$WR:$Q/calib/calib.txt.json" "$LOCAL/calibration.json" 2>/dev/null || true
ssh -i $KEY $WR "cd $Q/$RUN && ls -l *.gguf" > "$LOCAL/gguf-sizes.txt" 2>/dev/null || true

# sync, so an adapter already uploaded (1.7 GB, about 13 minutes from here) isn't sent again.
"${AWS[@]}" s3 sync --only-show-errors --exclude "*.gguf" "$LOCAL/" "$S3/"
echo "small files and adapter in $S3/"

for t in "$@"; do
  f=glimmer-$RUN-$t.gguf
  size=$(ssh -i $KEY $WR "stat -c %s $Q/$RUN/$f")
  if [ "${STORE_GGUF_LOCAL:-0}" = 1 ]; then
    scp -q -i $KEY "$WR:$Q/$RUN/$f" "$LOCAL/$f"
    "${AWS[@]}" s3 cp --only-show-errors "$LOCAL/$f" "$S3/$f"
  else
    ssh -i $KEY $WR "cat $Q/$RUN/$f" | "${AWS[@]}" s3 cp --only-show-errors --expected-size "$size" - "$S3/$f"
  fi
  got=$("${AWS[@]}" s3api head-object --bucket muse-knowledge-916979311153 --key "knowledge/models/$RUN/$f" --query ContentLength --output text)
  [ "$got" = "$size" ] && echo "$f in S3 ($size bytes)" || { echo "$f size mismatch: $got vs $size"; exit 1; }
done
