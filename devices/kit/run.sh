#!/bin/sh
# One kit run: one GGUF file on this device with llama.cpp b11669 (docs/DEVICES.md "The kit contract").
#
# It checks the file (downloading it first when it is missing and MM_MODEL_URL is set), benches it with llama-bench on
# every backend in MM_BACKENDS, asks the fixed prompts with llama-completion on the backends that loaded, fastest first,
# and writes plain text into MM_OUT for lib/devices/result.ts. Every step runs under a watchdog (TERM at its limit, KILL
# 10 s later), benches and answers also under a memory sampler, and neither helper outlives the run.
#
# POSIX sh: Android's mksh with toybox, dash and bash on Linux, macOS's /bin/sh and /bin/dash. mksh does its arithmetic
# in signed 32 bits, so the kit counts only seconds and kB and compares byte sizes as strings.
#
# Inputs are environment variables only (kitEnvFor in lib/devices/subjects.ts), plus one the contract leaves out:
#   MM_CLEANUP=model   delete MM_MODEL (and a partial download) when the run ends. Otherwise the kit never deletes it.
# MM_TEST_PROC and MM_TEST_SYS stand in for /proc and /sys in the kit's own tests; runners never set them.
#
# Exit codes: 0 it ran (run.txt says how), 2 bad inputs (one line on stderr, nothing written), 3 the model is missing,
# wrong or couldn't be downloaded, 130 or 143 stopped by INT or TERM (run.txt then says status=cut why=signal).
#
# Beyond the contract's keys, run.txt has layout_<backend> (flat, bin-lib or missing), npu_sessions_used when the NPU
# backend lists fewer Hexagon sessions than asked for, why=time or why=signal with status=cut, and cleanup and
# removed with MM_CLEANUP; fetch.log holds curl's errors when the kit downloaded the model.

# shellcheck disable=SC3043 # local: mksh, dash and bash all have it (docs/DEVICES.md "Rules for run.sh")

# A dropped adb session sends SIGHUP and breaks the kit's stdout, so both are ignored (and so are they in every tool
# the kit starts, which inherit it).
trap '' HUP PIPE
LC_ALL=C
export LC_ALL
umask 022
# shellcheck disable=SC3045 # mksh, dash and bash all take ulimit -c
ulimit -c 0 2>/dev/null

# No secret reaches llama.cpp or curl (llama-bench reads HF_TOKEN), and the kit needs none of them.
unset HF_TOKEN HUGGING_FACE_HUB_TOKEN HF_API_TOKEN QDC_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_CREDENTIAL_EXPIRATION AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ROLE_ARN \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE \
  AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
# llama.cpp reads LLAMA_ARG_* as flags, which would change a run behind the kit's back.
for _n in $(env | sed -n 's/^\(LLAMA_ARG_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$_n"; done

EMPTY_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

# ---------------------------------------------------------------------------------------------------------------
# Inputs. Every problem is one line on stderr and exit 2, before anything is written.

bad() {
  printf 'run.sh: %s\n' "$*" >&2
  exit 2
}

# The characters isSafeKitValue allows, so every value is safe unquoted on an adb shell line and in env(1) words.
safe() {
  case $2 in *[!A-Za-z0-9._:/,@+=-]*) bad "$1 has a character the kit can't take" ;; esac
}

# A whole number without a leading zero, small enough for mksh's arithmetic.
whole() {
  case $2 in ''|*[!0-9]*|0?*|??????????*) bad "$1 must be a whole number below 1000000000" ;; esac
}

# At least 1, too.
count() {
  whole "$1" "$2"
  [ "$2" -ge 1 ] || bad "$1 must be at least 1"
}

case $0 in */*) KIT_DIR=${0%/*} ;; *) KIT_DIR=. ;; esac
KIT_DIR=$(cd "$KIT_DIR" 2>/dev/null && pwd) || bad "can't find the kit's folder"

for _n in MM_OUT MM_SUBJECT MM_MODEL MM_MODEL_BYTES MM_MODEL_SHA256 MM_SYSTEM_FILE MM_BACKENDS; do
  eval "_v=\${$_n:-}"
  [ -n "$_v" ] || bad "$_n is not set"
done
for _n in MM_OUT MM_SUBJECT MM_MODEL MM_MODEL_BYTES MM_MODEL_SHA256 MM_MODEL_URL MM_MIN_RAM_KB MM_SYSTEM_FILE \
  MM_TEMPLATE_FILE MM_PROMPTS MM_BACKENDS MM_LLAMA_CPU MM_LLAMA_GPU MM_LLAMA_NPU MM_NPU_SESSIONS MM_THREADS MM_CTX \
  MM_BENCH_PROMPT MM_BENCH_GEN MM_BENCH_REPS MM_ANSWER_TOKENS MM_SAMPLE_SECONDS MM_LIMIT_FETCH MM_LIMIT_CHECK \
  MM_LIMIT_BENCH MM_LIMIT_ANSWER MM_LIMIT_TOTAL MM_CLEANUP MM_TEST_PROC MM_TEST_SYS; do
  eval "_v=\${$_n:-}"
  safe "$_n" "$_v"
done

case $MM_SUBJECT in *[!A-Za-z0-9._-]*) bad "MM_SUBJECT must be a subject id" ;; esac
case $MM_MODEL_BYTES in *[!0-9]*|0*) bad "MM_MODEL_BYTES must be the file's size in bytes" ;; esac
case $MM_MODEL_SHA256 in *[!0-9a-f]*) bad "MM_MODEL_SHA256 must be 64 lowercase hex characters" ;; esac
[ ${#MM_MODEL_SHA256} -eq 64 ] || bad "MM_MODEL_SHA256 must be 64 lowercase hex characters"
case ${MM_MODEL_URL:-} in ''|http://*|https://*) ;; *) bad "MM_MODEL_URL must be an http or https URL" ;; esac
case ${MM_CLEANUP:-} in ''|model) ;; *) bad "MM_CLEANUP takes only the value model" ;; esac
[ -f "$MM_SYSTEM_FILE" ] && [ -r "$MM_SYSTEM_FILE" ] || bad "MM_SYSTEM_FILE isn't a readable file"
[ -z "${MM_TEMPLATE_FILE:-}" ] || [ -f "$MM_TEMPLATE_FILE" ] || bad "MM_TEMPLATE_FILE isn't a file"
[ -z "${MM_MIN_RAM_KB:-}" ] || whole MM_MIN_RAM_KB "$MM_MIN_RAM_KB"

CTX=${MM_CTX:-4096}
BENCH_P=${MM_BENCH_PROMPT:-128}
BENCH_G=${MM_BENCH_GEN:-16}
BENCH_R=${MM_BENCH_REPS:-2}
ANSWER_N=${MM_ANSWER_TOKENS:-192}
SAMPLE=${MM_SAMPLE_SECONDS:-2}
LIMIT_FETCH=${MM_LIMIT_FETCH:-3600}
LIMIT_CHECK=${MM_LIMIT_CHECK:-600}
LIMIT_BENCH=${MM_LIMIT_BENCH:-900}
LIMIT_ANSWER=${MM_LIMIT_ANSWER:-420}
LIMIT_TOTAL=${MM_LIMIT_TOTAL:-2400}
NPU_N=${MM_NPU_SESSIONS:-1}
THREADS=${MM_THREADS:-}
count MM_CTX "$CTX"
count MM_BENCH_PROMPT "$BENCH_P"
count MM_BENCH_GEN "$BENCH_G"
count MM_BENCH_REPS "$BENCH_R"
count MM_ANSWER_TOKENS "$ANSWER_N"
count MM_SAMPLE_SECONDS "$SAMPLE"
count MM_LIMIT_FETCH "$LIMIT_FETCH"
count MM_LIMIT_CHECK "$LIMIT_CHECK"
count MM_LIMIT_BENCH "$LIMIT_BENCH"
count MM_LIMIT_ANSWER "$LIMIT_ANSWER"
count MM_LIMIT_TOTAL "$LIMIT_TOTAL"
count MM_NPU_SESSIONS "$NPU_N"
[ "$NPU_N" -le 16 ] || bad "MM_NPU_SESSIONS must be 16 or less"
[ -z "$THREADS" ] || count MM_THREADS "$THREADS"

# The build folder for a backend.
llama_dir() {
  case $1 in
    cpu) printf '%s' "${MM_LLAMA_CPU:-}" ;;
    gpu) printf '%s' "${MM_LLAMA_GPU:-}" ;;
    npu) printf '%s' "${MM_LLAMA_NPU:-}" ;;
  esac
}

BACKS=
for _b in $(printf '%s' "$MM_BACKENDS" | tr ',' ' '); do
  case $_b in cpu|gpu|npu) ;; *) bad "MM_BACKENDS has an unknown backend: $_b" ;; esac
  case " $BACKS " in *" $_b "*) bad "MM_BACKENDS names $_b twice" ;; esac
  [ -n "$(llama_dir "$_b")" ] || bad "no build folder is set for the $_b backend"
  BACKS="$BACKS $_b"
done
BACKS=${BACKS# }
[ -n "$BACKS" ] || bad "MM_BACKENDS names no backend"

PROMPTS=${MM_PROMPTS:-capital,sum,color}
PROMPT_IDS=
for _p in $(printf '%s' "$PROMPTS" | tr ',' ' '); do
  case $_p in *[!a-z0-9_]*) bad "MM_PROMPTS has a bad prompt id: $_p" ;; esac
  case " $PROMPT_IDS " in *" $_p "*) bad "MM_PROMPTS names $_p twice" ;; esac
  [ -f "$KIT_DIR/prompts/$_p.txt" ] || bad "no prompt file for $_p in the kit's prompts folder"
  PROMPT_IDS="$PROMPT_IDS $_p"
done
PROMPT_IDS=${PROMPT_IDS# }
[ -n "$PROMPT_IDS" ] || bad "MM_PROMPTS names no prompt"

if [ -e "$MM_OUT" ]; then
  [ -d "$MM_OUT" ] || bad "MM_OUT exists and isn't a folder"
  [ -z "$(ls -A "$MM_OUT" 2>/dev/null)" ] || bad "MM_OUT isn't empty"
fi
mkdir -p "$MM_OUT" 2>/dev/null && [ -w "$MM_OUT" ] || bad "can't create MM_OUT"
OUT=$(cd "$MM_OUT" && pwd)

if command -v getprop >/dev/null 2>&1; then
  PLATFORM=android
elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  PLATFORM=macos
else
  PLATFORM=linux
fi
PROC=${MM_TEST_PROC:-/proc}
SYS=${MM_TEST_SYS:-/sys}
KIT_PID=$$
RUN=$OUT/run.txt
DEV=$OUT/device.txt
STEPS=$OUT/steps.txt

# ---------------------------------------------------------------------------------------------------------------
# Small helpers

now() {
  date +%s
}

min() {
  if [ "$1" -lt "$2" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}

log() {
  _line="$(date +%H:%M:%S) $*"
  printf '%s\n' "$_line"
  printf '%s\n' "$_line" >> "$OUT/kit.log"
}

# kv FILE KEY VALUE: one key=value line, with carriage returns and newlines in the value turned into spaces.
kv() {
  printf '%s=%s\n' "$2" "$(printf '%s' "$3" | tr '\r\n' '  ')" >> "$1"
}

# step_line NAME BACKEND PROMPT START SECONDS LIMIT RC END WHY: one line of steps.txt.
step_line() {
  printf 'name=%s backend=%s prompt=%s start=%s seconds=%s limit=%s rc=%s end=%s why=%s\n' "$@" >> "$STEPS"
}

# skip_step NAME BACKEND PROMPT WHY
skip_step() {
  step_line "$1" "$2" "$3" "$(now)" 0 0 - skipped "$4"
}

# div1024 N: floor(N / 1024) for a decimal string of any length, digit by digit, so no number gets near 2^31.
div1024() {
  local n q r c
  n=$1 q='' r=0
  case $n in ''|*[!0-9]*) return 0 ;; esac
  while [ -n "$n" ]; do
    c=${n%"${n#?}"}
    n=${n#?}
    r=$((r * 10 + c))
    q=$q$((r / 1024))
    r=$((r % 1024))
  done
  while [ "${q#0}" != "$q" ] && [ -n "${q#0}" ]; do q=${q#0}; done
  printf '%s' "$q"
}

# file_size FILE: its size in bytes as a string (it may not fit mksh's arithmetic). Toybox's stat -f means the
# filesystem, so only macOS uses it; wc -c is the fallback everywhere.
file_size() {
  local s
  s=
  [ -f "$1" ] || return 0
  if [ "$PLATFORM" = macos ]; then
    s=$(stat -L -f %z "$1" 2>/dev/null)
  else
    s=$(stat -L -c %s "$1" 2>/dev/null)
  fi
  case $s in ''|*[!0-9]*) s=$(wc -c < "$1" 2>/dev/null | tr -d ' \t') ;; esac
  printf '%s' "$s"
}

# free_kb DIR: free kB in the filesystem of DIR (or of its nearest existing parent), from df -kP.
free_kb() {
  local d
  d=$1
  while [ ! -d "$d" ]; do
    case $d in */*) d=${d%/*} ;; *) d=. ;; esac
    [ -n "$d" ] || d=/
  done
  df -kP "$d" 2>/dev/null | tail -n 1 |
    sed -n 's/^.*[[:space:]]\([0-9][0-9]*\)[[:space:]][[:space:]]*[0-9][0-9]*%[[:space:]].*$/\1/p'
}

# cap FILE MAX HEAD TAIL (bytes): a file over MAX keeps its first HEAD and last TAIL bytes, with a line between.
cap() {
  local size
  [ -f "$1" ] || return 0
  size=$(file_size "$1")
  [ -n "$size" ] && [ "$size" -gt "$2" ] || return 0
  { head -c "$3" "$1"; printf '\n[... cut by the kit ...]\n'; tail -c "$4" "$1"; } > "$1.cut" && mv "$1.cut" "$1"
}

# stop_pid PID: end a helper and reap it.
stop_pid() {
  kill -TERM "$1" 2>/dev/null
  wait "$1" 2>/dev/null
}

# watchdog LIMIT PID MARKER, in the background: after LIMIT seconds, touch MARKER, TERM PID, and KILL it 10 s later.
# It acts only while the kit lives, so a pid the system has reused is never hit. Its sleeps go with it, and it holds
# none of the kit's output open (adb shell would wait for it).
watchdog() {
  (
    _ws=''
    trap 'kill "$_ws" 2>/dev/null; exit 0' TERM
    sleep "$1" &
    _ws=$!
    wait "$_ws"
    kill -0 "$KIT_PID" 2>/dev/null || exit 0
    touch "$3"
    kill -TERM "$2" 2>/dev/null
    sleep 10 &
    _ws=$!
    wait "$_ws"
    kill -0 "$KIT_PID" 2>/dev/null || exit 0
    kill -KILL "$2" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
}

# quick LIMIT CMD...: CMD's stdout, with the command stopped after LIMIT seconds (dumpsys and logcat can hang).
quick() {
  local limit pid w
  limit=$1
  shift
  "$@" </dev/null >"$OUT/.quick" 2>/dev/null &
  pid=$!
  watchdog "$limit" "$pid" "$OUT/.quick-timeout"
  w=$!
  wait "$pid" 2>/dev/null
  stop_pid "$w"
  cat "$OUT/.quick" 2>/dev/null
  rm -f "$OUT/.quick" "$OUT/.quick-timeout"
}

prop() {
  getprop "$1" 2>/dev/null | head -n 1
}

thermal_status() {
  quick 15 dumpsys thermalservice | sed -n 's/^Thermal Status:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1
}

# hottest: the hottest plausible thermal zone in millidegrees C (zones that read garbage are left out).
hottest() {
  local max v
  max=
  # shellcheck disable=SC2013 # each zone's file holds one number
  for v in $(cat "$SYS"/class/thermal/thermal_zone*/temp 2>/dev/null); do
    case $v in ''|*[!0-9]*|??????????*) continue ;; esac
    [ "$v" -gt 0 ] && [ "$v" -lt 150000 ] || continue
    if [ -z "$max" ] || [ "$v" -gt "$max" ]; then max=$v; fi
  done
  printf '%s' "$max"
}

# sample PID T: one line of mem-<step>.txt. PID is empty for the t=0 sample taken before the tool starts.
sample() {
  local line
  line="t=$2"
  if [ "$PLATFORM" = macos ]; then
    [ -z "$1" ] || line="$line rss_kb=$(ps -o rss= -p "$1" 2>/dev/null | tr -d ' ')"
    line="$line level=$(sysctl -n kern.memorystatus_level 2>/dev/null)"
  else
    line="$line $(sed -n -e 's/^MemAvailable:[[:space:]]*\([0-9][0-9]*\).*/avail_kb=\1/p' \
      -e 's/^MemFree:[[:space:]]*\([0-9][0-9]*\).*/free_kb=\1/p' -e 's/^Cached:[[:space:]]*\([0-9][0-9]*\).*/cached_kb=\1/p' \
      -e 's/^SwapFree:[[:space:]]*\([0-9][0-9]*\).*/swap_free_kb=\1/p' "$PROC/meminfo" 2>/dev/null | tr '\n' ' ')"
    if [ -n "$1" ]; then
      line="$line $(sed -n -e 's/^VmRSS:[[:space:]]*\([0-9][0-9]*\).*/rss_kb=\1/p' \
        -e 's/^VmHWM:[[:space:]]*\([0-9][0-9]*\).*/hwm_kb=\1/p' -e 's/^RssAnon:[[:space:]]*\([0-9][0-9]*\).*/anon_kb=\1/p' \
        -e 's/^RssFile:[[:space:]]*\([0-9][0-9]*\).*/file_kb=\1/p' "$PROC/$1/status" 2>/dev/null | tr '\n' ' ')"
    fi
    line="$line temp_mc=$(hottest)"
  fi
  printf '%s\n' "$line" | tr -s ' '
}

# sampler PID FILE START, in the background: a sample every MM_SAMPLE_SECONDS while PID and the kit live.
sampler() {
  (
    _ss=''
    trap 'kill "$_ss" 2>/dev/null; exit 0' TERM
    while kill -0 "$1" 2>/dev/null && kill -0 "$KIT_PID" 2>/dev/null; do
      sample "$1" $(($(now) - $3)) >> "$2"
      sleep "$SAMPLE" &
      _ss=$!
      wait "$_ss"
    done
  ) </dev/null >/dev/null 2>&1 &
}

# lmk_check PID STEP: "lmk" when the system logs name PID in a low-memory kill (the lines go to lmk-<step>.txt),
# otherwise "signal9". Android's lmkd logs to the main and events buffers; the kernel's own OOM killer, which the
# kernel buffer may show, counts too.
lmk_check() {
  local f
  f=$OUT/lmk-$2.txt
  if [ "$PLATFORM" = android ]; then
    quick 30 logcat -d -b main,system,events | grep -E 'lowmemorykiller|lmkd|killinfo' |
      grep -E "(^|[^0-9])$1([^0-9]|\$)" > "$f"
    [ -s "$f" ] || quick 30 logcat -d -b kernel | grep -E 'lowmemorykiller|Out of memory|oom_reaper|oom-kill' |
      grep -E "(^|[^0-9])$1([^0-9]|\$)" > "$f"
    if [ -s "$f" ]; then
      cap "$f" 262144 196608 65536
      printf 'lmk'
      return 0
    fi
    rm -f "$f"
  fi
  printf 'signal9'
}

# run_tool STEP LIMIT OUT ERR SAMPLED CMD...: CMD in the background with stdin from /dev/null, stdout to OUT and
# stderr to ERR (- for OUT), under the watchdog and, when SAMPLED is 1, the sampler. Sets RC, SECS, END and WHY.
run_tool() {
  local step limit out err sampled pid w s t0 mark
  step=$1 limit=$2 out=$3 err=$4 sampled=$5
  shift 5
  mark=$OUT/.timeout-$step
  rm -f "$mark"
  if [ "$sampled" = 1 ]; then
    [ "$PLATFORM" != android ] || kv "$OUT/thermal-$step.txt" before "$(thermal_status)"
    sample "" 0 >> "$OUT/mem-$step.txt"
  fi
  t0=$(now)
  if [ "$err" = - ]; then
    "$@" </dev/null >"$out" 2>&1 &
  else
    "$@" </dev/null >"$out" 2>"$err" &
  fi
  pid=$!
  CUR_PID=$pid
  watchdog "$limit" "$pid" "$mark"
  w=$!
  s=
  if [ "$sampled" = 1 ]; then
    sampler "$pid" "$OUT/mem-$step.txt" "$t0"
    s=$!
  fi
  CUR_HELPERS="$w $s"
  # wait's own stderr goes nowhere: shells print a "Terminated" notice there for a job a signal ended.
  wait "$pid" 2>/dev/null
  RC=$?
  stop_pid "$w"
  [ -z "$s" ] || stop_pid "$s"
  CUR_PID=
  CUR_HELPERS=
  SECS=$(($(now) - t0))
  if [ "$RC" -eq 0 ]; then
    END=ok WHY=-
  elif [ -f "$mark" ]; then
    END=timeout WHY=limit
  elif [ "$RC" -eq 137 ] || [ "$RC" -eq 265 ]; then
    END=killed
    WHY=$(lmk_check "$pid" "$step")
  elif [ "$RC" -gt 256 ]; then
    END=crashed WHY=signal$((RC - 256))
  elif [ "$RC" -gt 128 ]; then
    END=crashed WHY=signal$((RC - 128))
  else
    END=error WHY=-
  fi
  rm -f "$mark"
  if [ "$sampled" = 1 ]; then
    [ "$PLATFORM" != android ] || kv "$OUT/thermal-$step.txt" after "$(thermal_status)"
    cap "$OUT/mem-$step.txt" 262144 196608 65536
  fi
}

# The end of the run: run.txt's last lines. The model goes only when MM_CLEANUP asks.
finish() {
  local t
  t=$(now)
  kv "$RUN" finished "$t"
  kv "$RUN" seconds "$((t - STARTED))"
  kv "$RUN" status "$1"
  [ -z "${2:-}" ] || kv "$RUN" why "$2"
  if [ "${MM_CLEANUP:-}" = model ]; then
    rm -f "$MM_MODEL" "$MM_MODEL.part"
    kv "$RUN" removed 1
    log "deleted the model, as MM_CLEANUP asked"
  fi
  rm -f "$OUT"/.timeout-* "$OUT"/.err-* "$OUT/.quick" "$OUT/.quick-timeout" "$OUT/.check" "$OUT/.fetch"
  log "finished: status=$1${2:+ why=$2}"
}

# on_signal CODE: a TERM or INT from outside. Stop the tool and the helpers, say so in run.txt and exit CODE (128 plus
# the signal). The step that was running gets no line in steps.txt; result.ts reads it, and every step after it, as
# stopped.
# shellcheck disable=SC2329 # the traps below call it
on_signal() {
  trap '' INT TERM
  [ -z "${CUR_PID:-}" ] || kill -KILL "$CUR_PID" 2>/dev/null
  for _h in ${CUR_HELPERS:-}; do kill -TERM "$_h" 2>/dev/null; done
  log "stopped by a signal"
  finish cut signal
  exit "$1"
}

# ---------------------------------------------------------------------------------------------------------------
# Backends

# The layout of a build folder: flat, bin-lib (detected by bin/llama-bench) or missing.
layout_of() {
  if [ -f "$1/bin/llama-bench" ]; then
    printf 'bin-lib'
  elif [ -f "$1/llama-bench" ]; then
    printf 'flat'
  else
    printf 'missing'
  fi
}

# use_build BACKEND: sets BIN and LIB for the backend's build folder.
use_build() {
  local dir
  dir=$(llama_dir "$1")
  if [ "$(layout_of "$dir")" = bin-lib ]; then BIN=$dir/bin LIB=$dir/lib; else BIN=$dir LIB=$dir; fi
}

# dev_names BACKEND SEP: llama.cpp's device list for the backend, joined by SEP.
dev_names() {
  local i out
  case $1 in
    cpu) printf 'none' ;;
    gpu) if [ "$PLATFORM" = macos ]; then printf 'MTL0'; else printf 'GPUOpenCL'; fi ;;
    npu)
      i=0 out=
      while [ "$i" -lt "$NPU_N" ]; do
        out=$out${out:+$2}HTP$i
        i=$((i + 1))
      done
      printf '%s' "$out"
      ;;
  esac
}

# env_words BACKEND: the env(1) assignments the backend needs. The macOS build finds its libraries by @loader_path.
env_words() {
  [ "$PLATFORM" != macos ] || return 0
  case $1 in
    cpu) printf 'LD_LIBRARY_PATH=%s' "$LIB" ;;
    gpu) printf 'LD_LIBRARY_PATH=%s ADSP_LIBRARY_PATH=%s' "$LIB" "$LIB" ;;
    npu) printf 'LD_LIBRARY_PATH=%s ADSP_LIBRARY_PATH=%s GGML_HEXAGON_DEVICES=%s' "$LIB" "$LIB" "$NPU_N" ;;
  esac
}

# ngl_words BACKEND: the offload flags.
ngl_words() {
  case $1 in
    cpu) printf '%s' '-ngl 0' ;;
    gpu) printf '%s' '-ngl 99' ;;
    npu) printf '%s' '-ngl 99 -ub 1024' ;;
  esac
}

# listed FILE NAME...: every NAME has a device line "  NAME: ..." in llama-bench --list-devices' output.
listed() {
  local f n
  f=$1
  shift
  for n in "$@"; do
    grep -q "^  $n:" "$f" 2>/dev/null || return 1
  done
}

# htp_listed FILE: how many Hexagon sessions the list shows, counting HTP0, HTP1, ... up to the first one missing.
htp_listed() {
  local i
  i=0
  while [ "$i" -lt 16 ] && grep -q "^  HTP$i:" "$1" 2>/dev/null; do i=$((i + 1)); done
  printf '%s' "$i"
}

# The bench's end per backend, for the answers: ok, error, ..., or a skip's why.
set_bench() {
  case $1 in cpu) BENCH_CPU=$2 ;; gpu) BENCH_GPU=$2 ;; npu) BENCH_NPU=$2 ;; esac
}
get_bench() {
  case $1 in cpu) printf '%s' "${BENCH_CPU:-}" ;; gpu) printf '%s' "${BENCH_GPU:-}" ;; npu) printf '%s' "${BENCH_NPU:-}" ;; esac
}

time_left() {
  printf '%s' $((LIMIT_TOTAL - ($(now) - T0)))
}

# time_ok: 30 s or more of MM_LIMIT_TOTAL left. Once not, every later bench and answer is skipped with why=time.
time_ok() {
  [ -z "$CUT" ] && [ "$(time_left)" -ge 30 ] && return 0
  CUT=1
  return 1
}

# ---------------------------------------------------------------------------------------------------------------
# The steps

device_facts() {
  local mem
  kv "$DEV" platform "$PLATFORM"
  kv "$DEV" kernel "$(uname -r 2>/dev/null)"
  kv "$DEV" arch "$(uname -m 2>/dev/null)"
  if [ "$PLATFORM" = macos ]; then
    mem=$(sysctl -n hw.memsize 2>/dev/null)
    RAM_KB=$(div1024 "$mem")
    kv "$DEV" ram_kb "$RAM_KB"
    kv "$DEV" cores "$(sysctl -n hw.ncpu 2>/dev/null)"
  else
    RAM_KB=$(sed -n 's/^MemTotal:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PROC/meminfo" 2>/dev/null | head -n 1)
    kv "$DEV" ram_kb "$RAM_KB"
    kv "$DEV" cores "$(grep -c '^processor' "$PROC/cpuinfo" 2>/dev/null)"
  fi
  case $RAM_KB in *[!0-9]*|??????????*) RAM_KB= ;; esac
  kv "$DEV" disk_free_kb "$(free_kb "$MODEL_DIR")"
  case $PLATFORM in
    android)
      SDK=$(prop ro.build.version.sdk)
      kv "$DEV" manufacturer "$(prop ro.product.manufacturer)"
      kv "$DEV" model "$(prop ro.product.model)"
      kv "$DEV" brand "$(prop ro.product.brand)"
      kv "$DEV" device "$(prop ro.product.device)"
      kv "$DEV" android "$(prop ro.build.version.release)"
      kv "$DEV" sdk "$SDK"
      kv "$DEV" soc_manufacturer "$(prop ro.soc.manufacturer)"
      kv "$DEV" soc_model "$(prop ro.soc.model)"
      kv "$DEV" board "$(prop ro.board.platform)"
      kv "$DEV" hardware "$(prop ro.hardware)"
      kv "$DEV" abi "$(prop ro.product.cpu.abi)"
      kv "$DEV" cpuset "$(cat "$PROC/self/cpuset" 2>/dev/null)"
      kv "$DEV" thermal_status "$(thermal_status)"
      kv "$DEV" battery_temp_dc "$(quick 15 dumpsys battery |
        sed -n 's/^[[:space:]]*temperature:[[:space:]]*\(-*[0-9][0-9]*\).*/\1/p' | head -n 1)"
      case $SDK in ''|*[!0-9]*|??????????*) SDK= ;; esac
      ;;
    macos)
      kv "$DEV" hw_model "$(sysctl -n hw.model 2>/dev/null)"
      kv "$DEV" macos "$(sw_vers -productVersion 2>/dev/null)"
      kv "$DEV" chip "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
      kv "$DEV" perf_cores "$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null)"
      kv "$DEV" memorystatus_level "$(sysctl -n kern.memorystatus_level 2>/dev/null)"
      ;;
    *)
      kv "$DEV" os_release "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -n 1)"
      kv "$DEV" cpu "$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' "$PROC/cpuinfo" 2>/dev/null | head -n 1)"
      ;;
  esac
}

# model_txt CHECK BYTES SHA256 TOOL SECONDS
model_txt() {
  local f
  f=$OUT/model.txt
  : > "$f"
  kv "$f" path "$MM_MODEL"
  kv "$f" bytes_expected "$MM_MODEL_BYTES"
  kv "$f" bytes "$2"
  kv "$f" sha256_expected "$MM_MODEL_SHA256"
  kv "$f" sha256 "$3"
  kv "$f" check "$1"
  kv "$f" tool "$4"
  kv "$f" seconds "$5"
  kv "$f" fetched "$FETCHED"
  kv "$f" fetch_seconds "$FETCH_SECS"
}

# fail_model WHY: every bench skipped with why=model, status failed, exit 3.
fail_model() {
  local b
  for b in $BACKS; do skip_step bench "$b" - model; done
  finish failed "$1"
  exit 3
}

# fetch: the model from MM_MODEL_URL with the device's own curl, resuming a partial download.
fetch() {
  local part need have free start
  part=$MM_MODEL.part
  mkdir -p "$MODEL_DIR" 2>/dev/null
  if ! command -v curl >/dev/null 2>&1; then
    log "the model is missing and this device has no curl to download it"
    skip_step fetch - - no_curl
    model_txt missing "" "" "" ""
    fail_model no_curl
  fi
  if [ "$(file_size "$part")" = "$MM_MODEL_BYTES" ]; then
    mv "$part" "$MM_MODEL"
    FETCHED=1 FETCH_SECS=0
    step_line fetch - - "$(now)" 0 "$LIMIT_FETCH" - ok -
    log "a finished download was waiting in $part"
    return 0
  fi
  have=$(div1024 "$(file_size "$part")")
  need=$(($(div1024 "$MM_MODEL_BYTES") + 1 - ${have:-0} + 1048576))
  free=$(free_kb "$MODEL_DIR")
  if [ -n "$free" ] && [ "$free" -lt "$need" ]; then
    log "the download needs $need kB free (the file plus 1 GiB) and $MODEL_DIR has $free kB"
    skip_step fetch - - disk
    model_txt missing "" "" "" ""
    fail_model disk
  fi
  log "downloading the model (limit ${LIMIT_FETCH}s)"
  start=$(now)
  run_tool fetch "$LIMIT_FETCH" "$OUT/.fetch" "$OUT/.err-fetch" 0 \
    curl -fL -sS --retry 5 --retry-delay 10 -C - -o "$part" "$MM_MODEL_URL"
  FETCH_SECS=$SECS
  # curl's errors, with every URL's query taken out: a redirect's signed URL is a credential while it lasts.
  sed 's/\(https\{0,1\}:\/\/[^?[:space:]]*\)?[^[:space:]]*/\1/g' "$OUT/.err-fetch" > "$OUT/fetch.log" 2>/dev/null
  rm -f "$OUT/.err-fetch" "$OUT/.fetch"
  cap "$OUT/fetch.log" 262144 196608 65536
  [ -s "$OUT/fetch.log" ] || rm -f "$OUT/fetch.log"
  have=$(file_size "$part")
  if [ "$END" = ok ] && [ "$have" = "$MM_MODEL_BYTES" ]; then
    step_line fetch - - "$start" "$SECS" "$LIMIT_FETCH" "$RC" ok -
    mv "$part" "$MM_MODEL"
    FETCHED=1
    log "downloaded in ${SECS}s"
    return 0
  fi
  if [ "$END" = ok ]; then
    # curl ended well with the wrong size, so the partial file can't be trusted for the next try either.
    log "the download ended with ${have:-no} bytes, not $MM_MODEL_BYTES"
    rm -f "$part"
    step_line fetch - - "$start" "$SECS" "$LIMIT_FETCH" "$RC" error size
  else
    step_line fetch - - "$start" "$SECS" "$LIMIT_FETCH" "$RC" "$END" "$WHY"
  fi
  log "the download failed: end=$END rc=$RC (a partial file stays for the next try)"
  model_txt missing "" "" "" ""
  fail_model fetch
}

# hash_tool: the first sha256 tool here that gives the right digest of nothing.
hash_tool() {
  if sha256sum /dev/null 2>/dev/null | grep -q "^$EMPTY_SHA256"; then
    printf 'sha256sum'
  elif toybox sha256sum /dev/null 2>/dev/null | grep -q "^$EMPTY_SHA256"; then
    printf 'toybox'
  elif shasum -a 256 /dev/null 2>/dev/null | grep -q "^$EMPTY_SHA256"; then
    printf 'shasum'
  elif openssl dgst -sha256 /dev/null 2>/dev/null | grep -q "$EMPTY_SHA256\$"; then
    printf 'openssl'
  fi
}

# check: the size, then the sha256. A missing or wrong file ends the run with exit 3.
check() {
  local size tool sum start
  start=$(now)
  if [ ! -f "$MM_MODEL" ]; then
    log "no model at $MM_MODEL"
    model_txt missing "" "" "" ""
    step_line check - - "$start" 0 0 - error missing
    fail_model model
  fi
  size=$(file_size "$MM_MODEL")
  if [ "$size" != "$MM_MODEL_BYTES" ]; then
    log "the model has $size bytes, not $MM_MODEL_BYTES"
    model_txt size "$size" "" "" $(($(now) - start))
    step_line check - - "$start" $(($(now) - start)) 0 - error size
    fail_model model
  fi
  tool=$(hash_tool)
  if [ -z "$tool" ]; then
    log "no sha256 tool here: the size matches and the sha256 goes unchecked"
    model_txt no_tool "$size" "" "" 0
    step_line check - - "$start" 0 0 - skipped no_tool
    return 0
  fi
  case $tool in
    sha256sum) set -- sha256sum "$MM_MODEL" ;;
    toybox) set -- toybox sha256sum "$MM_MODEL" ;;
    shasum) set -- shasum -a 256 "$MM_MODEL" ;;
    openssl) set -- openssl dgst -sha256 "$MM_MODEL" ;;
  esac
  log "checking the sha256 with $tool (limit ${LIMIT_CHECK}s)"
  run_tool check "$LIMIT_CHECK" "$OUT/.check" - 0 "$@"
  sum=$(sed -n -e 's/^\([0-9a-fA-F]\{64\}\)[^0-9a-fA-F].*/\1/p' -e 's/^.*= *\([0-9a-fA-F]\{64\}\)$/\1/p' "$OUT/.check" |
    head -n 1 | tr 'A-F' 'a-f')
  rm -f "$OUT/.check"
  if [ "$END" = timeout ]; then
    log "the sha256 didn't finish in ${LIMIT_CHECK}s: the size matches and the run goes on unverified"
    model_txt timeout "$size" "" "$tool" "$SECS"
    step_line check - - "$start" "$SECS" "$LIMIT_CHECK" "$RC" timeout limit
    return 0
  fi
  if [ "$sum" = "$MM_MODEL_SHA256" ]; then
    model_txt ok "$size" "$sum" "$tool" "$SECS"
    step_line check - - "$start" "$SECS" "$LIMIT_CHECK" "$RC" ok -
    return 0
  fi
  log "the model's sha256 is ${sum:-unreadable}, not $MM_MODEL_SHA256"
  model_txt sha256 "$size" "$sum" "$tool" "$SECS"
  step_line check - - "$start" "$SECS" "$LIMIT_CHECK" "$RC" error sha256
  fail_model model
}

# bench BACKEND: llama-bench on one backend, after checking it can run here.
bench() {
  local b lim start words n
  b=$1
  if [ "$(layout_of "$(llama_dir "$b")")" = missing ]; then
    log "bench $b: no llama-bench in its build folder"
    skip_step bench "$b" - nobuild
    set_bench "$b" nobuild
    return 0
  fi
  if [ "$PLATFORM" = android ] && [ "$b" != cpu ] && [ -n "$SDK" ] && [ "$SDK" -lt 34 ]; then
    log "bench $b: the Snapdragon build needs Android 14 (API 34), this is API $SDK"
    skip_step bench "$b" - android_sdk
    set_bench "$b" android_sdk
    return 0
  fi
  if ! time_ok; then
    skip_step bench "$b" - time
    set_bench "$b" time
    return 0
  fi
  use_build "$b"
  words=$(env_words "$b")
  if [ "$b" != cpu ]; then
    lim=$(min 60 "$(time_left)")
    log "bench $b: listing the devices llama.cpp sees (limit ${lim}s)"
    start=$(now)
    # shellcheck disable=SC2086 # env words and device names hold no spaces (isSafeKitValue)
    run_tool "list-$b" "$lim" "$OUT/list-$b.txt" - 0 env $words "$BIN/llama-bench" --list-devices
    step_line list "$b" - "$start" "$SECS" "$lim" "$RC" "$END" "$WHY"
    cap "$OUT/list-$b.txt" 262144 196608 65536
    # The Hexagon backend may open fewer sessions than GGML_HEXAGON_DEVICES asks for (it forces one on v73 chips):
    # the NPU then runs on the sessions it lists.
    if [ "$b" = npu ]; then
      n=$(htp_listed "$OUT/list-npu.txt")
      if [ "$n" -ge 1 ] && [ "$n" -lt "$NPU_N" ]; then
        log "bench npu: the backend lists $n of the $NPU_N Hexagon sessions asked for, so the NPU runs on $n"
        NPU_N=$n
        kv "$RUN" npu_sessions_used "$n"
        words=$(env_words npu)
      fi
    fi
    # shellcheck disable=SC2046
    if ! listed "$OUT/list-$b.txt" $(dev_names "$b" ' '); then
      log "bench $b: $(dev_names "$b" ' ') not on this device"
      skip_step bench "$b" - unavailable
      set_bench "$b" unavailable
      return 0
    fi
    if ! time_ok; then
      skip_step bench "$b" - time
      set_bench "$b" time
      return 0
    fi
  fi
  lim=$(min "$LIMIT_BENCH" "$(time_left)")
  set -- "$BIN/llama-bench" -m "$MM_MODEL" -p "$BENCH_P" -n "$BENCH_G" -r "$BENCH_R" -o jsonl -v -dev "$(dev_names "$b" /)"
  # shellcheck disable=SC2046
  set -- "$@" $(ngl_words "$b")
  [ -z "$THREADS" ] || set -- "$@" -t "$THREADS"
  log "bench $b on $(dev_names "$b" /) (limit ${lim}s)"
  start=$(now)
  # shellcheck disable=SC2086
  run_tool "bench-$b" "$lim" "$OUT/bench-$b.jsonl" "$OUT/.err-bench-$b" 1 env $words "$@"
  step_line bench "$b" - "$start" "$SECS" "$lim" "$RC" "$END" "$WHY"
  grep -v -E '^(create_tensor|llama_graph_n_input_tensors|ggml_metal_library_compile)' "$OUT/.err-bench-$b" \
    > "$OUT/bench-$b.log" 2>/dev/null
  rm -f "$OUT/.err-bench-$b"
  cap "$OUT/bench-$b.jsonl" 262144 196608 65536
  cap "$OUT/bench-$b.log" 262144 196608 65536
  set_bench "$b" "$END"
  log "bench $b: end=$END why=$WHY rc=$RC in ${SECS}s"
}

# gen_score BACKEND: the bench's generation speed in thousandths of a token a second, or nothing without one. A speed
# of a million tokens a second or more counts as 999999.999, so the score stays inside mksh's 32 bits.
gen_score() {
  local ts int frac
  [ -f "$OUT/bench-$1.jsonl" ] || return 0
  ts=$(grep '"n_gen": *[1-9]' "$OUT/bench-$1.jsonl" | grep '"n_prompt": *0[,}]' | head -n 1 |
    sed -n 's/.*"avg_ts": *\([0-9][0-9]*\)\.\{0,1\}\([0-9]*\).*/\1.\2/p')
  [ -n "$ts" ] || return 0
  int=${ts%%.*}
  frac=${ts#*.}000
  frac=${frac%"${frac#???}"}
  while [ "${int#0}" != "$int" ] && [ -n "${int#0}" ]; do int=${int#0}; done
  case $int in ???????*) int=999999 frac=999 ;; esac
  printf '%s' $((int * 1000 + 1$frac - 1000))
}

# rank: RANKED holds the backends with a bench generation speed, fastest first (bench order on a tie); NOLOAD the rest.
rank() {
  local b s e best top rest
  RANKED='' NOLOAD='' rest=''
  for b in $BACKS; do
    s=$(gen_score "$b")
    if [ -n "$s" ]; then rest="$rest $b:$s"; else NOLOAD="$NOLOAD $b"; fi
  done
  while [ -n "$rest" ]; do
    best='' top=-1
    for e in $rest; do
      if [ "${e#*:}" -gt "$top" ]; then
        best=${e%%:*}
        top=${e#*:}
      fi
    done
    RANKED="$RANKED $best"
    s=
    for e in $rest; do [ "${e%%:*}" = "$best" ] || s="$s $e"; done
    rest=$s
  done
}

# answer BACKEND PROMPT: one fixed prompt through llama-completion.
answer() {
  local b p lim start words
  b=$1 p=$2
  if ! time_ok; then
    skip_step answer "$b" "$p" time
    return 0
  fi
  use_build "$b"
  if [ ! -f "$BIN/llama-completion" ]; then
    skip_step answer "$b" "$p" nobuild
    return 0
  fi
  words=$(env_words "$b")
  lim=$(min "$LIMIT_ANSWER" "$(time_left)")
  set -- "$BIN/llama-completion" -m "$MM_MODEL" --jinja -st -sysf "$MM_SYSTEM_FILE" -f "$KIT_DIR/prompts/$p.txt" \
    -n "$ANSWER_N" --temp 0 --seed 42 --no-display-prompt --simple-io --perf -sp -c "$CTX" -fit off \
    -dev "$(dev_names "$b" ,)"
  # shellcheck disable=SC2046
  set -- "$@" $(ngl_words "$b")
  [ -z "$THREADS" ] || set -- "$@" -t "$THREADS"
  [ -z "${MM_TEMPLATE_FILE:-}" ] || set -- "$@" --chat-template-file "$MM_TEMPLATE_FILE"
  log "answer $p on $b (limit ${lim}s)"
  start=$(now)
  # shellcheck disable=SC2086
  run_tool "answer-$b-$p" "$lim" "$OUT/answer-$b-$p.txt" "$OUT/answer-$b-$p.log" 1 env $words "$@"
  step_line answer "$b" "$p" "$start" "$SECS" "$lim" "$RC" "$END" "$WHY"
  cap "$OUT/answer-$b-$p.txt" 65536 49152 16384
  cap "$OUT/answer-$b-$p.log" 262144 196608 65536
  log "answer $p on $b: end=$END in ${SECS}s"
}

answers() {
  local b p why
  rank
  for b in $NOLOAD; do
    why=noload
    [ "$(get_bench "$b")" != time ] || why='time'
    for p in $PROMPT_IDS; do skip_step answer "$b" "$p" "$why"; done
  done
  for b in $RANKED; do
    for p in $PROMPT_IDS; do answer "$b" "$p"; done
  done
}

# ---------------------------------------------------------------------------------------------------------------
# The run

STARTED=$(now)
FETCHED=0 FETCH_SECS='' CUT='' CUR_PID='' CUR_HELPERS='' RAM_KB='' SDK='' T0=$STARTED
case $MM_MODEL in */*) MODEL_DIR=${MM_MODEL%/*} ;; *) MODEL_DIR=. ;; esac
[ -n "$MODEL_DIR" ] || MODEL_DIR=/
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

kv "$RUN" kit 1
kv "$RUN" subject "$MM_SUBJECT"
kv "$RUN" platform "$PLATFORM"
kv "$RUN" backends "$(printf '%s' "$BACKS" | tr ' ' ',')"
kv "$RUN" prompts "$(printf '%s' "$PROMPT_IDS" | tr ' ' ',')"
kv "$RUN" ctx "$CTX"
kv "$RUN" bench_prompt "$BENCH_P"
kv "$RUN" bench_gen "$BENCH_G"
kv "$RUN" bench_reps "$BENCH_R"
kv "$RUN" answer_tokens "$ANSWER_N"
kv "$RUN" npu_sessions "$NPU_N"
kv "$RUN" threads "$THREADS"
kv "$RUN" limit_fetch "$LIMIT_FETCH"
kv "$RUN" limit_check "$LIMIT_CHECK"
kv "$RUN" limit_bench "$LIMIT_BENCH"
kv "$RUN" limit_answer "$LIMIT_ANSWER"
kv "$RUN" limit_total "$LIMIT_TOTAL"
kv "$RUN" started "$STARTED"
for _b in $BACKS; do
  kv "$RUN" "layout_$_b" "$(layout_of "$(llama_dir "$_b")")"
done
[ -z "${MM_CLEANUP:-}" ] || kv "$RUN" cleanup "$MM_CLEANUP"
log "kit 1: $MM_SUBJECT on $PLATFORM, backends $BACKS"

device_facts

if [ -n "${MM_MIN_RAM_KB:-}" ] && [ -n "$RAM_KB" ] && [ "$RAM_KB" -lt "$MM_MIN_RAM_KB" ]; then
  log "this device has $RAM_KB kB of RAM and the run needs $MM_MIN_RAM_KB kB: skipped"
  model_txt skipped "" "" "" ""
  for _b in $BACKS; do skip_step bench "$_b" - ram; done
  finish skipped ram
  exit 0
fi

[ -f "$MM_MODEL" ] || [ -z "${MM_MODEL_URL:-}" ] || fetch
T0=$(now)
check
for _b in $BACKS; do bench "$_b"; done
answers
if [ -n "$CUT" ]; then
  finish cut time
else
  finish 'done'
fi
exit 0
