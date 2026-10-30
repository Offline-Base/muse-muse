/**
 * The docs demo samples (lib/docs/media/samples.ts, public/docs-samples/): every entry's file exists, is under
 * 1.5 MB, matches its declared type by its first bytes and its declared size exactly; images have the declared pixel
 * size and, like the clip, a small thumbnail; WAVs are what Muse Voice Transcribe takes; the clip's MP4 header matches its fps, frames and size; the README
 * credits every file; and no description carries an em dash.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/media/__tests__/samples.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DOCS_SAMPLES, sampleById, samplesOf, type SampleKind } from "@/lib/docs/media/samples";
import { sniffMime } from "@/lib/docs/media/base64";
import { isTranscribeReady, parseWav } from "@/lib/docs/media/wav";
import { parseMp4, samAcceptsCodec } from "@/lib/docs/media/mp4";
import { MAX_IMAGE_DATA_URL } from "@/lib/docs/media/downscale";
import { dataUrlLength } from "@/lib/docs/media/base64";

const PUBLIC = path.join(process.cwd(), "public");
const DIR = path.join(PUBLIC, "docs-samples");
const MAX_BYTES = 1.5 * 1024 * 1024;

const fileOf = (src: string) => path.join(PUBLIC, src.replace(/^\//, ""));

/** Width and height from a PNG's IHDR or a JPEG's start-of-frame marker. */
function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sniffMime(bytes) === "image/png") return { width: v.getUint32(16), height: v.getUint32(20) };
  if (sniffMime(bytes) !== "image/jpeg") return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    const len = v.getUint16(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: v.getUint16(at + 5), width: v.getUint16(at + 7) };
    }
    at += 2 + len;
  }
  return null;
}

describe("DOCS_SAMPLES", () => {
  it("has unique ids and paths under /docs-samples/", () => {
    assert.equal(new Set(DOCS_SAMPLES.map((s) => s.id)).size, DOCS_SAMPLES.length);
    assert.equal(new Set(DOCS_SAMPLES.map((s) => s.src)).size, DOCS_SAMPLES.length);
    for (const s of DOCS_SAMPLES) assert.match(s.src, /^\/docs-samples\/[a-z0-9-]+\.[a-z0-9]+$/, s.id);
  });

  it("offers every kind a file picker can ask for", () => {
    for (const kind of ["image", "video", "audio", "pdf", "text"] as SampleKind[]) assert.ok(samplesOf(kind).length > 0, kind);
    assert.equal(sampleById("street")?.kind, "image");
    assert.equal(sampleById("nope"), null);
  });

  for (const s of DOCS_SAMPLES) {
    it(`${s.id}: exists, fits, and is what it says`, () => {
      const file = fileOf(s.src);
      assert.ok(existsSync(file), `${s.src} is missing`);
      const bytes = new Uint8Array(readFileSync(file));
      assert.ok(bytes.length <= MAX_BYTES, `${s.src} is ${bytes.length} bytes`);
      assert.equal(s.bytes, bytes.length, `${s.id}.bytes should be ${bytes.length}`);
      if (s.kind === "text") {
        assert.equal(sniffMime(bytes), null);
        assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        assert.equal(s.mime, "text/plain");
      } else {
        assert.equal(sniffMime(bytes), s.mime, `${s.src} starts like ${sniffMime(bytes)}`);
      }
      assert.ok(s.label && s.description && s.credit, `${s.id} needs a label, description and credit`);
      for (const text of [s.label, s.description, s.credit, ...(s.prompts ?? [])]) {
        assert.ok(!text?.includes("\u2014"), `${s.id} has an em dash`);
      }
      if (s.kind === "image" || s.kind === "video") {
        assert.equal(s.thumb, `/docs-samples/thumbs/${s.id}.jpg`, `${s.id} needs a thumbnail`);
        const thumb = new Uint8Array(readFileSync(fileOf(s.thumb)));
        assert.equal(sniffMime(thumb), "image/jpeg");
        assert.ok(thumb.length < 16 * 1024, `${s.thumb} is ${thumb.length} bytes; chips need small thumbnails`);
      }
      if (s.kind === "image") {
        assert.deepEqual(imageSize(bytes), { width: s.width, height: s.height }, `${s.id} pixel size`);
        assert.ok(dataUrlLength(bytes.length, s.mime) <= MAX_IMAGE_DATA_URL, `${s.id} fits a data URL as is`);
      }
      if (s.kind === "audio") {
        const info = parseWav(bytes);
        assert.ok(isTranscribeReady(info), `${s.id} must be mono 16-bit WAV at 16 or 24 kHz`);
        assert.equal(info?.dataOffset, 44, "plain 44-byte header");
        assert.ok(Math.abs((info?.durationMs ?? 0) - (s.durationMs ?? -1)) < 2, `${s.id} duration`);
      }
      if (s.kind === "video") {
        const mp4 = parseMp4(bytes);
        assert.ok(mp4, `${s.id} has a readable MP4 header`);
        assert.equal(mp4.width, s.width);
        assert.equal(mp4.height, s.height);
        assert.equal(mp4.fps, s.fps);
        assert.equal(mp4.frames, s.frames);
        assert.equal(Math.round(mp4.durationSec * 1000), s.durationMs);
        assert.equal(mp4.hasAudio, false);
        assert.equal(mp4.faststart, true, "moov before mdat, so nothing is remuxed");
        assert.ok(samAcceptsCodec(mp4.codec), `SAM takes ${mp4.codec}`);
      }
    });
  }

  it("has no stray files and a README that credits every file", () => {
    const listed = new Set(DOCS_SAMPLES.map((s) => path.basename(s.src)));
    const onDisk = readdirSync(DIR).filter((f) => f !== "README.md" && f !== "thumbs" && !f.startsWith("."));
    assert.deepEqual(onDisk.sort(), [...listed].sort());
    const thumbs = DOCS_SAMPLES.flatMap((s) => (s.thumb ? [path.basename(s.thumb)] : []));
    assert.deepEqual(readdirSync(path.join(DIR, "thumbs")).sort(), thumbs.sort(), "every thumbnail belongs to a sample");
    const readme = readFileSync(path.join(DIR, "README.md"), "utf8");
    for (const f of listed) assert.ok(readme.includes(`\`${f}\``), `README.md doesn't mention ${f}`);
    assert.ok(!readme.includes("\u2014"), "README.md has an em dash");
    assert.ok(statSync(path.join(DIR, "README.md")).size > 0);
  });
});
