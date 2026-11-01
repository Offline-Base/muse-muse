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
/**
 * Paths relative to PRODUCT_DIR (and PRISTINE_DIR). verify.mjs imports smoke-report.mjs, and demo-studio.mjs imports
 * demo-plan.mjs. Each must exist in template/. The last four are Demo Studio (docs/DEMO_STUDIO.md), with the Inter font
 * its cards and the recorder's file chip use: a pristine copy without tests/demo-fixtures.ts marks a sandbox from an
 * older snapshot, which records the old way.
 */
export const PLATFORM_FILES = [
  "scripts/verify.mjs",
  "scripts/smoke-report.mjs",
  "playwright.config.ts",
  "musemuse.schema.json",
  "tests/judge-shot.ts",
  "tests/glasses.ts",
  "tests/xr.ts",
  "scripts/xr-peek.mjs",
  "scripts/browser.json",
  "tests/demo-fixtures.ts",
  "scripts/demo-plan.mjs",
  "scripts/demo-studio.mjs",
  "scripts/demo-inter.woff2",
] as const;
/** The platform file whose pristine copy says a sandbox can record with Demo Studio. */
export const DEMO_STUDIO_MARKER = "tests/demo-fixtures.ts";
/** A platform file only snapshots and refreshes with the target overlays have. Without it a sandbox needs them refreshed. */
export const TARGET_PLATFORM_MARKER = "scripts/browser.json";
/**
 * Read-only, root-owned copy of template/targets, one folder per overlay: deps.json, files/ and platform-files.json. The
 * snapshot has it, and provisioning a target in a sandbox from an older snapshot adds it from this checkout's template/.
 */
export const TARGETS_DIR = `${WORK_DIR}/targets`;
/** Which targets this sandbox's product has, as {"targets":[...]}. Root-owned like the rest, so a build can't change it. */
export const ACTIVE_TARGETS_FILE = `${TARGETS_DIR}/active.json`;
/** The product's own copy of ACTIVE_TARGETS_FILE, which playwright.config.ts, verify and the tests read. Relative to PRODUCT_DIR. */
export const TARGET_FILE = "musemuse.target.json";
/** The targets with an overlay in template/targets. Others (phone, desktop) only get TARGET_FILE. */
export const TARGET_OVERLAYS: readonly string[] = ["vr", "glasses", "agent"];
/** Demo Studio's spec for the next demo run (builder.ts writeDemoSpec), read by scripts/demo-studio.mjs --spec. */
export const DEMO_SPEC_PATH = `${WORK_DIR}/demo-spec.json`;
/** Where Demo Studio writes demo.mp4, poster.jpg and studio.json. Sandboxes from older snapshots make their MP4 here too. */
export const DEMO_OUT_DIR = `${OUT_DIR}/demo`;
/** What tests/demo-fixtures.ts records, relative to PRODUCT_DIR: timeline.json and frames/. */
export const DEMO_RECORDING_DIR = "test-results/demo";
/**
 * Folder in PRODUCT_DIR where a fix round keeps the screenshots the judge saw, so the resumed Muse Code run can attach
 * them with --image (which takes paths inside the product). It holds its own `*` .gitignore, and DEPLOY_EXCLUDE_DIRS
 * in lib/publish/vercel.ts keeps it out of every deployment.
 */
export const FIX_SCREENSHOTS_DIR = ".muse-fix";
/** Where scripts/xr-peek.mjs keeps its pictures by default. It holds its own `*` .gitignore, and no deployment includes it. */
export const PEEK_DIR = ".muse-peek";
/** Ports the product's own servers use: npm start, verify's pickPort and the demo's webServer. */
export const PRODUCT_PORTS = { first: 3100, last: 3199 } as const;

/** Exact tool versions the snapshot installs. Keep in step with template/package.json. */
export const PLAYWRIGHT_VERSION = "1.64.1";
export const MUSE_INSTALL_URL = "https://dev.meta.ai/install.sh";

// ---------- Wave 3, unit 2: cap overlays (docs/CAPABILITIES.md, 2.5) ----------

/** template/caps in the sandbox: root-owned and read-only, one folder per overlay (files/, deps.json, platform-files.json). */
export const CAPS_DIR = `${WORK_DIR}/caps`;
/** Which caps and overlays this product has, root-owned, written once at provision. Restores read it. */
export const ACTIVE_CAPS_FILE = `${CAPS_DIR}/active.json`;
/** The product's copy (in PRODUCT_DIR), which verify, Playwright and the tests read. Put back before every verify and demo. */
export const CAPS_FILE = "musemuse.caps.json";
// ---------- Wave 3, unit 3: each overlay's own marker (docs/CAPABILITIES.md, 2.4a) ----------
/** An overlay's deps.json in CAPS_DIR: there only when the snapshot (or a local copy) installed that overlay. */
export const capOverlayMarker = (overlay: string) => `${CAPS_DIR}/${overlay}/deps.json`;
// ---------- end Wave 3, unit 3 ----------
/** The overlay every product with a cap gets. Its deps.json marks a sandbox whose snapshot has the cap overlays. */
export const CORE_CAPS_MARKER = capOverlayMarker("core");
/**
 * The gateway's address and this build's token for the caps check, root-owned and read-only, written at provision and
 * on every change. verify's caps step reads it instead of the product's .env.local, which product code can edit.
 */
export const CAPS_GATEWAY_FILE = `${CAPS_DIR}/gateway.json`;
/** The core overlay's caps check in CAPS_DIR. template/scripts/verify.mjs runs this copy in a build sandbox. */
export const CAPS_CHECK_SCRIPT = `${CAPS_DIR}/core/files/scripts/caps-check.mjs`;
/** Text only a verify.mjs with the caps step has. A pristine copy without it is from before caps, so it needs a refresh. */
export const CAPS_VERIFY_MARKER = "musemuse_caps";
