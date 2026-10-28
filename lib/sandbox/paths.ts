/**
 * Fixed locations inside a builder sandbox. The product source lives in PRODUCT_DIR. Everything the platform keeps
 * for itself (run scripts, logs, demo output, transcripts) lives in WORK_DIR, outside the product, so it is never
 * deployed and Muse Code doesn't trip over it.
 */
export const PRODUCT_DIR = "/vercel/app";
export const WORK_DIR = "/vercel/musemuse";
export const LOG_DIR = `${WORK_DIR}/logs`;
export const RUN_DIR = `${WORK_DIR}/run`;
export const OUT_DIR = `${WORK_DIR}/out`;
/** Written last by the toolchain setup, so a sandbox without it is not ready to build. */
export const BUILDER_MARKER = `${WORK_DIR}/builder.json`;
/**
 * Read-only, root-owned copy of the platform-owned files the verify gate depends on, made at snapshot time. startTask
 * puts them back in PRODUCT_DIR before every verify or demo, so Muse Code's edits to them can't fake a pass.
 */
export const PRISTINE_DIR = `${WORK_DIR}/pristine`;
/** Paths relative to PRODUCT_DIR (and PRISTINE_DIR). verify.mjs imports smoke-report.mjs. Each must exist in template/. */
export const PLATFORM_FILES = [
  "scripts/verify.mjs",
  "scripts/smoke-report.mjs",
  "playwright.config.ts",
  "musemuse.schema.json",
  "tests/judge-shot.ts",
] as const;
/**
 * Folder in PRODUCT_DIR where a fix round keeps the screenshots the judge saw, so the resumed Muse Code run can attach
 * them with --image (which takes paths inside the product). It holds its own `*` .gitignore, and DEPLOY_EXCLUDE_DIRS
 * in lib/publish/vercel.ts keeps it out of every deployment.
 */
export const FIX_SCREENSHOTS_DIR = ".muse-fix";
/** Ports the product's own servers use: npm start, verify's pickPort and the demo's webServer. */
export const PRODUCT_PORTS = { first: 3100, last: 3199 } as const;

/** Exact tool versions the snapshot installs. Keep in step with template/package.json. */
export const PLAYWRIGHT_VERSION = "1.64.1";
export const MUSE_INSTALL_URL = "https://dev.meta.ai/install.sh";
