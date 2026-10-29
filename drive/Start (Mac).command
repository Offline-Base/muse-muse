#!/bin/bash
# Starts the model on this drive on a Mac with Apple silicon. Double-click it in Finder.
#
# It never downloads anything. It reads this Mac's memory, picks the build that fits (support/builds.tsv, the same
# table the Muse Muse website uses), offers to copy that build to this Mac, then starts the llama.cpp server from this
# drive on 127.0.0.1 only and opens its chat page in your browser. Close this window to stop the model.

set -u

DRIVE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$DRIVE/support"
COPY_ROOT="$HOME/Muse Muse"

tell() { printf '%s\n' "$*"; }

finish() {
  tell ""
  tell "$1"
  tell ""
  read -r -p "Press Return to close this window. " _ || true
  exit "${2:-1}"
}

ask_yes() {
  # $1: the question. $2: "y" or "n", the answer when the person just presses Return.
  local answer
  read -r -p "$1 " answer || answer=""
  [ -z "$answer" ] && answer="$2"
  case "$answer" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

value_of() {
  # The value of key $1 in support/model.tsv.
  local key value
  while IFS=$'\t' read -r key value; do
    if [ "$key" = "$1" ]; then printf '%s' "$value"; return 0; fi
  done < "$SUPPORT/model.tsv"
  return 1
}

sum_of() {
  # The sha256 SHA256SUMS lists for path $1, relative to the drive.
  local sum path
  while read -r sum path; do
    if [ "$path" = "$1" ]; then printf '%s' "$sum"; return 0; fi
  done < "$DRIVE/SHA256SUMS"
  return 1
}

[ -f "$SUPPORT/builds.tsv" ] && [ -f "$SUPPORT/files.tsv" ] && [ -f "$SUPPORT/model.tsv" ] ||
  finish "This drive is missing its support folder. Run Verify (Mac).command to check its files."

TITLE="$(value_of title)"
SLUG="$(value_of slug)"
[ -n "$SLUG" ] || SLUG="model"
PAGE="$(value_of page)"
[ -n "$PAGE" ] || PAGE="the model's page on the Muse Muse website"
tell "$TITLE, from a Muse Muse flash drive."
tell ""

# 1. The machine. uname -m says x86_64 in a Rosetta Terminal, so ask the hardware itself.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
  finish "This Mac has an Intel chip. The model on this drive needs a Mac with Apple silicon (M1 or later)."
fi
MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null)"
case "$MEM_BYTES" in '' | *[!0-9]*) MEM_BYTES=0 ;; esac
MEM_GB=$((MEM_BYTES / 1073741824))
CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
tell "This Mac: ${CHIP:-Apple silicon}, $MEM_GB GB of memory."

# 2. The build: the row for the largest memory size this Mac has at least.
BEST=-1 LEVEL="" FIT="" MIN_MAC=""
while IFS=$'\t' read -r kind mem vram level runtime fit where; do
  [ "$kind" = "mac" ] || continue
  if [ "$level" != "-" ] && [ -z "$MIN_MAC" ]; then MIN_MAC="$mem"; fi
  if [ "$mem" -le "$MEM_GB" ] && [ "$mem" -gt "$BEST" ]; then
    BEST="$mem" LEVEL="$level" FIT="$fit"
  fi
done < "$SUPPORT/builds.tsv"

SMALLEST=""
while IFS=$'\t' read -r level name bytes; do
  [ "$level" = "level" ] && continue
  [ -z "$SMALLEST" ] && SMALLEST="$level"
done < "$SUPPORT/files.tsv"

if [ -z "$LEVEL" ] || [ "$LEVEL" = "-" ]; then
  tell ""
  if [ -n "$MIN_MAC" ]; then
    tell "This model needs a Mac with $MIN_MAC GB of memory or more, and this one has $MEM_GB GB."
  else
    tell "None of the builds on this drive fits a Mac's memory."
  fi
  tell "It would run very slowly here, if at all, and other apps would slow down too."
  ask_yes "Try the smallest build anyway? [y/N]" n || finish "Nothing was started. Try it live instead, on its page: $PAGE" 0
  LEVEL="$SMALLEST" FIT="no"
fi

NAME="" BYTES=0
while IFS=$'\t' read -r level name bytes; do
  if [ "$level" = "$LEVEL" ]; then NAME="$name" BYTES="$bytes"; fi
done < "$SUPPORT/files.tsv"
[ -n "$NAME" ] && [ -f "$DRIVE/model/$NAME" ] || finish "The $LEVEL build is missing from this drive. Run Verify (Mac).command to check its files."
# Rounded to the nearest GB, as Windows and the website show it.
SIZE_GB=$(((BYTES + 500000000) / 1000000000))

case "$FIT" in
  well) tell "The $LEVEL build ($SIZE_GB GB) runs well on this Mac." ;;
  tight) tell "The $LEVEL build ($SIZE_GB GB) runs on this Mac if you close other apps first, since it uses most of the memory." ;;
  *) tell "Starting the $LEVEL build ($SIZE_GB GB). Expect it to be slow." ;;
esac
tell ""

# 3. Copy it to this Mac, if the person agrees: loads are faster and the drive can come out.
RUN_DIR="$DRIVE"
WANT_SUM="$(sum_of "model/$NAME")"
COPY="$COPY_ROOT/$SLUG"
if [ -n "$WANT_SUM" ] && [ -f "$COPY/model/$NAME" ] && [ "$(cat "$COPY/model/$NAME.verified" 2>/dev/null)" = "$WANT_SUM" ]; then
  tell "Using the copy on this Mac, in $COPY."
  RUN_DIR="$COPY"
elif ask_yes "Copy the $LEVEL build to this Mac first? Loads are faster, and you can take the drive out. [Y/n]" y; then
  FREE_KB="$(df -k "$HOME" | awk 'NR == 2 { print $4 }')"
  case "$FREE_KB" in '' | *[!0-9]*) FREE_KB=0 ;; esac
  NEED_KB=$((BYTES / 1024 + 5 * 1024 * 1024))
  if [ "$FREE_KB" -lt "$NEED_KB" ]; then
    tell "There isn't room to copy it: it needs $((NEED_KB / 1024 / 1024)) GB free, and this Mac has $((FREE_KB / 1024 / 1024)) GB. Running it from the drive instead."
  else
    # At about 100 MB/s from a USB 3 drive; a slower drive or port takes longer.
    COPY_MIN=$((BYTES / 6000000000 + 1))
    tell "Copying $SIZE_GB GB to $COPY. This takes about $COPY_MIN minutes, and nothing shows here until it's done."
    rm -rf "$COPY/runtime" "$COPY/model"
    if mkdir -p "$COPY/model" "$COPY/runtime" &&
      cp -R "$DRIVE/runtime/macos-arm64" "$COPY/runtime/" &&
      chmod +x "$COPY/runtime/macos-arm64/llama-server" &&
      cp "$DRIVE/model/ui-config.json" "$DRIVE/model/system.txt" "$COPY/model/" &&
      { [ ! -f "$DRIVE/model/tuned.jinja" ] || cp "$DRIVE/model/tuned.jinja" "$COPY/model/"; } &&
      cp "$DRIVE/model/$NAME" "$COPY/model/$NAME"; then
      tell "Checking the copy against its checksum."
      GOT_SUM="$(shasum -a 256 "$COPY/model/$NAME" | awk '{ print $1 }')"
      if [ -n "$WANT_SUM" ] && [ "$GOT_SUM" = "$WANT_SUM" ]; then
        printf '%s' "$WANT_SUM" > "$COPY/model/$NAME.verified"
        RUN_DIR="$COPY"
        tell "The copy matches. You can take the drive out once the chat opens."
      else
        rm -f "$COPY/model/$NAME"
        tell "The copy didn't match its checksum, so it was deleted. Running it from the drive instead."
      fi
    else
      rm -f "$COPY/model/$NAME"
      tell "The copy didn't finish. Running it from the drive instead."
    fi
  fi
fi

# 4. A free port on 127.0.0.1, then the server, with the chat's system message preset (model/ui-config.json).
PORT=""
for p in $(seq 9931 9950); do
  if ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then PORT="$p"; break; fi
done
[ -n "$PORT" ] || finish "Ports 9931 to 9950 are all in use on this Mac. Quit the other model server and try again."

SERVER="$RUN_DIR/runtime/macos-arm64/llama-server"
ARGS=(-m "$RUN_DIR/model/$NAME" --host 127.0.0.1 --port "$PORT" --offline --jinja -c 8192 --no-mmproj -np 1 --temp 0
  --ui-config-file "$RUN_DIR/model/ui-config.json")
if [ -f "$RUN_DIR/model/tuned.jinja" ]; then
  # A model trained before it learned to open its answer itself needs the template that opens it.
  ARGS+=(--chat-template-file "$RUN_DIR/model/tuned.jinja" --skip-chat-parsing --reasoning off)
fi

"$SERVER" "${ARGS[@]}" &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT HUP INT TERM
tell ""
tell "Loading the model. The first time after copying or plugging in the drive can take up to 10 minutes."
tell "The server's messages scroll by below while it loads. That's normal: the chat opens once it's ready."

READY=""
for _ in $(seq 1 600); do
  kill -0 "$PID" 2>/dev/null || finish "The model server stopped before it was ready. Its messages are above."
  if curl -fs --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ -n "$READY" ] || finish "The model didn't finish loading in 10 minutes. Close other apps and try again."

open "http://127.0.0.1:$PORT/"
tell ""
tell "The chat is open at http://127.0.0.1:$PORT in your browser. Only this Mac can reach it."
tell "Keep this window open while you use it. Close it to stop the model."
wait "$PID"
