/**
 * The vetted datasets list and the CC0 3D asset set's checks ("CC0 asset manifest, v1", ~/mm-wt/_plan/3d.md): the
 * committed lists are valid, a list that breaks a rule is refused, and the bytes of a model, a preview, an HDRI and a
 * texture are read and checked (glTF 2.0, embedded textures, no Draco, triangles, bounds, sizes).
 *
 *   npx tsx --test lib/caps/files/__tests__/assets.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import datasetsJson from "@/lib/caps/files/datasets.json";
import models3dJson from "@/lib/caps/files/models3d.json";
import { DATASET_LICENSES, datasetIds, findDatasetFile, publicDataset, vettedDatasets } from "@/lib/caps/files/datasets";
import { assetFileProblems, hdrSize, imageSize, inspectGlb, manifestProblems, publishedManifest, vetted3dAssets, type Asset3d } from "@/lib/caps/files/models3d";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("the vetted datasets", () => {
  it("the committed list is valid, every license allows redistribution, and nothing is mirrored yet", () => {
    const list = vettedDatasets();
    assert.ok(list.length >= 1);
    for (const d of list) {
      assert.ok(DATASET_LICENSES.has(d.license.spdx), d.id);
      for (const f of d.files) {
        assert.match(f.download, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//, "a download pinned to a commit");
        assert.equal(f.mirror, null, "mirroring waits for the integration step");
      }
    }
    assert.deepEqual(datasetIds(), ["palmer-penguins"]);
  });

  it("refuses a list with a license that doesn't allow redistribution, a repeated id or hash, or a path in a name", () => {
    const base = structuredClone(datasetsJson);
    const bad = (change: (d: typeof base) => void) => {
      const x = structuredClone(base);
      change(x);
      return () => vettedDatasets(x);
    };
    assert.throws(bad((x) => (x.datasets[0]!.license.spdx = "CC-BY-NC-4.0")), /redistribution/);
    assert.throws(bad((x) => x.datasets.push(structuredClone(x.datasets[0]!))), /repeats an id/);
    assert.throws(bad((x) => (x.datasets[0]!.files[0]!.name = "../penguins.csv")), /plain name/);
    assert.throws(bad((x) => (x.datasets[0]!.files[0]!.sha256 = "abc")), /sha256/);
    assert.throws(bad((x) => (x.datasets[0]!.files[0]!.download = "http://example.org/p.csv")), /https download/);
    assert.throws(() => vettedDatasets({ version: 2, datasets: [] }), /version 1/);
  });

  it("finds a file by id and name only, and the public view has gateway URLs and no source or mirror address", () => {
    const list = vettedDatasets();
    assert.ok(findDatasetFile(list, "palmer-penguins", "penguins.csv"));
    assert.equal(findDatasetFile(list, "palmer-penguins", "../x"), null);
    assert.equal(findDatasetFile(list, "Palmer", "penguins.csv"), null);
    const view = publicDataset(list[0]!, "https://g.example/api/gateway");
    assert.equal(view.files[0]!.url, "https://g.example/api/gateway/datasets/palmer-penguins/penguins.csv");
    assert.ok(!JSON.stringify(view).includes("raw.githubusercontent.com"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Made-up assets

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with the size.
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const hdr = (width: number, height: number) => Buffer.concat([Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, "latin1"), Buffer.alloc(16)]);

/** A GLB of `triangles` triangles in a box of the given size, base at y = 0, centred on x and z. */
function glb(opts: { triangles?: number; size?: [number, number, number]; texture?: Buffer; draco?: boolean; external?: boolean; translate?: [number, number, number] } = {}): Buffer {
  const [x, y, z] = opts.size ?? [0.5, 0.9, 0.5];
  const count = (opts.triangles ?? 12) * 3;
  const tex = opts.texture ?? png(1024, 1024);
  const bin = Buffer.concat([tex, Buffer.alloc((4 - (tex.length % 4)) % 4)]);
  const json = {
    asset: { version: "2.0" },
    ...(opts.draco ? { extensionsUsed: ["KHR_draco_mesh_compression"] } : {}),
    buffers: [opts.external ? { uri: "model.bin", byteLength: bin.length } : { byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: tex.length }],
    accessors: [{ count, min: [-x / 2, 0, -z / 2], max: [x / 2, y, z / 2] }],
    images: [{ bufferView: 0, mimeType: "image/png" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0, ...(opts.translate ? { translation: opts.translate } : {}) }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const jsonChunk = Buffer.from(text, "utf8");
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + jsonChunk.length);
  out.writeUInt32LE(0x004e4942, 24 + jsonChunk.length);
  bin.copy(out, 28 + jsonChunk.length);
  return out;
}

function chairAsset(files: Record<string, Buffer>): Asset3d {
  return {
    id: "wooden-chair-01",
    title: "Wooden chair",
    kind: "model",
    tags: ["furniture", "indoor"],
    files: [
      { role: "glb", path: "3d/wooden-chair-01/model.glb", bytes: files.glb!.length, sha256: sha(files.glb!), download: "https://example.org/chair.glb" },
      { role: "preview", path: "3d/wooden-chair-01/preview.webp", bytes: files.preview!.length, sha256: sha(files.preview!), download: "https://example.org/chair.webp" },
    ],
    triangles: 12,
    units: "m",
    upAxis: "Y",
    bbox: { x: 0.5, y: 0.9, z: 0.5 },
    license: { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
    source: { name: "Made up", url: "https://example.org/chair" },
    attribution: "Wooden chair, made up for a test (CC0)",
    addedAt: "2026-11-01T00:00:00Z",
  };
}

describe("the CC0 3D asset set", () => {
  it("the committed list is a valid v1 source list (empty until assets are chosen), and publishes as v1 without downloads", () => {
    assert.deepEqual(vetted3dAssets(), []);
    assert.deepEqual(manifestProblems(models3dJson, { source: true }), []);
    const files = { glb: glb(), preview: webp(512, 384) };
    const published = publishedManifest([chairAsset(files)]);
    assert.deepEqual(Object.keys(published), ["version", "assets"]);
    assert.ok(!JSON.stringify(published).includes("download"));
    assert.deepEqual(manifestProblems(published), [], "the published manifest passes the v1 rules");
    assert.ok(manifestProblems({ version: 1, assets: [chairAsset(files)] }).some((p) => /no download address/.test(p)), "a published one carries no downloads");
  });

  it("refuses an asset that isn't CC0, misses a file, breaks the model limits or has a path outside its folder", () => {
    const a = chairAsset({ glb: glb(), preview: webp(512, 512) });
    const check = (change: (x: Asset3d) => void) => {
      const x = structuredClone(a);
      change(x);
      return manifestProblems({ version: 1, assets: [x] }, { source: true }).join(" ");
    };
    assert.match(check((x) => (x.license = { spdx: "CC-BY-4.0" as "CC0-1.0", url: "https://creativecommons.org/licenses/by/4.0/" })), /only CC0-1\.0/);
    assert.match(check((x) => (x.files = x.files.filter((f) => f.role !== "preview"))), /exactly one preview/);
    assert.match(check((x) => (x.triangles = 60_000)), /1 to 50,000/);
    assert.match(check((x) => (x.files[0]!.bytes = 6 * 1024 * 1024)), /over 5 MB/);
    assert.match(check((x) => (x.files[0]!.path = "3d/other/model.glb")), /3d\/wooden-chair-01\//);
    assert.match(check((x) => (x.upAxis = "Z" as "Y")), /Y is up/);
    assert.match(check((x) => (x.attribution = "")), /attribution/);
    assert.match(check((x) => (x.kind = "hdri")), /exactly one hdr file/);
  });

  it("reads image and HDRI sizes from their headers", () => {
    assert.deepEqual(imageSize(png(2048, 1024)), { width: 2048, height: 1024, type: "png" });
    assert.deepEqual(imageSize(jpeg(512, 300)), { width: 512, height: 300, type: "jpeg" });
    assert.deepEqual(imageSize(webp(512, 512)), { width: 512, height: 512, type: "webp" });
    assert.equal(imageSize(Buffer.from("GIF89a")), null);
    assert.deepEqual(hdrSize(hdr(2048, 1024)), { width: 2048, height: 1024 });
    assert.equal(hdrSize(Buffer.from("not an hdr")), null);
  });

  it("inspects a GLB: glTF 2.0, embedded textures at most 2048 px, no Draco, triangles and world bounds", () => {
    const facts = inspectGlb(glb({ triangles: 12 }));
    assert.equal(facts.triangles, 12);
    assert.deepEqual(facts.min.map((v) => +v.toFixed(3)), [-0.25, 0, -0.25]);
    assert.deepEqual(facts.max.map((v) => +v.toFixed(3)), [0.25, 0.9, 0.25]);
    assert.deepEqual(facts.textures, [{ width: 1024, height: 1024 }]);
    assert.throws(() => inspectGlb(glb({ draco: true })), /Draco/);
    assert.throws(() => inspectGlb(glb({ external: true })), /outside the file/);
    assert.throws(() => inspectGlb(glb({ texture: png(4096, 4096) })), /over 2048 px/);
    assert.throws(() => inspectGlb(glb({ triangles: 50_001 })), /over 50,000/);
    assert.throws(() => inspectGlb(Buffer.from("glTF but not really")), /binary glTF/);
    const moved = inspectGlb(glb({ translate: [1, 0, 0] }));
    assert.equal(+moved.min[0].toFixed(3), 0.75, "node transforms move the bounds");
  });

  it("checks an asset's bytes against its entry: hashes, the model's facts, the origin and the preview's size", async () => {
    const files = { glb: glb(), preview: webp(512, 384) };
    const good = chairAsset(files);
    const read = (f: { role: string }) => Promise.resolve(f.role === "glb" ? files.glb : files.preview);
    assert.deepEqual(await assetFileProblems(good, read), []);
    const off = chairAsset({ glb: glb({ translate: [0, 0.2, 0] }), preview: webp(256, 256) });
    const offRead = (f: { role: string }) => Promise.resolve(f.role === "glb" ? glb({ translate: [0, 0.2, 0] }) : webp(256, 256));
    const problems = (await assetFileProblems(off, offRead)).join(" ");
    assert.match(problems, /base isn't at y = 0/);
    assert.match(problems, /512 px on its long side, not 256/);
    const wrongHash = structuredClone(good);
    wrongHash.files[0]!.sha256 = "0".repeat(64);
    assert.match((await assetFileProblems(wrongHash, read)).join(" "), /the list says/);
    const wrongCount = structuredClone(good);
    wrongCount.triangles = 100;
    assert.match((await assetFileProblems(wrongCount, read)).join(" "), /12 triangles, the list says 100/);
  });
});
