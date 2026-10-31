#!/bin/bash
# Optional: can Muse Code implement a made-up method from one paragraph and run it, offline, on the venv and MNIST from setup?
# Muse Code on muse-spark-1.3-contributor only, low effort, reminders off, telemetry off, through mc-proxy.mjs on loopback (which
# refuses any other model and stops at its budget). The firewall allows api.meta.ai only, and gives the real key only to the
# proxy's placeholder. Muse Code holds a stand-in, REP_STANDIN. Our own cl.py is removed first so it can't be read.
set -uo pipefail
OUT=/tmp/out/muse
mkdir -p "$OUT" /tmp/mc
rm -f /tmp/spike/cl.py
export PATH="$HOME/.local/bin:$PATH"
muse --version 2>&1 | head -1
cat > /tmp/mc-prompt.md <<'EOF'
Implement and run a continual learning method from this description. Write all code yourself, in this folder. Do not read any
file outside this folder except the MNIST files named below. There is no network.

The method, "Running Importance Damping" (RID): After finishing each task, compute an importance score for every weight: the mean
absolute value of the gradient of the cross-entropy loss with respect to that weight, over 256 training examples of the task just
finished, using their true labels. Keep a running importance O, which starts at zero: after task k, O = 0.5 * O + I_k, where I_k is
that task's importance. While training every later task, after loss.backward() and before the optimizer step, divide each weight's
gradient by (1 + 20 * O / max(O)), where max(O) is the largest entry of O over all weights. Nothing else changes from plain
fine-tuning.

The setup: Split MNIST with five tasks, digits (0,1), (2,3), (4,5), (6,7), (8,9), learned in that order. Task-incremental: an MLP
784-400-400-10 with ReLU, and in training and testing only the current task's two output logits compete (mask the other eight).
Adam, learning rate 0.001, a new optimizer for each task, batch 128, one epoch per task, seed 0. Pixels scaled to [0, 1].
The data is the four IDX files in /tmp/rep/data/MNIST/raw (train-images-idx3-ubyte, train-labels-idx1-ubyte,
t10k-images-idx3-ubyte, t10k-labels-idx1-ubyte; read them yourself with gzip or plain open, with no torchvision). Use
/tmp/rep/venv/bin/python, which has torch.

Write rid.py that trains plain fine-tuning and then RID in the same setup and, for each, reports average test accuracy over the five
tasks after the last task, and average forgetting (for each of the first four tasks, its best test accuracy after any earlier point
minus its accuracy at the end). Write test_rid.py with one unittest that checks the gradient damping on a tiny made-up tensor. Run
the test, then run rid.py. The last line rid.py prints must be exactly: RESULT {"finetune": {"avg_acc": A, "forgetting": F}, "rid": {"avg_acc": A, "forgetting": F}}
with numbers in place of A and F. Keep it short. Stop once both have run.
EOF
SID=$(cat /proc/sys/kernel/random/uuid)
help=$(muse exec --help 2>&1)
cmd=(muse exec --json --yolo --session-id "$SID" --prompt-file /tmp/mc-prompt.md --model muse-spark-1.3-contributor
  --reasoning-effort low --max-model-steps 40 --disable-web-tools)
for f in --disable-request-user-input --no-foreign-personal-context --disable-reminders; do
  if grep -Eq -- "(^|[^A-Za-z0-9_-])$f([^A-Za-z0-9_-]|$)" <<<"$help"; then cmd+=("$f"); else echo "no $f in this muse exec"; fi
done
OFF='{"enabled":false}'
REM="{\"plugin:tbh-reminders:reminder:skill-reminder\":$OFF,\"plugin:tbh-reminders:reminder:goal-reminder\":$OFF,\"plugin:tbh-reminders:reminder:verify-reminder\":$OFF,\"plugin:tbh-reminders:reminder:memory-reminder\":$OFF,\"plugin:tbh-reminders:reminder:todo-reminder\":$OFF,\"plugin:tbh-reminders:reminder:scope-reminder\":$OFF}"
cmd+=(-c 'endpoint_transport={"base_url":"http://127.0.0.1:8787/v1","auth":"bearer"}' -c 'telemetry.enabled=false' -c "runtime_capabilities=$REM")
rm -rf "$HOME/.local/share/muse/model-catalog"
start=$(date +%s.%N)
(cd /tmp/mc && META_API_KEY="$REP_STANDIN" timeout 720 "${cmd[@]}" >"$OUT/exec.jsonl" 2>"$OUT/exec.stderr")
code=$?
echo "muse exec exit $code in $(awk -v a="$start" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }') s"
tail -c 1500 "$OUT/exec.stderr"
echo "== files Muse Code left"
(cd /tmp/mc && find . -path ./.muse -prune -o -type f -printf '%s %p\n' | sort -k2)
mkdir -p "$OUT/code"
cp /tmp/mc/*.py "$OUT/code/" 2>/dev/null
echo "== our own rerun, egress still closed to everything but the proxy"
if [ -f /tmp/mc/test_rid.py ]; then (cd /tmp/mc && timeout 120 /tmp/rep/venv/bin/python -m unittest test_rid 2>&1 | tail -5); fi
if [ -f /tmp/mc/rid.py ]; then
  start=$(date +%s.%N)
  (cd /tmp/mc && timeout 300 /tmp/rep/venv/bin/python rid.py 2>&1 | tail -8) | tee "$OUT/rerun.txt"
  echo "rerun wall $(awk -v a="$start" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }') s"
fi
echo "== proxy"
curl -s -m 3 http://127.0.0.1:8787/__health; echo
