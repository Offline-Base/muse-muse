/**
 * The drive's image (lib/drive/image.ts) and its launchers, with a fake llama.cpp release, a fake Hub and a temporary
 * folder standing in for the stick. What goes on the drive and nothing else: the server and the libraries it loads,
 * copied from the archive's symlinks because exFAT has none, each runtime with its license, Meta's license and Usage
 * Policy only when they match their pins, the card and tuned.jinja from the repo at the files' commit, CHANGES.md, and
 * no template left unfilled or em dash in what a person reads. The launchers' build table is the device picker's own
 * verdict, row for row with the design's table. PROVENANCE.json and SHA256SUMS list every file, and shasum checks
 * them. The Mac launcher runs for real against shims of sysctl, df, nc, curl and open: it picks the build for each
 * memory size, refuses an Intel Mac, copies and checks the build when asked, binds 127.0.0.1 only, and never downloads
 * anything. The Windows scripts are checked by reading them, since no Windows runs here.
 *
 *   npx tsx --test lib/drive/__tests__/image.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildDriveImage,
  buildForText,
  changesText,
  DERIVATIVE_DRIVE_FILES,
  DRIVE_SOURCE_DIR,
  launcherTable,
  listFiles,
  META_FILES,
  modelPath,
  RUNTIME_PIN,
  sha256File,
  systemExtract,
  writeManifestFiles,
  type ImageManifest,
  type ImageModel,
} from "../image";
import { DERIVATIVE_FILES } from "@/lib/train/licenses";
import { DRIVE_IMAGE_VERSION } from "../logic";
import { fakeExtract, fakeFetch, ggufBytes, imageModel, MIT, sha, smallModel, TEST_META, TEST_PIN } from "./fixtures";

const EM_DASH = String.fromCharCode(0x2014);
const darwin = process.platform === "darwin";
let tmp: string;

async function freshDir(name: string): Promise<string> {
  const dir = path.join(tmp, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function build(model: ImageModel = imageModel(), over: Partial<Parameters<typeof buildDriveImage>[1]> = {}) {
  const outDir = path.join(await freshDir("image"), "out");
  const cacheDir = over.cacheDir ?? (await freshDir("cache"));
  const fetchImpl = fakeFetch();
  const manifest = await buildDriveImage(model, { outDir, cacheDir, fetchImpl, extract: fakeExtract, pin: TEST_PIN, metaFiles: TEST_META, ...over });
  return { outDir, cacheDir, manifest, fetchImpl };
}

/**
 * A whole drive in a folder: the image, the small stand-in model files, PROVENANCE.json and SHA256SUMS. The model keeps
 * the design's sizes, so the launchers' table is the real one; the files on disk are the small ones its sha256 names.
 */
async function stick(model: ImageModel = imageModel()): Promise<{ dir: string; manifest: ImageManifest }> {
  const { outDir, manifest } = await build(model);
  for (const f of model.files) await fs.writeFile(path.join(outDir, modelPath(f)), ggufBytes(f.level));
  await writeManifestFiles(outDir, manifest, model, "MM-0A1B2C3D4E5F", new Date("2026-10-28T15:00:00Z"));
  return { dir: outDir, manifest };
}

describe("the drive image", () => {
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-image-"));
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("holds the pages, the launchers, the runtimes, the licenses and the card, and nothing else", async () => {
    const { outDir, manifest } = await build();
    const files = await listFiles(outDir);
    assert.deepEqual(files, [
      "MODEL_CARD.md",
      "README.txt",
      "Start (Mac).command",
      "Start (Windows).cmd",
      "Start Here.html",
      "Verify (Mac).command",
      "Verify (Windows).cmd",
      "licenses/Apache-2.0.txt",
      "licenses/CHANGES.md",
      "licenses/LLVM-OpenMP-LICENSE.txt",
      "licenses/USAGE_POLICY.md",
      "licenses/llama.cpp-LICENSE.txt",
      "model/system.txt",
      "model/ui-config.json",
      "runtime/macos-arm64/LICENSE",
      "runtime/macos-arm64/libggml-base.0.dylib",
      "runtime/macos-arm64/libllama-server-impl.dylib",
      "runtime/macos-arm64/libllama.0.dylib",
      "runtime/macos-arm64/llama-server",
      "runtime/windows-x64-cpu/LICENSE",
      "runtime/windows-x64-cpu/LICENSE-LLVM-OpenMP",
      "runtime/windows-x64-cpu/ggml-cpu-haswell.dll",
      "runtime/windows-x64-cpu/llama-server-impl.dll",
      "runtime/windows-x64-cpu/llama-server.exe",
      "runtime/windows-x64-vulkan/LICENSE",
      "runtime/windows-x64-vulkan/LICENSE-LLVM-OpenMP",
      "runtime/windows-x64-vulkan/ggml-cpu-haswell.dll",
      "runtime/windows-x64-vulkan/ggml-vulkan.dll",
      "runtime/windows-x64-vulkan/llama-server-impl.dll",
      "runtime/windows-x64-vulkan/llama-server.exe",
      "support/builds.tsv",
      "support/files.tsv",
      "support/model.tsv",
      "support/start-windows.ps1",
      "support/verify-windows.ps1",
    ]);
    assert.deepEqual(manifest.files.map((f) => f.path), files, "the manifest lists every file");
    assert.equal(manifest.imageVersion, DRIVE_IMAGE_VERSION);
    for (const f of manifest.files) assert.equal(f.sha256, await sha256File(path.join(outDir, f.path)), f.path);
  });

  it("copies the libraries the server loads from the archive's symlinks, since exFAT has none", async () => {
    const { outDir } = await build();
    for (const rel of await listFiles(outDir)) {
      assert.equal((await fs.lstat(path.join(outDir, rel))).isSymbolicLink(), false, rel);
    }
    const mac = path.join(outDir, "runtime/macos-arm64");
    assert.equal(await fs.readFile(path.join(mac, "libllama.0.dylib"), "utf8"), "llama lib");
    assert.equal(await fs.readFile(path.join(mac, "libggml-base.0.dylib"), "utf8"), "ggml base lib");
    assert.equal((await fs.stat(path.join(mac, "llama-server"))).mode & 0o111, 0o111, "the server runs");
    assert.equal((await fs.stat(path.join(outDir, "Start (Mac).command"))).mode & 0o111, 0o111);
    assert.equal(await fs.readFile(path.join(mac, "LICENSE"), "utf8"), MIT);
    assert.equal(await fs.readFile(path.join(outDir, "runtime/windows-x64-vulkan/LICENSE"), "utf8"), MIT, "llama.cpp's MIT license goes with every build");
  });

  it("takes a download only when it matches its pin, and fetches each one once", async () => {
    const cacheDir = await freshDir("cache");
    const first = await build(imageModel(), { cacheDir });
    const runtimeCalls = first.fetchImpl.urls.filter((u) => u.startsWith("https://github.com/"));
    assert.equal(runtimeCalls.length, 3);
    const second = await build(imageModel(), { cacheDir });
    assert.equal(second.fetchImpl.urls.filter((u) => u.startsWith("https://github.com/")).length, 0, "the cache answers");

    const wrongPin = { ...TEST_PIN, assets: TEST_PIN.assets.map((a, i) => (i === 1 ? { ...a, sha256: "0".repeat(64) } : a)) };
    await assert.rejects(build(imageModel(), { pin: wrongPin }), /didn't match its pinned sha256/);
    const wrongMeta = [{ ...TEST_META[0], sha256: sha("something else") }, TEST_META[1]];
    await assert.rejects(build(imageModel(), { metaFiles: wrongMeta }), /didn't match its pinned sha256/);
  });

  it("pins the real llama.cpp release and Meta's files", () => {
    assert.equal(RUNTIME_PIN.build, "b11669");
    assert.deepEqual(RUNTIME_PIN.assets.map((a) => a.runtime), ["macos-arm64", "windows-x64-vulkan", "windows-x64-cpu"]);
    for (const a of RUNTIME_PIN.assets) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      assert.match(a.name, /^llama-b11669-bin-(macos-arm64\.tar\.gz|win-(vulkan|cpu)-x64\.zip)$/);
    }
    for (const m of META_FILES) assert.match(m.url, /^https:\/\/huggingface\.co\/meta-models\/Muse-Glimmer-30B-GGUF\/raw\/[0-9a-f]{40}\//);
  });

  it("brings the card from the repo at the files' commit, and tuned.jinja only for an adapter that needs it", async () => {
    const plain = await build();
    assert.ok(plain.fetchImpl.urls.includes(`https://huggingface.co/${imageModel().repo}/raw/${imageModel().commit}/README.md`));
    assert.equal(plain.fetchImpl.urls.some((u) => u.endsWith("/tuned.jinja")), false);
    const old = await build(imageModel({ needsTunedTemplate: true }));
    assert.equal(await fs.readFile(path.join(old.outDir, "model/tuned.jinja"), "utf8"), "{{ bos_token }}tuned template");
    assert.match(await fs.readFile(path.join(old.outDir, "Start Here.html"), "utf8"), /model\/tuned\.jinja/);
    assert.ok(old.manifest.sources.some((s) => s.path === "model/tuned.jinja" && /^[0-9a-f]{64}$/.test(s.sha256)));
  });

  it("presets the chat's system message, and fills every page with the model's facts, escaped", async () => {
    const model = imageModel({ title: "Bakery <b>helper</b> & co" });
    const { outDir } = await build(model);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(outDir, "model/ui-config.json"), "utf8")), {
      systemMessage: model.systemLine,
      temperature: 0,
    });
    assert.equal(await fs.readFile(path.join(outDir, "model/system.txt"), "utf8"), `${model.systemLine}\n`);
    const html = await fs.readFile(path.join(outDir, "Start Here.html"), "utf8");
    assert.match(html, /<h1>Bakery &lt;b&gt;helper&lt;\/b&gt; &amp; co<\/h1>/);
    assert.match(html, /<pre id="system">You are the bakery helper\.\n\nReasoning strength: low\.<\/pre>/);
    assert.match(html, /It runs on a Mac with Apple silicon and 24 GB of memory or more, or a Windows PC with a 16 GB graphics card or 32 GB of memory\./);
    assert.match(html, /<tr><td>Q4_K_M<\/td><td class="num">16\.9 GB<\/td><td>a Mac with 32 or 36 GB; a PC with a graphics card of 20 or 24 GB; a PC with 32 GB of memory and no big graphics card, slowly<\/td><\/tr>/);
    assert.match(html, /Smart App Control on aren't supported yet/);
    assert.match(html, /Open Anyway/);
    // Start Here works offline: it loads nothing, and its only web addresses are links the buyer may follow.
    assert.doesNotMatch(html, /(src|action)=["']https?:|<link\b|url\(\s*["']?https?:|@import|fetch\(/);
    for (const url of html.match(/https?:\/\/[^"'<\s]+/g) ?? []) assert.ok(url.startsWith("http://127.0.0.1") || html.includes(`href="${url}"`), url);
    // The model's page for Try it live, and where to write: the invoice's email until the site names an address.
    assert.match(html, /<a href="https:\/\/muse-muse\.vercel\.app\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001">/);
    assert.match(html, /Reply to the email your invoice came from for a replacement or a refund\./);
    assert.match(html, /doesn't run on Linux or on a Mac with an Intel chip/);
    assert.match(await fs.readFile(path.join(outDir, "support/model.tsv"), "utf8"), /\npage\thttps:\/\/muse-muse\.vercel\.app\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001\ncontact\treply to the email your invoice came from\n$/);
    const readme = await fs.readFile(path.join(outDir, "README.txt"), "utf8");
    assert.match(readme, /^Bakery <b>helper<\/b> & co, on a Muse Muse flash drive\r\n/);
    assert.match(readme, /To get a new one, reply to the email your invoice came from\./);
    // With an address to write to, every page and the launchers' table name it.
    const named = await build(model, { contact: "drives@example.com" });
    assert.match(await fs.readFile(path.join(named.outDir, "Start Here.html"), "utf8"), /Write to <a href="mailto:drives@example\.com">drives@example\.com<\/a> for a replacement/);
    assert.match(await fs.readFile(path.join(named.outDir, "README.txt"), "utf8"), /To get a new one, write to drives@example\.com\./);
    assert.match(await fs.readFile(path.join(named.outDir, "support/model.tsv"), "utf8"), /\ncontact\twrite to drives@example\.com\n$/);
    assert.match(readme, /Not made, reviewed or\r\nendorsed by Meta/);
    for (const rel of await listFiles(outDir)) {
      if (!/\.(html|txt|md|cmd|ps1|command|tsv|json)$/.test(rel) || rel.startsWith("licenses/USAGE")) continue;
      const text = await fs.readFile(path.join(outDir, rel), "utf8");
      assert.equal(text.includes(EM_DASH), false, `no em dash in ${rel}`);
      assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `nothing unfilled in ${rel}`);
    }
  });

  it("writes CHANGES.md as Apache 2.0 section 4(b) asks", () => {
    const text = changesText(imageModel(), RUNTIME_PIN);
    assert.match(text, /fine-tuned it with a LoRA adapter \(training job 8f1d2c3b-0000-4000-8000-000000000001\)/);
    assert.match(text, /merged into Meta's bf16 weights/);
    assert.match(text, /quantized to Q3_K_M, Q4_K_M, Q6_K with llama\.cpp/);
    assert.match(text, /release b11669 \(0\.7\.0\), unchanged/);
    assert.match(text, /wasn't made, reviewed or endorsed by Meta/);
  });

  it("ships a Derivative of Muse Spark Open with the Muse Model License and r30b's NOTICE, and says Built with Muse Spark Open", async () => {
    const { outDir, manifest } = await build({ ...imageModel(), sparkOpen: true });
    const read = (rel: string) => fs.readFile(path.join(outDir, rel), "utf8");
    for (const d of DERIVATIVE_DRIVE_FILES) {
      const f = DERIVATIVE_FILES.find((x) => x.path === d.from)!;
      assert.equal(await read(d.path), f.text, d.path);
      const source = manifest.sources.find((x) => x.path === d.path)!;
      assert.equal(source.sha256, f.sha256);
      assert.match(source.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/raw\/[0-9a-f]{40}\/(MUSE_MODEL_LICENSE\.md|NOTICE)$/, "the same bytes as the GGUF repo at the files' commit");
    }
    // The Usage Policy and Apache 2.0 already on every drive are r30b's own bytes too.
    for (const name of ["LICENSE", "USAGE_POLICY.md"]) {
      assert.ok(META_FILES.some((m) => m.sha256 === DERIVATIVE_FILES.find((f) => f.path === name)!.sha256), name);
    }
    const start = await read("Start Here.html");
    assert.match(start, /<\/p><p><strong>Built with Muse Spark Open\.<\/strong> For people 18 and over only\. Its answers are written by a model\. Never present them as written by a person\./);
    assert.match(await read("README.txt"), /^.+, on a Muse Muse flash drive\r\n\r\nBuilt with Muse Spark Open\. For people 18 and over only\./);
    const changes = await read("licenses/CHANGES.md");
    assert.match(changes, /fine-tuned it with 2026 knowledge as OfflineBase\/Glimmer-30B-2026-Knowledge/);
    assert.match(changes, /merged into OfflineBase\/Glimmer-30B-2026-Knowledge's bf16 weights/);
    assert.match(changes, /Built with Muse Spark Open\. Muse Spark Open wrote part of/);
    for (const rel of ["Start Here.html", "README.txt", "licenses/CHANGES.md"]) assert.ok(!(await read(rel)).includes(EM_DASH), rel);

    const plain = await build();
    const files = await listFiles(plain.outDir);
    assert.ok(!files.includes("licenses/MUSE_MODEL_LICENSE.md") && !files.includes("licenses/NOTICE"), "plain Glimmer files as before");
    assert.doesNotMatch(await fs.readFile(path.join(plain.outDir, "Start Here.html"), "utf8"), /Spark Open/);
  });

  it("gives the Windows files CRLF and plain ASCII, as cmd.exe needs", async () => {
    const { outDir } = await build();
    for (const rel of ["Start (Windows).cmd", "Verify (Windows).cmd", "support/start-windows.ps1", "support/verify-windows.ps1"]) {
      const text = await fs.readFile(path.join(outDir, rel), "utf8");
      assert.equal(/[^\x00-\x7f]/.test(text), false, `${rel} is ASCII`);
      assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, `${rel} has CRLF only`);
    }
  });

  it("writes PROVENANCE.json and SHA256SUMS over every file, which shasum checks", async () => {
    const model = smallModel();
    const { dir } = await stick(model);
    const sums = await fs.readFile(path.join(dir, "SHA256SUMS"), "utf8");
    const listed = sums.trim().split("\n").map((l) => l.slice(66));
    assert.deepEqual(listed, [...listed].sort(), "sorted by path");
    assert.deepEqual(listed.filter((p) => p !== "SHA256SUMS"), (await listFiles(dir)).filter((p) => p !== "SHA256SUMS"), "every file but itself");
    const provenance = JSON.parse(await fs.readFile(path.join(dir, "PROVENANCE.json"), "utf8"));
    assert.equal(provenance.serial, "MM-0A1B2C3D4E5F");
    assert.equal(provenance.runtime.build, TEST_PIN.build);
    assert.deepEqual(
      provenance.files.map((f: { path: string; source: string }) => [f.path, f.source]),
      model.files.map((f) => [modelPath(f), `https://huggingface.co/${model.repo}/resolve/${model.commit}/${f.name}`]),
    );
    if (darwin) {
      const check = spawnSync("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: dir, encoding: "utf8" });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      await fs.appendFile(path.join(dir, "model", model.files[1].name), "x");
      assert.notEqual(spawnSync("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: dir }).status, 0, "a changed file fails");
    }
  });

  it("unpacks the real archives' formats with the Mac's own tar", { skip: darwin ? false : "the bench's tar is bsdtar, on macOS" }, async () => {
    const src = await freshDir("src");
    await fs.writeFile(path.join(src, "libx.0.1.dylib"), "lib");
    await fs.symlink("libx.0.1.dylib", path.join(src, "libx.0.dylib"));
    const tgz = path.join(tmp, "a.tar.gz");
    const zip = path.join(tmp, "a.zip");
    assert.equal(spawnSync("/usr/bin/tar", ["-czf", tgz, "-C", src, "."]).status, 0);
    assert.equal(spawnSync("/usr/bin/tar", ["--format", "zip", "-cf", zip, "-C", src, "libx.0.1.dylib"]).status, 0);
    const a = await freshDir("a");
    await systemExtract(tgz, a);
    assert.equal((await fs.lstat(path.join(a, "libx.0.dylib"))).isSymbolicLink(), true, "symlinks come out as they are");
    const b = await freshDir("b");
    await systemExtract(zip, b);
    assert.equal(await fs.readFile(path.join(b, "libx.0.1.dylib"), "utf8"), "lib");
  });
});

describe("the launchers' build table", () => {
  const files = imageModel().files;
  const rows = () =>
    launcherTable(files)
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split("\t"));
  const row = (kind: string, memory: number, vram: number) => rows().find((r) => r[0] === kind && r[1] === String(memory) && r[2] === String(vram));

  it("is the device picker's verdict, as in the design's table", () => {
    const cases: Array<[string, number, number, string, string, string]> = [
      ["mac", 16, 0, "-", "macos-arm64", "-"],
      ["mac", 18, 0, "-", "macos-arm64", "-"],
      ["mac", 24, 0, "Q3_K_M", "macos-arm64", "gpu"],
      ["mac", 32, 0, "Q4_K_M", "macos-arm64", "gpu"],
      ["mac", 36, 0, "Q4_K_M", "macos-arm64", "gpu"],
      ["mac", 48, 0, "Q6_K", "macos-arm64", "gpu"],
      ["mac", 128, 0, "Q6_K", "macos-arm64", "gpu"],
      ["pc", 16, 32, "Q6_K", "windows-x64-vulkan", "gpu"],
      ["pc", 16, 24, "Q4_K_M", "windows-x64-vulkan", "gpu"],
      ["pc", 16, 16, "Q3_K_M", "windows-x64-vulkan", "gpu"],
      ["pc", 32, 12, "Q3_K_M", "windows-x64-vulkan", "split"],
      ["pc", 16, 12, "-", "-", "-"],
      ["pc", 32, 0, "Q4_K_M", "windows-x64-cpu", "cpu"],
      ["pc", 64, 8, "Q4_K_M", "windows-x64-cpu", "cpu"],
      ["pc", 24, 8, "-", "-", "-"],
    ];
    for (const [kind, memory, vram, level, runtime, where] of cases) {
      const r = row(kind, memory, vram);
      assert.ok(r, `${kind} ${memory} ${vram}`);
      assert.deepEqual([r[3], r[4], r[6]], [level, runtime, where], `${kind} ${memory} GB, ${vram} GB card`);
    }
    assert.equal(row("mac", 24, 0)![5], "tight", "a 24 GB Mac runs it with other apps closed");
    assert.equal(row("mac", 48, 0)![5], "well");
  });

  it("follows what is on the drive: one build fits fewer machines", () => {
    const only = launcherTable(files.filter((f) => f.level === "Q6_K")).split("\n").map((l) => l.split("\t"));
    assert.equal(only.find((r) => r[0] === "mac" && r[1] === "32")?.[3], "-");
    assert.equal(only.find((r) => r[0] === "mac" && r[1] === "48")?.[3], "Q6_K");
    assert.equal(buildForText(launcherTable(files), "Q6_K"), "a Mac with 48 GB or more; a PC with a graphics card of 32 GB or more");
  });
});

describe("the Mac launcher", { skip: darwin ? false : "it runs on macOS" }, () => {
  let drive: string;
  let shims: string;
  const model = imageModel();
  const q = (level: string) => model.files.find((f) => f.level === level)!.name;

  before(async () => {
    tmp ??= await fs.mkdtemp(path.join(os.tmpdir(), "drive-image-"));
    drive = (await stick(model)).dir;
    // A stand-in for llama-server that records how it was started and stays up until the chat opened.
    await fs.writeFile(
      path.join(drive, "runtime/macos-arm64/llama-server"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$MM_TEST_DIR/server-args"\ntouch "$MM_TEST_DIR/server-up"\ni=0\nwhile [ ! -f "$MM_TEST_DIR/opened" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\nexit 0\n',
      { mode: 0o755 },
    );
    shims = await freshDir("shims");
    const shim = (name: string, body: string) => fs.writeFile(path.join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await shim("sysctl", 'case "$2" in hw.optional.arm64) echo "$MM_ARM64";; hw.memsize) echo "$MM_MEMSIZE";; machdep.cpu.brand_string) echo "Apple M4 Max";; esac');
    await shim("df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk3s1 999999999 1 %s 1%% /\\n" "$MM_FREE_KB"');
    await shim("nc", "exit 1");
    await shim("curl", 'echo "$@" >> "$MM_TEST_DIR/curl.log"\n[ -f "$MM_TEST_DIR/server-up" ]');
    await shim("open", 'echo "$@" >> "$MM_TEST_DIR/open.log"\ntouch "$MM_TEST_DIR/opened"');
    for (const name of ["wget", "git", "pip", "brew", "python3", "ollama"]) await shim(name, `echo "$0 was called" >> "$MM_TEST_DIR/downloaders.log"; exit 1`);
  });

  async function launch(opts: { memGb?: number; arm64?: string; answers?: string; freeKb?: number; home?: string } = {}) {
    const dir = await freshDir("run");
    const home = opts.home ?? (await freshDir("home"));
    const res = spawnSync("/bin/bash", [path.join(drive, "Start (Mac).command")], {
      input: opts.answers ?? "n\n",
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        MM_TEST_DIR: dir,
        MM_ARM64: opts.arm64 ?? "1",
        MM_MEMSIZE: String((opts.memGb ?? 36) * 1073741824),
        MM_FREE_KB: String(opts.freeKb ?? 500_000_000),
      } as unknown as NodeJS.ProcessEnv,
    });
    const read = (name: string) => fs.readFile(path.join(dir, name), "utf8").catch(() => "");
    return { res, home, args: (await read("server-args")).trim().split("\n").filter(Boolean), curl: await read("curl.log"), open: await read("open.log"), downloaders: await read("downloaders.log") };
  }

  const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("picks the build for each memory size and starts the server on 127.0.0.1, offline", async () => {
    for (const [memGb, level] of [
      [24, "Q3_K_M"],
      [36, "Q4_K_M"],
      [64, "Q6_K"],
    ] as const) {
      const run = await launch({ memGb });
      assert.equal(run.res.status, 0, run.res.stdout + run.res.stderr);
      assert.equal(argAfter(run.args, "-m"), path.join(drive, "model", q(level)), `${memGb} GB`);
      assert.equal(argAfter(run.args, "--host"), "127.0.0.1");
      assert.equal(argAfter(run.args, "--port"), "9931");
      assert.equal(argAfter(run.args, "-c"), "8192");
      for (const flag of ["--offline", "--jinja", "--no-mmproj"]) assert.ok(run.args.includes(flag), flag);
      assert.equal(argAfter(run.args, "--ui-config-file"), path.join(drive, "model/ui-config.json"));
      assert.equal(run.open.trim(), "http://127.0.0.1:9931/");
      for (const line of run.curl.trim().split("\n")) assert.match(line, /^-fs --max-time 2 http:\/\/127\.0\.0\.1:9931\/health$/);
      assert.equal(run.downloaders, "", "nothing downloads");
      if (memGb === 24) assert.match(run.res.stdout, /if you close other apps first/);
    }
  });

  it("refuses an Intel Mac, and starts nothing on one too small unless asked", async () => {
    const intel = await launch({ arm64: "0" });
    assert.equal(intel.res.status, 1);
    assert.match(intel.res.stdout, /This Mac has an Intel chip/);
    assert.deepEqual(intel.args, []);

    const small = await launch({ memGb: 16 });
    assert.equal(small.res.status, 0);
    assert.match(small.res.stdout, /needs a Mac with 24 GB of memory or more, and this one has 16 GB/);
    assert.match(small.res.stdout, /Try it live instead, on its page: https:\/\/muse-muse\.vercel\.app\/fine-tuning\/8f1d2c3b-0000-4000-8000-000000000001/, "the page to go to, not just a name");
    assert.deepEqual(small.args, [], "nothing started");

    const anyway = await launch({ memGb: 16, answers: "y\nn\n" });
    assert.equal(argAfter(anyway.args, "-m"), path.join(drive, "model", q("Q3_K_M")), "the smallest, when asked");
  });

  it("copies the build to this Mac when asked, checks it, and runs the copy from then on", async () => {
    const first = await launch({ memGb: 36, answers: "\n" });
    const copy = path.join(first.home, "Muse Muse", "bakery-helper");
    assert.equal(argAfter(first.args, "-m"), path.join(copy, "model", q("Q4_K_M")));
    assert.equal(first.args[0], "-m");
    assert.equal(await sha256File(path.join(copy, "model", q("Q4_K_M"))), model.files[1].sha256);
    assert.equal(await fs.readFile(path.join(copy, "model", `${q("Q4_K_M")}.verified`), "utf8"), model.files[1].sha256);
    assert.ok((await fs.stat(path.join(copy, "runtime/macos-arm64/llama-server"))).isFile());
    assert.match(first.res.stdout, /The copy matches/);
    // It says how long the quiet copy takes, the size rounded as Windows shows it, and that the server's log scrolls by.
    assert.match(first.res.stdout, /Copying 17 GB to .*This takes about \d+ minutes, and nothing shows here until it's done\./);
    assert.match(first.res.stdout, /The server's messages scroll by below while it loads/);

    const again = await launch({ memGb: 36, answers: "", home: first.home });
    assert.match(again.res.stdout, /Using the copy on this Mac/);
    assert.equal(argAfter(again.args, "-m"), path.join(copy, "model", q("Q4_K_M")));
  });

  it("runs from the drive when the disk is too full or the copy doesn't match", async () => {
    const full = await launch({ memGb: 36, answers: "y\n", freeKb: 1000 });
    assert.match(full.res.stdout, /There isn't room to copy it/);
    assert.equal(argAfter(full.args, "-m"), path.join(drive, "model", q("Q4_K_M")));

    const sumsPath = path.join(drive, "SHA256SUMS");
    const sums = await fs.readFile(sumsPath, "utf8");
    await fs.writeFile(sumsPath, sums.replace(model.files[1].sha256, "0".repeat(64)));
    try {
      const bad = await launch({ memGb: 36, answers: "y\n" });
      assert.match(bad.res.stdout, /didn't match its checksum, so it was deleted/);
      assert.equal(argAfter(bad.args, "-m"), path.join(drive, "model", q("Q4_K_M")));
      await assert.rejects(fs.stat(path.join(bad.home, "Muse Muse/bakery-helper/model", q("Q4_K_M"))));
    } finally {
      await fs.writeFile(sumsPath, sums);
    }
  });
});

describe("the Windows launchers, read", () => {
  const read = (rel: string) => fs.readFile(path.join(DRIVE_SOURCE_DIR, rel), "utf8");

  it("start the server on 127.0.0.1, offline, and reach nothing but it", async () => {
    const ps = await read("support/start-windows.ps1");
    assert.match(ps, /'--host', '127\.0\.0\.1'/);
    assert.match(ps, /'--offline'/);
    assert.match(ps, /'--ui-config-file'/);
    for (const text of [ps, await read("support/verify-windows.ps1"), await read("Start (Windows).cmd"), await read("Verify (Windows).cmd")]) {
      for (const url of text.match(/https?:\/\/[^\s'"`)]+/g) ?? []) assert.match(url, /^http:\/\/127\.0\.0\.1:\$port(\/|$)/, url);
      assert.doesNotMatch(text, /Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|Unblock-File|DownloadFile|Start-BitsTransfer|winget|Invoke-RestMethod/);
    }
    assert.match(ps, /VerifiedAndReputablePolicyState/, "Smart App Control is checked first");
    assert.match(ps, /aren't supported yet/);
    assert.match(ps, /HardwareInformation\.qwMemorySize/, "card memory over 4 GB, which AdapterRAM can't say");
  });

  it("read the same table and files the Mac launcher reads", async () => {
    const ps = await read("support/start-windows.ps1");
    for (const name of ["builds.tsv", "files.tsv", "model.tsv", "SHA256SUMS", "ui-config.json"]) assert.ok(ps.includes(name), name);
    const cmd = await read("Start (Windows).cmd");
    assert.match(cmd, /-ExecutionPolicy Bypass -File "%~dp0support\\start-windows\.ps1"/, "for this one script, this one time");
    assert.match(cmd, /ARM64/);
  });
});
