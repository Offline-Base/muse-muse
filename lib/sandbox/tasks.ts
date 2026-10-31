/**
 * Shell for the preview, verify and demo runners and for fix-round screenshots. Pure string builders, so they can be
 * tested without a sandbox.
 */
import {
  ACTIVE_CAPS_FILE,
  ACTIVE_TARGETS_FILE,
  CAPS_DIR,
  CAPS_FILE,
  DEMO_OUT_DIR,
  DEMO_RECORDING_DIR,
  DEMO_SPEC_PATH,
  DEMO_STUDIO_MARKER,
  PLATFORM_FILES,
  PRISTINE_DIR,
  PRODUCT_DIR,
  PRODUCT_PORTS,
  TARGET_FILE,
  TARGET_OVERLAYS,
  TARGETS_DIR,
} from "@/lib/sandbox/paths";
import { q } from "@/lib/sandbox/shell";

export type SandboxTask = "verify" | "demo";

/** The copy of the smoke test the demo runs, with its Playwright imports pointed at the recorder (demoSpecCopyScript). */
export const DEMO_SPEC_COPY = "tests/smoke.demo.spec.ts";

/**
 * The demo's Playwright projects (template/playwright.config.ts): Demo Studio's recorder, and Playwright's own video,
 * the old demo. Platform code from before Demo Studio runs the old one by name, so it keeps the name "demo".
 */
export const STUDIO_PROJECT = "studio";
export const VIDEO_PROJECT = "demo";

/** Where a task script finds the pristine copy and the demo's spec and render folder. Tests move them to temp dirs. */
export interface TaskPaths {
  pristineDir?: string;
  specPath?: string;
  outDir?: string;
  targetsDir?: string;
  /** Where the cap overlays are (CAPS_DIR). Tests move it to a temp dir. */
  capsDir?: string;
}

/**
 * What each task runs, called directly rather than through package.json scripts, which Muse Code can edit. The demo
 * runs the copy of the smoke test in one worker, since the recorder writes a single test-results/demo even when a spec
 * asks for parallel tests, then Demo Studio's render (taskScript).
 */
export const TASK_COMMANDS: Record<SandboxTask, string> = {
  verify: "node scripts/verify.mjs",
  demo: `./node_modules/.bin/playwright test ${DEMO_SPEC_COPY} --project=${STUDIO_PROJECT} --workers=1`,
};

/**
 * The smoke test with Playwright's own video: the demo in sandboxes from snapshots made before Demo Studio, and the
 * second try in newer ones when the studio run passed but recorded nothing.
 */
export const LEGACY_DEMO_COMMAND = `./node_modules/.bin/playwright test tests/smoke.spec.ts --project=${VIDEO_PROJECT}`;

/** Demo Studio's render from a spec. `basic` makes the plain cut with captions and no camera (builder.ts finishDemo). */
export function studioCommand(specPath: string = DEMO_SPEC_PATH, basic = false): string {
  return `node scripts/demo-studio.mjs --spec ${q(specPath)}${basic ? " --basic" : ""}`;
}

/**
 * Copies tests/smoke.spec.ts to DEMO_SPEC_COPY with every import of "@playwright/test" pointed at "./demo-fixtures",
 * which re-exports it with the demo recorder on the page fixture and in test.step. Only the quoted module name changes,
 * in either quote style, so `import type`, `export ... from` and imports split over several lines all follow. Exits 1
 * when there is no smoke test to copy.
 */
export function demoSpecCopyScript(): string {
  const rewrite = [`s#"@playwright/test"#"./demo-fixtures"#g`, `s#'@playwright/test'#'./demo-fixtures'#g`];
  return [
    `[ -f tests/smoke.spec.ts ] || { echo "musemuse: there is no tests/smoke.spec.ts to record" >&2; exit 1; }`,
    `grep -q "@playwright/test" tests/smoke.spec.ts || echo "musemuse: tests/smoke.spec.ts doesn't import @playwright/test itself, so the demo recorder may not attach" >&2`,
    `sed ${rewrite.map((e) => `-e ${q(e)}`).join(" ")} tests/smoke.spec.ts > ${q(DEMO_SPEC_COPY)} || exit 1`,
  ].join("\n");
}

/**
 * The demo after the restore. Sandboxes whose pristine copy has DEMO_STUDIO_MARKER clear the last recording and
 * render, run the smoke test's copy in the studio project, always delete the copy, and render with Demo Studio only
 * when the run passed. A passing run that left no timeline ran without the recorder: the smoke test takes its test()
 * from a module of its own, which the copy's import rewrite doesn't reach. That test is recorded again with
 * Playwright's video, as older sandboxes always record, and builder.ts finishDemo makes the old MP4 from it. Either way
 * a failed run exits with Playwright's code and leaves no video, and report.json is cleared first, so it only ever
 * describes the last run.
 */
export function demoScript(outPath: string, opts: TaskPaths = {}): string {
  const { pristineDir = PRISTINE_DIR, specPath = DEMO_SPEC_PATH, outDir = DEMO_OUT_DIR } = opts;
  const out = q(outPath);
  return [
    "rm -f test-results/report.json",
    `if [ -f ${q(pristineDir)}/${DEMO_STUDIO_MARKER} ]; then`,
    `  rm -rf ${q(DEMO_RECORDING_DIR)} ${q(outDir)}`,
    // The runner stops a run that hits its cap with SIGTERM. Exiting through the trap still deletes the copy.
    `  trap 'rm -f ${DEMO_SPEC_COPY}' EXIT`,
    `  trap 'exit 143' TERM INT`,
    demoSpecCopyScript().replace(/^/gm, "  "),
    `  { ${TASK_COMMANDS.demo} 2>&3 | tee ${out}; } 3>&1`,
    `  code=$?`,
    `  rm -f ${DEMO_SPEC_COPY}`,
    `  [ "$code" -eq 0 ] || exit "$code"`,
    `  if [ ! -s ${q(`${DEMO_RECORDING_DIR}/timeline.json`)} ]; then`,
    `    echo "musemuse: the studio run recorded nothing, so the demo is recorded with Playwright's video instead" >&2`,
    `    { ${LEGACY_DEMO_COMMAND} 2>&3 | tee -a ${out}; } 3>&1`,
    `    exit $?`,
    `  fi`,
    `  { ${studioCommand(specPath)} 2>&3 | tee -a ${out}; } 3>&1`,
    "else",
    `  { ${LEGACY_DEMO_COMMAND} 2>&3 | tee ${out}; } 3>&1`,
    "fi",
  ].join("\n");
}

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

/** What goes in ACTIVE_TARGETS_FILE and TARGET_FILE: where the product runs. glassesGateProblems and verify read this shape. */
export function targetFileText(targets: readonly string[]): string {
  return `${JSON.stringify({ targets })}\n`;
}

/**
 * Installs an unpacked template/targets (`from`, with `from/targets/<id>/...`) as the read-only TARGETS_DIR, then removes
 * `from`. Run with sudo. A target already there is replaced, so a refresh can't leave old files behind.
 */
export function installTargetsScript(from: string, targetsDir: string = TARGETS_DIR): string {
  const dir = q(targetsDir);
  return [
    "set -e",
    `mkdir -p ${dir}`,
    `for t in ${q(from)}/targets/*; do`,
    `  rm -rf ${dir}/"$(basename "$t")"`,
    `  cp -R "$t" ${dir}/`,
    `done`,
    `rm -rf ${q(from)}`,
    `chown -R root:root ${dir}`,
    `chmod -R a-w,a+rX ${dir}`,
  ].join("\n");
}

/**
 * Writes ACTIVE_TARGETS_FILE. Run with sudo, once the overlays are there. A target with no overlay installs nothing, so on a
 * snapshot made before targets its folder doesn't exist yet.
 */
export function activeTargetsScript(targets: readonly string[], activeFile: string = ACTIVE_TARGETS_FILE): string {
  const file = q(activeFile);
  return [`set -e`, `mkdir -p "$(dirname ${file})"`, `rm -f ${file}`, `printf '%s' ${q(targetFileText(targets))} > ${file}`, `chown root:root ${file}`, `chmod 444 ${file}`].join("\n");
}

/** Prints an overlay's deps.json as npm's name@version, one a line, for "dependencies" or "devDependencies". */
function depsOf(depsFile: string, field: "dependencies" | "devDependencies"): string {
  const print = `const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).${field}??{};for(const[k,v]of Object.entries(d))console.log(k+"@"+v)`;
  return `node -e ${q(print)} ${q(depsFile)}`;
}

/**
 * Applies a brief's targets to the product in the current directory (PRODUCT_DIR), before Muse Code starts: copies each
 * overlay's files, installs its deps at their exact versions (npm is open in the build policy), writes TARGET_FILE and
 * commits. Runs as the default user, so the product parts are the build's to change. A retry that finds it done does nothing,
 * since by then the build's own files may be there. Any target without an overlay only shows in TARGET_FILE.
 */
export function applyTargetScript(targets: readonly string[], targetsDir: string = TARGETS_DIR): string {
  const overlays = targets.filter((t) => TARGET_OVERLAYS.includes(t));
  const added = targets.filter((t) => t !== "web");
  const want = targetFileText(targets);
  const lines = [
    "set -e",
    `if [ "$(cat ${TARGET_FILE} 2>/dev/null)" = ${q(want.trimEnd())} ] && [ -n "$(git log --format=%s --grep='^Target: ' -1 2>/dev/null)" ]; then exit 0; fi`,
    `deps=""; dev=""`,
  ];
  for (const t of overlays) {
    const dir = `${targetsDir}/${t}`;
    lines.push(
      `[ -f ${q(`${dir}/deps.json`)} ] || { echo "musemuse: the ${t} overlay isn't in this sandbox" >&2; exit 1; }`,
      `(cd ${q(`${dir}/files`)} && find . -type f) | while IFS= read -r f; do`,
      `  mkdir -p -- "$(dirname -- "$f")"`,
      `  rm -f -- "$f"`,
      `  cat ${q(`${dir}/files`)}/"$f" > "$f"`,
      `done`,
      `deps="$deps $(${depsOf(`${dir}/deps.json`, "dependencies")} | tr '\n' ' ')"`,
      `dev="$dev $(${depsOf(`${dir}/deps.json`, "devDependencies")} | tr '\n' ' ')"`,
    );
  }
  const install = "npm install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error";
  lines.push(
    `if [ -n "$(echo $deps)" ]; then ${install} $deps; fi`,
    `if [ -n "$(echo $dev)" ]; then ${install} --save-dev $dev; fi`,
    `printf '%s' ${q(want)} > ${TARGET_FILE}`,
    `git add -A`,
    `git diff --cached --quiet || git commit -qm ${q(`Target: ${added.join(", ")}`)}`,
  );
  return lines.join("\n");
}

/**
 * Before every verify and demo, in a sandbox with targets: rewrites TARGET_FILE from the read-only copy and restores each
 * overlay's platform files, so an edit can't change which checks run. Does nothing in a sandbox without ACTIVE_TARGETS_FILE,
 * which is every product with no target.
 */
export function restoreTargetFilesScript(targetsDir: string = TARGETS_DIR): string {
  const dir = q(targetsDir);
  const active = `${targetsDir}/active.json`;
  const list = [
    `const fs=require("fs");const[active,root]=process.argv.slice(1);`,
    `for(const t of JSON.parse(fs.readFileSync(active,"utf8")).targets){`,
    `const f=root+"/"+t+"/platform-files.json";if(!fs.existsSync(f))continue;`,
    `for(const p of JSON.parse(fs.readFileSync(f,"utf8")))console.log(t+"\\t"+p)}`,
  ].join("");
  return [
    `if [ -f ${q(active)} ]; then`,
    `  rm -f ${TARGET_FILE} && cat ${q(active)} > ${TARGET_FILE}`,
    `  node -e ${q(list)} ${q(active)} ${dir} | while IFS=$'\t' read -r t p; do`,
    `    rm -rf -- "$p"`,
    `    mkdir -p -- "$(dirname -- "$p")"`,
    `    cp -R -- ${dir}/"$t"/files/"$p" "$p" && chmod -R u+w -- "$p" || echo "musemuse: couldn't restore $p" >&2`,
    `  done`,
    `fi`,
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
export function taskScript(task: SandboxTask, outPath: string, opts: TaskPaths = {}): string {
  return [
    "set -o pipefail",
    restorePlatformFilesScript(opts.pristineDir),
    restoreTargetFilesScript(opts.targetsDir),
    // Beside the targets' restore. Does nothing in a sandbox without caps (no ACTIVE_CAPS_FILE), which is every product today.
    restoreCapFilesScript(opts.capsDir),
    ...(task === "demo"
      ? [freeProductPortsScript(), demoScript(outPath, opts)]
      : [`{ ${TASK_COMMANDS[task]} 2>&3 | tee ${q(outPath)}; } 3>&1`]),
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

// ---------- Wave 3, unit 2: cap overlays (docs/CAPABILITIES.md, 2.5), side by side with the target overlays ----------

/** musemuse.caps.json and ACTIVE_CAPS_FILE: which caps the product has, and the overlays they brought. */
export function capsFileText(file: { caps: readonly string[]; overlays: readonly string[] }): string {
  return `${JSON.stringify({ caps: [...file.caps], overlays: [...file.overlays] })}\n`;
}

/**
 * Installs an unpacked template/caps (`from`, with `from/caps/<overlay>/...`) as the read-only CAPS_DIR, then removes
 * `from`. Run with sudo. An overlay already there is replaced, so a refresh can't leave old files behind.
 */
export function installCapsScript(from: string, capsDir: string = CAPS_DIR): string {
  const dir = q(capsDir);
  return [
    "set -e",
    `mkdir -p ${dir}`,
    `for o in ${q(from)}/caps/*; do`,
    `  [ -d "$o" ] || continue`,
    `  rm -rf ${dir}/"$(basename "$o")"`,
    `  cp -R "$o" ${dir}/`,
    `done`,
    `rm -rf ${q(from)}`,
    `chown -R root:root ${dir}`,
    `chmod -R a-w,a+rX ${dir}`,
  ].join("\n");
}

/** Writes ACTIVE_CAPS_FILE, root-owned and read-only. Run with sudo, once the overlays are there. */
export function activeCapsScript(file: { caps: readonly string[]; overlays: readonly string[] }, activeFile: string = ACTIVE_CAPS_FILE): string {
  const target = q(activeFile);
  return [
    "set -e",
    `mkdir -p "$(dirname ${target})"`,
    `chmod u+w "$(dirname ${target})"`,
    `rm -f ${target}`,
    `printf '%s' ${q(capsFileText(file))} > ${target}`,
    `chown root:root ${target}`,
    `chmod 444 ${target}`,
    `chmod a-w "$(dirname ${target})"`,
  ].join("\n");
}

/**
 * Applies a brief's cap overlays to the product in the current directory (PRODUCT_DIR), right after any target overlay:
 * copies each overlay's files, installs its deps at their exact versions, writes CAPS_FILE and commits "Caps: data, jobs".
 * Runs as the default user. A retry that finds it done does nothing, since the build's own files may be there by then.
 */
export function applyCapsScript(file: { caps: readonly string[]; overlays: readonly string[] }, capsDir: string = CAPS_DIR): string {
  const want = capsFileText(file);
  const lines = [
    "set -e",
    `if [ "$(cat ${CAPS_FILE} 2>/dev/null)" = ${q(want.trimEnd())} ] && [ -n "$(git log --format=%s --grep='^Caps: ' -1 2>/dev/null)" ]; then exit 0; fi`,
    `deps=""; dev=""`,
  ];
  for (const o of file.overlays) {
    const dir = `${capsDir}/${o}`;
    lines.push(
      `[ -f ${q(`${dir}/deps.json`)} ] || { echo "musemuse: the ${o} cap overlay isn't in this sandbox" >&2; exit 1; }`,
      `if [ -d ${q(`${dir}/files`)} ]; then`,
      `  (cd ${q(`${dir}/files`)} && find . -type f) | while IFS= read -r f; do`,
      `    mkdir -p -- "$(dirname -- "$f")"`,
      `    rm -f -- "$f"`,
      `    cat ${q(`${dir}/files`)}/"$f" > "$f"`,
      `  done`,
      `fi`,
      `deps="$deps $(${depsOf(`${dir}/deps.json`, "dependencies")} | tr '\n' ' ')"`,
      `dev="$dev $(${depsOf(`${dir}/deps.json`, "devDependencies")} | tr '\n' ' ')"`,
    );
  }
  const install = "npm install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error";
  lines.push(
    `if [ -n "$(echo $deps)" ]; then ${install} $deps; fi`,
    `if [ -n "$(echo $dev)" ]; then ${install} --save-dev $dev; fi`,
    `printf '%s' ${q(want)} > ${CAPS_FILE}`,
    `git add -A`,
    `git diff --cached --quiet || git commit -qm ${q(`Caps: ${file.caps.join(", ")}`)}`,
  );
  return lines.join("\n");
}

/**
 * Before every verify and demo, in a sandbox with caps: rewrites CAPS_FILE from the read-only record and puts back each
 * overlay's platform files (helpers, tests/caps/<id>.ts, scripts/caps/<id>.mjs), so an edit can't change which checks
 * run or fake a pass. Does nothing in a sandbox without ACTIVE_CAPS_FILE, which is every product with no caps.
 */
export function restoreCapFilesScript(capsDir: string = CAPS_DIR): string {
  const dir = q(capsDir);
  const active = `${capsDir}/active.json`;
  const list = [
    `const fs=require("fs");const[active,root]=process.argv.slice(1);`,
    `for(const o of JSON.parse(fs.readFileSync(active,"utf8")).overlays||[]){`,
    `const f=root+"/"+o+"/platform-files.json";if(!fs.existsSync(f))continue;`,
    `for(const p of JSON.parse(fs.readFileSync(f,"utf8")))console.log(o+"\\t"+p)}`,
  ].join("");
  return [
    `if [ -f ${q(active)} ]; then`,
    `  rm -f ${CAPS_FILE} && cat ${q(active)} > ${CAPS_FILE}`,
    `  node -e ${q(list)} ${q(active)} ${dir} | while IFS=$'\t' read -r o p; do`,
    `    rm -rf -- "$p"`,
    `    mkdir -p -- "$(dirname -- "$p")"`,
    `    cp -R -- ${dir}/"$o"/files/"$p" "$p" && chmod -R u+w -- "$p" || echo "musemuse: couldn't restore $p" >&2`,
    `  done`,
    `fi`,
  ].join("\n");
}
