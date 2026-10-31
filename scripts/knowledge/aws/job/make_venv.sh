#!/bin/bash
# A local Python for quantize.sh, on the GPU machine's own disk: the versions of the training venv (transformers
# 5.15.0, peft 0.21.2, safetensors 0.8.0, tokenizers 0.22.2, numpy 2.5.2) with torch 2.11.0's CPU build, since the
# merge and the GGUF converter run on the CPU.
#
# Why not the shared venv: on Oct 31 at 03:02 UTC a fine-tuning lab job on the shared file system retired
# venvs/glimmer-bdf08ed7acaa (lib/train/recipes/glimmer.ts remove_old_venvs: other pins, no use stamped for 12 hours)
# while this pipeline was using it. The shared file system also stalled for a long stretch under heavy writes.
# Built this way it took under a minute.
#
# Usage: make_venv.sh [dir]   (default /home/ubuntu/q/pyenv2; the python is <dir>/venv/bin/python)
set -euo pipefail
D=${1:-/home/ubuntu/q/pyenv2}
mkdir -p "$D"
pip3 install --user -q uv==0.13.1 || pip3 install --user -q uv
export UV_CACHE_DIR=$D/cache UV_PYTHON_INSTALL_DIR=$D/python
UV=~/.local/bin/uv
$UV venv -q --python 3.12 "$D/venv"
$UV pip install -q --python "$D/venv/bin/python" --index-url https://download.pytorch.org/whl/cpu torch==2.11.0
$UV pip install -q --python "$D/venv/bin/python" transformers==5.15.0 peft==0.21.2 safetensors==0.8.0 tokenizers==0.22.2 \
  numpy==2.5.2 sentencepiece==0.2.2 protobuf accelerate
"$D/venv/bin/python" -c "import torch, transformers, peft; from transformers import MuseGlimmerForConditionalGeneration; print('venv ok', torch.__version__, transformers.__version__, peft.__version__)"
