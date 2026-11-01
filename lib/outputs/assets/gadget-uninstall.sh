#!/usr/bin/env bash
# Removes this pack's commands from a Muse gadget (README.md):
#
#   sudo bash uninstall.sh
#
# It deletes only what install.sh added: its command files in /etc/musegadget/commands.d and /usr/local/lib/<pack>-gadget,
# then restarts the musegadget service. Meta's SDK, your SDK token and your pairing stay as they are.
# Built with Muse Muse, a hackathon concept. Not an official Meta product.
set -euo pipefail

PREFIX=__MUSE_GADGET_PREFIX__
COMMANDS=(__MUSE_GADGET_COMMANDS__)

ROOT=""
DRY_RUN=0
RESTART=1

usage() {
  cat <<EOF
Usage: sudo bash uninstall.sh [--no-restart] [--dry-run]

  --no-restart   Don't restart the musegadget service. The commands go away after the next restart.
  --dry-run      Print what it would do and change nothing. Needs no sudo.
  --root <dir>   Remove from under <dir> instead of /, for testing.
EOF
}

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-restart) RESTART=0 ;;
    --root)
      [ $# -ge 2 ] || fail "--root needs a folder."
      ROOT="${2%/}"
      case "$ROOT" in /*) ;; *) fail "--root must be a full path." ;; esac
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

NAME_RE='^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
[[ "$PREFIX" =~ ^[a-z][a-z0-9_]*$ ]] || fail "This pack's name is damaged. Download it again."

if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" != 0 ]; then
  fail "Run it with sudo: sudo bash uninstall.sh"
fi

CMD_DIR="$ROOT/etc/musegadget/commands.d"
LIB_DIR="$ROOT/usr/local/lib/$PREFIX-gadget"

# This version's commands, and any an earlier version added.
names=("${COMMANDS[@]}")
if [ -f "$LIB_DIR/commands.txt" ] && [ ! -L "$LIB_DIR/commands.txt" ]; then
  while IFS= read -r old; do names+=("$old"); done <"$LIB_DIR/commands.txt"
fi

removed=0
seen=" "
for name in "${names[@]}"; do
  [[ "$name" =~ $NAME_RE && "$name" == "$PREFIX."* ]] || continue
  case "$seen" in *" $name "*) continue ;; esac
  seen="$seen$name "
  if [ -e "$CMD_DIR/$name.json" ] || [ -L "$CMD_DIR/$name.json" ]; then
    run rm -f -- "$CMD_DIR/$name.json"
    removed=$((removed + 1))
  fi
done
if [ -L "$LIB_DIR" ]; then
  run rm -f -- "$LIB_DIR"
elif [ -d "$LIB_DIR" ]; then
  run rm -rf -- "$LIB_DIR"
fi

if [ "$RESTART" = 1 ]; then run systemctl restart musegadget; fi
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run: nothing was changed."
else
  say "Removed $removed commands and $LIB_DIR."
fi
