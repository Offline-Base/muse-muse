/**
 * Unit tests for lib/sandbox/tasks.ts. The scripts run in real bash with a stub curl and temp dirs.
 *   npx tsx --test lib/sandbox/__tests__/tasks.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PLATFORM_FILES, TARGET_OVERLAYS } from "@/lib/sandbox/paths";
import { writeRunner } from "@/lib/sandbox/shell";
import {
  activeTargetsScript,
  applyTargetScript,
  demoScript,
  demoSpecCopyScript,
  freeProductPortsScript,
  installTargetsScript,
  previewAnswered,
  previewWaitScript,
  pristineCopyScript,
  restorePlatformFilesScript,
  restoreTargetFilesScript,
  shrinkImagesScript,
  studioCommand,
  targetFileText,
  taskScript,
} from "@/lib/sandbox/tasks";

const tmp = mkdtempSync(path.join(tmpdir(), "musemuse-tasks-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = (name: string) => {
  const dir = path.join(tmp, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function bash(script: string, opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const res = spawnSync("bash", ["-c", script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("previewAnswered accepts anything below 500, redirects included", () => {
  for (const s of ["200", "204", "301", "307", "308", "401", "404", " 200\n"]) assert.equal(previewAnswered(s), true, s);
  for (const s of ["000", "", "500", "502", "503", "abc", "2000"]) assert.equal(previewAnswered(s), false, s);
});

/** A curl stand-in that prints the next status from a list, then repeats the last one. */
function stubCurl(codes: string[]): Record<string, string> {
  const dir = freshDir("bin");
  writeFileSync(path.join(dir, "codes"), `${codes.join("\n")}\n`);
  writeFileSync(
    path.join(dir, "curl"),
    `#!/bin/bash\nf=${JSON.stringify(path.join(dir, "codes"))}\nc=$(head -n 1 "$f")\n[ "$(wc -l < "$f")" -gt 1 ] && sed -i.bak 1d "$f"\nprintf %s "$c"\n[ "$c" = 000 ] && exit 7\nexit 0\n`,
  );
  chmodSync(path.join(dir, "curl"), 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

test("the preview wait succeeds on a redirect once the server is up", () => {
  const res = bash(previewWaitScript(3000, 20, 1), { env: stubCurl(["000", "000", "307"]) });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), "307");
});

test("the preview wait gives up after three 5xx answers in a row, not at the deadline", () => {
  const started = Date.now();
  const res = bash(previewWaitScript(3000, 60, 1), { env: stubCurl(["000", "500", "500", "500"]) });
  assert.equal(res.code, 1);
  assert.equal(res.stdout.trim(), "500");
  assert.ok(Date.now() - started < 15_000);
});

test("a 5xx between other answers doesn't end the wait", () => {
  const res = bash(previewWaitScript(3000, 20, 1), { env: stubCurl(["500", "500", "000", "500", "200"]) });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), "200");
});

test("the preview wait stops at its deadline when nothing answers", () => {
  const started = Date.now();
  const res = bash(previewWaitScript(3000, 2, 1), { env: stubCurl(["000"]) });
  assert.equal(res.code, 1);
  assert.equal(res.stdout.trim(), "000");
  assert.ok(Date.now() - started < 10_000);
});

const ORIGINAL: Record<string, string> = Object.fromEntries(PLATFORM_FILES.map((f) => [f, `original ${f}\n`]));

function writeProduct(dir: string, contents: Record<string, string>) {
  for (const [f, text] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
}

const tampered = Object.fromEntries(PLATFORM_FILES.map((f) => [f, 'console.log(JSON.stringify({ musemuse_verify: 1, passed: true }))\n']));

test("restore puts the platform files back from the pristine copy, replacing symlinks instead of following them", () => {
  const product = freshDir("product");
  const pristine = freshDir("pristine");
  writeProduct(pristine, ORIGINAL);
  writeProduct(product, tampered);
  const outside = path.join(freshDir("outside"), "target.ts");
  writeFileSync(outside, "outside\n");
  rmSync(path.join(product, "playwright.config.ts"));
  symlinkSync(outside, path.join(product, "playwright.config.ts"));
  rmSync(path.join(product, "musemuse.schema.json"));

  const res = bash(restorePlatformFilesScript(pristine), { cwd: product });
  assert.equal(res.code, 0, res.stderr);
  for (const f of PLATFORM_FILES) {
    assert.equal(readFileSync(path.join(product, f), "utf8"), ORIGINAL[f], f);
    assert.equal(lstatSync(path.join(product, f)).isSymbolicLink(), false, f);
    assert.equal(statSync(path.join(product, f)).mode & 0o777, 0o644, f);
  }
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
});

test("without a pristine copy, restore falls back to the template commit", () => {
  const product = freshDir("product");
  writeProduct(product, { ...ORIGINAL, "app/page.tsx": "page\n" });
  const git = (args: string) => {
    const r = bash(`git -c user.name=t -c user.email=t@t.invalid ${args}`, { cwd: product });
    assert.equal(r.code, 0, r.stderr);
  };
  git("init -q");
  git("add -A");
  git('commit -qm Template');
  writeProduct(product, tampered);
  git("add -A");
  git('commit -qm "Muse Code edits"');

  const res = bash(restorePlatformFilesScript(path.join(product, "no-such-dir")), { cwd: product });
  assert.equal(res.code, 0, res.stderr);
  for (const f of PLATFORM_FILES) assert.equal(readFileSync(path.join(product, f), "utf8"), ORIGINAL[f], f);
  assert.equal(readFileSync(path.join(product, "app/page.tsx"), "utf8"), "page\n");
});

test("with neither source, restore warns and leaves the files alone", () => {
  const product = freshDir("product");
  writeProduct(product, tampered);
  const res = bash(restorePlatformFilesScript(path.join(product, "no-such-dir")), {
    cwd: product,
    env: { GIT_CEILING_DIRECTORIES: path.dirname(product) },
  });
  assert.equal(res.code, 0);
  assert.match(res.stderr, /no pristine copy of scripts\/verify\.mjs/);
  for (const f of PLATFORM_FILES) assert.equal(readFileSync(path.join(product, f), "utf8"), tampered[f], f);
});

/**
 * Stub `ss` (prints a listener line for each live pid in a "port pid" table, in iproute2's format) and `sudo` (runs
 * the command), so the port cleanup runs for real against dummy processes.
 */
function stubSs(table: Array<[number, number]>): Record<string, string> {
  const dir = freshDir("ssbin");
  writeFileSync(path.join(dir, "table"), table.map(([port, pid]) => `${port} ${pid}`).join("\n") + "\n");
  writeFileSync(
    path.join(dir, "ss"),
    `#!/bin/bash\nwhile read -r port pid; do kill -0 "$pid" 2>/dev/null && echo "LISTEN 0 511 [::ffff:0.0.0.0]:$port [::]:* users:((\\"node\\",pid=$pid,fd=21))"; done < ${JSON.stringify(path.join(dir, "table"))}\nexit 0\n`,
  );
  writeFileSync(path.join(dir, "sudo"), `#!/bin/bash\n[ "$1" = -n ] && shift\nexec "$@"\n`);
  chmodSync(path.join(dir, "ss"), 0o755);
  chmodSync(path.join(dir, "sudo"), 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

test("the demo's port cleanup stops servers on 3100-3199 and leaves other ports alone", () => {
  const spawnSleeper = (trapTerm: boolean) => {
    const r = bash(`${trapTerm ? "trap '' TERM; " : ""}sleep 30 > /dev/null 2>&1 & echo $!`);
    return Number(r.stdout.trim());
  };
  const stale = spawnSleeper(false);
  const stubborn = spawnSleeper(true);
  const preview = spawnSleeper(false);
  const alive = (pid: number) => bash(`kill -0 ${pid} 2>/dev/null`).code === 0;
  try {
    const res = bash(freeProductPortsScript(), { env: stubSs([[3100, stale], [3150, stubborn], [3000, preview], [3200, preview]]) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /stopping old servers on ports 3100-3199/);
    assert.equal(alive(stale), false);
    assert.equal(alive(stubborn), false, "SIGKILL after SIGTERM is ignored");
    assert.equal(alive(preview), true, "ports outside 3100-3199 are left alone");
  } finally {
    for (const pid of [stale, stubborn, preview]) bash(`kill -9 ${pid} 2>/dev/null`);
  }
});

test("the port cleanup does nothing when no product port is taken", () => {
  const res = bash(freeProductPortsScript(), { env: stubSs([]) });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "");
});

test("verify and demo run directly, never through package.json scripts", () => {
  const verify = taskScript("verify", "/vercel/musemuse/logs/verify.out");
  const demo = taskScript("demo", "/vercel/musemuse/logs/demo.out");
  assert.ok(!/npm run/.test(verify) && !/npm run/.test(demo));
  assert.match(verify, /\{ node scripts\/verify\.mjs 2>&3 \| tee '\/vercel\/musemuse\/logs\/verify\.out'; \} 3>&1$/);
  assert.ok(demo.includes("{ ./node_modules/.bin/playwright test tests/smoke.demo.spec.ts --project=studio --workers=1 2>&3 | tee '/vercel/musemuse/logs/demo.out'; } 3>&1"));
  assert.ok(demo.includes("{ node scripts/demo-studio.mjs --spec '/vercel/musemuse/demo-spec.json' 2>&3 | tee -a '/vercel/musemuse/logs/demo.out'; } 3>&1"));
  // Sandboxes from older snapshots keep the old command, which also records a studio run the recorder never saw.
  assert.ok(demo.includes("{ ./node_modules/.bin/playwright test tests/smoke.spec.ts --project=demo 2>&3 | tee '/vercel/musemuse/logs/demo.out'; } 3>&1"));
  assert.ok(demo.includes("{ ./node_modules/.bin/playwright test tests/smoke.spec.ts --project=demo 2>&3 | tee -a '/vercel/musemuse/logs/demo.out'; } 3>&1"));
  assert.ok(demo.includes("if [ -f '/vercel/musemuse/pristine'/tests/demo-fixtures.ts ]; then"));
  // Both restore first. Only the demo frees the product ports, before it starts.
  for (const s of [verify, demo]) assert.ok(s.indexOf("for f in") < s.indexOf("2>&3"));
  assert.ok(!verify.includes("ss -Htlnp"));
  assert.ok(demo.indexOf("ss -Htlnp") > demo.indexOf("for f in") && demo.indexOf("ss -Htlnp") < demo.indexOf("2>&3"));
  assert.match(demo, /p >= 3100 && p <= 3199/);
  assert.equal(studioCommand("/x/spec.json", true), "node scripts/demo-studio.mjs --spec '/x/spec.json' --basic");
});

const SMOKE_IMPORTS = `import { test, expect } from "@playwright/test";
import type { Page, Locator } from '@playwright/test';
import {
  devices,
  type BrowserContext,
} from   "@playwright/test"  ;
import { judgeShot } from "./judge-shot";
export { expect as check } from"@playwright/test";
import type { Reporter } from "@playwright/test/reporter";

test("adds up the receipts", async ({ page }) => {
  await test.step("Open the product", async () => {
    await page.goto("/");
  });
});
`;

const SMOKE_IMPORTS_REWRITTEN = `import { test, expect } from "./demo-fixtures";
import type { Page, Locator } from './demo-fixtures';
import {
  devices,
  type BrowserContext,
} from   "./demo-fixtures"  ;
import { judgeShot } from "./judge-shot";
export { expect as check } from"./demo-fixtures";
import type { Reporter } from "@playwright/test/reporter";

test("adds up the receipts", async ({ page }) => {
  await test.step("Open the product", async () => {
    await page.goto("/");
  });
});
`;

/**
 * A product folder for the demo script, with stand-ins for Playwright and Demo Studio. The Playwright stand-in saves
 * its arguments (the last call's in playwright.args, every call's in playwright.calls) and the spec copy it was given,
 * writes a timeline as the recorder would when it runs the copy (unless PW_RECORD=0), sleeps PW_SLEEP seconds and
 * exits with PW_EXIT, or PW_VIDEO_EXIT for a run of the video project. The studio stand-in is the pristine copy of scripts/demo-studio.mjs (the restore puts it in
 * place) and saves its arguments. A stale recording, render and report are left where an earlier demo would have left
 * them.
 */
function demoProduct(opts: { smoke?: string | null; legacy?: boolean } = {}) {
  const product = freshDir("demo-product");
  const pristine = freshDir("pristine");
  const capture = freshDir("capture");
  const outDir = path.join(freshDir("work"), "out", "demo");
  const studio = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(capture, "studio.json"))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.STUDIO_EXIT || 0));\n`;
  const pristineFiles: Record<string, string> = { ...ORIGINAL, "scripts/demo-studio.mjs": studio };
  if (opts.legacy) for (const f of ["tests/demo-fixtures.ts", "scripts/demo-plan.mjs", "scripts/demo-studio.mjs"]) delete pristineFiles[f];
  writeProduct(pristine, pristineFiles);
  writeProduct(product, {
    ...(opts.smoke === null ? {} : { "tests/smoke.spec.ts": opts.smoke ?? SMOKE_IMPORTS }),
    "test-results/report.json": "{}",
    "test-results/demo/timeline.json": "stale",
    "test-results/demo/frames/000001.jpg": "jpg",
  });
  writeProduct(outDir, { "studio.json": '{"ok":true}', "demo.mp4": "old" });
  const pw = path.join(product, "node_modules/.bin/playwright");
  mkdirSync(path.dirname(pw), { recursive: true });
  writeFileSync(
    pw,
    [
      "#!/bin/bash",
      `echo "$@" > ${JSON.stringify(path.join(capture, "playwright.args"))}`,
      `echo "$@" >> ${JSON.stringify(path.join(capture, "playwright.calls"))}`,
      `[ -f tests/smoke.demo.spec.ts ] && cp tests/smoke.demo.spec.ts ${JSON.stringify(path.join(capture, "copy.ts"))}`,
      `case "$*" in *smoke.demo.spec.ts*) [ "\${PW_RECORD:-1}" = 1 ] && mkdir -p test-results/demo && echo "{}" > test-results/demo/timeline.json ;; esac`,
      `sleep "\${PW_SLEEP:-0}"`,
      `case "$*" in *--project=demo*) exit "\${PW_VIDEO_EXIT:-\${PW_EXIT:-0}}" ;; esac`,
      `exit "\${PW_EXIT:-0}"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const script = taskScript("demo", path.join(capture, "demo.out"), { pristineDir: pristine, specPath: "/work/demo-spec.json", outDir });
  const env = { ...stubSs([]), GIT_CEILING_DIRECTORIES: path.dirname(product) };
  const read = (file: string) => (existsSync(path.join(capture, file)) ? readFileSync(path.join(capture, file), "utf8") : null);
  return { product, outDir, script, env, read };
}

test("the demo runs a copy of the smoke test with every Playwright import pointed at the recorder, then the studio", () => {
  const d = demoProduct();
  const res = bash(d.script, { cwd: d.product, env: d.env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(d.read("playwright.calls")?.trim(), "test tests/smoke.demo.spec.ts --project=studio --workers=1");
  assert.equal(d.read("copy.ts"), SMOKE_IMPORTS_REWRITTEN);
  assert.deepEqual(JSON.parse(d.read("studio.json")!), ["--spec", "/work/demo-spec.json"]);
  // The copy is gone, the smoke test is untouched, and nothing from the last demo is left to be mistaken for this one.
  assert.ok(!existsSync(path.join(d.product, "tests/smoke.demo.spec.ts")));
  assert.equal(readFileSync(path.join(d.product, "tests/smoke.spec.ts"), "utf8"), SMOKE_IMPORTS);
  for (const stale of ["test-results/report.json", "test-results/demo/frames"]) assert.ok(!existsSync(path.join(d.product, stale)), stale);
  assert.equal(readFileSync(path.join(d.product, "test-results/demo/timeline.json"), "utf8").trim(), "{}", "this run's timeline");
  assert.ok(!existsSync(d.outDir));
  assert.ok(!res.stderr.includes("may not attach"));
});

test("a failed demo run exits with Playwright's code, skips the studio and still deletes the copy", () => {
  const d = demoProduct();
  const res = bash(d.script, { cwd: d.product, env: { ...d.env, PW_EXIT: "1" } });
  assert.equal(res.code, 1);
  assert.equal(d.read("studio.json"), null);
  assert.ok(d.read("copy.ts"), "the run got the copy");
  assert.ok(!existsSync(path.join(d.product, "tests/smoke.demo.spec.ts")));
});

test("a studio that fails after a passing run makes the demo exit with its code", () => {
  const d = demoProduct();
  const res = bash(d.script, { cwd: d.product, env: { ...d.env, STUDIO_EXIT: "3" } });
  assert.equal(res.code, 3);
  assert.ok(d.read("studio.json"));
});

test("a passing studio run that recorded nothing is recorded again with Playwright's video, and the studio doesn't run", () => {
  const d = demoProduct();
  const res = bash(d.script, { cwd: d.product, env: { ...d.env, PW_RECORD: "0" } });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(d.read("playwright.calls")?.trim().split("\n"), [
    "test tests/smoke.demo.spec.ts --project=studio --workers=1",
    "test tests/smoke.spec.ts --project=demo",
  ]);
  assert.match(res.stderr, /the studio run recorded nothing, so the demo is recorded with Playwright's video instead/);
  assert.equal(d.read("studio.json"), null);
  assert.ok(!existsSync(path.join(d.product, "tests/smoke.demo.spec.ts")), "the copy is gone before the second run");

  // The second run's failure is the task's.
  const failed = demoProduct();
  const second = bash(failed.script, { cwd: failed.product, env: { ...failed.env, PW_RECORD: "0", PW_VIDEO_EXIT: "4" } });
  assert.equal(second.code, 4);
  assert.equal(failed.read("studio.json"), null);
});

test("a smoke test that imports its test from elsewhere still runs, with a warning, and none at all fails", () => {
  const helper = demoProduct({ smoke: 'import { test } from "./fixtures";\ntest("x", async () => {});\n' });
  const warned = bash(helper.script, { cwd: helper.product, env: helper.env });
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /doesn't import @playwright\/test itself, so the demo recorder may not attach/);

  const none = demoProduct({ smoke: null });
  const res = bash(none.script, { cwd: none.product, env: none.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /there is no tests\/smoke\.spec\.ts to record/);
  assert.equal(none.read("playwright.args"), null);
  assert.ok(!existsSync(path.join(none.product, "tests/smoke.demo.spec.ts")));
});

test("a sandbox from an older snapshot, without the recorder in its pristine copy, records the old way", () => {
  const d = demoProduct({ legacy: true });
  const res = bash(d.script, { cwd: d.product, env: d.env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(d.read("playwright.args")?.trim(), "test tests/smoke.spec.ts --project=demo");
  assert.equal(d.read("copy.ts"), null);
  assert.equal(d.read("studio.json"), null);
  assert.ok(!existsSync(path.join(d.product, "test-results/report.json")), "report.json only ever describes this run");
});

test("a demo stopped at its cap still deletes the copy", async () => {
  const d = demoProduct();
  // The runner sends SIGTERM to the whole process group (shell.ts writeRunner), so this does the same.
  const child = spawn("bash", ["-c", d.script], { cwd: d.product, env: { ...process.env, ...d.env, PW_SLEEP: "30" }, detached: true, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const copy = path.join(d.product, "tests/smoke.demo.spec.ts");
  for (let i = 0; i < 100 && !d.read("playwright.args"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(copy), "the run is under way with its copy");
  process.kill(-child.pid!, "SIGTERM");
  assert.equal(await exited, 143);
  assert.ok(!existsSync(copy));
  assert.equal(d.read("studio.json"), null);
});

/** Writes the real runner script (shell.ts writeRunner) through a stand-in sandbox and returns its path. */
async function runnerFor(spec: Parameters<typeof writeRunner>[1]): Promise<string> {
  let script = "";
  const fake = { writeFiles: async (files: Array<{ content: string | Buffer }>) => void (script = String(files[0].content)) };
  await writeRunner(fake as unknown as Parameters<typeof writeRunner>[0], spec);
  const file = path.join(freshDir("runner"), `${spec.name}.sh`);
  writeFileSync(file, script, { mode: 0o755 });
  return file;
}

test("the verify runner restores a tampered gate, skips package.json and keeps the summary last on stdout", async () => {
  const product = freshDir("product");
  const pristine = freshDir("pristine");
  const realVerify = 'console.error("verify: typecheck ..."); console.log("verify: all steps passed"); console.log(JSON.stringify({ musemuse_verify: 1, passed: false, steps: [{ name: "typecheck", ok: false }] })); process.exit(1);\n';
  writeProduct(pristine, { ...ORIGINAL, "scripts/verify.mjs": realVerify });
  writeProduct(product, { ...tampered, "package.json": JSON.stringify({ scripts: { verify: "echo fake-pass" } }) });
  const logs = freshDir("logs");
  const bin = freshDir("bin");
  writeFileSync(path.join(bin, "setsid"), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });

  const script = taskScript("verify", path.join(logs, "verify.out")).replace(restorePlatformFilesScript(), restorePlatformFilesScript(pristine));
  const runner = await runnerFor({ name: "verify", cwd: product, argv: ["bash", "-c", script], stdoutPath: path.join(logs, "verify.log") });
  const res = spawnSync("bash", [runner], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });

  assert.equal(res.status, 1, "verify's exit code comes through the pipe");
  assert.equal(readFileSync(path.join(logs, "verify.log.exit"), "utf8").trim(), "1");
  const out = readFileSync(path.join(logs, "verify.out"), "utf8").trim().split("\n");
  assert.deepEqual(JSON.parse(out[out.length - 1]), { musemuse_verify: 1, passed: false, steps: [{ name: "typecheck", ok: false }] });
  assert.ok(!out.some((l) => l.includes("typecheck ...")), "stderr stays out of the .out file");
  assert.match(readFileSync(path.join(logs, "verify.log"), "utf8"), /typecheck \.\.\./);
  assert.equal(readFileSync(path.join(product, "scripts/verify.mjs"), "utf8"), realVerify);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

/** A PNG of grey noise, which compresses badly: 640x640 is about 600 KB. */
function noisePng(file: string): void {
  const res = spawnSync(
    "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=640x640,geq=lum='random(1)*255':cb=128:cr=128", "-frames:v", "1", "-update", "1", "-c:v", "png", "-f", "image2", file],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
}

test("the screenshot shrinker downscales what it can, drops the rest and always exits 0", { skip: hasFfmpeg ? false : "needs ffmpeg" }, () => {
  const dir = freshDir("shrink");
  const [fits, tooBig, broken] = ["round-1-1.png", "round-1-2.png", "round-1-3.png"].map((f) => path.join(dir, f));
  noisePng(`${fits}.big`);
  noisePng(`${tooBig}.big`);
  writeFileSync(`${broken}.big`, "not a png");
  const before = statSync(`${fits}.big`).size;
  assert.ok(before > 200_000, `noise came out at ${before} bytes`);

  // The cap is per run, so the second one gets a cap no downscale can meet.
  const first = bash(shrinkImagesScript([fits, broken], 200_000));
  const second = bash(shrinkImagesScript([tooBig], 1000));
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(first.stdout.trim().split("\n"), [fits]);
  assert.equal(second.stdout.trim(), "");
  assert.ok(statSync(fits).size <= 200_000);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", fits], { encoding: "utf8" });
  assert.equal(probe.stdout.trim(), "320,320", "half size was enough");
  for (const f of [tooBig, broken]) assert.ok(!existsSync(f), `${f} is left out`);
  for (const f of [fits, tooBig, broken]) assert.ok(!existsSync(`${f}.big`), `${f}.big is cleaned up`);
});

test("the screenshot shrinker leaves everything out, and still exits 0, when ffmpeg fails", () => {
  const dir = freshDir("shrink-fail");
  const bin = freshDir("bin");
  writeFileSync(path.join(bin, "ffmpeg"), '#!/bin/bash\necho "ffmpeg: broken" >&2\nexit 1\n', { mode: 0o755 });
  const file = path.join(dir, "round-2-1.png");
  writeFileSync(`${file}.big`, Buffer.alloc(3000, 1));
  const res = bash(shrinkImagesScript([file], 1000), { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, "");
  assert.ok(!existsSync(file) && !existsSync(`${file}.big`));
});

test("every generated script is valid bash", () => {
  for (const script of [
    previewWaitScript(),
    pristineCopyScript(),
    restorePlatformFilesScript(),
    freeProductPortsScript(),
    taskScript("verify", "/x/verify.out"),
    taskScript("demo", "/x/demo.out"),
    installTargetsScript("/tmp/it's"),
    activeTargetsScript(["web", "vr"]),
    applyTargetScript(["web", "vr", "glasses", "phone"]),
    restoreTargetFilesScript(),
    demoScript("/x/it's.out", { pristineDir: "/x/it's", specPath: "/x/it's.json", outDir: "/x/it's" }),
    demoSpecCopyScript(),
    studioCommand("/x/it's.json", true),
    shrinkImagesScript(["/x/.muse-fix/round-1-1.png", "/x/it's.png"], 2 * 1024 * 1024),
  ]) {
    const res = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
    assert.equal(res.status, 0, `${res.stderr}\n${script}`);
  }
});

test("every platform file exists in template/", () => {
  for (const f of PLATFORM_FILES) assert.ok(existsSync(path.join(process.cwd(), "template", f)), f);
});

test("every overlay the platform lists is in template/targets, with its platform files", () => {
  const root = path.join(process.cwd(), "template", "targets");
  assert.deepEqual([...TARGET_OVERLAYS].sort(), readdirSync(root).sort());
  for (const t of TARGET_OVERLAYS) {
    const deps = JSON.parse(readFileSync(path.join(root, t, "deps.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const group of Object.values(deps)) for (const version of Object.values(group)) assert.match(version, /^\d+\.\d+\.\d+$/, "exact versions only");
    for (const f of JSON.parse(readFileSync(path.join(root, t, "platform-files.json"), "utf8")) as string[]) {
      assert.ok(existsSync(path.join(root, t, "files", f)), `${t}: ${f}`);
    }
  }
});

/** A product repo and a targets folder with one overlay, and an npm stub that logs its arguments. */
function targetRig() {
  const dir = freshDir("target");
  const product = path.join(dir, "product");
  const targets = path.join(dir, "targets");
  const bin = path.join(dir, "bin");
  const overlay = path.join(targets, "vr");
  mkdirSync(path.join(overlay, "files", "lib", "xr"), { recursive: true });
  mkdirSync(path.join(overlay, "files", ".agents", "skills", "muse-vr"), { recursive: true });
  mkdirSync(product, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(overlay, "deps.json"), JSON.stringify({ dependencies: { three: "0.184.0", "@react-three/xr": "6.6.32" }, devDependencies: { "@types/three": "0.184.1" } }));
  writeFileSync(path.join(overlay, "platform-files.json"), JSON.stringify(["lib/xr/emulator.ts", ".agents/skills/muse-vr"]));
  writeFileSync(path.join(overlay, "files", "lib", "xr", "emulator.ts"), "the platform's\n");
  writeFileSync(path.join(overlay, "files", ".agents", "skills", "muse-vr", "SKILL.md"), "the skill\n");
  writeFileSync(path.join(overlay, "files", "Part.tsx"), "a part\n");
  chmodSync(path.join(overlay, "files", "Part.tsx"), 0o444);
  writeFileSync(path.join(bin, "npm"), `#!/bin/bash\necho "$*" >> ${JSON.stringify(path.join(dir, "npm.log"))}\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  assert.equal(bash(`git init -q && echo x > a.txt && git add -A && git commit -qm Template`, { cwd: product, env }).code, 0);
  return { dir, product, targets, env };
}

test("the active targets file goes in on a snapshot with no targets folder, as a phone-only brief has", () => {
  const { dir, env } = targetRig();
  const file = path.join(dir, "no-folder-yet", "active.json");
  writeFileSync(path.join(dir, "bin", "chown"), "#!/bin/bash\n");
  chmodSync(path.join(dir, "bin", "chown"), 0o755);
  const res = bash(activeTargetsScript(["web", "phone"], file), { env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(file, "utf8"), '{"targets":["web","phone"]}\n');
});

test("applying a target copies the overlay, installs its deps, writes the target file and commits", () => {
  const { dir, product, targets, env } = targetRig();
  const res = bash(applyTargetScript(["web", "vr", "phone"], targets), { cwd: product, env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(path.join(product, "lib/xr/emulator.ts"), "utf8"), "the platform's\n");
  assert.equal(readFileSync(path.join(product, ".agents/skills/muse-vr/SKILL.md"), "utf8"), "the skill\n");
  // The overlay's copy is read-only, and the product's parts are the build's to change.
  writeFileSync(path.join(product, "Part.tsx"), "changed\n");
  assert.equal(readFileSync(path.join(product, "musemuse.target.json"), "utf8"), '{"targets":["web","vr","phone"]}\n');
  assert.deepEqual(readFileSync(path.join(dir, "npm.log"), "utf8").trim().split("\n"), [
    "install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error three@0.184.0 @react-three/xr@6.6.32",
    "install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error --save-dev @types/three@0.184.1",
  ]);
  assert.equal(bash("git log --format=%s -1", { cwd: product }).stdout.trim(), "Target: vr, phone");
  assert.match(bash("git show --stat --format= HEAD", { cwd: product }).stdout, /lib\/xr\/emulator\.ts/);
});

test("a retry that finds a target applied leaves the build's own files alone", () => {
  const { dir, product, targets, env } = targetRig();
  assert.equal(bash(applyTargetScript(["web", "vr"], targets), { cwd: product, env }).code, 0);
  rmSync(path.join(dir, "npm.log"));
  writeFileSync(path.join(product, "brief.md"), "the user's brief\n");
  writeFileSync(path.join(product, "lib/xr/emulator.ts"), "edited\n");
  const res = bash(applyTargetScript(["web", "vr"], targets), { cwd: product, env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(path.join(product, "lib/xr/emulator.ts"), "utf8"), "edited\n");
  assert.ok(!existsSync(path.join(dir, "npm.log")));
  assert.match(bash("git status --short", { cwd: product }).stdout, /brief\.md/, "still uncommitted");
});

test("an overlay with no deps installs nothing, and a missing overlay fails before anything changes", () => {
  const { dir, product, targets, env } = targetRig();
  writeFileSync(path.join(targets, "vr", "deps.json"), "{}");
  assert.equal(bash(applyTargetScript(["web", "vr"], targets), { cwd: product, env }).code, 0);
  assert.ok(!existsSync(path.join(dir, "npm.log")));
  const other = targetRig();
  rmSync(path.join(other.targets, "vr", "deps.json"));
  const res = bash(applyTargetScript(["web", "vr"], other.targets), { cwd: other.product, env: other.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /the vr overlay isn't in this sandbox/);
  assert.ok(!existsSync(path.join(other.product, "musemuse.target.json")));
});

test("a target without an overlay only shows in the target file", () => {
  const { dir, product, targets, env } = targetRig();
  assert.equal(bash(applyTargetScript(["web", "phone"], targets), { cwd: product, env }).code, 0);
  assert.ok(!existsSync(path.join(product, "lib")));
  assert.ok(!existsSync(path.join(dir, "npm.log")));
  assert.equal(readFileSync(path.join(product, "musemuse.target.json"), "utf8"), targetFileText(["web", "phone"]));
});

test("before a task the target file and the overlay's platform files come back from the read-only copy", () => {
  const { product, targets, env } = targetRig();
  assert.equal(bash(applyTargetScript(["web", "vr"], targets), { cwd: product, env }).code, 0);
  writeFileSync(path.join(targets, "active.json"), targetFileText(["web", "vr"]));
  // A build that dropped the check by rewriting the target file, edited a platform file and left a link in a folder's place.
  writeFileSync(path.join(product, "musemuse.target.json"), '{"targets":["web"]}\n');
  writeFileSync(path.join(product, "lib/xr/emulator.ts"), "faked\n");
  rmSync(path.join(product, ".agents/skills/muse-vr"), { recursive: true });
  symlinkSync("/etc", path.join(product, ".agents/skills/muse-vr"));
  writeFileSync(path.join(product, "Part.tsx"), "the build's own\n");
  const res = bash(restoreTargetFilesScript(targets), { cwd: product, env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(path.join(product, "musemuse.target.json"), "utf8"), '{"targets":["web","vr"]}\n');
  assert.equal(readFileSync(path.join(product, "lib/xr/emulator.ts"), "utf8"), "the platform's\n");
  assert.ok(!lstatSync(path.join(product, ".agents/skills/muse-vr")).isSymbolicLink());
  assert.equal(readFileSync(path.join(product, ".agents/skills/muse-vr/SKILL.md"), "utf8"), "the skill\n");
  assert.equal(readFileSync(path.join(product, "Part.tsx"), "utf8"), "the build's own\n", "product parts stay");
  writeFileSync(path.join(product, "lib/xr/emulator.ts"), "writable again\n");
});

test("a sandbox with no target changes nothing before a task, and says nothing", () => {
  const product = freshDir("no-target");
  const res = bash(restoreTargetFilesScript(path.join(product, "no-such-dir")), { cwd: product });
  assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""]);
  assert.ok(!existsSync(path.join(product, "musemuse.target.json")));
});

test("the verify and demo runners restore targets after the platform files", () => {
  for (const task of ["verify", "demo"] as const) {
    const script = taskScript(task, "/x/out");
    assert.ok(script.indexOf(restorePlatformFilesScript()) < script.indexOf(restoreTargetFilesScript()));
    assert.ok(script.indexOf(restoreTargetFilesScript()) < script.indexOf(task === "demo" ? freeProductPortsScript() : "node scripts/verify.mjs"));
  }
});
