import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { getString } from "../lib/plist.mjs";
import { packageMac, patchHelperPlist, patchMainPlist, productConfig } from "../lib/mac.mjs";

const sharp = await import("sharp").then((m) => m.default).catch(() => null);
const product = { name: "Fern & Moss", fileName: "Fern & Moss", url: "https://fern.vercel.app/", packageId: "ai.musemuse.p0123456789abcdef", version: "1.0.0" };
const plist = (name, extra = "") => `<plist><dict><key>CFBundleName</key><string>${name}</string><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>ai.musemuse.desktop</string>${extra}</dict></plist>`;

describe("the Mac's edits", () => {
  it("writes the settings file the shell reads", () => {
    assert.deepEqual(JSON.parse(productConfig(product)), { name: "Fern & Moss", url: "https://fern.vercel.app/", shellVersion: "1.0.0" });
  });
  it("makes the main bundle this product's", () => {
    const out = patchMainPlist(plist("Muse Muse"), product);
    assert.equal(getString(out, "CFBundleName"), "Fern & Moss");
    assert.equal(getString(out, "CFBundleDisplayName"), "Fern & Moss");
    assert.equal(getString(out, "CFBundleExecutable"), "Fern & Moss");
    assert.equal(getString(out, "CFBundleIdentifier"), product.packageId);
  });
  it("renames helpers keeping the suffix Chromium looks for", () => {
    const gpu = patchHelperPlist(plist("Muse Muse Helper (GPU)"), product, " (GPU)");
    assert.equal(getString(gpu, "CFBundleName"), "Fern & Moss Helper (GPU)");
    assert.equal(getString(gpu, "CFBundleIdentifier"), `${product.packageId}.helper.gpu`);
    assert.equal(getString(patchHelperPlist(plist("Muse Muse Helper"), product, ""), "CFBundleIdentifier"), `${product.packageId}.helper`);
  });
});

describe("packageMac", { skip: !sharp && "run npm install in native/packager" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "packager-mac-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A folder laid out like the Electron template, and a stand-in for rcodesign that records its arguments. */
  function fixture() {
    const app = path.join(dir, "src", "Muse Muse.app", "Contents");
    for (const sub of ["MacOS", "Resources", "Frameworks/Electron Framework.framework/Versions/A"]) mkdirSync(path.join(app, sub), { recursive: true });
    writeFileSync(path.join(app, "Info.plist"), plist("Muse Muse", "<key>CFBundleIconFile</key><string>electron.icns</string>"));
    writeFileSync(path.join(app, "MacOS", "Muse Muse"), "bin");
    writeFileSync(path.join(app, "Resources", "muse-product.json"), "{}");
    writeFileSync(path.join(app, "Frameworks/Electron Framework.framework/Versions/A/Electron Framework"), "fw");
    symlinkSync("Versions/A/Electron Framework", path.join(app, "Frameworks/Electron Framework.framework/Electron Framework"));
    for (const suffix of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
      const helper = path.join(app, "Frameworks", `Muse Muse Helper${suffix}.app`, "Contents");
      mkdirSync(path.join(helper, "MacOS"), { recursive: true });
      writeFileSync(path.join(helper, "Info.plist"), plist(`Muse Muse Helper${suffix}`));
      writeFileSync(path.join(helper, "MacOS", `Muse Muse Helper${suffix}`), "bin");
    }
    const template = path.join(dir, "template.zip");
    execFileSync("zip", ["-y", "-r", "-q", template, "Muse Muse.app"], { cwd: path.join(dir, "src") });
    const signer = path.join(dir, "fake-rcodesign");
    writeFileSync(signer, `#!/bin/sh\necho "$@" > ${JSON.stringify(path.join(dir, "signed-args"))}\n`);
    chmodSync(signer, 0o755);
    return { template, signer };
  }

  it("makes a zip of the product's app, signed last, with symlinks kept", async () => {
    const { template, signer } = fixture();
    const master = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#123456" } }).png().toBuffer();
    const workDir = path.join(dir, "work");
    const made = await packageMac({ template, product, workDir, sharp, master, rcodesign: signer });

    const bundle = path.join(workDir, "Fern & Moss.app");
    assert.equal(readFileSync(path.join(dir, "signed-args"), "utf8").trim(), `sign ${bundle}`);
    assert.ok(!existsSync(path.join(workDir, "Muse Muse.app")));
    assert.ok(existsSync(path.join(bundle, "Contents/MacOS/Fern & Moss")));
    assert.ok(existsSync(path.join(bundle, "Contents/Frameworks/Fern & Moss Helper (Renderer).app/Contents/MacOS/Fern & Moss Helper (Renderer)")));
    assert.equal(JSON.parse(readFileSync(path.join(bundle, "Contents/Resources/muse-product.json"), "utf8")).url, product.url);
    assert.equal(readFileSync(path.join(bundle, "Contents/Resources/electron.icns")).toString("ascii", 0, 4), "icns");
    assert.equal(getString(readFileSync(path.join(bundle, "Contents/Info.plist"), "utf8"), "CFBundleIdentifier"), product.packageId);

    const listing = execFileSync("zipinfo", [made.path], { encoding: "utf8" });
    assert.match(listing, /^l.*Electron Framework\.framework\/Electron Framework$/m);
    assert.ok(made.timings.sign >= 0);
  });
});
