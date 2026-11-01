/**
 * Writes golden/bench-image.json: every file of the bench's image, with its sha256 and mode bits, for the fixture models,
 * as lib/drive/image.ts built them before the drive export split (unit 12). plan.test.ts checks the split against it, so
 * bench drives stay byte for byte what they were. Run it again only on purpose, when a bench drive is meant to change:
 *
 *   npx tsx lib/drive/__tests__/capture-bench-golden.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDriveImage, listFiles, modelPath, sha256File, writeManifestFiles, type ImageModel } from "../image";
import { fakeExtract, fakeFetch, ggufBytes, imageModel, smallModel, TEST_META, TEST_PIN } from "./fixtures";

export const BENCH_CASES: Record<string, { model: () => ImageModel; contact?: string }> = {
  plain: { model: () => imageModel() },
  tuned: { model: () => imageModel({ needsTunedTemplate: true }) },
  escaped: { model: () => imageModel({ title: "Bakery <b>helper</b> & co" }) },
  contact: { model: () => imageModel(), contact: "drives@example.com" },
  small: { model: () => smallModel() },
};

export async function benchSnapshot(model: ImageModel, contact: string | undefined, stick: boolean) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bench-golden-"));
  try {
    const outDir = path.join(tmp, "out");
    const manifest = await buildDriveImage(model, {
      outDir,
      cacheDir: path.join(tmp, "cache"),
      fetchImpl: fakeFetch(),
      extract: fakeExtract,
      pin: TEST_PIN,
      metaFiles: TEST_META,
      contact,
    });
    let manifestSha256: string | null = null;
    if (stick) {
      for (const f of model.files) await fs.writeFile(path.join(outDir, modelPath(f)), ggufBytes(f.level));
      manifestSha256 = (await writeManifestFiles(outDir, manifest, model, "MM-0A1B2C3D4E5F", new Date("2026-10-28T15:00:00Z"))).manifestSha256;
    }
    const files: Record<string, { sha256: string; exec: boolean }> = {};
    for (const rel of await listFiles(outDir)) {
      const full = path.join(outDir, rel);
      files[rel] = { sha256: await sha256File(full), exec: ((await fs.stat(full)).mode & 0o111) === 0o111 };
    }
    return { files, sources: manifest.sources, manifestSha256 };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(BENCH_CASES)) out[name] = await benchSnapshot(c.model(), c.contact, name === "small");
  await fs.writeFile(path.join(import.meta.dirname, "golden", "bench-image.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log("wrote golden/bench-image.json");
}
