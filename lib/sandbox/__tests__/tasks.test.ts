/**
 * Unit tests for lib/sandbox/tasks.ts. The scripts run in real bash with a stub curl and temp dirs.
 *   npx tsx --test lib/sandbox/__tests__/tasks.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PLATFORM_FILES } from "@/lib/sandbox/paths";
import { writeRunner } from "@/lib/sandbox/shell";
import {
  freeProductPortsScript,
  previewAnswered,
  previewWaitScript,
  pristineCopyScript,
  restorePlatformFilesScript,
  shrinkImagesScript,
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
  assert.match(demo, /\{ \.\/node_modules\/\.bin\/playwright test tests\/smoke\.spec\.ts --project=demo 2>&3 \| tee '\/vercel\/musemuse\/logs\/demo\.out'; \} 3>&1$/);
  // Both restore first. Only the demo frees the product ports, before it starts.
  for (const s of [verify, demo]) assert.ok(s.indexOf("for f in") < s.indexOf("2>&3"));
  assert.ok(!verify.includes("ss -Htlnp"));
  assert.ok(demo.indexOf("ss -Htlnp") > demo.indexOf("for f in") && demo.indexOf("ss -Htlnp") < demo.indexOf("2>&3"));
  assert.match(demo, /p >= 3100 && p <= 3199/);
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
    shrinkImagesScript(["/x/.muse-fix/round-1-1.png", "/x/it's.png"], 2 * 1024 * 1024),
  ]) {
    const res = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
    assert.equal(res.status, 0, `${res.stderr}\n${script}`);
  }
});

test("every platform file exists in template/", () => {
  for (const f of PLATFORM_FILES) assert.ok(existsSync(path.join(process.cwd(), "template", f)), f);
});
