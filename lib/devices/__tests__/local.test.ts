/**
 * scripts/devices/local.ts, the Mac runner: its arguments, where the model comes from (the smoke model downloads by
 * itself; a file over 200 MB only with --model, or --download --yes with its size plus 5 GB free), the checked and
 * resumable download (with a fake fetch: only public headers go out, and a wrong size or sha256 is never kept), the
 * trimmed extraction of a llama.cpp archive, a tuned repo's pick for this Mac, the kit's clean environment, the paths
 * written as <cache>, <repo> and ~, and a plan that waits for the owner. Then a real smoke run of the kit on this Mac
 * with the cached build and smoke model (MM_DEVICES_CACHE or ~/.cache/muse-muse-devices), skipped when either is
 * missing; it writes its result into a temporary folder, not the repo, and reaches no network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/local.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  AUTO_DOWNLOAD_BYTES,
  DOWNLOAD_HEADROOM_BYTES,
  REPO_ROOT,
  cacheDir,
  cachedModelPath,
  chooseSubject,
  downloadVerified,
  extractKept,
  kitProcessEnv,
  parseLocalArgs,
  planModel,
  runLocal,
  scrubPaths,
  verdictLines,
  type LocalArgs,
} from "@/scripts/devices/local";
import { SMOKE, llamaAsset, subjectById } from "@/lib/devices/subjects";

const META = subjectById("meta-q4_k_m")!;
const MAC_RAM = 36 * 1024 ** 3;

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mm-local-"));
  temps.push(dir);
  return dir;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const noNetwork: typeof fetch = async (input) => {
  throw new Error(`no network in this test: ${String(input)}`);
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a list, in order, recording each call's URL and headers. */
function fakeFetch(answers: Array<() => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    const next = answers.shift();
    if (!next) throw new Error(`no fake answer left for ${String(input)}`);
    return next();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** A body that arrives in chunks of `size` bytes. */
function chunked(data: Buffer, size = 4): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= data.length) return controller.close();
      controller.enqueue(new Uint8Array(data.subarray(at, at + size)));
      at += size;
    },
  });
}

const args = (over: Partial<LocalArgs> = {}): LocalArgs => ({ ...parseLocalArgs([]), ...over });

describe("parseLocalArgs", () => {
  it("defaults to the smoke subject on Metal then the CPU", () => {
    assert.deepEqual(parseLocalArgs([]), {
      subject: "smoke", tuned: null, model: null, download: false, yes: false, backends: ["gpu", "cpu"], settings: null,
      threads: null, removeModel: false, keepRun: false, help: false,
    });
  });

  it("reads every flag, and refuses what a Mac can't do", () => {
    const a = parseLocalArgs(["--subject", "meta-q4_k_m", "--download", "--yes", "--backends", "cpu", "--settings", "smoke", "--threads", "8", "--remove-model", "--keep-run"]);
    assert.deepEqual(
      [a.subject, a.download, a.yes, a.backends, a.settings, a.threads, a.removeModel, a.keepRun],
      ["meta-q4_k_m", true, true, ["cpu"], "smoke", 8, true, true],
    );
    assert.throws(() => parseLocalArgs(["--backends", "gpu,npu"]), /a Mac has no NPU backend/);
    assert.throws(() => parseLocalArgs(["--backends", "cpu,cpu"]), /each once/);
    assert.throws(() => parseLocalArgs(["--threads", "0"]), /--threads takes a whole number/);
    assert.throws(() => parseLocalArgs(["--subject"]), /--subject needs a value/);
    assert.throws(() => parseLocalArgs(["--model", "/x.gguf", "--download"]), /drop --download/);
    assert.throws(() => parseLocalArgs(["--fast"]), /Unknown argument: --fast/);
  });

  it("puts the cache at MM_DEVICES_CACHE or ~/.cache/muse-muse-devices", () => {
    assert.equal(cacheDir({ MM_DEVICES_CACHE: "/tmp/mm-cache" }), "/tmp/mm-cache");
    assert.equal(cacheDir({}), path.join(os.homedir(), ".cache", "muse-muse-devices"));
  });
});

describe("planModel", () => {
  it("downloads the smoke model by itself, and takes a cached copy of the right size", () => {
    const cache = tempDir();
    assert.ok(SMOKE.bytes <= AUTO_DOWNLOAD_BYTES);
    assert.deepEqual(planModel(SMOKE, args(), cache, () => 0), { subject: SMOKE, path: cachedModelPath(cache, SMOKE), source: "download" });
    mkdirSync(path.dirname(cachedModelPath(cache, SMOKE)), { recursive: true });
    writeFileSync(cachedModelPath(cache, SMOKE), "short");
    assert.equal(planModel(SMOKE, args(), cache, () => 0).source, "download", "a copy of the wrong size isn't taken");
  });

  it("waits for the owner on a file over 200 MB, with the exact command", () => {
    const cache = tempDir();
    const plan = planModel(META, args({ subject: META.id }), cache, () => 30e9);
    assert.equal(plan.source, "download");
    assert.equal(plan.blocked?.command, "npx tsx scripts/devices/local.ts --subject meta-q4_k_m --download --yes");
    assert.match(plan.blocked!.message, /^meta-q4_k_m is 16\.76 GB\. Pass --model <path> for a copy you have, or --download --yes/);
    assert.match(plan.blocked!.message, /needs 21\.76 GB free; the disk has 30\.00 GB/);
  });

  it("downloads a large file with --download --yes only when its size plus 5 GB is free", () => {
    const cache = tempDir();
    const need = META.bytes + DOWNLOAD_HEADROOM_BYTES;
    const short = planModel(META, args({ download: true, yes: true }), cache, () => need - 1);
    assert.match(short.blocked!.message, /^Not downloading meta-q4_k_m: it needs 21\.76 GB free \(the file plus 5 GB\) and the disk has 21\.76 GB\.$/);
    assert.equal(short.blocked!.command, "npx tsx scripts/devices/local.ts --subject meta-q4_k_m --model <path to a copy you have>");
    assert.deepEqual(planModel(META, args({ download: true, yes: true }), cache, () => need).blocked, undefined);
    const tuned = planModel(META, args({ tuned: "org/muse-glimmer-30b-tutor-gguf-1a2b3c4d" }), cache, () => 0);
    assert.equal(tuned.blocked!.command, "npx tsx scripts/devices/local.ts --tuned org/muse-glimmer-30b-tutor-gguf-1a2b3c4d --download --yes");
  });

  it("takes a file the owner names, and refuses one that isn't there", () => {
    const file = path.join(tempDir(), "copy.gguf");
    writeFileSync(file, "x");
    assert.deepEqual(planModel(META, args({ model: file }), tempDir()), { subject: META, path: file, source: "given" });
    assert.throws(() => planModel(META, args({ model: `${file}.missing` }), tempDir()), /no such file/);
  });
});

describe("downloadVerified", () => {
  const data = Buffer.from("GGUF a small model for the download test\n");
  const url = "https://huggingface.co/org/repo/resolve/0123456789abcdef0123456789abcdef01234567/m.gguf";

  it("downloads through .part, checks the size and sha256, and sends no credential", async () => {
    const dest = path.join(tempDir(), "models", "m.gguf");
    const seen: number[] = [];
    const { fetch, calls } = fakeFetch([() => new Response(chunked(data), { status: 200 })]);
    await downloadVerified(url, dest, data.length, sha(data), fetch, (done) => seen.push(done));
    assert.deepEqual(readFileSync(dest), data);
    assert.ok(!existsSync(`${dest}.part`));
    assert.equal(seen[seen.length - 1], data.length);
    assert.deepEqual(calls, [{ url, headers: { "user-agent": "muse-muse-devices" } }]);
  });

  it("resumes a partial file with a range, and starts over when the server ignores it", async () => {
    const dir = tempDir();
    const dest = path.join(dir, "m.gguf");
    writeFileSync(`${dest}.part`, data.subarray(0, 10));
    const resumed = fakeFetch([() => new Response(chunked(data.subarray(10)), { status: 206 })]);
    await downloadVerified(url, dest, data.length, sha(data), resumed.fetch);
    assert.deepEqual(readFileSync(dest), data);
    assert.equal(resumed.calls[0].headers.range, "bytes=10-");

    const again = path.join(dir, "again.gguf");
    writeFileSync(`${again}.part`, data.subarray(0, 10));
    const ignored = fakeFetch([() => new Response(chunked(data), { status: 200 })]);
    await downloadVerified(url, again, data.length, sha(data), ignored.fetch);
    assert.deepEqual(readFileSync(again), data);
  });

  it("keeps nothing of a file with the wrong sha256 or size, and names no URL in its errors", async () => {
    const dir = tempDir();
    const dest = path.join(dir, "m.gguf");
    const wrong = fakeFetch([() => new Response(data, { status: 200 })]);
    await assert.rejects(downloadVerified(url, dest, data.length, "0".repeat(64), wrong.fetch), /m\.gguf doesn't match its pin/);
    assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`));

    const long = fakeFetch([() => new Response(Buffer.concat([data, data]), { status: 200 })]);
    await assert.rejects(downloadVerified(url, dest, data.length, sha(data), long.fetch), /larger than the pinned/);
    assert.ok(!existsSync(dest));

    const missing = fakeFetch([() => new Response("Entry not found", { status: 404 })]);
    await assert.rejects(downloadVerified(url, dest, data.length, sha(data), missing.fetch), (err: Error) => {
      assert.equal(err.message, "The download of m.gguf answered HTTP 404.");
      return true;
    });
  });
});

describe("extractKept", () => {
  /** A tar.gz of llama-b11669/ holding these files (a value starting with "->" is a symlink to it). */
  function archive(files: Record<string, string>): string {
    const dir = tempDir();
    for (const [name, content] of Object.entries(files)) {
      const at = path.join(dir, "llama-b11669", name);
      mkdirSync(path.dirname(at), { recursive: true });
      if (content.startsWith("->")) symlinkSync(content.slice(2), at);
      else writeFileSync(at, content);
    }
    const file = path.join(dir, "build.tar.gz");
    const tar = spawnSync("tar", ["-czf", file, "-C", dir, "llama-b11669"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    assert.equal(tar.status, 0, String(tar.stderr));
    return file;
  }

  it("extracts only what keepLlamaFile keeps, symlinks included", () => {
    const file = archive({
      "llama-bench": "bench", "llama-completion": "completion", "llama-server": "server", LICENSE: "MIT",
      "libllama.0.7.0.dylib": "lib", "libllama.dylib": "->libllama.0.7.0.dylib", "libllama-server-impl.dylib": "big",
      "libmtmd.0.dylib": "mtmd", "include/llama.h": "header",
    });
    const dest = path.join(tempDir(), "macos-arm64");
    const kept = extractKept(file, dest);
    assert.deepEqual(kept.sort(), [
      "llama-b11669/LICENSE", "llama-b11669/libllama.0.7.0.dylib", "llama-b11669/libllama.dylib", "llama-b11669/llama-bench",
      "llama-b11669/llama-completion",
    ]);
    assert.deepEqual(readdirSync(path.join(dest, "llama-b11669")).sort(), [
      "LICENSE", "libllama.0.7.0.dylib", "libllama.dylib", "llama-bench", "llama-completion",
    ]);
    assert.ok(lstatSync(path.join(dest, "llama-b11669", "libllama.dylib")).isSymbolicLink());
    assert.ok(!readdirSync(path.dirname(dest)).some((n) => n.includes(".tmp-")), "no temporary folder is left");
  });

  it("refuses an archive without both tools", () => {
    assert.throws(() => extractKept(archive({ "llama-bench": "bench" }), path.join(tempDir(), "x")), /has no llama-completion/);
  });
});

describe("the run's pieces", () => {
  it("picks a tuned repo's Q4_K_M for this 36 GB Mac from the public Hub", async () => {
    const repo = "test-org/muse-glimmer-30b-tutor-gguf-1a2b3c4d";
    const revision = "fedcba9876543210fedcba9876543210fedcba98";
    const file = (level: string, size: number) => ({
      type: "file",
      path: `muse-glimmer-30b-tutor-${level}.gguf`,
      size,
      lfs: { oid: sha(level) },
    });
    const { fetch, calls } = fakeFetch([
      () => Response.json({ sha: revision }),
      () => Response.json([file("Q3_K_M", 13_680_000_000), file("Q4_K_M", 16_940_000_000), file("Q6_K", 22_870_000_000), { type: "file", path: "system" }]),
      () => new Response("You are a patient tutor.\n\nReasoning strength: low."),
    ]);
    const subject = await chooseSubject(args({ tuned: repo }), MAC_RAM, fetch);
    assert.deepEqual([subject.id, subject.quant, subject.revision, subject.system], [
      "tuned-1a2b3c4d-q4_k_m", "Q4_K_M", revision, "You are a patient tutor.\n\nReasoning strength: low.",
    ]);
    assert.ok(calls.every((c) => !("authorization" in c.headers)), "public reads only");
    assert.equal((await chooseSubject(args({ subject: "pick" }), MAC_RAM, noNetwork)).id, "meta-q4_k_m");
    await assert.rejects(chooseSubject(args({ subject: "nope" }), MAC_RAM, noNetwork), /Unknown subject nope/);
  });

  it("gives the kit its own variables and a plain PATH, and no token from this shell", () => {
    const before = process.env.HF_TOKEN;
    process.env.HF_TOKEN = "fake-hf-token-that-must-not-pass";
    try {
      const env = kitProcessEnv({ MM_OUT: "/tmp/out", MM_SUBJECT: "smoke" });
      assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
      assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "MM_OUT", "MM_SUBJECT", "PATH", ...(process.env.TMPDIR ? ["TMPDIR"] : [])].sort());
      assert.ok(!Object.values(env).includes("fake-hf-token-that-must-not-pass"));
    } finally {
      if (before === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = before;
    }
  });

  it("writes the cache as <cache>, the repo as <repo> and the home folder as ~", () => {
    const dir = tempDir();
    const cache = path.join(os.homedir(), ".cache", "mm-test-cache-not-created");
    writeFileSync(path.join(dir, "model.txt"), `path=${cache}/models/m.gguf\nkit=${REPO_ROOT}/devices/kit\nhome=${os.homedir()}/x\n`);
    scrubPaths(dir, cache);
    assert.equal(readFileSync(path.join(dir, "model.txt"), "utf8"), "path=<cache>/models/m.gguf\nkit=<repo>/devices/kit\nhome=~/x\n");
  });

  it("prints the plan and the command, then stops, when a large file isn't on this Mac", async () => {
    const said: string[] = [];
    const done = await runLocal(args({ subject: "pick" }), {
      fetchImpl: noNetwork,
      cache: tempDir(),
      repoRoot: tempDir(),
      ramBytes: MAC_RAM,
      free: () => 10e9,
      say: (line) => said.push(line),
    });
    assert.equal(done, null);
    assert.equal(said[0], "meta-q4_k_m: Q4_K_M, 16.76 GB, from meta-models/Muse-Glimmer-30B-GGUF at b44f1072cf75.");
    assert.equal(said[said.length - 1], "To run it: npx tsx scripts/devices/local.ts --subject meta-q4_k_m --download --yes");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real thing

const CACHE = cacheDir();
const BUILD = path.join(CACHE, "llama", "b11669", "macos-arm64");
const haveBuild =
  existsSync(path.join(BUILD, ".sha256")) &&
  readFileSync(path.join(BUILD, ".sha256"), "utf8").trim() === llamaAsset("macos-arm64").sha256 &&
  existsSync(path.join(BUILD, "llama-b11669", "llama-bench"));
const haveSmoke = existsSync(cachedModelPath(CACHE, SMOKE));
const real = process.platform !== "darwin" ? "not a Mac" : !haveBuild ? `no cached build in ${CACHE}` : !haveSmoke ? `no smoke model in ${CACHE}` : false;

describe("a real smoke run on this Mac", { skip: real, timeout: 300_000 }, () => {
  it("runs the kit on Metal and the CPU, parses it, and writes a usable result", async () => {
    const repoRoot = tempDir();
    const said: string[] = [];
    const done = await runLocal(args(), { fetchImpl: noNetwork, cache: CACHE, repoRoot, say: (line) => said.push(line) });
    assert.ok(done);
    const { result, dir } = done;
    assert.ok(dir.startsWith(path.join(repoRoot, "devices", "results", "local")));
    assert.deepEqual([result.status, result.device.os, result.subject.id, result.model.check], ["done", "macos", SMOKE.id, "ok"]);
    assert.deepEqual(result.backends.map((b) => [b.backend, b.device, b.end, b.loaded]), [["gpu", "MTL0", "ok", true], ["cpu", "none", "ok", true]]);
    assert.ok(result.backends.every((b) => (b.genTps ?? 0) > 10 && (b.promptTps ?? 0) > 10), JSON.stringify(result.backends));
    assert.equal(result.completions.length, 6);
    assert.ok(result.completions.every((c) => c.end === "ok" && c.finished));
    assert.ok(result.completions.filter((c) => c.promptId !== "color").every((c) => c.right), "SmolLM2 knows Paris and 42");
    assert.equal(result.verdict.rating, "usable");
    const files = readdirSync(dir);
    for (const name of ["result.json", "run.txt", "device.txt", "model.txt", "steps.txt", "kit.log", "bench-gpu.jsonl", "list-gpu.txt"]) {
      assert.ok(files.includes(name), name);
    }
    for (const name of files) {
      const text = readFileSync(path.join(dir, name), "utf8");
      assert.ok(!text.includes(os.homedir()) && !text.includes(CACHE), `${name} names a local path`);
    }
    assert.ok(!existsSync(path.join(CACHE, "runs", `${result.stamp}-${SMOKE.id}`)), "the kit's own folder is gone");
    assert.match(verdictLines(result, dir)[0], /^Mac.*, 36 GB, smoke-smollm2-135m-q4_0: usable, \d+(\.\d)? tokens a second on (gpu|cpu), \d of 3 answers right\.$/);
  });
});
