/**
 * Shell and files for the Prove it stage's sandbox copy (docs/PRODUCT_OUTPUTS.md). Pure string builders, so they can be
 * tested without a sandbox. The copy is thrown away after the run, so nothing written here reaches the product.
 */
import { PROVE_CHECK_PLUGIN_SOURCE, PROVE_RUNNER_SOURCE } from "@/lib/outputs/assets-source";
import type { ProveRunSpec } from "@/lib/outputs/prove";
import { DEMO_RECORDING_DIR, PRISTINE_DIR, DEMO_STUDIO_MARKER, WORK_DIR } from "@/lib/sandbox/paths";
import { q } from "@/lib/sandbox/shell";
import { restorePlatformFilesScript } from "@/lib/sandbox/tasks";

/** Where a run works, outside the product. */
export const PROVE_DIR = `${WORK_DIR}/prove`;
/** An empty folder but for the skill, so the skill test can't lean on the product's source. */
export const PROVE_SKILL_DIR = `${PROVE_DIR}/skill-test`;
/** Relative to PRODUCT_DIR: the recorder finds test-results/demo next to its config, and imports from tests/. */
export const PROVE_CONFIG = "prove.playwright.config.ts";
export const PROVE_SPEC = "prove-tests/scene.demo.spec.ts";

/** Time caps in the sandbox for one output's recording and render, and for the plain cut when the render fails. */
const RECORD_S = 150;
const RENDER_S = 240;
const BASIC_RENDER_S = 120;

/** The command that runs the checks. */
export const PROVE_CHECKS_ARGV = ["node", `${PROVE_DIR}/prove-runner.mjs`, `${PROVE_DIR}/spec.json`];

/** The files the checks need in the copy. */
export function proveCheckFiles(spec: ProveRunSpec): Array<{ path: string; content: string }> {
  return [
    { path: `${PROVE_DIR}/spec.json`, content: JSON.stringify(spec) },
    { path: `${PROVE_DIR}/prove-runner.mjs`, content: PROVE_RUNNER_SOURCE },
    { path: `${PROVE_DIR}/prove-check-plugin.mjs`, content: PROVE_CHECK_PLUGIN_SOURCE },
  ];
}

/** Just the recorder's project, with none of the product's own: nothing here needs the product's server. */
export function proveConfigFile(): string {
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "prove-tests",
  outputDir: "test-results/playwright",
  forbidOnly: true,
  timeout: 120_000,
  reporter: [["list"]],
  projects: [
    {
      name: "studio",
      testMatch: /\\.demo\\.spec\\.ts$/,
      use: {
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        video: "off",
        launchOptions: { args: ["--force-device-scale-factor=2"] },
      },
    },
  ],
});
`;
}

/** Plays one scene for Demo Studio's recorder. Each command is a step, so its caption shows under the window. */
export function proveSpecFile(): string {
  return `import { readFileSync } from "node:fs";
import { test } from "../tests/demo-fixtures";

const scene = JSON.parse(readFileSync(process.env.PROVE_SCENE ?? "", "utf8")) as {
  steps: Array<{ caption: string }>;
};

test("prove it", async ({ page }) => {
  await page.goto(process.env.PROVE_SCENE_URL ?? "");
  await page.evaluate((s) => (window as unknown as { loadScene(s: unknown): void }).loadScene(s), scene);
  for (let i = 0; i < scene.steps.length; i++) {
    await test.step(scene.steps[i]!.caption, async () => {
      await page.evaluate((n) => (window as unknown as { playStep(n: number): Promise<void> }).playStep(n), i);
    });
  }
});
`;
}

export interface ProveRecordPaths {
  proveDir?: string;
  pristineDir?: string;
}

/**
 * Records each output with a scene file: restores the platform's recorder and studio first, runs the scene under the
 * recorder, renders with Demo Studio (or its plain cut when that fails), and leaves demo.mp4 and poster.jpg in
 * <dir>/video/<output>/. One that fails is noted in <output>/failed and the rest still run. Frames go after each
 * render, since four recordings at once would be a lot of disk. Exits 3 when the sandbox has no Demo Studio at all.
 */
export function proveRecordScript(outputs: readonly string[], paths: ProveRecordPaths = {}): string {
  const { proveDir = PROVE_DIR, pristineDir = PRISTINE_DIR } = paths;
  const dir = q(proveDir);
  return [
    `[ -f ${q(pristineDir)}/${DEMO_STUDIO_MARKER} ] || { echo "musemuse: this sandbox has no Demo Studio, so nothing is recorded" >&2; exit 3; }`,
    restorePlatformFilesScript(pristineDir),
    `export PROVE_SCENE_URL=${q(`file://${proveDir}/scene.html`)}`,
    `for o in ${outputs.map(q).join(" ")}; do`,
    `  [ -f ${dir}/scene-"$o".json ] || continue`,
    `  out=${dir}/video/"$o"`,
    `  rm -rf ${q(DEMO_RECORDING_DIR)} "$out"; mkdir -p "$out"`,
    `  echo "musemuse: recording $o"`,
    `  if ! PROVE_SCENE=${dir}/scene-"$o".json timeout -k 10 ${RECORD_S} ./node_modules/.bin/playwright test --config ${q(PROVE_CONFIG)} --project=studio --workers=1; then`,
    `    echo "the recording failed" > "$out"/failed; continue`,
    `  fi`,
    `  if ! timeout -k 10 ${RENDER_S} node scripts/demo-studio.mjs --spec ${dir}/studio-"$o".json; then`,
    `    timeout -k 10 ${BASIC_RENDER_S} node scripts/demo-studio.mjs --spec ${dir}/studio-"$o".json --basic || echo "the render failed" > "$out"/failed`,
    `  fi`,
    `  rm -rf ${q(`${DEMO_RECORDING_DIR}/frames`)}`,
    `done`,
  ].join("\n");
}
