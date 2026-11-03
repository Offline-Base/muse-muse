/**
 * The muse-app look (docs/BRAND.md, Products): template/targets/muse-app, an overlay a new build gets when MUSE_APP_LOOK
 * is on. It holds the muse-app-ui skill, app/muse-app.css and the files that load it and name the skill. Script builders
 * only, so they can be tested without a sandbox; setup.ts and builder.ts run them.
 */
import { TARGETS_DIR } from "@/lib/sandbox/paths";
import { q } from "@/lib/sandbox/shell";

export const MUSE_APP_OVERLAY = "muse-app";

/**
 * Read-only, root-owned copy of template/targets in a builder snapshot, one folder per overlay: deps.json, files/ and
 * platform-files.json. It is TARGETS_DIR: the look sits beside a brief's targets, and setup.ts installTargets puts
 * them all there.
 */
export const OVERLAYS_DIR = TARGETS_DIR;

/** The commit applyLookScript makes in the product. A product with it was set up with the muse-app look. */
export const LOOK_COMMIT = "Look: muse-app";

/**
 * The commit a look "meta" polish asks Muse Code to make once the product is on the Meta AI app look (lib/polish/logic.ts).
 * In a product with it, restoreRangeFilesScript no longer puts the build-range skill files back.
 */
export const APP_LOOK_COMMIT = "Look: Meta AI app";

/** The look's tokens in the product, from the overlay. A product with it has the look. */
export const LOOK_CSS = "app/muse-app.css";

/**
 * The meta-ui colors in the files a phone or desktop product gets beyond the template (lib/native/template-files.ts),
 * and the look's in their place: a white splash and title bar, as the overlay's layout.tsx themeColor has, and the home
 * screen icon on the look's action blue (--accent in muse-app.css). look.test.ts checks that each swap still finds its
 * text in the native template and that these are the overlay's values.
 */
export const LOOK_NATIVE_COLORS: ReadonlyArray<{ path: string; from: string; to: string }> = [
  { path: "app/manifest.ts", from: 'background_color: "#f0f2f5"', to: 'background_color: "#ffffff"' },
  { path: "app/manifest.ts", from: 'theme_color: "#0866ff"', to: 'theme_color: "#ffffff"' },
  { path: "lib/native/app-icon.tsx", from: 'background: "#0866ff"', to: 'background: "#0064d4"' },
  { path: "lib/native/app-icon.tsx", from: "on Meta blue", to: "on the muse-app look's blue" },
];

/**
 * A product's extra files with the look's colors (LOOK_NATIVE_COLORS) in place of meta-ui's, for a product with the
 * look. Other files, and any text a swap doesn't find, stay as they are.
 */
export function withLookColors<T extends { path: string; content: string }>(files: readonly T[]): T[] {
  return files.map((f) => {
    const swaps = LOOK_NATIVE_COLORS.filter((c) => c.path === f.path);
    return swaps.length ? { ...f, content: swaps.reduce((text, c) => text.replace(c.from, c.to), f.content) } : f;
  });
}

/** Prints a deps.json's "dependencies" or "devDependencies" as npm's name@version, one a line. */
function depsOf(file: string, field: "dependencies" | "devDependencies"): string {
  const print = `const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).${field}??{};for(const[k,v]of Object.entries(d))console.log(k+"@"+v)`;
  return `node -e ${q(print)} ${q(file)}`;
}

/**
 * Puts the muse-app look into the product in the current directory (PRODUCT_DIR) before Muse Code starts: copies the
 * overlay's files over the template's, installs any deps it lists at their exact versions (npm is open in the build
 * policy), and commits only those files as LOOK_COMMIT. Runs as the default user, so the files are the build's to
 * change. A retry that finds the commit does nothing, since by then the build's own changes may be there.
 */
export function applyLookScript(dir: string = OVERLAYS_DIR): string {
  const overlay = `${dir}/${MUSE_APP_OVERLAY}`;
  const files = q(`${overlay}/files`);
  const install = "npm install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error";
  return [
    "set -eo pipefail",
    `if [ -n "$(git log --format=%s --grep=${q(`^${LOOK_COMMIT}$`)} -1 2>/dev/null)" ]; then exit 0; fi`,
    `[ -f ${q(`${overlay}/deps.json`)} ] || { echo "musemuse: the ${MUSE_APP_OVERLAY} overlay isn't in this sandbox" >&2; exit 1; }`,
    `(cd ${files} && find . -type f) | while IFS= read -r f; do`,
    `  mkdir -p -- "$(dirname -- "$f")"`,
    `  rm -f -- "$f"`,
    `  cat ${files}/"$f" > "$f"`,
    `  git add -- "$f"`,
    "done",
    `deps="$(${depsOf(`${overlay}/deps.json`, "dependencies")} | tr '\\n' ' ')"`,
    `dev="$(${depsOf(`${overlay}/deps.json`, "devDependencies")} | tr '\\n' ' ')"`,
    `if [ -n "$(echo $deps)" ]; then ${install} $deps; git add package.json package-lock.json; fi`,
    `if [ -n "$(echo $dev)" ]; then ${install} --save-dev $dev; git add package.json package-lock.json; fi`,
    `git diff --cached --quiet || git commit -qm ${q(LOOK_COMMIT)}`,
  ].join("\n");
}

/** BUILD_RANGE (docs/BUILD_RANGE.md): template/targets/build-range, laid over the muse-app look. */
export const RANGE_OVERLAY = "build-range";

/** The commit applyRangeScript makes in the product. restoreRangeFilesScript reads it. */
export const RANGE_COMMIT = "Look: build range";

/**
 * Puts the build-range overlay's files over the muse-app look's, in the current directory, after applyLookScript. Only
 * the rules change: the tokens and parts stay, and the build sets the tokens from its brief's direction. A retry that
 * finds the commit does nothing.
 */
export function applyRangeScript(dir: string = OVERLAYS_DIR): string {
  const files = q(`${dir}/${RANGE_OVERLAY}/files`);
  return [
    "set -eo pipefail",
    `if [ -n "$(git log --format=%s --grep=${q(`^${RANGE_COMMIT}$`)} -1 2>/dev/null)" ]; then exit 0; fi`,
    `[ -d ${files} ] || { echo "musemuse: the ${RANGE_OVERLAY} overlay isn't in this sandbox" >&2; exit 1; }`,
    `(cd ${files} && find . -type f) | while IFS= read -r f; do`,
    `  mkdir -p -- "$(dirname -- "$f")"`,
    `  rm -f -- "$f"`,
    `  cat ${files}/"$f" > "$f"`,
    `  git add -- "$f"`,
    "done",
    `git diff --cached --quiet || git commit -qm ${q(RANGE_COMMIT)}`,
  ].join("\n");
}

/**
 * Before every verify and demo, after the look's and the template's own restores, in a product with RANGE_COMMIT: puts its
 * platform files back, so its skill's rules and its wider final-screen limits outlast those restores. Once a look polish
 * has put the product on the Meta AI app look (APP_LOOK_COMMIT), only the files outside .agents/skills come back (the
 * wider limits), so the direction's skill rules and design-looks stay out. Nothing, and no output, in any other product,
 * so a flag-off product runs what it always ran.
 */
export function restoreRangeFilesScript(dir: string = OVERLAYS_DIR): string {
  const overlay = `${dir}/${RANGE_OVERLAY}`;
  const list = `for(const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))console.log(p)`;
  return [
    `if [ -f ${q(`${overlay}/platform-files.json`)} ] && [ -n "$(git log --format=%s --grep=${q(`^${RANGE_COMMIT}$`)} -1 2>/dev/null)" ]; then`,
    `  applook="$(git log --format=%s --grep=${q(`^${APP_LOOK_COMMIT}$`)} -1 2>/dev/null)"`,
    `  node -e ${q(list)} ${q(`${overlay}/platform-files.json`)} | while IFS= read -r p; do`,
    `    case "$p" in .agents/skills/*) if [ -n "$applook" ]; then continue; fi ;; esac`,
    `    rm -f -- "$p"`,
    `    mkdir -p -- "$(dirname -- "$p")"`,
    `    cp -- ${q(`${overlay}/files`)}/"$p" "$p" && chmod u+w "./$p" || echo "musemuse: couldn't restore $p" >&2`,
    `  done`,
    `fi`,
  ].join("\n");
}

/**
 * Before every verify and demo, in a product with the look (LOOK_COMMIT in its history): puts the overlay's platform files
 * (platform-files.json, the muse-app-ui skill) back from the read-only copy, so a build can't rewrite the look's
 * instructions for its own later rounds. The rest of the look (muse-app.css, layout.tsx, AGENTS.md) is the build's to
 * change. Does nothing, and says nothing, in a product without the look, or in a sandbox whose overlay has no such list.
 * restoreTargetFilesScript does the same for a brief's targets, from active.json, which never names the look.
 */
export function restoreLookFilesScript(dir: string = OVERLAYS_DIR): string {
  const overlay = `${dir}/${MUSE_APP_OVERLAY}`;
  const list = `for(const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))console.log(p)`;
  return [
    `if [ -f ${q(`${overlay}/platform-files.json`)} ] && [ -n "$(git log --format=%s --grep=${q(`^${LOOK_COMMIT}$`)} -1 2>/dev/null)" ]; then`,
    `  node -e ${q(list)} ${q(`${overlay}/platform-files.json`)} | while IFS= read -r p; do`,
    `    rm -rf -- "$p"`,
    `    mkdir -p -- "$(dirname -- "$p")"`,
    // "./$p" rather than `--`: BSD chmod takes `--` after the mode as a file name. The paths are the overlay's, never "-x".
    `    cp -R -- ${q(`${overlay}/files`)}/"$p" "$p" && chmod -R u+w "./$p" || echo "musemuse: couldn't restore $p" >&2`,
    `  done`,
    `fi`,
  ].join("\n");
}
