import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { icoFile, ICO_SIZES, iconAt } from "../lib/icons.mjs";
import { packageWindows, patchExe, readExe } from "../lib/windows.mjs";

const resedit = await import("resedit").catch(() => null);
const sharp = await import("sharp").then((m) => m.default).catch(() => null);
const PNG_SIZE = 16;

/** A small exe with an icon and version info, built with resedit as electron.exe has them. */
async function fixtureExe() {
  const { NtExecutable, NtExecutableResource, Data, Resource } = resedit;
  const exe = NtExecutable.createEmpty();
  const res = NtExecutableResource.from(exe);
  const png = await sharp({ create: { width: PNG_SIZE, height: PNG_SIZE, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const icon = Data.IconFile.from(icoFile(new Map(ICO_SIZES.map((size) => [size, png]))));
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map((i) => i.data));
  const version = Resource.VersionInfo.createEmpty();
  version.lang = 1033;
  version.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: "Muse Muse" });
  version.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

describe("patchExe", { skip: (!resedit || !sharp) && "run npm install in native/packager" }, () => {
  const product = { name: "Fern & Moss", fileName: "Fern & Moss", version: "1.2.3" };
  it("sets the version text and replaces the icon, and they read back", async () => {
    const pngs = new Map();
    const master = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00ff00" } }).png().toBuffer();
    for (const size of ICO_SIZES) pngs.set(size, await iconAt(sharp, master, size, "rounded"));
    const patched = await patchExe(await fixtureExe(), icoFile(pngs), product, resedit);
    const read = readExe(patched, resedit);
    assert.equal(read.strings.ProductName, "Fern & Moss");
    assert.equal(read.strings.FileDescription, "Fern & Moss");
    assert.equal(read.strings.OriginalFilename, "Fern & Moss.exe");
    assert.equal(read.strings.FileVersion, "1.2.3");
    assert.deepEqual(read.iconSizes, ICO_SIZES);
    assert.ok(read.iconImages[0].equals(pngs.get(ICO_SIZES[0])));
  });
  it("packages a product named like the zip it writes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "windows-name-"));
    try {
      mkdirSync(path.join(dir, "src", "win-unpacked", "resources"), { recursive: true });
      writeFileSync(path.join(dir, "src", "win-unpacked", "Muse Muse.exe"), await fixtureExe());
      execFileSync("zip", ["-r", "-q", path.join(dir, "template.zip"), "win-unpacked"], { cwd: path.join(dir, "src") });
      const master = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00ff00" } }).png().toBuffer();
      const named = { name: "product.zip", fileName: "product.zip", url: "https://fern.vercel.app/", version: "1.2.3" };
      const made = await packageWindows({ template: path.join(dir, "template.zip"), product: named, workDir: path.join(dir, "work"), sharp, master });
      assert.match(execFileSync("unzip", ["-Z1", made.path], { encoding: "utf8" }), /^product\.zip\/product\.zip\.exe$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses an exe with no icon to replace", async () => {
    const { NtExecutable } = resedit;
    const empty = Buffer.from(NtExecutable.createEmpty().generate());
    const png = await sharp({ create: { width: PNG_SIZE, height: PNG_SIZE, channels: 4, background: "#ff0000" } }).png().toBuffer();
    await assert.rejects(patchExe(empty, icoFile(new Map(ICO_SIZES.map((size) => [size, png]))), product, resedit), /no icon/);
  });
});
