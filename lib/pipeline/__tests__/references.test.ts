import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isInspoBlobUrl,
  kindForContentType,
  MAX_NOTE_CHARS,
  safeFileName,
  validateNote,
  validateReferences,
} from "@/lib/pipeline/references";

const URL_OK = "https://abc123xyz.public.blob.vercel-storage.com/inspo/photo-Xy12.png";

function ref(over: Record<string, unknown> = {}) {
  return { url: URL_OK, kind: "image", fileName: "photo.png", contentType: "image/png", size: 1234, ...over };
}

describe("isInspoBlobUrl", () => {
  it("accepts public Blob URLs under inspo/", () => {
    assert.equal(isInspoBlobUrl(URL_OK), true);
  });

  it("rejects other hosts, http, other prefixes and tricks", () => {
    assert.equal(isInspoBlobUrl("http://abc.public.blob.vercel-storage.com/inspo/a.png"), false);
    assert.equal(isInspoBlobUrl("https://evil.com/inspo/a.png?x=.public.blob.vercel-storage.com"), false);
    assert.equal(isInspoBlobUrl("https://abc.public.blob.vercel-storage.com.evil.com/inspo/a.png"), false);
    assert.equal(isInspoBlobUrl("https://abc.public.blob.vercel-storage.com/uploads/a.png"), false);
    assert.equal(isInspoBlobUrl("https://user:pw@abc.public.blob.vercel-storage.com/inspo/a.png"), false);
    assert.equal(isInspoBlobUrl("https://abc.public.blob.vercel-storage.com:8443/inspo/a.png"), false);
    assert.equal(isInspoBlobUrl("not a url"), false);
  });
});

describe("kindForContentType", () => {
  it("maps allowed types and rejects the rest", () => {
    assert.equal(kindForContentType("image/jpeg"), "image");
    assert.equal(kindForContentType("IMAGE/PNG; charset=binary"), "image");
    assert.equal(kindForContentType("video/mp4"), "video");
    assert.equal(kindForContentType("video/quicktime"), "video");
    assert.equal(kindForContentType("audio/wav"), "audio");
    assert.equal(kindForContentType("audio/x-wav"), "audio");
    assert.equal(kindForContentType("application/pdf"), "pdf");
    assert.equal(kindForContentType("audio/mpeg"), null);
    assert.equal(kindForContentType("video/webm"), null);
    assert.equal(kindForContentType("text/html"), null);
  });
});

describe("safeFileName", () => {
  it("drops directories and odd characters, keeps the extension", () => {
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("C:\\Users\\me\\My Photo (1).JPG"), "My-Photo-1.JPG");
    assert.equal(safeFileName("résumé.pdf"), "resume.pdf");
    assert.equal(safeFileName(".hidden"), "hidden");
    assert.equal(safeFileName("???.png"), "file.png");
    assert.ok(safeFileName(`${"x".repeat(200)}.png`).length <= 80);
    assert.ok(safeFileName(`${"x".repeat(200)}.png`).endsWith(".png"));
  });
});

describe("validateNote", () => {
  it("trims, allows null and blank, caps the length", () => {
    assert.deepEqual(validateNote(undefined), { ok: true, value: null });
    assert.deepEqual(validateNote("   "), { ok: true, value: null });
    assert.deepEqual(validateNote("  make it for my bakery "), { ok: true, value: "make it for my bakery" });
    assert.equal(validateNote(42).ok, false);
    assert.equal(validateNote("x".repeat(MAX_NOTE_CHARS + 1)).ok, false);
    assert.equal(validateNote("x".repeat(MAX_NOTE_CHARS)).ok, true);
  });
});

describe("validateReferences", () => {
  it("accepts good references and normalizes names", () => {
    const result = validateReferences([
      ref(),
      ref({ fileName: "photo.png" }),
      ref({ kind: "pdf", contentType: "application/pdf", fileName: "Menu Card.pdf" }),
    ]);
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.map((r) => r.fileName),
      ["photo.png", "photo-2.png", "Menu-Card.pdf"],
    );
  });

  it("applies a prefix for refinements", () => {
    const result = validateReferences([ref()], { prefix: "abcd1234-" });
    assert.ok(result.ok);
    assert.equal(result.value[0]!.fileName, "abcd1234-photo.png");
  });

  it("allows none", () => {
    assert.deepEqual(validateReferences(undefined), { ok: true, value: [] });
    assert.deepEqual(validateReferences([]), { ok: true, value: [] });
  });

  it("rejects more than 8", () => {
    assert.equal(validateReferences(Array.from({ length: 9 }, () => ref())).ok, false);
    assert.equal(validateReferences(Array.from({ length: 8 }, () => ref())).ok, true);
  });

  it("rejects URLs that didn't come through the inspo upload", () => {
    assert.equal(validateReferences([ref({ url: "https://example.com/inspo/a.png" })]).ok, false);
    assert.equal(
      validateReferences([ref({ url: "https://abc.public.blob.vercel-storage.com/uploads/a.png" })]).ok,
      false,
    );
  });

  it("rejects a kind that doesn't match the content type", () => {
    assert.equal(validateReferences([ref({ kind: "video" })]).ok, false);
    assert.equal(validateReferences([ref({ kind: "audio", contentType: "audio/mpeg" })]).ok, false);
    assert.equal(validateReferences([ref({ kind: "audio", contentType: "audio/wav" })]).ok, true);
  });

  it("rejects bad sizes and missing names", () => {
    assert.equal(validateReferences([ref({ size: 101 * 1024 * 1024 })]).ok, false);
    assert.equal(validateReferences([ref({ size: -1 })]).ok, false);
    assert.equal(validateReferences([ref({ size: "12" })]).ok, false);
    assert.equal(validateReferences([ref({ fileName: "  " })]).ok, false);
    assert.equal(validateReferences("nope").ok, false);
    assert.equal(validateReferences([null]).ok, false);
  });
});
