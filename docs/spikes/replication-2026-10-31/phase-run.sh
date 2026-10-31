#!/bin/bash
# The experiment, with egress closed: the same script at 8 threads on all 8 vCPUs, then at 4 threads pinned to 4 of them
# (taskset), which stands in for a 4 vCPU sandbox inside one VM.
set -uo pipefail
OUT=/tmp/out
PY=/tmp/rep/venv/bin/python
mkdir -p "$OUT"
grep -m1 'model name' /proc/cpuinfo
for n in 8 4; do
  last=$((n - 1))
  start=$(date +%s.%N)
  taskset -c "0-$last" "$PY" /tmp/spike/cl.py --data /tmp/rep/data --threads "$n" --out "$OUT/cl-$n.json" 2>&1 | tee "$OUT/cl-$n.txt"
  code=${PIPESTATUS[0]}
  echo "threads $n: exit $code, wall $(awk -v a="$start" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }') s"
done
