#!/usr/bin/env bash
# Turns on, in Production, every "turn on now" switch from docs/FLAGS.md that Production doesn't have yet.
#
# Run it from the Vercel-linked worktree, ~/mm-wt/overnight:
#   cd ~/mm-wt/overnight && ~/mm-wt/f-flags/scripts/flags-on.sh --dry
#   cd ~/mm-wt/overnight && ~/mm-wt/f-flags/scripts/flags-on.sh
#
# It changes no folder. It reads names only (vercel env ls production), never values.
# A missing switch is added with the value 1. A switch already present is left alone, since its value can't be read
# here. With --rewrite, present switches are reset to 1 too: removed from Production, then added again from stdin.
# It touches nothing else: no "after setup" or "leave off" switch, no secret, no deploy.
# Set VERCEL_SCOPE first if your CLI needs the team slug (runbook step 0).
#
# Options: --dry prints the plan only. --rewrite also resets present switches to 1. --help prints this.

set -u

FLAGS_NOW=(
  # New on Nov 3 (docs/FLAGS.md, "New: the script adds these 11")
  STEER_CHAT
  BUILD_ROOM_STEPS
  ENGINE_EXACT_LOGIC
  ENGINE_FIT_OUTPUT
  ENGINE_LIVE_SMOKE
  RUNTIME_OUTPUTS
  STORY_PAGES
  TRUST_REPORTS
  TUNE_GENERAL_CHECKS
  CODE_BROWSE
  HARDWARE_GADGET_OWNER_CHECK
  # Already present on Nov 3 (docs/FLAGS.md, "Already present: keep these 36")
  AGENTS_ENABLED
  AGENT_LONG_RUNS
  BUILD_RANGE
  CODE_ENABLED
  DATA_ENABLED
  EDGE_BUILDS
  EDGE_ENABLED
  ENGINE_CHECK_ON_TIMEOUT
  ENGINE_MILESTONES
  ENGINE_ROUND_SCALING
  FULL_BUILDS
  GADGETS_ENABLED
  GLASSES_ENABLED
  GUEST_EDITS
  HOST_TUNED
  MAKE_CHAT_ALL
  MUSE_APP_LOOK
  MUSE_CODE_ENABLED
  MUSE_FULL
  OPEN_TRAIN
  PLAN_ART
  PRODUCT_OUTPUTS
  PROVE_IT
  RECIPES_ENABLED
  TRAIN_CONTRIBUTOR_WRITER
  TRUST_SIGNED_IN_CAPS
  TUNE_ANY_BASE
  TUNE_AUTO_PUBLISH
  TUNE_COMPOSER
  TUNE_FOLDER
  TUNE_FROM_BUILDS
  TUNE_LOOP
  TUNE_RESEARCH
  TUNE_RL
  VERIFY_AGENTS
  VR_ENABLED
)

VALUE=1
DRY=0
REWRITE=0

for arg in "$@"; do
  case "$arg" in
    --dry) DRY=1 ;;
    --rewrite) REWRITE=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (use --dry, --rewrite or --help)" >&2; exit 2 ;;
  esac
done

if [ ! -f .vercel/project.json ]; then
  echo "This folder isn't linked to the Vercel project. Run it from ~/mm-wt/overnight:" >&2
  echo "  cd ~/mm-wt/overnight && $0 ${*:-}" >&2
  exit 1
fi

SCOPE_ARGS=()
if [ -n "${VERCEL_SCOPE:-}" ]; then
  SCOPE_ARGS=(--scope "$VERCEL_SCOPE")
fi

# Names only. The first column of each line; headers and notices never match a flag name exactly.
if ! LISTING="$(vercel env ls production ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} 2>/dev/null)"; then
  echo "vercel env ls production failed. Check vercel login and the project link." >&2
  exit 1
fi
PRESENT="$(printf '%s\n' "$LISTING" | awk '{print $1}')"

is_present() {
  printf '%s\n' "$PRESENT" | grep -qxF "$1"
}

TO_ADD=()
TO_RESET=()
KEPT=()
for name in "${FLAGS_NOW[@]}"; do
  if is_present "$name"; then
    if [ "$REWRITE" = 1 ]; then TO_RESET+=("$name"); else KEPT+=("$name"); fi
  else
    TO_ADD+=("$name")
  fi
done

echo "Production, turn on now: ${#FLAGS_NOW[@]} switches."
echo "  To add (missing): ${#TO_ADD[@]}"
echo "  To reset to $VALUE (present, --rewrite): ${#TO_RESET[@]}"
echo "  Left alone (present, value not read): ${#KEPT[@]}"
[ "${#KEPT[@]}" -gt 0 ] && echo "    ${KEPT[*]}"
echo

if [ "$DRY" = 1 ]; then
  for name in ${TO_ADD[@]+"${TO_ADD[@]}"}; do echo "would add   $name=$VALUE"; done
  for name in ${TO_RESET[@]+"${TO_RESET[@]}"}; do echo "would reset $name=$VALUE (remove, then add)"; done
  [ "${#TO_ADD[@]}" -eq 0 ] && [ "${#TO_RESET[@]}" -eq 0 ] && echo "Nothing to change."
  echo
  echo "Dry run: nothing changed."
  exit 0
fi

FAILED=()
CHANGED=0

# The value goes in on stdin. The CLI's own message is shown only when it refuses (flag values are not secrets).
add_flag() {
  local out
  if out="$(printf '%s' "$VALUE" | vercel env add "$1" --environment production --yes ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} 2>&1)"; then
    return 0
  fi
  printf '%s\n' "$out" | tail -3 | sed 's/^/        vercel: /' >&2
  return 1
}

for name in ${TO_ADD[@]+"${TO_ADD[@]}"}; do
  if add_flag "$name"; then
    echo "added   $name=$VALUE"
    CHANGED=$((CHANGED + 1))
  else
    echo "FAILED  $name: add refused. Try: printf '1' | vercel env add $name --environment production" >&2
    FAILED+=("$name")
  fi
done

for name in ${TO_RESET[@]+"${TO_RESET[@]}"}; do
  if ! vercel env rm "$name" --environment production --yes ${SCOPE_ARGS[@]+"${SCOPE_ARGS[@]}"} >/dev/null 2>&1; then
    echo "FAILED  $name: remove refused, left as it was." >&2
    FAILED+=("$name")
    continue
  fi
  if add_flag "$name"; then
    echo "reset   $name=$VALUE"
    CHANGED=$((CHANGED + 1))
  else
    echo "FAILED  $name: removed but not added back. Run now: printf '1' | vercel env add $name --environment production" >&2
    FAILED+=("$name")
  fi
done

echo
echo "Changed $CHANGED switch(es) in Production."
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "Failed: ${FAILED[*]}" >&2
fi
if [ "$CHANGED" -gt 0 ]; then
  echo "Now redeploy, or nothing takes effect: push to main, or press Redeploy on the latest Production deployment."
  echo "After the Nov 4 8 AM code freeze, use Redeploy only. Then run: node scripts/judge-check.mjs"
fi
[ "${#FAILED[@]}" -eq 0 ]
