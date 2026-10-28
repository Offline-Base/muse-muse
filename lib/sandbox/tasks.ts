/**
 * Shell for the preview, verify and demo runners and for fix-round screenshots. Pure string builders, so they can be
 * tested without a sandbox.
 */
import { PLATFORM_FILES, PRISTINE_DIR, PRODUCT_DIR, PRODUCT_PORTS } from "@/lib/sandbox/paths";
import { q } from "@/lib/sandbox/shell";

export type SandboxTask = "verify" | "demo";

/**
 * What each task runs, called directly rather than through package.json scripts, which Muse Code can edit. The demo
 * command is the template's `npm run demo`.
 */
export const TASK_COMMANDS: Record<SandboxTask, string> = {
  verify: "node scripts/verify.mjs",
  demo: "./node_modules/.bin/playwright test tests/smoke.spec.ts --project=demo",
};

/** How long startPreview waits for `next dev` to answer. It compiles the page on the first request. */
export const PREVIEW_WAIT_S = 90;

/**
 * True when the dev server answered with anything below 500, redirects included. Whether the page actually works is
 * verify's job, and its failures feed the fix rounds.
 */
export function previewAnswered(status: string): boolean {
  return /^[1-4]\d\d$/.test(status.trim());
}

/**
 * Polls GET / until it answers below 500 (exit 0) or the time runs out (exit 1). Three 5xx answers in a row also end
 * it, since a dev server that is up and failing won't heal by itself. Prints the last status.
 */
export function previewWaitScript(port = 3000, waitSeconds = PREVIEW_WAIT_S, probeSeconds = 15): string {
  return [
    `end=$((SECONDS + ${waitSeconds})); errors=0; c=000`,
    `while [ "$SECONDS" -lt "$end" ]; do`,
    `  c=$(curl -s -o /dev/null -w "%{http_code}" --max-time ${probeSeconds} http://localhost:${port}/)`,
    `  case "$c" in`,
    `    [1-4][0-9][0-9]) echo "$c"; exit 0 ;;`,
    `    5[0-9][0-9]) errors=$((errors + 1)); [ "$errors" -ge 3 ] && break ;;`,
    `    *) errors=0 ;;`,
    `  esac`,
    `  sleep 1`,
    `done`,
    `echo "$c"; exit 1`,
  ].join("\n");
}

/** Copies PLATFORM_FILES from PRODUCT_DIR into a root-owned, read-only PRISTINE_DIR. Run once with sudo at snapshot time. */
export function pristineCopyScript(): string {
  const dir = q(PRISTINE_DIR);
  return [
    "set -e",
    `rm -rf ${dir}`,
    `mkdir -p ${dir}`,
    `cd ${q(PRODUCT_DIR)}`,
    `cp --parents -- ${PLATFORM_FILES.map(q).join(" ")} ${dir}/`,
    `chown -R root:root ${dir}`,
    `chmod -R a-w ${dir}`,
  ].join("\n");
}

/**
 * Puts PLATFORM_FILES back in the current directory (PRODUCT_DIR) from the pristine copy. Sandboxes from a snapshot
 * made before the copy existed fall back to the template commit (the repo's first). Without either, it warns and
 * leaves the file as it is.
 */
export function restorePlatformFilesScript(pristineDir: string = PRISTINE_DIR, files: readonly string[] = PLATFORM_FILES): string {
  return [
    `root=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -n 1)`,
    `put() { rm -f -- "$1" && mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && chmod 644 "$1"; }`,
    `for f in ${files.map(q).join(" ")}; do`,
    `  if [ -f ${q(pristineDir)}/"$f" ]; then put "$f" < ${q(pristineDir)}/"$f"`,
    `  elif [ -n "$root" ] && git cat-file -e "$root:$f" 2>/dev/null; then git show "$root:$f" | put "$f"`,
    `  else echo "musemuse: no pristine copy of $f, so it runs as it is" >&2`,
    `  fi`,
    `done`,
  ].join("\n");
}

/**
 * Stops every server listening on the product ports (3100-3199), such as a `next start` orphaned by an earlier
 * verify or left by Muse Code, so the demo's Playwright starts a fresh one from the latest build instead of reusing
 * a stale one. Exits 1 if a port is still taken.
 */
export function freeProductPortsScript(): string {
  const { first, last } = PRODUCT_PORTS;
  return [
    `listeners() { { sudo -n ss -Htlnp 2>/dev/null || ss -Htlnp 2>/dev/null; } | awk '{ n = split($4, a, ":"); p = a[n] + 0; if (p >= ${first} && p <= ${last}) print }' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u; }`,
    `pids=$(listeners)`,
    `if [ -n "$pids" ]; then`,
    `  echo "musemuse: stopping old servers on ports ${first}-${last} (pids" $pids")"`,
    `  sudo -n kill -TERM $pids 2>/dev/null || kill -TERM $pids 2>/dev/null`,
    `  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(listeners)" ] && break; sleep 0.5; done`,
    `  pids=$(listeners)`,
    `  if [ -n "$pids" ]; then sudo -n kill -KILL $pids 2>/dev/null || kill -KILL $pids 2>/dev/null; sleep 0.5; fi`,
    `  if [ -n "$(listeners)" ]; then echo "musemuse: ports ${first}-${last} are still in use" >&2; exit 1; fi`,
    `fi`,
  ].join("\n");
}

/**
 * The runner's bash for a task: restore the platform files, free the product ports for the demo, then run it.
 * stdout is teed to `outPath` because verify's summary must be the last line of stdout, not of stderr.
 */
export function taskScript(task: SandboxTask, outPath: string): string {
  return [
    "set -o pipefail",
    restorePlatformFilesScript(),
    ...(task === "demo" ? [freeProductPortsScript()] : []),
    `{ ${TASK_COMMANDS[task]} 2>&3 | tee ${q(outPath)}; } 3>&1`,
  ].join("\n");
}

/**
 * Downscales each `<file>.big` into `<file>` with ffmpeg (half size, then a third, then a quarter) until it is at most
 * `maxBytes`, for fix-round screenshots too big to attach as they are. Deletes the .big copies and any result still
 * too big, and prints each file that fits, one per line. Always exits 0: a file it can't shrink is just left out.
 */
export function shrinkImagesScript(files: string[], maxBytes: number): string {
  return [
    `fits() { [ -s "$1" ] && [ "$(wc -c < "$1")" -le ${Math.floor(maxBytes)} ]; }`,
    `for f in ${files.map(q).join(" ")}; do`,
    `  for div in 2 3 4; do`,
    `    fits "$f" && break`,
    `    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$f.big" -vf "scale=iw/$div:-1" -frames:v 1 -update 1 "$f" >&2 || rm -f "$f"`,
    `  done`,
    `  rm -f "$f.big"`,
    `  if fits "$f"; then echo "$f"; else rm -f "$f"; fi`,
    `done`,
    `exit 0`,
  ].join("\n");
}
