#!/usr/bin/env bash
# Adds this pack's commands to a Muse gadget that runs Meta's Linux Gadget SDK, so your Muse can use the product
# (README.md). Run it on the gadget, from the unzipped folder, after the SDK is installed and paired with your own Muse
# account:
#
#   sudo bash install.sh
#
# It copies the command files to /etc/musegadget/commands.d and the runner to /usr/local/lib/<pack>-gadget, owned by root
# and writable only by root, then restarts the musegadget service. It never reads or changes your SDK token or pairing.
# Built with Muse Muse, a hackathon concept. Not an official Meta product.
set -euo pipefail

PREFIX=__MUSE_GADGET_PREFIX__
COMMANDS=(__MUSE_GADGET_COMMANDS__)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=""
DRY_RUN=0
RESTART=1
NODE_BIN=""

usage() {
  cat <<EOF
Usage: sudo bash install.sh [--node /path/to/node] [--no-restart] [--dry-run]

  --node <path>  The Node.js 18+ to run the commands with. Default: the node on root's PATH, then /usr/bin/node.
  --no-restart   Don't restart the musegadget service. The commands appear after the next restart.
  --dry-run      Print what it would do and change nothing. Needs no sudo.
  --root <dir>   Install under <dir> instead of /, for testing.
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
    --node)
      [ $# -ge 2 ] || fail "--node needs a path."
      NODE_BIN="$2"
      shift
      ;;
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

# Runs a step, or in a dry run prints it.
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
for name in "${COMMANDS[@]}"; do
  [[ "$name" =~ $NAME_RE && "$name" == "$PREFIX."* ]] || fail "This pack's command list is damaged. Download it again."
done

if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" != 0 ]; then
  fail "Run it with sudo: sudo bash install.sh"
fi

SDK_DIR="$ROOT/opt/musegadget"
CMD_DIR="$ROOT/etc/musegadget/commands.d"
LIB_DIR="$ROOT/usr/local/lib/$PREFIX-gadget"

if [ ! -d "$SDK_DIR" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "note: Meta's Linux Gadget SDK isn't installed here (no /opt/musegadget). A real install would stop."
  else
    fail "Meta's Linux Gadget SDK isn't installed here (no /opt/musegadget). Install it and pair it with your own Muse account first: https://github.com/facebookincubator/muse-gadget-sdk/blob/main/linux/README.md"
  fi
fi

# The node to run the commands with. The service runs them with no shell and no PATH of yours, so it needs a full path.
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || NODE_BIN=/usr/bin/node
fi
case "$NODE_BIN" in
  /*) ;;
  *) fail "--node must be a full path, like /usr/bin/node." ;;
esac
[ -x "$NODE_BIN" ] || fail "There's no Node.js at $NODE_BIN. Install Node 18 or newer (sudo apt install nodejs), or name it with --node."
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || fail "$NODE_BIN is older than Node 18. Install a newer one, or name it with --node."

# The SDK skips commands in a folder that is a link, or that anyone but root can write to.
[ ! -L "$CMD_DIR" ] || fail "$CMD_DIR is a link. The gadget refuses commands from a linked folder."
[ ! -L "$LIB_DIR" ] || fail "$LIB_DIR is a link. Remove it and run this again."
if [ -d "$CMD_DIR" ] && [ -n "$(find "$CMD_DIR" -maxdepth 0 \( -perm -020 -o -perm -002 \))" ]; then
  fail "$CMD_DIR can be written by others, so the gadget would refuse every command in it. Fix it with: sudo chmod 755 $CMD_DIR"
fi
for name in "${COMMANDS[@]}"; do
  src="$HERE/commands.d/$name.json"
  [ -f "$src" ] && [ ! -L "$src" ] || fail "commands.d/$name.json is missing from this folder. Download the pack again."
done
[ -f "$HERE/runner.cjs" ] && [ ! -L "$HERE/runner.cjs" ] || fail "runner.cjs is missing from this folder. Download the pack again."

# Commands an earlier version of this pack added and this one doesn't have.
if [ -f "$LIB_DIR/commands.txt" ]; then
  while IFS= read -r old; do
    [[ "$old" =~ $NAME_RE && "$old" == "$PREFIX."* ]] || continue
    keep=0
    for name in "${COMMANDS[@]}"; do [ "$name" = "$old" ] && keep=1; done
    [ "$keep" = 1 ] || run rm -f -- "$CMD_DIR/$old.json"
  done <"$LIB_DIR/commands.txt"
fi

if [ ! -d "$CMD_DIR" ]; then
  run mkdir -p -- "$CMD_DIR"
  run chown -- 0:0 "$CMD_DIR"
  run chmod -- 0755 "$CMD_DIR"
fi
run mkdir -p -- "$LIB_DIR"
run chown -- 0:0 "$LIB_DIR"
run chmod -- 0755 "$LIB_DIR"

# Each file is written beside its place, then moved in, so the service never reads half of one.
put() {
  local src="$1" dest="$2" mode="$3"
  run cp -- "$src" "$dest.tmp"
  run chown -- 0:0 "$dest.tmp"
  run chmod -- "$mode" "$dest.tmp"
  run mv -f -- "$dest.tmp" "$dest"
}

put "$HERE/runner.cjs" "$LIB_DIR/runner.cjs" 0755
run ln -sfn -- "$NODE_BIN" "$LIB_DIR/node"
for name in "${COMMANDS[@]}"; do
  put "$HERE/commands.d/$name.json" "$CMD_DIR/$name.json" 0644
done
if [ "$DRY_RUN" = 1 ]; then
  say "would write: $LIB_DIR/commands.txt"
else
  printf '%s\n' "${COMMANDS[@]}" >"$LIB_DIR/commands.txt.tmp"
  chown -- 0:0 "$LIB_DIR/commands.txt.tmp"
  chmod -- 0644 "$LIB_DIR/commands.txt.tmp"
  mv -f -- "$LIB_DIR/commands.txt.tmp" "$LIB_DIR/commands.txt"
fi

if [ "$DRY_RUN" = 1 ]; then
  [ "$RESTART" = 1 ] && run systemctl restart musegadget
  say "Dry run: nothing was changed."
  exit 0
fi
if [ "$RESTART" = 1 ]; then
  run systemctl restart musegadget
  say "Added ${#COMMANDS[@]} commands and restarted the gadget: ${COMMANDS[*]}"
else
  say "Added ${#COMMANDS[@]} commands: ${COMMANDS[*]}. They appear after: sudo systemctl restart musegadget"
fi
say "To check: sudo journalctl -u musegadget | grep commands"
say "To remove them: sudo bash uninstall.sh"
