import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { getString, setString } from "../lib/plist.mjs";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleName</key>
    <string>Muse Muse</string>
  </dict>
</plist>`;

describe("plist", () => {
  it("escapes a name and reads it back", () => {
    const out = setString(PLIST, "CFBundleName", "Fern & <Moss>");
    assert.equal(getString(out, "CFBundleName"), "Fern & <Moss>");
    assert.ok(out.includes("Fern &amp; &lt;Moss&gt;"));
  });
  it("adds a key that isn't there", () => {
    assert.equal(getString(setString(PLIST, "CFBundleDisplayName", "Fern"), "CFBundleDisplayName"), "Fern");
  });
  it("doesn't read a replacement pattern in a name as one", () => {
    assert.equal(getString(setString(PLIST, "CFBundleName", "$& $1 $`"), "CFBundleName"), "$& $1 $`");
  });
  it("gives a file macOS's own parser accepts", { skip: process.platform !== "darwin" }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plist-"));
    try {
      const file = path.join(dir, "Info.plist");
      writeFileSync(file, setString(setString(PLIST, "CFBundleName", 'Fern & "Moss" </string>'), "CFBundleExecutable", "Fern"));
      assert.equal(execFileSync("plutil", ["-extract", "CFBundleName", "raw", file], { encoding: "utf8" }).trim(), 'Fern & "Moss" </string>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
