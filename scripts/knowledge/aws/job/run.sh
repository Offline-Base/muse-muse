#!/usr/bin/env bash
# The knowledge training job's entry point on SageMaker (train_job.py uploads this folder as the "code" channel).
# It builds the glimmer-lora recipe's pinned venv (lib/train/recipes/glimmer.ts) with uv, then runs train_glimmer.py.
set -euo pipefail
cd /opt/ml/input/data/code
export HF_HOME=/tmp/hf HF_HUB_ENABLE_HF_TRANSFER=0 PYTHONUNBUFFERED=1
pip install -q "uv==0.13.1"
uv venv -q /opt/venv --python 3.12
PY=/opt/venv/bin/python
uv pip install -q --python $PY torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35 --index-url https://download.pytorch.org/whl/cu128
uv pip install -q --python $PY unsloth==2026.10.9 unsloth_zoo==2026.10.9 peft==0.21.2 accelerate==1.15.0 bitsandbytes==0.50.2 datasets==4.8.5
uv pip install -q --python $PY --no-deps torchao==0.18.0
uv pip install -q --python $PY transformers==5.15.0
uv pip install -q --python $PY --no-deps trl==0.22.2
$PY -c "import torch; assert torch.cuda.is_available(); print('MUSE gpu', torch.cuda.get_device_name(0), torch.version.cuda)"
exec $PY train_glimmer.py
