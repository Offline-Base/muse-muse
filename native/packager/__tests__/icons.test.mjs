import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { icnsFile, ICNS_TYPES, icoFile, ICO_SIZES, masterIcon, tileColor, tileLetter, tileSvg } from "../lib/icons.mjs";

const sharp = await import("sharp").then((m) => m.default).catch(() => null);

describe("the letter tile", () => {
  it("shows the name's first letter or digit", () => {
    assert.equal(tileLetter("fern & moss"), "F");
    assert.equal(tileLetter("  3D Lab"), "3");
    assert.equal(tileLetter("Éa"), "E");
    assert.equal(tileLetter("🌿🌿"), "M");
  });
  it("gives a name the same color every time", () => {
    assert.equal(tileColor("Fern"), tileColor("Fern"));
  });
  it("can't be broken out of by a name", () => {
    assert.ok(!tileSvg("<script>").includes("<script"));
  });
});

describe("icon containers", () => {
  const fake = (size) => Buffer.from(`png-${size}`);
  it("writes ICNS entries with their lengths", () => {
    const icns = icnsFile(new Map(ICNS_TYPES.map(([, size]) => [size, fake(size)])));
    assert.equal(icns.toString("ascii", 0, 4), "icns");
    assert.equal(icns.readUInt32BE(4), icns.length);
    let at = 8;
    for (const [type, size] of ICNS_TYPES) {
      assert.equal(icns.toString("ascii", at, at + 4), type);
      assert.equal(icns.readUInt32BE(at + 4), fake(size).length + 8);
      at += icns.readUInt32BE(at + 4);
    }
    assert.equal(at, icns.length);
  });
  it("writes an ICO directory that points at each image", () => {
    const ico = icoFile(new Map(ICO_SIZES.map((size) => [size, fake(size)])));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
    ICO_SIZES.forEach((size, i) => {
      const at = 6 + 16 * i;
      assert.equal(ico[at], size === 256 ? 0 : size);
      const offset = ico.readUInt32LE(at + 12);
      assert.equal(ico.toString("ascii", offset, offset + ico.readUInt32LE(at + 8)), `png-${size}`);
    });
  });
});

describe("the master icon", { skip: !sharp && "run npm install in native/packager" }, () => {
  it("uses the product's picture, square, at 1024", async () => {
    const source = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#123456" } }).png().toBuffer();
    const { png, fromProduct, warning } = await masterIcon(sharp, "Fern", source);
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height, fromProduct, warning], [1024, 1024, true, null]);
  });
  it("falls back on the tile, and says so, for a picture it can't read", async () => {
    const { fromProduct, warning } = await masterIcon(sharp, "Fern", Buffer.from("not an image"));
    assert.equal(fromProduct, false);
    assert.match(warning, /letter tile/);
  });
  it("makes a tile with no warning when there's no picture", async () => {
    const { png, fromProduct, warning } = await masterIcon(sharp, "Fern", null);
    assert.equal((await sharp(png).metadata()).width, 1024);
    assert.deepEqual([fromProduct, warning], [false, null]);
  });
});
