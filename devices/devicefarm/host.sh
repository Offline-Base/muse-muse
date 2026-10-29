#!/usr/bin/env bash
# The host side of a Muse Muse device test run on AWS Device Farm (docs/DEVICES.md "On AWS Device Farm"). The test spec
# runs it once per phase on the Amazon Linux 2023 host that has adb to the phone:
#
#   bash "$DEVICEFARM_TEST_PACKAGE_PATH/mm/host.sh" <install|pre_test|test|post_test>
#
# MM_PLAN, set on the run by ScheduleRun, names the run's folder mm/plan/<run key>/: run.env (MM_PLAN_VERSION, MM_RUN,
# MM_SUBJECTS, MM_TRANSFER_LIMIT, MM_COPY) and per subject <id>.env (the kit's environment), <id>.system, <id>.url
# and maybe <id>.jinja. For each subject in order, `test` reads the phone's MemTotal and free space, gets the model
# onto the phone (a download on the host, its sha256, then adb push; or a stream from the Hub when the host lacks the
# disk), runs devices/kit/run.sh on the phone, pulls its output folder into $DEVICEFARM_LOG_DIR/mm/<id>/ with
# host-<id>.txt (how the copy went), and deletes the model. Device Farm keeps $DEVICEFARM_LOG_DIR.
#
# Nothing here writes or prints the device's serial (adb's own messages are scrubbed), a token or a signed URL. The
# phone never gets a token: the model's URL is public. Bash 3.2 or later; the kit itself is POSIX sh on the phone.
#
# MM_PLAN missing (the run's environment variables didn't reach the host) is fine when the package has one plan. Tests
# set MM_HOST_DIR (the download folder), MM_POLL_SECONDS and MM_RETRY_SECONDS; runs never do.
set -u
unset HF_TOKEN HUGGING_FACE_HUB_TOKEN HF_API_TOKEN QDC_API_KEY

PHASE="${1:-}"
PKG="${DEVICEFARM_TEST_PACKAGE_PATH:-}"
LOGS="${DEVICEFARM_LOG_DIR:-}"
SERIAL="${DEVICEFARM_DEVICE_UDID:-}"
DEV=/data/local/tmp/mm
OUT=""
[ -n "$LOGS" ] && OUT="$LOGS/mm"
WORK=""
PLAN=""
SUBJECTS=""
TRANSFER_LIMIT=1200
COPY_MODE=auto
# Seconds between run.txt polls after a dropped adb session, and between stream attempts.
POLL_SECONDS="${MM_POLL_SECONDS:-20}"
RETRY_SECONDS="${MM_RETRY_SECONDS:-5}"

now() { date +%s; }

# Seconds left until the epoch time $1, at least 1: GNU timeout takes 0 to mean no limit at all.
left() {
  local l=$(($1 - $(now)))
  [ "$l" -ge 1 ] || l=1
  printf '%s\n' "$l"
}

# Copies stdin to stdout with the device's serial replaced, so nothing the host keeps names the phone.
scrub() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$SERIAL" ]; then line="${line//"$SERIAL"/[device]}"; fi
    printf '%s\n' "$line"
  done
}

# A progress line on stdout (the spec's console) and in $DEVICEFARM_LOG_DIR/mm/host.log once that folder is known.
say() {
  if [ -n "$OUT" ] && mkdir -p "$OUT" 2>/dev/null; then
    printf '[mm] %s\n' "$*" | scrub | tee -a "$OUT/host.log"
  else
    printf '[mm] %s\n' "$*" | scrub
  fi
}

fail() {
  say "error: $*"
  exit 1
}

# Runs adb on this run's phone with its own stderr scrubbed into ours and the log.
a() {
  local err="$WORK/adb.err" rc
  adb -s "$SERIAL" "$@" 2>"$err"
  rc=$?
  if [ -s "$err" ]; then scrub <"$err" | sed 's/^/[mm] adb: /' | tee -a "$OUT/host.log" >&2; fi
  return $rc
}

# The same, bounded to $1 seconds by coreutils timeout (exit 124 when it fires).
ta() {
  local secs=$1 err="$WORK/adb.err" rc
  shift
  [ "$secs" -gt 0 ] || return 124
  timeout "$secs" adb -s "$SERIAL" "$@" 2>"$err"
  rc=$?
  if [ -s "$err" ]; then scrub <"$err" | sed 's/^/[mm] adb: /' | tee -a "$OUT/host.log" >&2; fi
  return $rc
}

# A value from a key=value file: kv <file> <NAME>.
kv() { sed -n "s/^$2=//p" "$1" | head -n 1; }

# The Available kB of the last line of `df -kP` output.
free_kb() { tr -d '\r' | tail -n 1 | tr -s ' ' | cut -d ' ' -f 4; }

fsize() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || wc -c <"$1" | tr -d ' '; }

is_num() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# The characters isSafeKitValue allows: values from the plan go unquoted into adb shell lines.
is_safe() { case "$1" in '' | *[!A-Za-z0-9._:/,@+=-]*) return 1 ;; *) return 0 ;; esac; }

# Removes URLs with a query string (the Hub redirects to signed CDN URLs) from what curl prints.
nourl() { sed 's#https\{0,1\}://[^ ]*?[^ ]*#[url]#g'; }

# The host folder for downloads: MM_HOST_DIR, or the writable disk-backed folder with the most free space.
pick_host_dir() {
  local best="" best_kb=-1 dir fs kb
  if [ -n "${MM_HOST_DIR:-}" ]; then
    printf '%s\n' "$MM_HOST_DIR"
    return
  fi
  for dir in /var/tmp "${HOME:-/var/tmp}" /tmp; do
    [ -d "$dir" ] && [ -w "$dir" ] || continue
    fs=$(df -kP "$dir" 2>/dev/null | tail -n 1 | cut -d ' ' -f 1)
    case "$fs" in tmpfs | devtmpfs | none) continue ;; esac
    kb=$(df -kP "$dir" 2>/dev/null | free_kb)
    is_num "$kb" || continue
    if [ "$kb" -gt "$best_kb" ]; then
      best=$dir
      best_kb=$kb
    fi
  done
  printf '%s\n' "${best:-/tmp}"
}

# The host's side: the package, the log folder, the phone's serial, and a download folder. Every phase needs them.
setup_host() {
  [ -n "$LOGS" ] || fail "DEVICEFARM_LOG_DIR isn't set"
  [ -n "$PKG" ] && [ -d "$PKG/mm" ] || fail "DEVICEFARM_TEST_PACKAGE_PATH has no mm folder"
  [ -n "$SERIAL" ] || fail "DEVICEFARM_DEVICE_UDID isn't set"
  mkdir -p "$OUT" || fail "can't make $OUT"
  WORK="$(pick_host_dir)/mm-host"
  mkdir -p "$WORK" || fail "can't make the host folder"
}

# Reads the run's plan folder into PLAN, SUBJECTS, TRANSFER_LIMIT and COPY_MODE. On a problem it sets PROBLEM and
# returns 1, so post_test can still clean the phone.
read_plan() {
  local plans
  PROBLEM=""
  if [ -z "${MM_PLAN:-}" ]; then
    plans=$(ls "$PKG/mm/plan" 2>/dev/null)
    case "$plans" in
      '' | *[!A-Za-z0-9._-]*)
        PROBLEM="MM_PLAN isn't set and the package doesn't have exactly one plan"
        return 1
        ;;
    esac
    MM_PLAN=$plans
    say "MM_PLAN isn't set: using the package's one plan, $MM_PLAN"
  fi
  case "$MM_PLAN" in *[!A-Za-z0-9._-]*) PROBLEM="MM_PLAN isn't a plan folder name" && return 1 ;; esac
  PLAN="$PKG/mm/plan/$MM_PLAN"
  if [ ! -f "$PLAN/run.env" ]; then
    PROBLEM="the package has no mm/plan/$MM_PLAN/run.env"
  elif [ "$(kv "$PLAN/run.env" MM_PLAN_VERSION)" != 1 ]; then
    PROBLEM="the plan isn't version 1"
  elif [ "$(kv "$PLAN/run.env" MM_RUN)" != "$MM_PLAN" ]; then
    PROBLEM="run.env is for another run"
  fi
  [ -z "$PROBLEM" ] || return 1
  SUBJECTS=$(kv "$PLAN/run.env" MM_SUBJECTS)
  TRANSFER_LIMIT=$(kv "$PLAN/run.env" MM_TRANSFER_LIMIT)
  COPY_MODE=$(kv "$PLAN/run.env" MM_COPY)
  case "$SUBJECTS" in '' | *[!a-z0-9._,-]*) PROBLEM="MM_SUBJECTS isn't a list of subject ids" ;; esac
  is_num "$TRANSFER_LIMIT" || PROBLEM="MM_TRANSFER_LIMIT isn't a number"
  case "$COPY_MODE" in '') COPY_MODE=auto ;; auto | push | stream) ;; *) PROBLEM="MM_COPY isn't auto, push or stream" ;; esac
  [ -z "$PROBLEM" ]
}

load_plan() {
  setup_host
  read_plan || fail "$PROBLEM"
}

# A key=value line for the subject's host-<id>.txt.
hk() { printf '%s=%s\n' "$1" "$2" >>"$H"; }

phase_install() {
  load_plan
  local tool
  for tool in adb curl timeout sha256sum df stat sed; do
    command -v "$tool" >/dev/null 2>&1 || fail "the host has no $tool"
  done
  # shellcheck disable=SC1091 # the host's own os-release, read for its name only
  {
    printf 'plan=%s\n' "$MM_PLAN"
    printf 'subjects=%s\n' "$SUBJECTS"
    printf 'host_os=%s\n' "$( (. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}") | tr -d '\n')"
    printf 'host_kernel=%s\n' "$(uname -r)"
    printf 'host_arch=%s\n' "$(uname -m)"
    printf 'host_cpus=%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '')"
    printf 'host_mem_kb=%s\n' "$(sed -n 's/^MemTotal: *\([0-9]*\) kB.*/\1/p' /proc/meminfo 2>/dev/null | head -n 1)"
    printf 'host_dir=%s\n' "${WORK%/mm-host}"
    printf 'host_free_kb=%s\n' "$(df -kP "$WORK" | free_kb)"
    printf 'adb_version=%s\n' "$(adb version 2>/dev/null | head -n 1)"
    printf 'curl_version=%s\n' "$(curl --version 2>/dev/null | head -n 1 | cut -d ' ' -f 1-2)"
  } | scrub >"$OUT/host.txt"
  say "install: plan $MM_PLAN, subjects $SUBJECTS, host folder ${WORK%/mm-host}"
}

phase_pre_test() {
  load_plan
  local t0
  ta 180 wait-for-device || fail "the phone didn't come up on adb"
  a shell "svc power stayon true" >/dev/null || say "couldn't keep the screen on"
  a shell "rm -rf $DEV && mkdir -p $DEV/model $DEV/out $DEV/plan" || fail "couldn't make $DEV on the phone"
  t0=$(now)
  ta 600 push "$PKG/mm/kit" "$DEV/" >/dev/null || fail "couldn't push the kit"
  ta 900 push "$PKG/mm/llama-android" "$DEV/" >/dev/null || fail "couldn't push the plain build"
  ta 900 push "$PKG/mm/llama-snapdragon" "$DEV/" >/dev/null || fail "couldn't push the Snapdragon build"
  ta 300 push "$PLAN" "$DEV/plan/" >/dev/null || fail "couldn't push the plan"
  a shell "chmod 755 $DEV/kit/run.sh $DEV/llama-android/llama-bench $DEV/llama-android/llama-completion $DEV/llama-snapdragon/bin/llama-bench $DEV/llama-snapdragon/bin/llama-completion" ||
    fail "couldn't mark the tools executable"
  printf 'pre_test_push_seconds=%s\n' "$(($(now) - t0))" >>"$OUT/host.txt"
  say "pre_test: pushed the kit, both builds and the plan in $(($(now) - t0)) s"
}

# Gets $MODEL onto the phone: sets COPY to push, stream, present, no_space or failed (with COPY_WHY).
copy_model() {
  local deadline=$(($(now) + TRANSFER_LIMIT)) need_kb phone_free have host_free mode
  need_kb=$((BYTES / 1024 + 1048576))
  phone_free=$(a shell "df -kP $DEV/model" | free_kb)
  hk phone_free_kb "$phone_free"
  if ! is_num "$phone_free" || [ "$phone_free" -lt "$need_kb" ]; then
    COPY=no_space
    COPY_WHY=phone
    return
  fi
  have=$(a shell "stat -c %s $MODEL 2>/dev/null" | tr -d '\r')
  if [ "$have" = "$BYTES" ]; then
    COPY=present
    return
  fi
  host_free=$(df -kP "$WORK" | free_kb)
  hk host_free_kb "$host_free"
  mode=$COPY_MODE
  if [ "$mode" = auto ]; then
    if is_num "$host_free" && [ "$host_free" -ge $((BYTES / 1024 + 2097152)) ]; then mode=push; else mode=stream; fi
  fi
  if [ "$mode" = push ]; then copy_push "$deadline"; else copy_stream "$deadline"; fi
}

copy_push() {
  local deadline=$1 part="$WORK/$FILE.part" t0 rc size got
  t0=$(now)
  timeout "$(left "$deadline")" curl -fL --retry 8 --retry-all-errors --retry-delay 5 -sS -C - -o "$part" "$URL" 2>"$WORK/curl.err"
  rc=$?
  hk download_seconds $(($(now) - t0))
  [ -s "$WORK/curl.err" ] && nourl <"$WORK/curl.err" | sed 's/^/[mm] curl: /' | tee -a "$OUT/host.log" >&2
  if [ $rc -ne 0 ]; then
    hk download_rc "$rc"
    COPY=failed
    if [ $rc -eq 124 ]; then COPY_WHY='time'; else COPY_WHY=download; fi
    rm -f "$part"
    return
  fi
  size=$(fsize "$part")
  if [ "$size" != "$BYTES" ]; then
    COPY=failed
    COPY_WHY=size
    rm -f "$part"
    return
  fi
  t0=$(now)
  got=$(timeout "$(left "$deadline")" sha256sum "$part" | cut -d ' ' -f 1)
  hk host_sha256_seconds $(($(now) - t0))
  if [ "$got" != "$SHA256" ]; then
    hk host_sha256 mismatch
    COPY=failed
    COPY_WHY=sha256
    rm -f "$part"
    return
  fi
  hk host_sha256 ok
  t0=$(now)
  ta "$(left "$deadline")" push "$part" "$MODEL.part" >/dev/null
  rc=$?
  hk push_seconds $(($(now) - t0))
  rm -f "$part"
  if [ $rc -ne 0 ] || ! a shell "mv $MODEL.part $MODEL"; then
    a shell "rm -f $MODEL.part" >/dev/null
    COPY=failed
    if [ $rc -eq 124 ]; then COPY_WHY='time'; else COPY_WHY=push; fi
    return
  fi
  COPY=push
}

# Streams the file from the Hub into the phone with adb exec-in, resuming from what the phone has after a break.
copy_stream() {
  local deadline=$1 part="$MODEL.part" t0 attempt=0 have=0 rc=1 range
  t0=$(now)
  a shell "rm -f $part" >/dev/null
  while [ $attempt -lt 8 ] && [ "$(now)" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    range=""
    [ "$have" -gt 0 ] && range="-C $have"
    # shellcheck disable=SC2016
    timeout "$(left "$deadline")" bash -c 'set -o pipefail; curl -fsSL $1 "$2" | adb -s "$3" exec-in "cat >> $4"' \
      _ "$range" "$URL" "$SERIAL" "$part" 2>>"$WORK/stream.err"
    rc=$?
    have=$(a shell "stat -c %s $part 2>/dev/null" | tr -d '\r')
    is_num "$have" || have=0
    [ "$have" = "$BYTES" ] && break
    [ $rc -eq 124 ] && break
    if [ "$have" -gt "$BYTES" ]; then break; fi
    sleep "$RETRY_SECONDS"
  done
  hk stream_seconds $(($(now) - t0))
  hk stream_attempts "$attempt"
  [ -s "$WORK/stream.err" ] && nourl <"$WORK/stream.err" | scrub | sed 's/^/[mm] stream: /' | tee -a "$OUT/host.log" >&2
  rm -f "$WORK/stream.err"
  if [ "$have" != "$BYTES" ] || ! a shell "mv $part $MODEL"; then
    a shell "rm -f $part" >/dev/null
    COPY=failed
    if [ $rc -eq 124 ]; then COPY_WHY='time'; else COPY_WHY=stream; fi
    return
  fi
  hk host_sha256 skipped
  COPY=stream
}

# Runs the kit on the phone. Its console goes to a file there, so a dropped adb session can't stop it with SIGPIPE,
# and the kit ignores SIGHUP; when adb comes back without the kit's exit code, this waits for run.txt's status line.
run_kit() {
  local id=$1 start deadline rc
  start=$(now)
  deadline=$((start + LIMIT_CHECK + LIMIT_TOTAL + 300))
  rc=$(timeout $((deadline - start)) adb -s "$SERIAL" shell \
    "cd $DEV && set -a && . plan/$MM_PLAN/$id.env && set +a && sh kit/run.sh > out/$id.console 2>&1 < /dev/null; echo kit_rc=\$?" \
    2>"$WORK/adb.err" | tr -d '\r' | sed -n 's/^kit_rc=//p' | tail -n 1)
  if [ -s "$WORK/adb.err" ]; then scrub <"$WORK/adb.err" | sed 's/^/[mm] adb: /' | tee -a "$OUT/host.log" >&2; fi
  if [ -z "$rc" ]; then
    hk adb_dropped 1
    say "$id: adb came back without the kit's exit code; waiting for its run.txt"
    while [ "$(now)" -lt "$deadline" ]; do
      ta 60 wait-for-device
      a shell "grep -qE '^(status|finished)=' $DEV/out/$id/run.txt" 2>/dev/null && break
      sleep "$POLL_SECONDS"
    done
  fi
  hk kit_rc "${rc:--}"
  hk kit_seconds $(($(now) - start))
  if a shell "grep -qE '^(status|finished)=' $DEV/out/$id/run.txt" 2>/dev/null; then
    hk kit_finished 1
  else
    hk kit_finished 0
    # A kit still running would share the phone with the next subject's.
    a shell "pkill -f kit/run.sh; pkill -f llama-bench; pkill -f llama-completion; true" >/dev/null 2>&1
  fi
}

# Pulls the kit's folder and console, and puts host-<id>.txt with them.
pull_out() {
  local id=$1
  ta 600 pull "$DEV/out/$id" "$OUT/" >/dev/null || say "$id: couldn't pull the kit's folder"
  mkdir -p "$OUT/$id"
  ta 60 pull "$DEV/out/$id.console" "$OUT/$id.console.txt" >/dev/null 2>&1 || true
  scrub <"$H" >"$OUT/$id/host-$id.txt"
  rm -f "$H"
}

run_subject() {
  local id=$1 env mem_kb min_ram ok=0
  case "$id" in '' | *[!a-z0-9._-]*) say "skipping a subject id that isn't safe" && return 1 ;; esac
  env="$PLAN/$id.env"
  H="$WORK/host-$id.txt"
  : >"$H"
  hk subject "$id"
  if [ ! -f "$env" ] || [ ! -f "$PLAN/$id.url" ]; then
    say "$id: the plan has no $id.env or $id.url"
    hk copy failed
    hk copy_why plan
    mkdir -p "$OUT/$id" && scrub <"$H" >"$OUT/$id/host-$id.txt"
    return 1
  fi
  MODEL=$(kv "$env" MM_MODEL)
  BYTES=$(kv "$env" MM_MODEL_BYTES)
  SHA256=$(kv "$env" MM_MODEL_SHA256)
  LIMIT_CHECK=$(kv "$env" MM_LIMIT_CHECK)
  LIMIT_TOTAL=$(kv "$env" MM_LIMIT_TOTAL)
  min_ram=$(kv "$env" MM_MIN_RAM_KB)
  URL=$(head -n 1 "$PLAN/$id.url")
  FILE=${MODEL##*/}
  is_num "$LIMIT_CHECK" || LIMIT_CHECK=600
  is_num "$LIMIT_TOTAL" || LIMIT_TOTAL=2400
  COPY=""
  COPY_WHY=""
  if ! is_num "$BYTES" || ! is_safe "$MODEL" || ! is_safe "$URL" || ! is_safe "$SHA256"; then
    MODEL=""
    COPY=failed
    COPY_WHY=plan
  elif ! ta 120 wait-for-device; then
    COPY=failed
    COPY_WHY=adb
  else
    mem_kb=$(a shell "cat /proc/meminfo" | tr -d '\r' | sed -n 's/^MemTotal: *\([0-9][0-9]*\) kB.*/\1/p' | head -n 1)
    hk mem_total_kb "$mem_kb"
    hk min_ram_kb "$min_ram"
    if is_num "$mem_kb" && is_num "$min_ram" && [ "$mem_kb" -lt "$min_ram" ]; then
      COPY=ram_skip
    else
      say "$id: copying $FILE ($BYTES bytes) to the phone"
      copy_model
    fi
  fi
  hk copy "$COPY"
  [ -n "$COPY_WHY" ] && hk copy_why "$COPY_WHY"
  say "$id: copy $COPY${COPY_WHY:+ ($COPY_WHY)}"
  case "$COPY" in
    push | stream | present | ram_skip)
      run_kit "$id"
      say "$id: the kit ended (exit $(kv "$H" kit_rc))"
      [ "$(kv "$H" kit_finished)" = 1 ] || ok=1
      ;;
    *) ok=1 ;;
  esac
  pull_out "$id"
  if [ -s "$OUT/$id.console.txt" ]; then tail -n 5 "$OUT/$id.console.txt" | scrub | sed "s/^/[mm] $id kit: /"; fi
  [ -n "$MODEL" ] && a shell "rm -f $MODEL $MODEL.part" >/dev/null
  return $ok
}

phase_test() {
  load_plan
  local id status=0 old_ifs=$IFS
  IFS=,
  # shellcheck disable=SC2086
  set -- $SUBJECTS
  IFS=$old_ifs
  for id in "$@"; do
    run_subject "$id" || status=1
  done
  say "test: done (status $status)"
  return $status
}

# Pulls what a stopped test left on the phone, then cleans the phone and the host, whatever the plan says.
phase_post_test() {
  local id dir old_ifs=$IFS
  setup_host
  if read_plan; then
    IFS=,
    # shellcheck disable=SC2086
    set -- $SUBJECTS
    IFS=$old_ifs
    for id in "$@"; do
      case "$id" in '' | *[!a-z0-9._-]*) continue ;; esac
      if [ ! -f "$OUT/$id/host-$id.txt" ] && a shell "test -d $DEV/out/$id" 2>/dev/null; then
        H="$WORK/host-$id.txt"
        [ -f "$H" ] || { : >"$H" && hk subject "$id"; }
        hk pulled_in post_test
        pull_out "$id"
      fi
    done
  else
    say "post_test: $PROBLEM; cleaning up anyway"
  fi
  a shell "svc power stayon false" >/dev/null 2>&1 || true
  a shell "rm -rf $DEV" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [ -z "${MM_HOST_DIR:-}" ]; then
    for dir in /var/tmp "${HOME:-/var/tmp}" /tmp; do rm -rf "$dir/mm-host"; done
  fi
  say "post_test: cleaned up"
  return 0
}

case "$PHASE" in
  install) phase_install ;;
  pre_test) phase_pre_test ;;
  test) phase_test ;;
  post_test) phase_post_test ;;
  *)
    printf 'usage: host.sh <install|pre_test|test|post_test>\n' >&2
    exit 2
    ;;
esac
