/**
 * The muse-app look (docs/BRAND.md, Products): template/targets/muse-app, an overlay a new build gets when MUSE_APP_LOOK
 * is on. It holds the muse-app-ui skill, app/muse-app.css and the files that load it and name the skill. Script builders
 * only, so they can be tested without a sandbox; setup.ts and builder.ts run them.
 */
import { WORK_DIR } from "@/lib/sandbox/paths";
import { q } from "@/lib/sandbox/shell";

export const MUSE_APP_OVERLAY = "muse-app";

/**
 * Read-only, root-owned copy of template/targets in a builder snapshot, one folder per overlay: deps.json, files/ and
 * platform-files.json. The VR target's overlays use the same place and shape (the tg-vr branch).
 */
export const OVERLAYS_DIR = `${WORK_DIR}/targets`;

/** The commit applyLookScript makes in the product. A product with it was set up with the muse-app look. */
export const LOOK_COMMIT = "Look: muse-app";

/**
 * Installs an unpacked template/targets (`from`, holding `from/targets/<id>/...`) as OVERLAYS_DIR, then removes `from`.
 * Run with sudo. An overlay already there is replaced, so a refresh can't leave old files behind.
 */
export function installOverlaysScript(from: string, dir: string = OVERLAYS_DIR, owner = "root:root"): string {
  const d = q(dir);
  return [
    "set -e",
    `mkdir -p ${d}`,
    `for t in ${q(from)}/targets/*; do`,
    `  rm -rf ${d}/"$(basename "$t")"`,
    `  cp -R "$t" ${d}/`,
    "done",
    `rm -rf ${q(from)}`,
    `chown -R ${q(owner)} ${d}`,
    `chmod -R a-w,a+rX ${d}`,
  ].join("\n");
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
