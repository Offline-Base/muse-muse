import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import { SANDBOX_ENV } from "@/lib/sandbox/muse";
import { BUILDER_MARKER, LOG_DIR, MUSE_INSTALL_URL, OUT_DIR, PLAYWRIGHT_VERSION, PRODUCT_DIR, RUN_DIR, WORK_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";
import { pristineCopyScript } from "@/lib/sandbox/tasks";

/**
 * Turns a fresh `vercel/sandbox/universal` VM into a builder: system tools and fonts, Playwright's Chromium, Muse Code
 * and the template with its node_modules in PRODUCT_DIR. The snapshot script runs this once with open egress. Product
 * sandboxes run it only when no BUILDER_SNAPSHOT_ID is set, which is slow (a few minutes) but works from scripts.
 */

// __tests__ holds the template's own unit tests (template/scripts/__tests__), which products don't need.
const SKIP_NAMES = new Set(["node_modules", ".next", "test-results", "playwright-report", ".git", ".vercel", ".DS_Store", "__tests__"]);

const TARGETS_DIR = "targets";

function skipTemplateEntry(name: string): boolean {
  return SKIP_NAMES.has(name) || name.startsWith(".env") || name.endsWith(".tsbuildinfo");
}

export interface TemplateFile {
  path: string;
  content: Buffer;
}

/**
 * Reads template/ from disk, without node_modules, build output, test output or env files. The directory is always
 * passed in: a literal path.join(process.cwd(), "template") here would make Next's file tracing bundle the whole
 * template (node_modules included) into the platform's functions.
 */
export async function readTemplateFiles(templateDir: string): Promise<TemplateFile[]> {
  return readTemplateTree(templateDir, "");
}

/**
 * Reads the top-level template/targets/: overlays a product gets only when its brief asks for that target, so they
 * aren't in readTemplateFiles. They still count toward templateHash, since a snapshot carries them too.
 */
export async function readTargetFiles(templateDir: string): Promise<TemplateFile[]> {
  return readTemplateTree(templateDir, TARGETS_DIR);
}

async function readTemplateTree(templateDir: string, from: string): Promise<TemplateFile[]> {
  const out: TemplateFile[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(templateDir, rel), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (rel === TARGETS_DIR && err.code === "ENOENT") return [];
      throw err;
    });
    for (const e of entries) {
      if (skipTemplateEntry(e.name)) continue;
      if (!rel && e.name === TARGETS_DIR) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push({ path: child, content: await readFile(path.join(templateDir, child)) });
    }
  }
  await walk(from);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A short hash of the template files, recorded in the builder marker so a stale snapshot is easy to spot. */
export function templateHash(files: TemplateFile[]): string {
  const h = createHash("sha1");
  for (const f of files) h.update(f.path).update("\0").update(f.content).update("\0");
  return h.digest("hex").slice(0, 12);
}

type Log = (step: string, ms: number, detail?: string) => void;

/** mkdir -p owned by the default user, with sudo when the parent isn't writable. */
export async function makeDirs(sandbox: Sandbox, dirs: string[]): Promise<void> {
  const list = dirs.map(q).join(" ");
  await sh(sandbox, `mkdir -p ${list} 2>/dev/null || { sudo -n mkdir -p ${list} && sudo -n chown "$(id -un):$(id -gn)" ${list}; }`);
}

async function timed<T>(log: Log, step: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T> {
  const started = Date.now();
  const value = await fn();
  log(step, Date.now() - started, detail?.(value));
  return value;
}

/**
 * Fonts for Demo Studio's cards and captions (docs/DEMO_STUDIO.md): Inter, color emoji, and fontconfig for fc-cache.
 * All three are in Ubuntu 26.04, the universal image's distro (Inter in universe, like ffmpeg).
 */
export const DEMO_FONT_PACKAGES = ["fontconfig", "fonts-inter", "fonts-noto-color-emoji"] as const;

/**
 * fontconfig rules that make Inter the sandbox's system font. Products use the template's system font stack
 * (system-ui first), which Chromium on Linux would draw in DejaVu Sans. Inter is the closest open font to what phones
 * and laptops show, so the judge's screenshots and the demo video look the way visitors see the product. Glyphs Inter
 * lacks, like emoji, still come from the other fonts.
 */
export const INTER_DEFAULT_CONF = [
  '<?xml version="1.0"?>',
  '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
  "<fontconfig>",
  ...["system-ui", "sans-serif", "sans"].map((f) => `  <alias><family>${f}</family><prefer><family>Inter</family></prefer></alias>`),
  "</fontconfig>",
].join("\n");

/**
 * Installs DEMO_FONT_PACKAGES after `apt-get update`, makes Inter the default sans-serif font when it installed
 * (INTER_DEFAULT_CONF in `conf`, which the distro's fonts.conf reads), then rebuilds the font cache. Best effort: when
 * the set won't install, each package is tried alone, and one that still won't is skipped (the cards and products
 * fall back to DejaVu Sans, which the snapshot always has). Prints "skipped <what>" for each, and always exits 0.
 */
export function fontInstallScript(conf = "/etc/fonts/local.conf"): string {
  return [
    `pkgs=${q(DEMO_FONT_PACKAGES.join(" "))}`,
    "if ! apt-get install -y -q --no-install-recommends $pkgs >/dev/null 2>&1; then",
    '  for p in $pkgs; do apt-get install -y -q --no-install-recommends "$p" >/dev/null 2>&1 || echo "skipped $p"; done',
    "fi",
    "if fc-list : family 2>/dev/null | grep -qiE '(^|,)Inter(,|$)'; then",
    `  printf '%s\\n' ${q(INTER_DEFAULT_CONF)} > ${q(conf)} 2>/dev/null || echo "skipped the Inter default"`,
    "else",
    '  echo "skipped the Inter default"',
    "fi",
    'fc-cache -f >/dev/null 2>&1 || echo "skipped fc-cache"',
    "exit 0",
  ].join("\n");
}

export async function installSystemTools(sandbox: Sandbox, log: Log): Promise<void> {
  // iproute2 gives `ss`, which the demo runner uses to find stale servers on the product ports (tasks.ts).
  await timed(log, "apt: ffmpeg, fonts-dejavu-core, espeak-ng, iproute2", () =>
    sh(
      sandbox,
      "apt-get update -q >/dev/null && apt-get install -y -q --no-install-recommends ffmpeg fonts-dejavu-core espeak-ng iproute2 >/dev/null",
      { sudo: true, env: { DEBIAN_FRONTEND: "noninteractive" } },
    ),
  );
  await timed(log, `playwright@${PLAYWRIGHT_VERSION} install-deps chromium`, () =>
    sh(sandbox, `npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium >/dev/null`, {
      sudo: true,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    }),
  );
  // Last, so fc-cache also picks up the fonts install-deps brought in.
  await timed(
    log,
    `apt: ${DEMO_FONT_PACKAGES.join(", ")} (best effort), Inter as the default sans-serif, fc-cache`,
    () => sh(sandbox, fontInstallScript(), { sudo: true, allowFail: true, env: { DEBIAN_FRONTEND: "noninteractive" } }),
    (res) => res.stdout.trim().replace(/\n/g, ", ") || "all installed",
  );
}

export async function installMuseCode(sandbox: Sandbox, log: Log): Promise<string> {
  await timed(log, "Muse Code installer", () =>
    sh(sandbox, `curl -fsSL ${MUSE_INSTALL_URL} | MUSE_NO_MODIFY_PATH=1 MUSE_LOGIN=0 bash >/dev/null`),
  );
  const { stdout } = await sh(sandbox, 'PATH="$HOME/.local/bin:$PATH" muse --version', { env: { ...SANDBOX_ENV } });
  return stdout.trim();
}

/**
 * Bundled Muse Code skills that fight a headless build of the Next.js template (spike 2, Oct 27, Muse Code 1.4.14).
 * They move the product into a new folder (browser-game, greenfield-project-scaffolding), stop to ask or only plan
 * (requirements-clarification, plan, grill), fan out critic loops and workflows (visual-coding, web3d,
 * game-3d-visuals, workflow-authoring), need Blender (blender), take over start commands and URLs
 * (browser-app-delivery), or read ~/.claude and ~/.codex (migrate, import, resume-claude, resume-codex).
 */
export const DISABLED_BUNDLED_SKILLS = [
  "browser-game",
  "web3d",
  "visual-coding",
  "game-3d-visuals",
  "blender",
  "browser-app-delivery",
  "greenfield-project-scaffolding",
  "requirements-clarification",
  "plan",
  "grill",
  "workflow-authoring",
  "migrate",
  "import",
  "resume-claude",
  "resume-codex",
] as const;

/**
 * Turns DISABLED_BUNDLED_SKILLS off for the default user. `muse skills disable` saves this in
 * ~/.config/muse/settings.json, which the snapshot keeps (a per-run -c override does not work for skills). A skill
 * this Muse Code version doesn't have exits 1 ("unknown-skill"), which fails setup.
 */
export async function disableBundledSkills(sandbox: Sandbox, log: Log): Promise<void> {
  const script = DISABLED_BUNDLED_SKILLS.map((id) => `muse skills disable ${q(`bundled:${id}`)} --scope built-in --json`).join(" && ");
  await timed(log, `disable ${DISABLED_BUNDLED_SKILLS.length} bundled Muse Code skills`, () =>
    sh(sandbox, `export PATH="$HOME/.local/bin:$PATH" && ${script} >/dev/null`, { env: { ...SANDBOX_ENV } }),
  );
}

/**
 * The DISABLED_BUNDLED_SKILLS that `muse skills list --json` doesn't show as off. Settings are keyed by skill path, so
 * a Muse Code update that moves a skill would quietly turn it back on; the snapshot script fails on any left here.
 */
export function skillsNotOff(listJson: string): string[] {
  let skills: Array<{ id?: unknown; activation?: unknown }> = [];
  try {
    const parsed = JSON.parse(listJson) as { skills?: unknown };
    if (Array.isArray(parsed.skills)) skills = parsed.skills;
  } catch {
    // Not JSON: every skill counts as not off.
  }
  return DISABLED_BUNDLED_SKILLS.filter((id) => skills.find((s) => s.id === `bundled:${id}`)?.activation !== "off");
}

/** Copies the template into PRODUCT_DIR, installs its packages and Chromium, and commits it as the starting point. */
export async function installTemplate(sandbox: Sandbox, files: TemplateFile[], log: Log): Promise<void> {
  await makeDirs(sandbox, [PRODUCT_DIR, LOG_DIR, RUN_DIR, OUT_DIR]);
  await timed(log, `write ${files.length} template files`, async () => {
    for (let i = 0; i < files.length; i += 100) {
      await sandbox.writeFiles(files.slice(i, i + 100).map((f) => ({ path: `${PRODUCT_DIR}/${f.path}`, content: f.content })));
    }
  });
  await timed(log, "npm ci", () => sh(sandbox, "npm ci --no-audit --no-fund --loglevel=error", { cwd: PRODUCT_DIR }));
  await timed(log, "playwright install chromium", () =>
    sh(sandbox, "npx playwright install chromium >/dev/null", { cwd: PRODUCT_DIR }),
  );
  await timed(log, "git init and first commit", () =>
    sh(
      sandbox,
      [
        'git config --global user.name "Muse Muse"',
        "git config --global user.email builder@musemuse.invalid",
        "git config --global init.defaultBranch main",
        "git init -q",
        "git add -A",
        'git commit -qm "Template"',
      ].join(" && "),
      { cwd: PRODUCT_DIR },
    ),
  );
}

/** Keeps a root-owned, read-only copy of the platform-owned files outside the product, for startTask to restore. */
export async function savePristineFiles(sandbox: Sandbox, log: Log): Promise<void> {
  await timed(log, "pristine copy of the platform files", () => sh(sandbox, pristineCopyScript(), { sudo: true }));
}

export interface BuilderInfo {
  createdAt: string;
  muse: string;
  node: string;
  ffmpeg: string;
  templateHash: string;
}

export async function writeBuilderMarker(sandbox: Sandbox, info: Omit<BuilderInfo, "node" | "ffmpeg" | "createdAt">): Promise<BuilderInfo> {
  const { stdout } = await sh(sandbox, "node --version; ffmpeg -hide_banner -version | head -1");
  const [node = "", ffmpeg = ""] = stdout.trim().split("\n");
  const full: BuilderInfo = { createdAt: new Date().toISOString(), node, ffmpeg, ...info };
  await sandbox.writeFiles([{ path: BUILDER_MARKER, content: JSON.stringify(full, null, 2) }]);
  return full;
}

/** Full setup on a fresh VM. Needs open egress. `targets` is readTargetFiles, and only counts toward the template's hash. */
export async function setupBuilder(sandbox: Sandbox, files: TemplateFile[], log: Log, targets: TemplateFile[] = []): Promise<BuilderInfo> {
  await makeDirs(sandbox, [WORK_DIR]);
  await installSystemTools(sandbox, log);
  const muse = await installMuseCode(sandbox, log);
  await disableBundledSkills(sandbox, log);
  await installTemplate(sandbox, files, log);
  await savePristineFiles(sandbox, log);
  return writeBuilderMarker(sandbox, { muse, templateHash: templateHash([...files, ...targets]) });
}
