#!/bin/bash
# Sets up on-device training (train.py): PyTorch with CUDA 13 in ~/train/venv and Llama 3.2 1B in ~/train/models. Training this
# model on a Jetson hasn't been measured: PyTorch's setup was tested on an Orin Nano with an earlier model, and this one is larger.
# About 4.8 GB for the venv and 2.5 GB for the model. Tested on a Jetson Orin Nano on JetPack 7, where PyTorch's ordinary
# arm64 CUDA build sees the GPU. Also llama.cpp's converter scripts in ~/train/llama.cpp, a few MB, to turn adapters into GGUFs.
# It doesn't install a GGUF of the model, which start_model needs under a trained adapter: train_model refuses until there is one.
#
#   setup-train.sh
set -euo pipefail

UV_VERSION=0.13.1
UV_SHA256=9041c73c99fdc5892cf128140beb354eca9231d502068cc36e6cb53a8e59ad14
# The venv and the model, plus uv's cache while it installs them.
NEEDED_GIB=8
# Every package, pinned with its hashes: transformers reads this model through its own Llama classes, and peft follows it.
LOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/requirements-train.lock"
if [ ! -f "$LOCK" ]; then
  echo "Copy requirements-train.lock to this board, beside this script." >&2
  exit 1
fi
MODEL=unsloth/Llama-3.2-1B-Instruct
MODEL_REVISION=5a8abab4a5d6f164389b1079fb721cfab8d7126c
LLAMA_CPP_TAG=b11970
LLAMA_CPP_SHA256=d9062cf018a783af728bcaf404a9d384629558d6e8208b004f5be294413028d8

cd ~
mkdir -p train/models
cd train
if [ ! -x venv/bin/python ]; then
  free_gib=$(df --output=avail -BG . | tail -1 | tr -dc 0-9)
  if [ "$free_gib" -lt "$NEEDED_GIB" ]; then
    echo "Setup needs about $NEEDED_GIB GB of free disk, and this board has $free_gib GB." >&2
    exit 1
  fi
fi
export UV_CACHE_DIR="$HOME/train/.uvcache" UV_HTTP_TIMEOUT=900 UV_CONCURRENT_DOWNLOADS=2
# Even when a step fails, since a full card would stop the board's other services too.
trap 'rm -rf "$UV_CACHE_DIR" uv.tar.gz uv.part' EXIT
if [ ! -x ./uv ]; then
  curl -fsSL -o uv.tar.gz "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-unknown-linux-gnu.tar.gz"
  echo "$UV_SHA256  uv.tar.gz" | sha256sum -c -
  mkdir -p uv.part
  tar xzf uv.tar.gz --strip-components=1 -C uv.part uv-aarch64-unknown-linux-gnu/uv
  # Only whole does it take the name the test above trusts.
  mv uv.part/uv uv
fi
[ -x venv/bin/python ] || ./uv venv --python 3.12 --python-preference only-system venv
./uv pip install --python venv/bin/python --require-hashes --index https://download.pytorch.org/whl/cu130 --default-index https://pypi.org/simple --index-strategy unsafe-best-match -r "$LOCK"
rm -rf "$UV_CACHE_DIR"
venv/bin/python - "$MODEL" "$MODEL_REVISION" <<'EOF'
import os, sys
from huggingface_hub import snapshot_download
model, revision = sys.argv[1:]
snapshot_download(model, revision=revision, local_dir=os.path.expanduser("~/train/models/" + model.split("/")[-1]), ignore_patterns=["*.gguf"])
EOF
if [ ! -f "llama.cpp/.$LLAMA_CPP_TAG" ]; then
  curl -fsSL -o llama.cpp.tar.gz "https://github.com/ggml-org/llama.cpp/archive/refs/tags/$LLAMA_CPP_TAG.tar.gz"
  echo "$LLAMA_CPP_SHA256  llama.cpp.tar.gz" | sha256sum -c -
  rm -rf llama.cpp
  mkdir llama.cpp
  tar xzf llama.cpp.tar.gz --strip-components=1 -C llama.cpp "llama.cpp-$LLAMA_CPP_TAG/convert_lora_to_gguf.py" \
    "llama.cpp-$LLAMA_CPP_TAG/convert_hf_to_gguf.py" "llama.cpp-$LLAMA_CPP_TAG/conversion" "llama.cpp-$LLAMA_CPP_TAG/gguf-py"
  rm llama.cpp.tar.gz
  touch "llama.cpp/.$LLAMA_CPP_TAG"
fi
venv/bin/python llama.cpp/convert_lora_to_gguf.py --help > /dev/null
venv/bin/python -c "import torch; assert torch.cuda.is_available(), 'PyTorch cannot see the GPU'; print('GPU:', torch.cuda.get_device_name(0))"
df -h / | tail -1
