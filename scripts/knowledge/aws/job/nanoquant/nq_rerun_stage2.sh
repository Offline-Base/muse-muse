#!/bin/bash
# The stage 1 NanoQuant run again, for the stage 2 model. Run from the Mac in ~/muse-muse; each step is one command.
# Assumes the GH200 (or another ARM64/x86 H100 box with ~450 GB RAM) still has ~/k/nq/venv from nq_setup.sh and the
# Glimmer base snapshot; stage 2's training run lives in ~/k/runs/stage2 and writes out/adapter and out/metrics.json.
# Set STAGE2_TRAIN to the stage 2 training file on the box (the calibration text; never the probes).
set -euo pipefail
H=${GH200_HOST:?set GH200_HOST to the GH200 as ubuntu@<address>}
KEY=~/.ssh/muse-muse-lambda
J=scripts/knowledge/aws/job
STAGE2_TRAIN=${STAGE2_TRAIN:?set STAGE2_TRAIN to the stage 2 train.jsonl path on the box}
STAGE2_PROBES=${STAGE2_PROBES:-/home/ubuntu/k/data-s1/probes.jsonl}   # same 1,500 eval probes unless stage 2 adds its own
STAGE2_FORGET=${STAGE2_FORGET:-/home/ubuntu/k/data-s1/forget.jsonl}

# 1. Code (and the venv, only if it's missing: about 5 minutes, 8 cores, no GPU).
scp -i $KEY $J/nanoquant/nq_*.py $J/nanoquant/nq_setup.sh $J/nanoquant/nq_run.sh $J/merge_adapter.py $J/train_glimmer.py $H:k/nq/code/
ssh -i $KEY $H '[ -x ~/k/nq/venv/bin/python ] || (nice -n 19 taskset -c 56-63 bash ~/k/nq/code/nq_setup.sh > ~/k/nq/setup.log 2>&1)'

# 2. Data copies next to the outputs.
ssh -i $KEY $H "D=~/k/models/stage2-nanoquant/data; mkdir -p \$D/../logs && cp -p $STAGE2_TRAIN \$D/train.jsonl && cp -p $STAGE2_PROBES \$D/eval-probes.jsonl && cp -p $STAGE2_FORGET \$D/forget.jsonl"

# 3. Wait for stage 2 to finish, then merge (CPU) and the 2-layer GPU test, unattended. The script is copied first so
#    later edits to the code folder can't change a running bash script under it.
ssh -i $KEY $H 'cp ~/k/nq/code/nq_run.sh ~/k/nq/nq_run.stage2.sh; cd ~/k/models/stage2-nanoquant && (NQ_NAME=stage2 NQ_CALIB_JSONL=$HOME/k/models/stage2-nanoquant/data/train.jsonl nohup bash ~/k/nq/nq_run.stage2.sh watch >> logs/watch.log 2>&1 < /dev/null &)'
#    Check: ssh ... 'tail ~/k/models/stage2-nanoquant/logs/{watch,merge,gputest}.log'; merge-report.json must say "ok": true.

# 4. Settings used for stage 1 (see ~/k/models/stage1-nanoquant/settings.env), then the run: prepare (stats + teacher
#    logits), BF16 reference score, both bit settings side by side, each scored through the GEMV kernels.
ssh -i $KEY $H 'cp ~/k/models/stage1-nanoquant/settings.env ~/k/models/stage2-nanoquant/settings.env; cd ~/k/models/stage2-nanoquant && (NQ_NAME=stage2 NQ_CALIB_JSONL=$HOME/k/models/stage2-nanoquant/data/train.jsonl nohup bash ~/k/nq/nq_run.stage2.sh pipeline > logs/pipeline.log 2>&1 < /dev/null &)'
#    Progress: ssh ... 'grep "NQ {\"event\": \"block\"" ~/k/models/stage2-nanoquant/logs/quantize-0.8.log | tail -2'
#    A stopped quantize run resumes from its last 4-block checkpoint:
#      NQ_NAME=stage2 NQ_RESUME=1 NQ_CALIB_JSONL=... bash ~/k/nq/nq_run.stage2.sh quantize 0.8

# 5. Results to the Mac and S3 (only small files and nq-text.safetensors go through the Mac; nq-full.pt stays on the box).
bash $J/nanoquant/nq_pull.sh stage2 0.8 0.55
