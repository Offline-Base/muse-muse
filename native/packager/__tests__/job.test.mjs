import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanName, fileName, JobError, parseJob } from "../lib/job.mjs";

const sha = "a".repeat(64);
function job(overrides = {}) {
  return {
    v: 1,
    shellVersion: "1.0.0",
    product: { name: "Fern & Moss", url: "https://fern.vercel.app/", packageId: "ai.musemuse.p0123456789abcdef" },
    templates: { mac: { sha256: sha } },
    outputs: { mac: { method: "keep", name: "mac", pathname: "native/x.zip" } },
    ...overrides,
  };
}

describe("cleanName", () => {
  it("drops control and bidi characters and folds spaces", () => {
    assert.equal(cleanName("  Fern\n\t&‮ Moss\u0000 "), "Fern & Moss");
  });
  it("keeps at most 80 characters, counting by code point", () => {
    assert.equal([...cleanName("🌿".repeat(100))].length, 80);
  });
});

describe("fileName", () => {
  it("removes what macOS and Windows can't have in a file name", () => {
    assert.equal(fileName('A/B:C*D?"E<F>G|H\\I'), "A B C D E F G H I");
  });
  it("can't climb out of its folder or hide", () => {
    assert.equal(fileName("../../evil"), "evil");
    assert.equal(fileName(".hidden."), "hidden");
    assert.equal(fileName("-rf"), "rf");
  });
  it("falls back on a name Windows reserves or nothing left", () => {
    assert.equal(fileName("CON"), "Muse App");
    assert.equal(fileName("lpt1"), "Muse App");
    assert.equal(fileName("///"), "Muse App");
  });
});

describe("parseJob", () => {
  it("returns what the script reads, with the shell version as the app's version", () => {
    const parsed = parseJob(job());
    assert.deepEqual(parsed.kinds, ["mac"]);
    assert.equal(parsed.product.fileName, "Fern & Moss");
    assert.equal(parsed.product.version, "1.0.0");
  });
  for (const [what, overrides] of [
    ["another version", { v: 2 }],
    ["no name", { product: { url: "https://a.b/", packageId: "ai.musemuse.p0123456789abcdef" } }],
    ["an http link", { product: { name: "A", url: "http://a.b/", packageId: "ai.musemuse.p0123456789abcdef" } }],
    ["a link with a password", { product: { name: "A", url: "https://u:p@a.b/", packageId: "ai.musemuse.p0123456789abcdef" } }],
    ["a package id it didn't make", { product: { name: "A", url: "https://a.b/", packageId: "com.evil" } }],
    ["a version with a slash", { shellVersion: "../1" }],
    ["no outputs", { outputs: {} }],
    ["a template with no checksum", { templates: { mac: {} } }],
  ]) {
    it(`refuses ${what}`, () => assert.throws(() => parseJob(job(overrides)), JobError));
  }
});
