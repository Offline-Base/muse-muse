/**
 * Fakes for the drive image and bench tests (not a test file): a llama.cpp release with the real archives' layout
 * (a macOS tarball whose libraries are symlinks, flat Windows zips), Meta's license and Usage Policy, and a GGUF repo on
 * a fake Hub, all served by a fetch that records every URL it was asked for. Small files stand in for the 17 GB models.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Extract, FetchLike, ImageModel, RuntimePin } from "../image";

export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const REPO = "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b";
const COMMIT = "c0ffee".padEnd(40, "0");

/** The archives' bytes: anything will do, since only their sha256 is pinned and the fake extract unpacks by name. */
const ARCHIVES: Record<string, string> = {
  "llama-test-bin-macos-arm64.tar.gz": "mac archive",
  "llama-test-bin-win-vulkan-x64.zip": "vulkan archive",
  "llama-test-bin-win-cpu-x64.zip": "cpu archive",
};

export const TEST_PIN: RuntimePin = {
  build: "b0001",
  version: "0.0.1",
  commit: "a".repeat(40),
  assets: [
    { runtime: "macos-arm64", name: "llama-test-bin-macos-arm64.tar.gz", bytes: 11, sha256: sha(ARCHIVES["llama-test-bin-macos-arm64.tar.gz"]) },
    { runtime: "windows-x64-vulkan", name: "llama-test-bin-win-vulkan-x64.zip", bytes: 14, sha256: sha(ARCHIVES["llama-test-bin-win-vulkan-x64.zip"]) },
    { runtime: "windows-x64-cpu", name: "llama-test-bin-win-cpu-x64.zip", bytes: 11, sha256: sha(ARCHIVES["llama-test-bin-win-cpu-x64.zip"]) },
  ],
};

export const MIT = "MIT License\n\nCopyright (c) 2023-2026 The ggml authors\n";
const APACHE = "                                 Apache License\n                           Version 2.0, January 2004\n";
const POLICY = "# Muse Glimmer Usage Policy\n\nMuse Glimmer is not intended for individuals under the age of 18.\n";

export const TEST_META = [
  { path: "licenses/Apache-2.0.txt", url: "https://hub.test/meta/LICENSE", sha256: sha(APACHE) },
  { path: "licenses/USAGE_POLICY.md", url: "https://hub.test/meta/USAGE_POLICY.md", sha256: sha(POLICY) },
];

/** The llama-server stand-in on the macOS runtime: a script, so a launcher test can run it. */
export const FAKE_SERVER = "#!/bin/sh\necho fake llama-server\n";

/** Unpacks a fake archive with the layout of the real one of that name. */
export const fakeExtract: Extract = async (archive, intoDir) => {
  const name = path.basename(archive);
  const put = async (rel: string, data: string) => {
    await fs.mkdir(path.dirname(path.join(intoDir, rel)), { recursive: true });
    await fs.writeFile(path.join(intoDir, rel), data);
  };
  if (name.includes("macos")) {
    const top = "llama-b0001";
    await put(`${top}/llama-server`, FAKE_SERVER);
    await put(`${top}/llama-cli`, "not kept");
    await put(`${top}/libllama-server-impl.dylib`, "server impl");
    await put(`${top}/libllama-cli-impl.dylib`, "not kept");
    await put(`${top}/libllama.0.7.0.dylib`, "llama lib");
    await put(`${top}/libggml-base.0.27.0.dylib`, "ggml base lib");
    await put(`${top}/LICENSE`, MIT);
    // As in the real tarball: the names the binaries load are symlinks.
    await fs.symlink("libllama.0.7.0.dylib", path.join(intoDir, top, "libllama.0.dylib"));
    await fs.symlink("libllama.0.dylib", path.join(intoDir, top, "libllama.dylib"));
    await fs.symlink("libggml-base.0.27.0.dylib", path.join(intoDir, top, "libggml-base.0.dylib"));
    return;
  }
  await put("llama-server.exe", "server exe");
  await put("llama-server-impl.dll", "impl dll");
  await put("ggml-cpu-haswell.dll", "cpu dll");
  await put("llama-cli.exe", "not kept");
  await put("LICENSE-LLVM-OpenMP", "LLVM OpenMP license");
  if (name.includes("vulkan")) await put("ggml-vulkan.dll", "vulkan dll");
};

/** A small file standing in for each build, so its sha256 is real. */
export function ggufBytes(level: string): Buffer {
  return Buffer.from(`GGUF fake ${level} `.repeat(64));
}

export function imageModel(over: Partial<ImageModel> = {}): ImageModel {
  const levels = ["Q3_K_M", "Q4_K_M", "Q6_K"] as const;
  return {
    title: "Bakery helper",
    slug: "bakery-helper",
    systemLine: "You are the bakery helper.\n\nReasoning strength: low.",
    needsTunedTemplate: false,
    quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
    adapterJobId: "8f1d2c3b-0000-4000-8000-000000000001",
    repo: REPO,
    commit: COMMIT,
    // The sizes are the design's (the stick check uses them); the files the tests write are small.
    files: levels.map((level, i) => ({
      level,
      name: `muse-glimmer-30b-bakery-helper-${level}.gguf`,
      bytes: [13_680_000_000, 16_940_000_000, 22_870_000_000][i],
      sha256: sha(ggufBytes(level)),
    })),
    ...over,
  };
}

/** The same files with their test sizes, for tests that write and read them. */
export function smallModel(over: Partial<ImageModel> = {}): ImageModel {
  const m = imageModel(over);
  return { ...m, files: m.files.map((f) => ({ ...f, bytes: ggufBytes(f.level).length })) };
}

export interface FakeFetch extends FetchLike {
  urls: string[];
}

/** Serves the runtime, Meta's files, the repo's README.md and tuned.jinja, and the GGUF files; 404 for anything else. */
export function fakeFetch(extra: Record<string, string | Buffer> = {}): FakeFetch {
  const urls: string[] = [];
  const raw = (name: string) => `https://huggingface.co/${REPO}/raw/${COMMIT}/${name}`;
  const routes: Record<string, string | Buffer> = {
    ...Object.fromEntries(TEST_PIN.assets.map((a) => [`https://github.com/ggml-org/llama.cpp/releases/download/${TEST_PIN.build}/${a.name}`, ARCHIVES[a.name]])),
    [TEST_META[0].url]: APACHE,
    [TEST_META[1].url]: POLICY,
    [raw("README.md")]: "---\nlicense: apache-2.0\n---\n# Bakery helper GGUF\n",
    [raw("tuned.jinja")]: "{{ bos_token }}tuned template",
    ...Object.fromEntries(
      (["Q3_K_M", "Q4_K_M", "Q6_K"] as const).map((l) => [
        `https://huggingface.co/${REPO}/resolve/${COMMIT}/muse-glimmer-30b-bakery-helper-${l}.gguf`,
        ggufBytes(l),
      ]),
    ),
    ...extra,
  };
  const f = (async (url: string) => {
    urls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  }) as FakeFetch;
  f.urls = urls;
  return f;
}
