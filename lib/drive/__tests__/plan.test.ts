/**
 * The drive plan (lib/drive/plan.ts): the bench's image comes out byte for byte as it did before drive export split
 * image.ts (golden/bench-image.json), and a board's export plan has the same layout plus the adapter, Qwen's license and
 * notice, PROVENANCE.json and SHA256SUMS. muse-device/fixtures/plan-small.json is the golden plan the board's own tests
 * write onto a fake drive; this test keeps it current:
 *
 *   npx tsx --test lib/drive/__tests__/plan.test.ts
 *   WRITE_FIXTURES=1 npx tsx --test lib/drive/__tests__/plan.test.ts   (rewrites the fixture, on purpose)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { collectKit, listFiles, sha256File, type DriveKit } from "../kit";
import { QWEN_BASE } from "../layout";
import {
  adapterBlocks,
  boardModel,
  boardTuned,
  exportPlan,
  labModel,
  MAX_PLAN_CALL_BYTES,
  planDriveImage,
  readDriveTemplates,
  urlModel,
  writePlan,
  type BoardSource,
  type DrivePlan,
  type DriveTemplates,
} from "../plan";
import { BENCH_CASES, benchSnapshot } from "./capture-bench-golden";
import { fakeExtract, fakeFetch, sha, TEST_META, TEST_PIN } from "./fixtures";

const EM_DASH = String.fromCharCode(0x2014);
const darwin = process.platform === "darwin";
const FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "muse-device", "fixtures", "plan-small.json");
const QWEN_LICENSE = "                                 Apache License\n   Copyright 2026 Alibaba Cloud\n";
const TEST_QWEN = [{ path: "licenses/Apache-2.0.txt", url: "https://hub.test/qwen/LICENSE", sha256: sha(QWEN_LICENSE) }];

let tmp: string;
let kit: DriveKit;
let kitFile: (sha256: string) => string;
let templates: DriveTemplates;

/** Small stand-ins for a board's files: a base build and an adapter, both starting GGUF as real ones do. */
const BASE_BYTES = Buffer.from("GGUF base Q4_K_M ".repeat(40));
const ADAPTER_BYTES = Buffer.from("GGUF adapter f32 ".repeat(12));

export function boardSource(over: Partial<BoardSource> = {}): BoardSource {
  return {
    run: "support-coach",
    adapter: { name: "support-coach.gguf", bytes: ADAPTER_BYTES.length, sha256: sha(ADAPTER_BYTES) },
    bases: [{ name: "Qwen3.5-0.8B-Q4_K_M.gguf", level: "Q4_K_M", bytes: BASE_BYTES.length, sha256: sha(BASE_BYTES), source: { url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf" } }],
    config: { base: "Qwen3.5-0.8B", dataset: "support-coach", steps: 60, rank: 8, lr: 0.0002, max_length: 512 },
    status: { examples: 49, skipped: 0, loss: 0.41, seconds: 812, peak_gpu_gib: 1.91 },
    base_revision: QWEN_BASE.revision,
    system: "You are the support coach.",
    converter: "llama.cpp b11970 convert_lora_to_gguf.py, f32",
    board: { model: "NVIDIA Jetson Orin Nano Developer Kit", muse_device: "0.4.0" },
    ...over,
  };
}

const FACTS = {
  exportId: "exp_2c41e0f9a8b3",
  madeAt: new Date("2026-11-01T18:04:11Z"),
  source: "board:support-coach",
  madeBy: { board: "NVIDIA Jetson Orin Nano Developer Kit", museDevice: "0.4.0" },
};

function boardPlan(src = boardSource()): DrivePlan {
  return exportPlan(boardModel(src, TEST_PIN), kit, templates, { ...FACTS, tuned: boardTuned(src) });
}

async function freshDir(name: string): Promise<string> {
  const dir = path.join(tmp, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** A plan written into a folder, with the board's files from a fake ~/models. */
async function written(plan: DrivePlan): Promise<string> {
  const models = await freshDir("models");
  await fs.writeFile(path.join(models, "Qwen3.5-0.8B-Q4_K_M.gguf"), BASE_BYTES);
  await fs.writeFile(path.join(models, "support-coach.gguf"), ADAPTER_BYTES);
  const dir = await freshDir("drive");
  await writePlan(plan.files, dir, { kitFile, boardFile: (name) => path.join(models, name) });
  return dir;
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-plan-"));
  const collected = await collectKit({
    cacheDir: path.join(tmp, "cache"),
    fetchImpl: fakeFetch({ [TEST_QWEN[0].url]: QWEN_LICENSE }),
    extract: fakeExtract,
    pin: TEST_PIN,
    metaFiles: TEST_META,
    qwenFiles: TEST_QWEN,
    families: ["glimmer", "qwen"],
  });
  kit = { ...collected.kit, baseUrl: "https://kit.test/drive-kit/" };
  kitFile = collected.fileOf;
  templates = await readDriveTemplates();
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("the bench's image, after the split", () => {
  it("is byte for byte what bench drives were before it", async () => {
    const golden = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "golden", "bench-image.json"), "utf8"));
    for (const [name, c] of Object.entries(BENCH_CASES)) {
      const got = await benchSnapshot(c.model(), c.contact, name === "small");
      assert.deepEqual(got.files, golden[name].files, `${name}: the files, their sha256 and which ones run`);
      assert.deepEqual(got.sources, golden[name].sources, `${name}: the sources`);
      assert.equal(got.manifestSha256, golden[name].manifestSha256, `${name}: SHA256SUMS`);
    }
  });

  it("loses its launchers' adapter blocks whole, and an adapter drive keeps what is inside them", () => {
    const text = "a\n# >>> adapter\nb\n  # <<< adapter\nc\n";
    assert.equal(adapterBlocks(text, false), "a\nc\n");
    assert.equal(adapterBlocks(text, true), "a\nb\nc\n");
    assert.throws(() => adapterBlocks("# >>> adapter\nb\n", false), /isn't closed/);
    for (const name of ["Start (Mac).command", "support/start-windows.ps1"] as const) {
      assert.ok((templates[name].match(/# >>> adapter/g)?.length ?? 0) >= 2, `${name} has its blocks`);
      assert.doesNotMatch(adapterBlocks(templates[name], false), /\$adapter|--lora|# (>>>|<<<)/i, `${name} without an adapter`);
      assert.match(adapterBlocks(templates[name], true), /--lora/);
    }
  });
});

describe("a board's export plan", () => {
  it("has the bench's layout, plus the adapter, Qwen's license and the two manifests", async () => {
    const plan = boardPlan();
    assert.equal(plan.format, "muse-drive-plan/1");
    assert.equal(plan.folder, "MuseMuse/support-coach-2c41");
    assert.equal(plan.needsLargeFiles, false);
    const paths = plan.files.map((f) => f.path);
    for (const p of ["Start Here.html", "README.txt", "Start (Mac).command", "Verify (Windows).cmd", "support/builds.tsv", "support/model.tsv", "runtime/macos-arm64/llama-server", "licenses/llama.cpp-LICENSE.txt", "licenses/CHANGES.md", "MODEL_CARD.md"]) {
      assert.ok(paths.includes(p), p);
    }
    assert.deepEqual(paths.slice(-4), ["model/Qwen3.5-0.8B-Q4_K_M.gguf", "model/support-coach.gguf", "PROVENANCE.json", "SHA256SUMS"], "the models, then the manifests last");
    assert.ok(!paths.includes("licenses/USAGE_POLICY.md"), "Meta's Usage Policy isn't on a Qwen drive");
    const license = plan.files.find((f) => f.path === "licenses/Apache-2.0.txt")!;
    assert.equal(license.sha256, sha(QWEN_LICENSE), "Qwen's license, not Meta's");
    assert.deepEqual(plan.files.find((f) => f.path === "model/support-coach.gguf"), { path: "model/support-coach.gguf", bytes: ADAPTER_BYTES.length, sha256: sha(ADAPTER_BYTES), board: "support-coach.gguf" });
    assert.ok(plan.files.filter((f) => "kit" in f).length > 10, "the runtime comes from the kit by sha256");
    assert.ok(Buffer.byteLength(JSON.stringify({ plan })) < MAX_PLAN_CALL_BYTES / 4, "far under the board's body limit");
  });

  it("says who made it and whose model it is, with no order's words and no em dash", async () => {
    const plan = boardPlan();
    const text = (p: string) => (plan.files.find((f) => f.path === p) as { text: string }).text;
    const readme = text("README.txt");
    assert.match(readme, /Fine-tuned from Qwen3\.5-0\.8B \(Apache 2\.0\) on a Jetson\. Not made, reviewed or\r\nendorsed by its makers/);
    assert.match(readme, /To get a new one, ask whoever gave you this drive\./);
    assert.match(readme, /Muse Muse, which\r\nmade it, is at https:\/\/muse-muse\.vercel\.app/);
    assert.doesNotMatch(readme, /Meta|invoice/);
    const html = text("Start Here.html");
    assert.match(html, /Not made, reviewed or endorsed by its makers/);
    assert.match(html, /the adapter <span class="file">model\/support-coach\.gguf<\/span> on top/);
    assert.doesNotMatch(html, /Meta|invoice|refund|Hugging Face page/);
    assert.match(text("support/model.tsv"), /\npage\thttps:\/\/muse-muse\.vercel\.app\ncontact\task whoever gave you this drive\nadapter\tsupport-coach\.gguf\n$/);
    const changes = text("licenses/CHANGES.md");
    assert.match(changes, /modified version of Qwen3\.5-0\.8B/);
    assert.match(changes, /run support-coach: 60 steps, rank 8/);
    assert.match(text("MODEL_CARD.md"), /Final loss 0\.41, after 812 seconds/);
    for (const f of plan.files) {
      if ("text" in f) assert.equal(f.text.includes(EM_DASH), false, `no em dash in ${f.path}`);
    }
  });

  it("writes PROVENANCE.json with where it was tuned, and no URL with a query", () => {
    const signed = boardSource({ bases: [{ ...boardSource().bases[0], source: { url: "https://cdn.test/base.gguf?X-Amz-Signature=secret" } }] });
    const plan = boardPlan(signed);
    const provenance = JSON.parse((plan.files.find((f) => f.path === "PROVENANCE.json") as { text: string }).text);
    assert.equal(provenance.export, "exp_2c41e0f9a8b3");
    assert.deepEqual(provenance.madeBy, FACTS.madeBy);
    assert.equal(provenance.tuned.where, "board");
    assert.equal(provenance.tuned.baseRevision, QWEN_BASE.revision);
    assert.equal(provenance.tuned.loss, 0.41);
    assert.deepEqual(provenance.files.map((f: { path: string }) => f.path), ["model/Qwen3.5-0.8B-Q4_K_M.gguf", "model/support-coach.gguf"]);
    assert.match(provenance.files[0].source, /^board: ~\/models\/Qwen3\.5-0\.8B-Q4_K_M\.gguf, downloaded from https:\/\/cdn\.test\/base\.gguf$/);
    assert.doesNotMatch(JSON.stringify(plan), /secret|X-Amz/);
    const byHand = boardPlan(boardSource({ bases: [{ ...boardSource().bases[0], source: null }] }));
    assert.match((byHand.files.find((f) => f.path === "PROVENANCE.json") as { text: string }).text, /installed by hand/);
  });

  it("refuses a base whose license the kit doesn't have, and a board with no base build", () => {
    assert.throws(() => boardModel(boardSource({ config: { ...boardSource().config, base: "SomeModel-1B" } }), TEST_PIN), /only has licenses for Qwen3\.5-0\.8B/);
    assert.throws(() => boardModel(boardSource({ bases: [] }), TEST_PIN), /no GGUF of Qwen3\.5-0\.8B/);
    assert.throws(() => boardModel(boardSource(), TEST_PIN, "Q8_0"), /no Q8_0 build/);
  });

  it("written into a folder, lists every file in SHA256SUMS, which shasum checks", async () => {
    const plan = boardPlan();
    const dir = await written(plan);
    assert.deepEqual(await listFiles(dir), plan.files.map((f) => f.path).sort());
    for (const f of plan.files) assert.equal(await sha256File(path.join(dir, f.path)), f.sha256, f.path);
    const sums = await fs.readFile(path.join(dir, "SHA256SUMS"), "utf8");
    assert.deepEqual(sums.trim().split("\n").map((l) => l.slice(66)), plan.files.map((f) => f.path).filter((p) => p !== "SHA256SUMS").sort());
    if (darwin) {
      const check = spawnSync("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: dir, encoding: "utf8" });
      assert.equal(check.status, 0, check.stdout + check.stderr);
    }
  });

  it("refuses a board file that changed since export_source hashed it", async () => {
    const plan = boardPlan(boardSource({ adapter: { name: "support-coach.gguf", bytes: ADAPTER_BYTES.length, sha256: "0".repeat(64) } }));
    await assert.rejects(written(plan), /didn't match its sha256/);
  });

  it("keeps the golden plan the board's tests write in muse-device/fixtures current", async () => {
    const plan = boardPlan();
    const fixture = {
      note: "Written by lib/drive/__tests__/plan.test.ts (WRITE_FIXTURES=1). muse-device/test_drive.py writes this plan onto a fake drive.",
      plan,
      kit: Object.fromEntries(await Promise.all(plan.files.filter((f) => "kit" in f).map(async (f) => [f.sha256, (await fs.readFile(kitFile(f.sha256))).toString("base64")]))),
      board: { "Qwen3.5-0.8B-Q4_K_M.gguf": BASE_BYTES.toString("base64"), "support-coach.gguf": ADAPTER_BYTES.toString("base64") },
      manifestSha256: createHash("sha256").update((plan.files.at(-1) as { text: string }).text).digest("hex"),
    };
    const text = `${JSON.stringify(fixture, null, 1)}\n`;
    if (process.env.WRITE_FIXTURES) {
      await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
      await fs.writeFile(FIXTURE, text);
    }
    assert.equal(await fs.readFile(FIXTURE, "utf8"), text, "muse-device/fixtures/plan-small.json is stale: rerun with WRITE_FIXTURES=1");
  });
});

describe("the launchers on a board's drive", () => {
  it("the Mac launcher loads the adapter on the base build, and copies it with the build", { skip: darwin ? false : "it runs on macOS" }, async () => {
    const drive = await written(boardPlan());
    await fs.writeFile(
      path.join(drive, "runtime/macos-arm64/llama-server"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$MM_TEST_DIR/server-args"\ntouch "$MM_TEST_DIR/server-up"\ni=0\nwhile [ ! -f "$MM_TEST_DIR/opened" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\nexit 0\n',
      { mode: 0o755 },
    );
    const shims = await freshDir("shims");
    const shim = (name: string, body: string) => fs.writeFile(path.join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await shim("sysctl", 'case "$2" in hw.optional.arm64) echo 1;; hw.memsize) echo 17179869184;; machdep.cpu.brand_string) echo "Apple M4";; esac');
    await shim("df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk3s1 999999999 1 500000000 1%% /\\n"');
    await shim("nc", "exit 1");
    await shim("curl", '[ -f "$MM_TEST_DIR/server-up" ]');
    await shim("open", 'touch "$MM_TEST_DIR/opened"');
    const launch = async (answers: string) => {
      const dir = await freshDir("run");
      const home = await freshDir("home");
      const res = spawnSync("/bin/bash", [path.join(drive, "Start (Mac).command")], {
        input: answers,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, MM_TEST_DIR: dir } as unknown as NodeJS.ProcessEnv,
      });
      const args = (await fs.readFile(path.join(dir, "server-args"), "utf8").catch(() => "")).trim().split("\n");
      return { res, home, args, after: (flag: string) => args[args.indexOf(flag) + 1] };
    };

    const fromDrive = await launch("n\n");
    assert.equal(fromDrive.res.status, 0, fromDrive.res.stdout + fromDrive.res.stderr);
    assert.equal(fromDrive.after("-m"), path.join(drive, "model/Qwen3.5-0.8B-Q4_K_M.gguf"));
    assert.equal(fromDrive.after("--lora"), path.join(drive, "model/support-coach.gguf"));

    const copied = await launch("\n");
    assert.equal(copied.res.status, 0, copied.res.stdout + copied.res.stderr);
    const copy = path.join(copied.home, "Muse Muse", "support-coach");
    assert.equal(copied.after("-m"), path.join(copy, "model/Qwen3.5-0.8B-Q4_K_M.gguf"));
    assert.equal(copied.after("--lora"), path.join(copy, "model/support-coach.gguf"), "the copy's adapter");
    assert.equal(await sha256File(path.join(copy, "model/support-coach.gguf")), sha(ADAPTER_BYTES));

    // An adapter missing from the drive stops it with a plain sentence, before anything starts.
    await fs.rm(path.join(drive, "model/support-coach.gguf"));
    const missing = await launch("n\n");
    assert.match(missing.res.stdout, /The adapter support-coach\.gguf is missing from this drive/);
    assert.deepEqual(missing.args, [""]);
  });

  it("the Windows launcher, read, does the same", () => {
    const ps = (boardPlan().files.find((f) => f.path === "support/start-windows.ps1") as { text: string }).text;
    assert.match(ps, /\$adapter = \$model\['adapter'\]/);
    assert.match(ps, /\$list \+= @\('--lora', "`"\$lora`""\)/);
    assert.match(ps, /Copy-Item -LiteralPath \(Join-Path \$Drive "model\\\$adapter"\) -Destination \$adapterCopy/);
    assert.equal(/[^\x00-\x7f]/.test(ps), false, "ASCII");
    assert.equal(ps.replace(/\r\n/g, "").includes("\n"), false, "CRLF only");
  });
});

describe("a lab model's export plan, and the owner's own file", () => {
  const labSource = () => ({
    title: "Bakery helper",
    slug: "bakery-helper",
    systemLine: "You are the bakery helper.\n\nReasoning strength: low.",
    adapterJobId: "8f1d2c3b-0000-4000-8000-000000000001",
    quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
    repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
    commit: "c0ffee".padEnd(40, "0"),
    public: true,
    files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "a".repeat(64) }],
    card: "# Bakery helper GGUF\n",
    tuned: null,
  });
  const lab = () => labModel(labSource(), TEST_PIN);

  it("carries Meta's license and Usage Policy, the file by URL, and needs exFAT for a 17 GB file", () => {
    const plan = exportPlan(lab(), kit, templates, { ...FACTS, source: "lab:8f1d2c3b-0000-4000-8000-000000000001:Q4_K_M", tuned: { where: "cloud" } });
    assert.equal(plan.needsLargeFiles, true);
    const paths = plan.files.map((f) => f.path);
    assert.ok(paths.includes("licenses/USAGE_POLICY.md"));
    assert.equal(plan.files.find((f) => f.path === "licenses/Apache-2.0.txt")!.sha256, TEST_META[0].sha256, "Meta's license, not Qwen's");
    assert.deepEqual(plan.files.find((f) => f.path.endsWith("Q4_K_M.gguf")), { path: "model/muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "a".repeat(64), url: true });
    const html = (plan.files.find((f) => f.path === "Start Here.html") as { text: string }).text;
    assert.match(html, /Not made, reviewed or endorsed by Meta/);
    assert.match(html, /free on <a href="https:\/\/huggingface\.co\/musemuse\//);
    assert.doesNotMatch(html, /invoice|refund/);
    const provenance = JSON.parse((plan.files.find((f) => f.path === "PROVENANCE.json") as { text: string }).text);
    assert.match(provenance.files[0].source, /^https:\/\/huggingface\.co\/musemuse\/.+\/resolve\/c0ffee0+\/muse-glimmer-30b-bakery-helper-Q4_K_M\.gguf$/);
  });

  it("names the owner's private file without its URL", () => {
    const model = urlModel(
      {
        title: "Glimmer stage 2",
        slug: "glimmer-stage2",
        systemLine: "You are Muse Glimmer.",
        file: { level: "IQ1_S", name: "glimmer-stage2-IQ1_S.gguf", bytes: 6_526_418_880, sha256: "23fef56a3bb9c7f3f2e513044cf11c88bf2d3cb3adfbc727c49288cea4fbafb4" },
        changes: ["Muse Muse fine-tuned it in two stages of LoRA training on 2026 knowledge.", "It was merged, converted to GGUF and quantized to IQ1_S with llama.cpp."],
      },
      TEST_PIN,
    );
    const plan = exportPlan(model, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } });
    assert.equal(plan.needsLargeFiles, true);
    const provenance = JSON.parse((plan.files.find((f) => f.path === "PROVENANCE.json") as { text: string }).text);
    assert.equal(provenance.files[0].source, "the owner's private copy");
    const table = (plan.files.find((f) => f.path === "support/builds.tsv") as { text: string }).text;
    assert.match(table, /\nmac\t16\t0\tIQ1_S\t/, "any level name goes in the launchers' table");
  });

  it("escapes a build's level in Start Here", () => {
    const model = labModel({ ...labSource(), files: [{ level: "Q4&<K>", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "a".repeat(64) }] }, TEST_PIN);
    const html = (exportPlan(model, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } }).files.find((f) => f.path === "Start Here.html") as { text: string }).text;
    assert.match(html, /<td>Q4&amp;&lt;K&gt;<\/td>/);
    assert.doesNotMatch(html, /<td>Q4&<K>/);
  });

  it("puts only the image's own files in a plain image plan", () => {
    const image = planDriveImage(lab(), kit, templates);
    assert.ok(!image.files.some((f) => f.path.startsWith("model/") && f.path.endsWith(".gguf")));
    assert.ok(!image.files.some((f) => f.path === "SHA256SUMS" || f.path === "PROVENANCE.json"));
  });
});
