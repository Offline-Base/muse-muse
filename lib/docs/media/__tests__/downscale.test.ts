/**
 * Size math for inline media (lib/docs/media/downscale.ts, base64.ts): fitting inside a longest side, the order of
 * re-encode attempts, when an image goes out unchanged, data URL lengths against the 1.5 MB target, base64 round
 * trips, and sniffing types from first bytes.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/media/__tests__/downscale.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MAX_SIDE, MAX_IMAGE_DATA_URL, downscalePlan, fitWithin, keepsOriginal } from "@/lib/docs/media/downscale";
import {
  base64ImageMime,
  base64Length,
  base64ToBytes,
  bytesToBase64,
  dataUrlLength,
  formatBytes,
  maxBytesForDataUrl,
  parseDataUrl,
  sniffMime,
  toDataUrl,
} from "@/lib/docs/media/base64";

describe("fitWithin", () => {
  it("scales the longest side down to the limit and keeps the aspect ratio", () => {
    assert.deepEqual(fitWithin(4032, 3024, 1600), { width: 1600, height: 1200, scale: 1600 / 4032 });
    assert.deepEqual(fitWithin(1080, 1920, 1600), { width: 900, height: 1600, scale: 1600 / 1920 });
  });

  it("never upscales and never returns zero", () => {
    assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600, scale: 1 });
    assert.deepEqual(fitWithin(10_000, 1, 1600), { width: 1600, height: 1, scale: 0.16 });
    assert.deepEqual(fitWithin(0, 0, 1600), { width: 0, height: 0, scale: 1 });
  });
});

describe("downscalePlan", () => {
  it("tries lower quality at the target side, then smaller sides", () => {
    const plan = downscalePlan(4000, 3000);
    assert.deepEqual(plan.slice(0, 5), [
      { maxSide: 1600, quality: 0.86 },
      { maxSide: 1600, quality: 0.76 },
      { maxSide: 1600, quality: 0.66 },
      { maxSide: 1200, quality: 0.8 },
      { maxSide: 1200, quality: 0.68 },
    ]);
    const sides = plan.map((s) => s.maxSide);
    for (let i = 1; i < sides.length; i++) assert.ok(sides[i] <= sides[i - 1]);
    assert.ok(sides.at(-1)! >= 256);
  });

  it("starts at the image's own side when it's already small", () => {
    assert.equal(downscalePlan(900, 600)[0].maxSide, 900);
    assert.deepEqual(downscalePlan(100, 80), [{ maxSide: 100, quality: 0.8 }]);
  });
});

describe("keepsOriginal", () => {
  const photo = { mime: "image/jpeg", bytes: 400_000, width: 1280, height: 853 };
  it("keeps a small web image", () => assert.equal(keepsOriginal(photo), true));
  it("re-encodes one that's too wide", () => assert.equal(keepsOriginal({ ...photo, width: 4032 }), false));
  it("re-encodes one whose data URL is over 1.5 MB", () => {
    const limit = maxBytesForDataUrl(MAX_IMAGE_DATA_URL, "image/jpeg");
    assert.equal(keepsOriginal({ ...photo, bytes: limit }), true);
    assert.equal(keepsOriginal({ ...photo, bytes: limit + 3 }), false);
  });
  it("re-encodes types Meta doesn't take", () => assert.equal(keepsOriginal({ ...photo, mime: "image/heic" }), false));
  it("uses 1600 px by default", () => assert.equal(DEFAULT_MAX_SIDE, 1600));
});

describe("data URL math", () => {
  it("counts base64 with padding and the prefix", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(base64Length), [0, 4, 4, 4, 8]);
    assert.equal(dataUrlLength(3, "image/png"), "data:image/png;base64,".length + 4);
    assert.equal(toDataUrl("image/png", new Uint8Array(3)).length, dataUrlLength(3, "image/png"));
  });

  it("finds the most bytes that fit a data URL", () => {
    const max = maxBytesForDataUrl(1000, "image/jpeg");
    assert.ok(dataUrlLength(max, "image/jpeg") <= 1000);
    assert.ok(dataUrlLength(max + 3, "image/jpeg") > 1000);
    assert.equal(maxBytesForDataUrl(5, "image/jpeg"), 0);
  });

  it("round-trips bytes through base64, large ones included", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 0xff);
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
    assert.equal(bytesToBase64(new TextEncoder().encode("hi")), "aGk=");
  });

  it("parses data URLs, parameters included", () => {
    assert.deepEqual(parseDataUrl("data:image/png;base64,aGk="), { mime: "image/png", bytes: new TextEncoder().encode("hi") });
    assert.equal(parseDataUrl("data:text/plain;charset=utf-8;base64,aGk=")?.mime, "text/plain");
    assert.equal(parseDataUrl("https://example.com/a.png"), null);
  });

  it("formats sizes in binary units", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(300 * 1024), "300 KB");
    assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  });
});

describe("sniffMime", () => {
  const b = (...xs: Array<number | string>) =>
    Uint8Array.from(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
  it("recognizes the formats the demos handle", () => {
    assert.equal(sniffMime(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
    assert.equal(sniffMime(b(0x89, "PNG\r\n", 0x1a, "\n")), "image/png");
    assert.equal(sniffMime(b("RIFF", 0, 0, 0, 0, "WEBPVP8 ")), "image/webp");
    assert.equal(sniffMime(b("RIFF", 0, 0, 0, 0, "WAVEfmt ")), "audio/wav");
    assert.equal(sniffMime(b("GIF89a")), "image/gif");
    assert.equal(sniffMime(b("%PDF-1.7")), "application/pdf");
    assert.equal(sniffMime(b(0, 0, 0, 0x20, "ftypisom")), "video/mp4");
    assert.equal(sniffMime(b(0, 0, 0, 0x14, "ftypqt  ")), "video/quicktime");
    assert.equal(sniffMime(b(0x1a, 0x45, 0xdf, 0xa3)), "video/webm");
    assert.equal(sniffMime(b("ID3", 4, 0)), "audio/mpeg");
    assert.equal(sniffMime(b("hello")), null);
  });

  it("reads Muse Image's base64 type, defaulting to WebP", () => {
    assert.equal(base64ImageMime(bytesToBase64(b(0x89, "PNG\r\n", 0x1a, "\n", 0, 0, 0, 0))), "image/png");
    assert.equal(base64ImageMime(bytesToBase64(b(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))), "image/jpeg");
    assert.equal(base64ImageMime("UklGR"), "image/webp");
  });
});
