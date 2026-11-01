/**
 * The drive plan (lib/drive/plan.ts): the bench's image comes out byte for byte as it did before drive export split
 * image.ts (golden/bench-image.json), and a board's export plan has the same layout plus the adapter, the Llama license and
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
import { DERIVATIVE_DRIVE_FILES, LLAMA_BOARD_BASE } from "../layout";
import { USAGE_POINTS } from "@/lib/train/base";
import { builtWithBlock } from "@/lib/train/hub-cards";
import { DERIVATIVE_FILES } from "@/lib/train/licenses";
import {
  adapterBlocks,
  boardModel,
  boardTuned,
  exportPlan,
  inlineSparkDerivative,
  labModel,
  MAX_PLAN_CALL_BYTES,
  planDriveImage,
  readDriveTemplates,
  urlModel,
  writePlan,
  BUILT_WITH,
  SPARK_DERIVATIVE_FILES,
  type InlineSparkDerivative,
  type LinkedSparkDerivative,
  type UrlSource,
  type BoardSource,
  type DrivePlan,
  type DriveTemplates,
} from "../plan";
import { BENCH_CASES, benchSnapshot } from "./capture-bench-golden";
import { fakeExtract, fakeFetch, sha, TEST_META, TEST_PIN } from "./fixtures";

const EM_DASH = String.fromCharCode(0x2014);
const darwin = process.platform === "darwin";
const FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "muse-device", "fixtures", "plan-small.json");
const LLAMA_LICENSE = "LLAMA 3.2 COMMUNITY LICENSE AGREEMENT\n";
const TEST_LLAMA = [{ path: "licenses/LLAMA_3.2_LICENSE.txt", url: "https://hub.test/llama/LICENSE", sha256: sha(LLAMA_LICENSE) }];

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
    bases: [{ name: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", level: "Q4_K_M", bytes: BASE_BYTES.length, sha256: sha(BASE_BYTES), source: { url: "https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf" } }],
    config: { base: "Llama-3.2-1B-Instruct", dataset: "support-coach", steps: 60, rank: 8, lr: 0.0002, max_length: 512 },
    status: { examples: 49, skipped: 0, loss: 0.41, seconds: 812, peak_gpu_gib: 1.91 },
    base_revision: LLAMA_BOARD_BASE.revision,
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
  await fs.writeFile(path.join(models, "Llama-3.2-1B-Instruct-Q4_K_M.gguf"), BASE_BYTES);
  await fs.writeFile(path.join(models, "support-coach.gguf"), ADAPTER_BYTES);
  const dir = await freshDir("drive");
  await writePlan(plan.files, dir, { kitFile, boardFile: (name) => path.join(models, name) });
  return dir;
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-plan-"));
  const collected = await collectKit({
    cacheDir: path.join(tmp, "cache"),
    fetchImpl: fakeFetch({ [TEST_LLAMA[0].url]: LLAMA_LICENSE }),
    extract: fakeExtract,
    pin: TEST_PIN,
    metaFiles: TEST_META,
    llamaFiles: TEST_LLAMA,
    families: ["glimmer", "llama"],
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
  it("has the bench's layout, plus the adapter, the Llama license and the two manifests", async () => {
    const plan = boardPlan();
    assert.equal(plan.format, "muse-drive-plan/1");
    assert.equal(plan.folder, "MuseMuse/support-coach-2c41");
    assert.equal(plan.needsLargeFiles, false);
    const paths = plan.files.map((f) => f.path);
    for (const p of ["Start Here.html", "README.txt", "Start (Mac).command", "Verify (Windows).cmd", "support/builds.tsv", "support/model.tsv", "runtime/macos-arm64/llama-server", "licenses/llama.cpp-LICENSE.txt", "licenses/CHANGES.md", "MODEL_CARD.md"]) {
      assert.ok(paths.includes(p), p);
    }
    assert.deepEqual(paths.slice(-4), ["model/Llama-3.2-1B-Instruct-Q4_K_M.gguf", "model/support-coach.gguf", "PROVENANCE.json", "SHA256SUMS"], "the models, then the manifests last");
    assert.ok(!paths.includes("licenses/USAGE_POLICY.md"), "Muse Glimmer's Usage Policy isn't on a Llama drive");
    const license = plan.files.find((f) => f.path === "licenses/LLAMA_3.2_LICENSE.txt")!;
    assert.ok(!paths.includes("licenses/Apache-2.0.txt"), "not Muse Glimmer's license");
    assert.equal(license.sha256, sha(LLAMA_LICENSE), "the Llama license, not Meta's");
    assert.deepEqual(plan.files.find((f) => f.path === "model/support-coach.gguf"), { path: "model/support-coach.gguf", bytes: ADAPTER_BYTES.length, sha256: sha(ADAPTER_BYTES), board: "support-coach.gguf" });
    assert.ok(plan.files.filter((f) => "kit" in f).length > 10, "the runtime comes from the kit by sha256");
    assert.ok(Buffer.byteLength(JSON.stringify({ plan })) < MAX_PLAN_CALL_BYTES / 4, "far under the board's body limit");
  });

  it("says who made it and whose model it is, with no order's words and no em dash", async () => {
    const plan = boardPlan();
    const text = (p: string) => (plan.files.find((f) => f.path === p) as { text: string }).text;
    const readme = text("README.txt");
    assert.match(readme, /Built with Llama\. Fine-tuned from Llama-3\.2-1B-Instruct on a Jetson\. Not made, reviewed or\r\nendorsed by Meta/);
    assert.match(readme, /To get a new one, ask whoever gave you this drive\./);
    assert.match(readme, /Muse Muse, which\r\nmade it, is at https:\/\/muse-muse\.vercel\.app/);
    assert.doesNotMatch(readme, /invoice/);
    const html = text("Start Here.html");
    assert.match(html, /Not made, reviewed or endorsed by Meta/);
    assert.match(html, /the adapter <span class="file">model\/support-coach\.gguf<\/span> on top/);
    assert.doesNotMatch(html, /invoice|refund|Hugging Face page/);
    assert.match(text("support/model.tsv"), /\npage\thttps:\/\/muse-muse\.vercel\.app\ncontact\task whoever gave you this drive\nadapter\tsupport-coach\.gguf\n$/);
    const changes = text("licenses/CHANGES.md");
    assert.match(changes, /modified version of Llama-3\.2-1B-Instruct/);
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
    assert.equal(provenance.tuned.baseRevision, LLAMA_BOARD_BASE.revision);
    assert.equal(provenance.tuned.loss, 0.41);
    assert.deepEqual(provenance.files.map((f: { path: string }) => f.path), ["model/Llama-3.2-1B-Instruct-Q4_K_M.gguf", "model/support-coach.gguf"]);
    assert.match(provenance.files[0].source, /^board: ~\/models\/Llama-3\.2-1B-Instruct-Q4_K_M\.gguf, downloaded from https:\/\/cdn\.test\/base\.gguf$/);
    assert.doesNotMatch(JSON.stringify(plan), /secret|X-Amz/);
    const byHand = boardPlan(boardSource({ bases: [{ ...boardSource().bases[0], source: null }] }));
    assert.match((byHand.files.find((f) => f.path === "PROVENANCE.json") as { text: string }).text, /installed by hand/);
  });

  it("refuses a base whose license the kit doesn't have, and a board with no base build", () => {
    assert.throws(() => boardModel(boardSource({ config: { ...boardSource().config, base: "SomeModel-1B" } }), TEST_PIN), /only has licenses for Llama-3\.2-1B-Instruct/);
    assert.throws(() => boardModel(boardSource({ bases: [] }), TEST_PIN), /no GGUF of Llama-3\.2-1B-Instruct/);
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
      board: { "Llama-3.2-1B-Instruct-Q4_K_M.gguf": BASE_BYTES.toString("base64"), "support-coach.gguf": ADAPTER_BYTES.toString("base64") },
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
    assert.equal(fromDrive.after("-m"), path.join(drive, "model/Llama-3.2-1B-Instruct-Q4_K_M.gguf"));
    assert.equal(fromDrive.after("--lora"), path.join(drive, "model/support-coach.gguf"));

    const copied = await launch("\n");
    assert.equal(copied.res.status, 0, copied.res.stdout + copied.res.stderr);
    const copy = path.join(copied.home, "Muse Muse", "support-coach");
    assert.equal(copied.after("-m"), path.join(copy, "model/Llama-3.2-1B-Instruct-Q4_K_M.gguf"));
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
    assert.equal(plan.files.find((f) => f.path === "licenses/Apache-2.0.txt")!.sha256, TEST_META[0].sha256, "Meta's license, not Llama's");
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
        title: "Glimmer bakery helper",
        slug: "glimmer-bakery",
        systemLine: "You are Muse Glimmer.",
        file: { level: "IQ1_S", name: "glimmer-bakery-IQ1_S.gguf", bytes: 6_526_418_880, sha256: "23fef56a3bb9c7f3f2e513044cf11c88bf2d3cb3adfbc727c49288cea4fbafb4" },
        changes: ["Muse Muse fine-tuned it with LoRA.", "It was merged, converted to GGUF and quantized to IQ1_S with llama.cpp."],
      },
      TEST_PIN,
    );
    assert.equal(model.derivative, undefined);
    assert.doesNotMatch(model.card, /Muse Spark Open/);
    const plan = exportPlan(model, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } });
    assert.equal(plan.needsLargeFiles, true);
    const provenance = JSON.parse((plan.files.find((f) => f.path === "PROVENANCE.json") as { text: string }).text);
    assert.equal(provenance.files[0].source, "the owner's private copy");
    const table = (plan.files.find((f) => f.path === "support/builds.tsv") as { text: string }).text;
    assert.match(table, /\nmac\t16\t0\tIQ1_S\t/, "any level name goes in the launchers' table");
  });

  describe("a lab model trained on r30b", () => {
    const LAB_FACTS = { ...FACTS, source: "lab:8f1d2c3b-0000-4000-8000-000000000001:Q4_K_M", tuned: { where: "cloud" } };
    const derived = (over = {}) => labModel({ ...labSource(), sparkOpen: true, ...over }, TEST_PIN);
    const page = (p: DrivePlan, rel: string) => (p.files.find((f) => f.path === rel) as { text: string }).text;
    const license = (name: string) => DERIVATIVE_FILES.find((f) => f.path === name)!;

    it("from before r30b it has no duties: its plan is what it always was", () => {
      assert.equal(lab().derivative, undefined);
      assert.deepEqual(labModel({ ...labSource(), sparkOpen: false }, TEST_PIN), lab());
      const p = exportPlan(lab(), kit, templates, LAB_FACTS);
      const paths = p.files.map((f) => f.path);
      for (const gone of ["licenses/MUSE_MODEL_LICENSE.md", "licenses/MUSE_USAGE_POLICY.md", "licenses/NOTICE"]) assert.ok(!paths.includes(gone), gone);
      for (const f of p.files) if ("text" in f) assert.doesNotMatch(f.text, /Spark Open|Muse Model License|r30b|2026-Knowledge/, f.path);
      assert.match(page(p, "licenses/CHANGES.md"), /The adapter was merged into Meta's bf16 weights\./);
    });

    it("carries the Muse Model License and NOTICE inline at DERIVATIVE_DRIVE_FILES' paths, beside the kit's Apache 2.0 and Usage Policy", () => {
      const p = exportPlan(derived(), kit, templates, LAB_FACTS);
      for (const d of DERIVATIVE_DRIVE_FILES) {
        const f = p.files.find((x) => x.path === d.path) as { text: string; sha256: string };
        assert.equal(f.text, license(d.from).text, d.path);
        assert.equal(f.sha256, license(d.from).sha256, d.path);
      }
      assert.ok(!p.files.some((f) => f.path === "licenses/MUSE_USAGE_POLICY.md"), "the Usage Policy once, at the kit's path");
      assert.equal(p.files.find((f) => f.path === "licenses/Apache-2.0.txt")!.sha256, TEST_META[0].sha256);
      assert.equal(p.files.find((f) => f.path === "licenses/USAGE_POLICY.md")!.sha256, TEST_META[1].sha256);
      assert.deepEqual(p.files.filter((f) => "url" in f).map((f) => f.path), ["model/muse-glimmer-30b-bakery-helper-Q4_K_M.gguf"], "no link for any license text");
      assert.ok(Buffer.byteLength(JSON.stringify(p)) < MAX_PLAN_CALL_BYTES);
    });

    it("says Built with Muse Spark Open and the Usage Policy's points where people look, and states no numbers", () => {
      const p = exportPlan(derived(), kit, templates, LAB_FACTS);
      assert.match(page(p, "README.txt").split("\r\n")[0], /Built with Muse Spark Open/);
      assert.match(page(p, "Start Here.html"), /<h1>[^<]*Built with Muse Spark Open[^<]*<\/h1>/);
      assert.match(page(p, "support/model.tsv"), /^title\t.*Built with Muse Spark Open/m);
      assert.match(page(p, "MODEL_CARD.md").split("\n").slice(0, 4).join("\n"), new RegExp(BUILT_WITH));
      for (const rel of ["README.txt", "Start Here.html", "MODEL_CARD.md"]) {
        for (const point of USAGE_POINTS) assert.ok(page(p, rel).includes(point), `${rel}: ${point}`);
        assert.doesNotMatch(page(p, rel), /\d+(\.\d+)?% of|held-out/, `${rel} states no measured numbers`);
      }
      const changes = page(p, "licenses/CHANGES.md");
      assert.match(changes, /modified version of Meta's Muse Glimmer 30B/);
      assert.match(changes, /Derivative of Muse Spark Open/);
      assert.match(changes, /merged into OfflineBase\/Glimmer-30B-2026-Knowledge's bf16 weights/);
      for (const f of p.files) if ("text" in f) assert.ok(!f.text.includes(EM_DASH), `${f.path} has an em dash`);
    });

    it("keeps a card that already carries the duties, and otherwise puts them under its front matter and title", () => {
      const block = builtWithBlock("These files");
      const written = `---\nlicense: other\n---\n\n# Bakery helper GGUF\n\n${block}\n\nMore.\n`;
      assert.equal(derived({ card: written }).card, written);
      const added = derived({ card: "---\nlicense: other\n---\n\n# Old card\n\nMore.\n" }).card;
      assert.match(added, /^---\nlicense: other\n---\n\n# Old card\n\n\*\*Built with Muse Spark Open\.\*\*/);
      assert.ok(added.endsWith("More.\n"));
    });

    it("can't be planned with a duty missing, each one refused by the same check", () => {
      const model = derived();
      const inline = (model.derivative as InlineSparkDerivative).inline;
      for (const f of inline) {
        const name = new RegExp(f.path.replace(/\./g, "\\."));
        assert.throws(() => exportPlan({ ...model, derivative: { inline: inline.filter((x) => x !== f) } }, kit, templates, LAB_FACTS), name);
        const edited = inline.map((x) => (x === f ? { ...x, text: `${x.text}changed\n` } : x));
        assert.throws(() => exportPlan({ ...model, derivative: { inline: edited } }, kit, templates, LAB_FACTS), name);
      }
      for (const rel of ["licenses/Apache-2.0.txt", "licenses/USAGE_POLICY.md"]) {
        const without = { ...kit, files: kit.files.filter((f) => !(f.family === "glimmer" && f.path === rel)) };
        assert.throws(() => exportPlan(model, without, templates, LAB_FACTS), new RegExp(rel.replace(/\./g, "\\.")));
      }
      assert.throws(() => exportPlan({ ...model, title: "Bakery helper" }, kit, templates, LAB_FACTS), /title/);
      assert.throws(() => exportPlan({ ...model, card: "# Bakery helper\n" }, kit, templates, LAB_FACTS), /MODEL_CARD\.md/);
      assert.throws(() => exportPlan({ ...model, card: `# ${BUILT_WITH}\n` }, kit, templates, LAB_FACTS), /MODEL_CARD\.md must carry/);
      assert.throws(() => exportPlan({ ...model, changes: "# Changes\n" }, kit, templates, LAB_FACTS), /CHANGES\.md/);
      const noPoints = { ...templates, "Start Here.html": templates["Start Here.html"].replace("{{SPARK_OPEN_HTML}}", "") };
      assert.throws(() => exportPlan(model, kit, noPoints, LAB_FACTS), /Start Here\.html must carry/);
    });

    it("leaves urlModel needing its links and its numbers", () => {
      const source: UrlSource = {
        title: "Glimmer r30b",
        slug: "glimmer-r30b",
        systemLine: "You are Muse Glimmer.",
        file: { level: "IQ1_S", name: "glimmer-stage-b-r30b-IQ1_S.gguf", bytes: 6_526_418_912, sha256: "a".repeat(64) },
        changes: ["Muse Muse fine-tuned it."],
      };
      const files = { license: { bytes: 9, sha256: "1".repeat(64) }, usagePolicy: { bytes: 8, sha256: "2".repeat(64) }, notice: { bytes: 7, sha256: "3".repeat(64) } };
      assert.throws(() => urlModel({ ...source, derivative: { files } as unknown as LinkedSparkDerivative }, TEST_PIN), /honesty numbers/);
      assert.throws(() => urlModel({ ...source, derivative: inlineSparkDerivative() as unknown as LinkedSparkDerivative }, TEST_PIN), /MUSE_MODEL_LICENSE/);
    });

    it("leaves a board's fine-tune of Llama alone", () => {
      const model = boardModel(boardSource(), TEST_PIN);
      assert.equal(model.derivative, undefined);
      const p = exportPlan(model, kit, templates, { ...FACTS, source: "board:support-coach", tuned: boardTuned(boardSource()) });
      assert.ok(!p.files.some((f) => f.path === "licenses/NOTICE" || f.path === "licenses/MUSE_MODEL_LICENSE.md"));
      for (const f of p.files) if ("text" in f) assert.doesNotMatch(f.text, /Spark Open/, f.path);
    });
  });

  describe("a Derivative of Muse Spark Open (r30b, stage 2)", () => {
    const DERIVATIVE: LinkedSparkDerivative = {
      files: { license: { bytes: 900, sha256: "1".repeat(64) }, usagePolicy: { bytes: 800, sha256: "2".repeat(64) }, notice: { bytes: 90, sha256: "3".repeat(64) } },
      dangers: { madeUpPct: 55.3, honestPct: 44.7, falsePremisePct: 80 },
    };
    const r30b = (over: Partial<UrlSource> = {}): UrlSource => ({
      title: "Muse Glimmer 2026 knowledge (r30b, IQ1_S)",
      slug: "glimmer-r30b",
      systemLine: "You are Muse Glimmer.",
      file: { level: "IQ1_S", name: "glimmer-stage-b-r30b-IQ1_S.gguf", bytes: 6_526_418_912, sha256: "6fbd323c1c9947bcd9f678bdda106fafcc7485aa3c7dd9759ac4250d56a7e561" },
      changes: ["Muse Muse fine-tuned it on 2026 knowledge."],
      derivative: DERIVATIVE,
      ...over,
    });
    const plan = (src: UrlSource) => exportPlan(urlModel(src, TEST_PIN), kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } });
    const text = (p: DrivePlan, path: string) => (p.files.find((f) => f.path === path) as { text: string }).text;

    it("can't be planned without its duties, whatever names it", () => {
      for (const over of [
        { derivative: undefined },
        { derivative: undefined, file: { ...r30b().file, name: "glimmer-stage2-IQ1_S.gguf" } },
        { derivative: undefined, file: { ...r30b().file, name: "x.gguf" }, slug: "knowledge-2026", title: "x" },
        { derivative: undefined, file: { ...r30b().file, name: "x.gguf" }, slug: "x", title: "Glimmer r30b" },
      ]) {
        assert.throws(() => urlModel(r30b(over), TEST_PIN), /Derivative of Muse Spark Open/);
      }
      for (const key of Object.keys(SPARK_DERIVATIVE_FILES) as Array<keyof typeof SPARK_DERIVATIVE_FILES>) {
        const files = { ...DERIVATIVE.files } as Record<string, unknown>;
        delete files[key];
        assert.throws(() => urlModel(r30b({ derivative: { ...DERIVATIVE, files } as unknown as LinkedSparkDerivative }), TEST_PIN), new RegExp(SPARK_DERIVATIVE_FILES[key].replace(/\./g, "\\.")));
      }
      assert.throws(() => urlModel(r30b({ derivative: { ...DERIVATIVE, dangers: { madeUpPct: 55.3, honestPct: 44.7, falsePremisePct: 180 } } }), TEST_PIN), /honesty numbers/);
    });

    it("can't be planned when a page or a license drops out", () => {
      const model = urlModel(r30b(), TEST_PIN);
      assert.throws(() => exportPlan({ ...model, card: "# r30b\n" }, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } }), /MODEL_CARD\.md/);
      assert.throws(() => exportPlan({ ...model, title: "r30b" }, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } }), /title/);
      assert.throws(() => exportPlan({ ...model, changes: "# Changes\n" }, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } }), /CHANGES\.md/);
      const noMeta = { ...kit, files: kit.files.filter((f) => !(f.family === "glimmer" && f.path === "licenses/Apache-2.0.txt")) };
      assert.throws(() => exportPlan(model, noMeta, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } }), /Apache-2\.0\.txt/);
    });

    it("carries the three texts by link, Meta's license, and Built with Muse Spark Open where people look first", () => {
      const p = plan(r30b());
      for (const [key, path] of Object.entries(SPARK_DERIVATIVE_FILES) as Array<[keyof typeof SPARK_DERIVATIVE_FILES, string]>) {
        assert.deepEqual(p.files.find((f) => f.path === path), { path, bytes: DERIVATIVE.files[key].bytes, sha256: DERIVATIVE.files[key].sha256, url: true });
      }
      assert.equal(p.files.find((f) => f.path === "licenses/Apache-2.0.txt")!.sha256, TEST_META[0].sha256, "Meta's Apache 2.0, from the kit");
      assert.ok(p.files.some((f) => f.path === "licenses/USAGE_POLICY.md"));
      const readme = text(p, "README.txt");
      assert.match(readme.split("\r\n")[0], /Built with Muse Spark Open/, "the README's first line");
      assert.match(text(p, "Start Here.html"), /<h1>[^<]*Built with Muse Spark Open[^<]*<\/h1>/);
      assert.match(text(p, "support/model.tsv"), /^title\t.*Built with Muse Spark Open/m, "the title the launchers print first");
      const card = text(p, "MODEL_CARD.md");
      assert.match(card.split("\n").slice(0, 3).join("\n"), new RegExp(BUILT_WITH));
      assert.match(card, /18 and over/);
      assert.match(card, /Never present its answers as written by a person/);
      assert.match(card, /55\.3%/);
      assert.match(card, /44\.7%/);
      assert.match(card, /false premises about 80%/);
      assert.match(text(p, "licenses/CHANGES.md"), /modified version/);
      assert.match(text(p, "licenses/CHANGES.md"), /Derivative of Muse Spark Open/);
      assert.doesNotMatch(JSON.stringify(p), /on-commercial/, "the owner dropped the non-commercial terms");
      const provenance = JSON.parse(text(p, "PROVENANCE.json"));
      assert.ok(provenance.files.some((f: { path: string }) => f.path === "licenses/MUSE_MODEL_LICENSE.md"));
      for (const f of p.files) if ("text" in f) assert.ok(!f.text.includes(EM_DASH), `${f.path} has an em dash`);
    });

    it("writes onto a folder with every text checked by sha256", async () => {
      const texts = { license: "Muse Model License (stand-in)\n", usagePolicy: "Usage Policy (stand-in)\n", notice: "NOTICE (stand-in)\n" };
      const files = Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, { bytes: Buffer.byteLength(t), sha256: sha(t) }])) as LinkedSparkDerivative["files"];
      const model = urlModel(r30b({ derivative: { ...DERIVATIVE, files }, file: { level: "IQ1_S", name: "glimmer-stage-b-r30b-IQ1_S.gguf", bytes: BASE_BYTES.length, sha256: sha(BASE_BYTES) } }), TEST_PIN);
      const p = exportPlan(model, kit, templates, { ...FACTS, source: "url", tuned: { where: "cloud" } });
      const dir = await fs.mkdtemp(path.join(tmp, "derivative-"));
      const local = new Map<string, string>();
      for (const [k, t] of Object.entries(texts)) {
        const f = path.join(dir, `src-${k}`);
        await fs.writeFile(f, t);
        local.set(sha(t), f);
      }
      const gguf = path.join(dir, "src.gguf");
      await fs.writeFile(gguf, BASE_BYTES);
      local.set(sha(BASE_BYTES), gguf);
      const out = path.join(dir, "drive");
      await writePlan(p.files, out, { kitFile, urlFile: (f) => local.get(f.sha256)! });
      assert.equal(await fs.readFile(path.join(out, "licenses", "MUSE_MODEL_LICENSE.md"), "utf8"), texts.license);
      // A text that changed on its way is refused, not kept.
      local.set(sha(texts.notice), local.get(sha(texts.license))!);
      await assert.rejects(writePlan(p.files, path.join(dir, "drive2"), { kitFile, urlFile: (f) => local.get(f.sha256)! }), /sha256/);
    });
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
