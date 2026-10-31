import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { apkSigner, ApkSignError, readApkKey, signApk } from "@/lib/native/apk-sign";

const dir = mkdtempSync(path.join(tmpdir(), "apk-sign-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A throwaway key and certificate. Node can't make a certificate, and openssl is everywhere these tests run. */
function pemFor(name: string, args: string[]): string {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-nodes", ...args, "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${name}`], { stdio: "ignore" });
  return readFileSync(key, "utf8") + readFileSync(cert, "utf8");
}

const rsaPem = pemFor("rsa", ["-newkey", "rsa:2048"]);
const ecPem = pemFor("ec", ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]);

/** A zip with one stored file: the parts v2 cares about, with a comment if asked. */
function fixtureZip(content: Buffer, comment = ""): Buffer {
  const name = Buffer.from("a.txt");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const entries = Buffer.concat([local, name, content]);
  const directory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entries.length, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([entries, directory, end, Buffer.from(comment)]);
}

const fingerprint = (pem: string) => createHash("sha256").update(readApkKey(pem).certificate.raw).digest("hex");
const eocdOf = (zip: Buffer) => zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

describe("signApk", () => {
  const zip = fixtureZip(Buffer.alloc(3 * 1024 * 1024 + 17, 7));

  for (const [what, pem] of [["RSA", rsaPem], ["EC", ecPem]] as const) {
    it(`signs with an ${what} key, and the signature checks out`, () => {
      const signed = signApk(zip, readApkKey(pem));
      assert.equal(apkSigner(signed), fingerprint(pem));
    });
  }

  it("leaves the zip's entries where they were and points the directory past the block", () => {
    const signed = signApk(zip, readApkKey(rsaPem));
    const entriesEnd = zip.readUInt32LE(eocdOf(zip) + 16);
    assert.ok(signed.subarray(0, entriesEnd).equals(zip.subarray(0, entriesEnd)));
    const directory = signed.readUInt32LE(eocdOf(signed) + 16);
    assert.equal(signed.toString("ascii", directory - 16, directory), "APK Sig Block 42");
    assert.equal(signed.readUInt32LE(directory), 0x02014b50);
  });

  it("pads the block to 4 KB, as apksigner does", () => {
    const signed = signApk(zip, readApkKey(rsaPem));
    const entriesEnd = zip.readUInt32LE(eocdOf(zip) + 16);
    assert.equal((signed.readUInt32LE(eocdOf(signed) + 16) - entriesEnd) % 4096, 0);
  });

  it("replaces an earlier signature rather than adding to it", () => {
    const first = signApk(zip, readApkKey(ecPem));
    const second = signApk(first, readApkKey(rsaPem));
    assert.equal(apkSigner(second), fingerprint(rsaPem));
    assert.ok(second.equals(signApk(zip, readApkKey(rsaPem))));
  });

  it("handles a zip with a comment", () => {
    assert.equal(apkSigner(signApk(fixtureZip(Buffer.from("hi"), "a comment"), readApkKey(rsaPem))), fingerprint(rsaPem));
  });

  it("refuses a file that isn't a zip", () => {
    assert.throws(() => signApk(Buffer.alloc(1000), readApkKey(rsaPem)), ApkSignError);
  });
});

describe("apkSigner", () => {
  const signed = signApk(fixtureZip(Buffer.from("the contents")), readApkKey(rsaPem));

  it("says null for an unsigned zip", () => assert.equal(apkSigner(fixtureZip(Buffer.from("x"))), null));

  it("catches a changed file", () => {
    const changed = Buffer.from(signed);
    changed[signed.indexOf("the contents")] ^= 1;
    assert.equal(apkSigner(changed), null);
  });

  it("catches a changed directory", () => {
    const changed = Buffer.from(signed);
    changed[signed.lastIndexOf(Buffer.from("a.txt"))] ^= 1;
    assert.equal(apkSigner(changed), null);
  });

  it("catches a changed digest inside the signed data", () => {
    const changed = Buffer.from(signed);
    const entriesEnd = "the contents".length + "a.txt".length + 30;
    // Block size, pair length and id, then the four length prefixes before the digests start.
    changed[entriesEnd + 8 + 12 + 4 * 4 + 12] ^= 1;
    assert.equal(apkSigner(changed), null);
  });
});

describe("readApkKey", () => {
  it("refuses a key and certificate that don't match", () => {
    const key = rsaPem.slice(0, rsaPem.indexOf("-----BEGIN CERTIFICATE"));
    const cert = ecPem.slice(ecPem.indexOf("-----BEGIN CERTIFICATE"));
    assert.throws(() => readApkKey(key + cert), /doesn't match/);
  });

  it("refuses text that isn't a key, without repeating it", () => {
    assert.throws(
      () => readApkKey("secret text"),
      (err: Error) => err instanceof ApkSignError && !err.message.includes("secret text"),
    );
  });

  it("opens a key with a passphrase", () => {
    const key = path.join(dir, "enc.key");
    execFileSync("openssl", ["pkcs8", "-topk8", "-in", path.join(dir, "rsa.key"), "-out", key, "-passout", "pass:hunter2"], { stdio: "ignore" });
    const pem = readFileSync(key, "utf8") + readFileSync(path.join(dir, "rsa.crt"), "utf8");
    assert.equal(createHash("sha256").update(readApkKey(pem, "hunter2").certificate.raw).digest("hex"), fingerprint(rsaPem));
    assert.throws(() => readApkKey(pem, "wrong"), ApkSignError);
  });
});
