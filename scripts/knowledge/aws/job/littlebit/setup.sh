#!/bin/bash
# Installs LittleBit (SamsungLabs, CC BY-NC 4.0: NON-COMMERCIAL ONLY, see README.md) for the Glimmer adaptation, in
# its own venv, apart from the training venv. Run on the GPU machine, never on the owner's Mac. Idempotent.
#
#   bash setup.sh                       venv at $LB_HOME/venv, LittleBit at $LB_HOME/LittleBit (LB_HOME=~/lb)
#   GLIMMER_DIR=~/glimmer DOWNLOAD_BASE=1 bash setup.sh   also fetch base Glimmer at the pinned revision (public, no token)
#
# The versions are the ones the one-GPU proof ran with on Oct 31, 2026. LittleBit asks for transformers 4.51, which
# has no Glimmer; 5.15.0 is what Glimmer's config names and what train_glimmer.py uses. No secrets are needed or used.
set -euo pipefail
LB_HOME=${LB_HOME:-$HOME/lb}
LITTLEBIT_URL=https://github.com/SamsungLabs/LittleBit.git
LITTLEBIT_COMMIT=42d658b0c79f76450b34b6a3547462c7cdc3e1a0   # main on 2026-10-09, the one tested
GLIMMER_REVISION=cec94fcfd6512f2cfe708138c32533b346ea4f69
UV_VERSION=0.9.5
mkdir -p "$LB_HOME"
export PATH=$HOME/.local/bin:$PATH
command -v uv >/dev/null 2>&1 && [ "$(uv --version | cut -d' ' -f2)" = "$UV_VERSION" ] || python3 -m pip install --user -q "uv==$UV_VERSION"

if [ ! -f "$LB_HOME/venv/.muse-ready" ]; then
  rm -rf "$LB_HOME/venv"
  uv venv -q -p 3.12 "$LB_HOME/venv"
  export VIRTUAL_ENV=$LB_HOME/venv
  uv pip install -q "torch==2.11.0+cu128" "torchvision==0.26.0+cu128" --index-url https://download.pytorch.org/whl/cu128
  uv pip install -q "transformers==5.15.0" "tokenizers==0.22.2" "accelerate==1.15.0" "datasets==4.8.5" "deepspeed==0.19.9" \
    "safetensors==0.8.0" "huggingface-hub==1.33.0" "hf-xet==1.8.0" "numpy==2.5.4" "pyarrow==26.0.0" "ninja==1.13.2" \
    "sentencepiece==0.2.2" "pillow==13.0.0" "tqdm==4.70.1" "gputil==1.4.0" "pytorch-optimizer==4.1.0" "tensorboardx==2.6.5"
  "$LB_HOME/venv/bin/python" -c "import torch, transformers, deepspeed, datasets; assert torch.cuda.is_available(); print('LB_SETUP', torch.__version__, transformers.__version__, deepspeed.__version__)"
  touch "$LB_HOME/venv/.muse-ready"
fi

if [ ! -d "$LB_HOME/LittleBit/.git" ]; then
  git clone -q "$LITTLEBIT_URL" "$LB_HOME/LittleBit"
fi
git -C "$LB_HOME/LittleBit" fetch -q origin
git -C "$LB_HOME/LittleBit" checkout -q "$LITTLEBIT_COMMIT"
test "$(git -C "$LB_HOME/LittleBit" rev-parse HEAD)" = "$LITTLEBIT_COMMIT"
grep -q "CC BY-NC\|Attribution-NonCommercial" "$LB_HOME/LittleBit/LICENSE" "$LB_HOME/LittleBit/README.md"

if [ "${DOWNLOAD_BASE:-0}" = 1 ]; then
  GLIMMER_DIR=${GLIMMER_DIR:-$HOME/glimmer}
  [ -f "$GLIMMER_DIR/model.safetensors.index.json" ] || HF_HOME=${HF_HOME:-$HOME/hf} "$LB_HOME/venv/bin/hf" download meta-models/Muse-Glimmer-30B \
    --revision "$GLIMMER_REVISION" --local-dir "$GLIMMER_DIR"
fi
echo "LB_SETUP_DONE venv=$LB_HOME/venv littlebit=$LB_HOME/LittleBit@$LITTLEBIT_COMMIT"
