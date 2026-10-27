import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import { SANDBOX_ENV } from "@/lib/sandbox/muse";
import { BUILDER_MARKER, LOG_DIR, MUSE_INSTALL_URL, OUT_DIR, PLAYWRIGHT_VERSION, PRODUCT_DIR, RUN_DIR, WORK_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";

/**
 * Turns a fresh `vercel/sandbox/universal` VM into a builder: system tools, Playwright's Chromium, Muse Code and the
 * template with its node_modules in PRODUCT_DIR. The snapshot script runs this once with open egress. Product
 * sandboxes run it only when no BUILDER_SNAPSHOT_ID is set, which is slow (a few minutes) but works from scripts.
 */

const SKIP_NAMES = new Set(["node_modules", ".next", "test-results", "playwright-report", ".git", ".vercel", ".DS_Store"]);

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
  const out: TemplateFile[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(templateDir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (skipTemplateEntry(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push({ path: child, content: await readFile(path.join(templateDir, child)) });
    }
  }
  await walk("");
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

export async function installSystemTools(sandbox: Sandbox, log: Log): Promise<void> {
  await timed(log, "apt: ffmpeg, fonts-dejavu-core, espeak-ng", () =>
    sh(
      sandbox,
      "apt-get update -q >/dev/null && apt-get install -y -q --no-install-recommends ffmpeg fonts-dejavu-core espeak-ng >/dev/null",
      { sudo: true, env: { DEBIAN_FRONTEND: "noninteractive" } },
    ),
  );
  await timed(log, `playwright@${PLAYWRIGHT_VERSION} install-deps chromium`, () =>
    sh(sandbox, `npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium >/dev/null`, {
      sudo: true,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    }),
  );
}

export async function installMuseCode(sandbox: Sandbox, log: Log): Promise<string> {
  await timed(log, "Muse Code installer", () =>
    sh(sandbox, `curl -fsSL ${MUSE_INSTALL_URL} | MUSE_NO_MODIFY_PATH=1 MUSE_LOGIN=0 bash >/dev/null`),
  );
  const { stdout } = await sh(sandbox, 'PATH="$HOME/.local/bin:$PATH" muse --version', { env: { ...SANDBOX_ENV } });
  return stdout.trim();
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

/** Full setup on a fresh VM. Needs open egress. */
export async function setupBuilder(sandbox: Sandbox, files: TemplateFile[], log: Log): Promise<BuilderInfo> {
  await makeDirs(sandbox, [WORK_DIR]);
  await installSystemTools(sandbox, log);
  const muse = await installMuseCode(sandbox, log);
  await installTemplate(sandbox, files, log);
  return writeBuilderMarker(sandbox, { muse, templateHash: templateHash(files) });
}
