#!/bin/bash
# NanoQuant (SamsungLabs, Apache 2.0) as an installed tool on the GH200 (ARM64 + H100), in its own venv
# (~/k/nq/venv), apart from the training venv (~/k/venv). Its code stays in ~/k/nq/src/NanoQuant at a pinned commit;
# nothing of it is copied into the repo. Our Glimmer adaptation (nq_glimmer.py and friends) imports it.
#
# NanoQuant pins transformers==4.51.3, which has no Muse Glimmer, so it is installed with --no-deps next to
# transformers 5.15.0 (the version the training venv uses) and its other dependencies.
#
# Built without touching the GPU (CUDA_VISIBLE_DEVICES is empty, so setup.py compiles for sm_80, sm_89 and sm_90,
# which includes the H100), on at most 8 cores at the lowest priority, so it can run next to a training job:
#   nice -n 19 taskset -c 56-63 bash nq_setup.sh > ~/k/nq/setup.log 2>&1
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
export CUDA_VISIBLE_DEVICES=""
export MAX_JOBS=8
export TORCH_CUDA_ARCH_LIST="9.0"
NQ=$HOME/k/nq
COMMIT=a9e0a430881ff80d83b622c3129e330dc33c04f5
mkdir -p "$NQ/src"
if [ ! -d "$NQ/src/NanoQuant/.git" ]; then
  git clone https://github.com/SamsungLabs/NanoQuant.git "$NQ/src/NanoQuant"
fi
git -C "$NQ/src/NanoQuant" fetch -q origin "$COMMIT" 2>/dev/null || true
git -C "$NQ/src/NanoQuant" checkout -q "$COMMIT"
echo "NQ commit $(git -C "$NQ/src/NanoQuant" rev-parse HEAD)"

[ -x "$NQ/venv/bin/python" ] || uv venv -q "$NQ/venv" --python 3.12
PY=$NQ/venv/bin/python
uv pip install --python "$PY" torch==2.11.0+cu128 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$PY" transformers==5.15.0 accelerate==1.15.0 datasets==4.8.5 peft==0.21.2 safetensors \
  loguru tqdm numpy ninja pybind11 setuptools wheel rich "cut-cross-entropy>=25.1.1" "lm_eval>=0.4.9" "torch==2.11.0+cu128" \
  --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$PY" --no-deps -e "$NQ/src/NanoQuant"

# CUDA kernels (GEMV for decode, Marlin-style GEMM for prefill), built in place; a .pth file puts them on sys.path.
cd "$NQ/src/NanoQuant/src/nanoquant/kernel"
rm -rf build ./*.so
"$PY" setup.py build_ext --inplace
SITE=$("$PY" -c "import site; print(site.getsitepackages()[0])")
echo "$NQ/src/NanoQuant/src/nanoquant/kernel" > "$SITE/nanoquant_kernels.pth"
ls -la "$NQ/src/NanoQuant/src/nanoquant/kernel"/*.so

"$PY" - <<'EOF'
import importlib, torch, transformers
print("NQ versions", torch.__version__, torch.version.cuda, transformers.__version__)
# nanoquant.modules first: importing nanoquant.core first hits a circular import inside NanoQuant's packages.
for m in ["nanoquant.modules", "nanoquant.core.compress_block", "nanoquant.core.importance", "nanoquant.modules.linear",
          "nanoquant.utils.eval_utils", "nanoquant.kernel.utils", "cut_cross_entropy", "binary_kernels"]:
    importlib.import_module(m)
    print("NQ import ok", m)
for op in ["nanoquant_dyn_forward", "marlin_nanoquant_forward"]:
    getattr(torch.ops.binary_kernels, op)
    print("NQ op ok", op)
EOF
echo NQ_SETUP_DONE
