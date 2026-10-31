#!/bin/bash
# Prepares a muse-knowledge-train machine (scripts/knowledge/aws/train_multi.py) for train_glimmer.py on every GPU:
# the glimmer-lora venv with run.sh's pins, the Glimmer weights (BF16 on 80 GB GPUs, Unsloth's 4-bit on smaller
# ones), and the stage data. EC2 runs it from user data and reads the data from S3 with its instance role; Lambda
# runs it over SSH with the data already copied in (KNOWLEDGE_NO_S3=1). Public weights, no Hugging Face token.
set -uo pipefail
export PATH=$HOME/.local/bin:$PATH HF_HUB_DISABLE_TELEMETRY=1
unset HF_TOKEN HUGGING_FACE_HUB_TOKEN
K=/home/ubuntu/k
# The local NVMe (the Deep Learning AMI mounts it at /opt/dlami/nvme) holds weights, data and checkpoints.
FAST=$K
if [ -d /opt/dlami/nvme/k ] && [ -w /opt/dlami/nvme/k ]; then FAST=/opt/dlami/nvme/k; fi
mkdir -p $K $FAST/hf $FAST/data $FAST/runs
[ "$FAST" != "$K" ] && ln -sfn $FAST/hf $K/hf && ln -sfn $FAST/data $K/data && ln -sfn $FAST/runs $K/runs
cd $K
step(){ echo "MUSE setup $(date -u +%H:%M:%S) $*"; }

GPU_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
GPUS=$(nvidia-smi -L | wc -l)
if [ "$GPU_MB" -ge 70000 ]; then MODE=bf16; else MODE=4bit; fi
echo "GPUS=$GPUS MODE=$MODE" > $K/box.env
step "gpus $GPUS x ${GPU_MB} MiB, mode $MODE"

command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/0.13.1/install.sh | sh
export PATH=$HOME/.local/bin:$PATH

get_weights(){
  uv run -q --no-project --python 3.12 --with "huggingface_hub[hf_xet]==1.3.4" python -c \
    "import sys; from huggingface_hub import snapshot_download as s; print(s(sys.argv[1], revision=sys.argv[2], max_workers=32))" "$1" "$2"
}
step weights
if [ "$MODE" = bf16 ]; then
  HF_HOME=$K/hf get_weights meta-models/Muse-Glimmer-30B cec94fcfd6512f2cfe708138c32533b346ea4f69 > $K/weights.txt 2> $K/weights.log &
else
  HF_HOME=$K/hf get_weights unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit ecedda395d4d099b477d135a9a573eedaa5a7aad > $K/weights.txt 2> $K/weights.log &
fi
WPID=$!

step venv
uv venv -q $K/venv --python 3.12
PY=$K/venv/bin/python
uv pip install -q --python $PY torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35 --index-url https://download.pytorch.org/whl/cu128
uv pip install -q --python $PY unsloth==2026.10.9 unsloth_zoo==2026.10.9 peft==0.21.2 accelerate==1.15.0 bitsandbytes==0.50.2 datasets==4.8.5
uv pip install -q --python $PY --no-deps torchao==0.18.0
uv pip install -q --python $PY transformers==5.15.0
uv pip install -q --python $PY --no-deps trl==0.22.2
$PY -c "import torch; assert torch.cuda.is_available(); print('MUSE gpu', torch.cuda.device_count(), torch.cuda.get_device_name(0), torch.version.cuda)"

if [ "${KNOWLEDGE_NO_S3:-0}" != 1 ]; then
  step data
  B=s3://muse-knowledge-916979311153/knowledge/corpus/dataset
  aws s3 cp --only-show-errors $B/train-stage1.jsonl $FAST/data/train.jsonl
  aws s3 cp --only-show-errors $B/eval-probes.jsonl $FAST/data/probes.jsonl
  aws s3 cp --only-show-errors $B/forget.jsonl $FAST/data/forget.jsonl
fi
mkdir -p $FAST/data-test
head -n 1600 $FAST/data/train.jsonl > $FAST/data-test/train.jsonl
cp $FAST/data/probes.jsonl $FAST/data/forget.jsonl $FAST/data-test/
ln -sfn $FAST/data-test $K/data-test
wc -l $FAST/data/*.jsonl $FAST/data-test/train.jsonl

wait $WPID
step "weights exit $? at $(tail -1 $K/weights.txt)"
echo "MODEL_PATH=$(tail -1 $K/weights.txt)" >> $K/box.env
du -sh $K/hf
step done
touch $K/setup.done
