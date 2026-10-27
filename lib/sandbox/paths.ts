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

/** Exact tool versions the snapshot installs. Keep in step with template/package.json. */
export const PLAYWRIGHT_VERSION = "1.64.1";
export const MUSE_INSTALL_URL = "https://dev.meta.ai/install.sh";
