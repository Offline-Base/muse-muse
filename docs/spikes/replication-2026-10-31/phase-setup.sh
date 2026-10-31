#!/bin/bash
# Setup, with open egress: the pinned uv (sha256 checked, as lib/train/recipes/glimmer.ts does), a uv-managed Python 3.12, CPU
# PyTorch and torchvision from PyTorch's CPU index only, then MNIST through torchvision's own download and md5 check.
# Writes timings and sizes to /tmp/out/setup.json. Prints no environment.
set -uo pipefail
OUT=/tmp/out
R=/tmp/rep
mkdir -p "$OUT" "$R"
UV_VERSION=0.13.1
UV_URL="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz"
UV_SHA256=eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220
TORCH_PIN="torch==2.11.0+cpu torchvision==0.26.0+cpu"
CPU_INDEX=https://download.pytorch.org/whl/cpu
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
bytes() { du -sb "$1" 2>/dev/null | cut -f1; }

echo "== machine"
uname -m
nproc
free -m | head -2
df -h /tmp | tail -1
head -2 /etc/os-release
command -v python3 >/dev/null && python3 --version || echo "no system python3"

echo "== uv $UV_VERSION"
T=$(now)
curl -fsSL --retry 2 -o "$R/uv.tgz" "$UV_URL" || { echo "uv download failed"; exit 10; }
echo "$UV_SHA256  $R/uv.tgz" | sha256sum -c - || { echo "uv sha256 mismatch"; exit 11; }
tar -xzf "$R/uv.tgz" -C "$R"
UV="$R/uv-x86_64-unknown-linux-gnu/uv"
"$UV" --version
UV_S=$(since "$T")

echo "== python 3.12 (uv-managed)"
T=$(now)
export UV_PYTHON_INSTALL_DIR="$R/python" UV_CACHE_DIR="$R/uv-cache" UV_LINK_MODE=copy
"$UV" venv --python 3.12 --python-preference only-managed "$R/venv" 2>&1 | tail -3
PY_S=$(since "$T")
"$R/venv/bin/python" --version

echo "== torch and torchvision, CPU wheels, pinned"
T=$(now)
PINNED=yes
if ! "$UV" pip install --python "$R/venv/bin/python" --index-url "$CPU_INDEX" $TORCH_PIN 2>&1 | tail -25; then
  PINNED=no
fi
if ! "$R/venv/bin/python" -c "import torch, torchvision" 2>/dev/null; then
  PINNED=no
  echo "pinned install failed; trying the newest CPU wheels"
  "$UV" pip install --python "$R/venv/bin/python" --index-url "$CPU_INDEX" torch torchvision 2>&1 | tail -25
fi
TORCH_S=$(since "$T")
"$R/venv/bin/python" -c "import torch, torchvision; print('torch', torch.__version__, 'torchvision', torchvision.__version__, 'threads', torch.get_num_threads(), 'mkldnn', torch.backends.mkldnn.is_available())"
"$UV" pip list --python "$R/venv/bin/python" 2>/dev/null | tee "$OUT/pip-list.txt"

echo "== MNIST through torchvision"
T=$(now)
"$R/venv/bin/python" - <<'PY' 2>&1 | grep -v '^\s*[0-9]*%' | tail -20
from torchvision.datasets import MNIST
for train in (True, False):
    d = MNIST("/tmp/rep/data", train=train, download=True)
    print("train" if train else "test", len(d))
PY
MNIST_S=$(since "$T")
ls -la /tmp/rep/data/MNIST/raw/
(cd /tmp/rep/data/MNIST/raw && sha256sum ./*.gz) | tee "$OUT/mnist-sha256.txt"

SITE=$("$R/venv/bin/python" -c "import site; print(site.getsitepackages()[0])")
"$R/venv/bin/python" - "$OUT/setup.json" <<PY
import json, sys
json.dump({
  "uv_s": $UV_S, "python_s": $PY_S, "torch_install_s": $TORCH_S, "mnist_s": $MNIST_S, "pinned": "$PINNED",
  "bytes": {
    "python": int("$(bytes "$R/python")" or 0), "venv": int("$(bytes "$R/venv")" or 0),
    "torch": int("$(bytes "$SITE/torch")" or 0), "torchvision": int("$(bytes "$SITE/torchvision")" or 0),
    "numpy": int("$(bytes "$SITE/numpy")" or 0), "uv_cache": int("$(bytes "$R/uv-cache")" or 0),
    "mnist_raw": int("$(bytes /tmp/rep/data/MNIST/raw)" or 0), "uv_binary": int("$(bytes "$UV")" or 0),
  },
}, open(sys.argv[1], "w"), indent=1)
PY
cat "$OUT/setup.json"
# The run phase needs only these; the uv cache goes so its size can't be mistaken for what a run needs.
rm -rf "$R/uv-cache" "$R/uv.tgz"
echo "setup done"
