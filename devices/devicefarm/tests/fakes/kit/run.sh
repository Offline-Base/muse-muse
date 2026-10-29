#!/bin/sh
# Stands in for devices/kit/run.sh on the fake phone in host.sh's tests: the RAM gate, the model check, then a finished
# folder, as the real kit leaves them (the real kit has its own tests). Paths from the plan's env point at the real
# phone, so they are read under $FAKE_PHONE. FAKE_KIT_SLEEP makes it take that many seconds.
out="$FAKE_PHONE$MM_OUT"
model="$FAKE_PHONE$MM_MODEL"
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "run.sh: MM_OUT isn't empty" >&2
  exit 2
fi
mkdir -p "$out"
printf 'kit=1\nsubject=%s\nplatform=android\nbackends=%s\n' "$MM_SUBJECT" "$MM_BACKENDS" >"$out/run.txt"
ram=$(sed -n 's/^MemTotal: *\([0-9]*\) kB.*/\1/p' "$FAKE_PHONE/proc/meminfo")
printf 'platform=android\nram_kb=%s\n' "$ram" >"$out/device.txt"
if [ -n "${MM_MIN_RAM_KB:-}" ] && [ "$ram" -lt "$MM_MIN_RAM_KB" ]; then
  printf 'finished=1\nstatus=skipped\nwhy=ram\n' >>"$out/run.txt"
  exit 0
fi
if [ ! -f "$model" ]; then
  printf 'finished=1\nstatus=failed\nwhy=model\n' >>"$out/run.txt"
  exit 3
fi
printf 'bytes=%s\n' "$(wc -c <"$model" | tr -d ' ')" >"$out/model.txt"
[ -z "${FAKE_KIT_SLEEP:-}" ] || sleep "$FAKE_KIT_SLEEP"
printf 'finished=2\nseconds=1\nstatus=done\n' >>"$out/run.txt"
echo "fake kit: done"
