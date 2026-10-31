import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { markUtf8Names } from "../lib/zip.mjs";

describe("markUtf8Names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "packager-zip-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("sets the flag on every local and central header, and the zip still reads", async () => {
    writeFileSync(path.join(dir, "日本語.txt"), "one");
    writeFileSync(path.join(dir, "plain.txt"), "two");
    const zip = path.join(dir, "out.zip");
    execFileSync("zip", ["-q", "-X", zip, "日本語.txt", "plain.txt"], { cwd: dir, env: { ...process.env, LC_ALL: "en_US.UTF-8" } });
    await markUtf8Names(zip);

    const bytes = readFileSync(zip);
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.equal(bytes.readUInt16LE(end + 10), 2);
    let at = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < 2; i++) {
      assert.equal(bytes.readUInt32LE(at), 0x02014b50);
      assert.ok(bytes.readUInt16LE(at + 8) & 0x0800, "central flag");
      assert.ok(bytes.readUInt16LE(bytes.readUInt32LE(at + 42) + 6) & 0x0800, "local flag");
      at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    execFileSync("unzip", ["-tq", zip], { stdio: "ignore" });
    assert.equal(execFileSync("unzip", ["-p", zip, "plain.txt"], { encoding: "utf8" }), "two");
  });

  it("refuses a file with no end record", async () => {
    const bad = path.join(dir, "bad.zip");
    writeFileSync(bad, Buffer.alloc(100));
    await assert.rejects(markUtf8Names(bad), /no end record/);
  });
});
