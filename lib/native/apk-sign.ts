/**
 * APK Signature Scheme v2, in the platform. The packager sandbox holds no credentials (docs/NATIVE_PACKAGER.md), so an APK
 * leaves it with the public debug key, and this replaces that signature with the platform's key. Nothing inside the zip
 * changes, so the alignment apksigner gave it stays. Every shell has a minSdk of 24 or more, so no v1 signature is needed.
 *
 * The format is at https://source.android.com/docs/security/features/apksigning/v2. The Oct 31 spike checked this file's
 * output with the real apksigner (docs/spikes/packager-2026-10-31/README.md).
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, X509Certificate, type KeyObject } from "node:crypto";

const BLOCK_MAGIC = Buffer.from("APK Sig Block 42", "ascii");
const EOCD_MAGIC = 0x06054b50;
const EOCD_BYTES = 22;
const V2_BLOCK_ID = 0x7109871a;
const PADDING_BLOCK_ID = 0x42726577;
const CHUNK_BYTES = 1024 * 1024;
const BLOCK_ALIGN = 4096;
const RSA_SHA256 = 0x0103;
const ECDSA_SHA256 = 0x0201;

export class ApkSignError extends Error {}

export interface ApkKey {
  key: KeyObject;
  certificate: X509Certificate;
}

/** A key and its certificate from one PEM text, as `NATIVE_APK_KEYSTORE_B64` holds them. Throws when they don't match. */
export function readApkKey(pem: string, passphrase?: string | null): ApkKey {
  let key: KeyObject;
  let certificate: X509Certificate;
  try {
    key = createPrivateKey({ key: pem, ...(passphrase ? { passphrase } : {}) });
    certificate = new X509Certificate(pem);
  } catch {
    // The reason from OpenSSL can quote the input, so it isn't passed on.
    throw new ApkSignError("The APK signing key isn't a PEM private key and certificate.");
  }
  if (!certificate.checkPrivateKey(key)) throw new ApkSignError("The APK signing key doesn't match its certificate.");
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ec") throw new ApkSignError("The APK signing key must be RSA or EC.");
  return { key, certificate };
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function prefixed(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]);
}

interface Layout {
  /** Where the zip entries end: the signing block's start if there is one, otherwise the central directory's. */
  entriesEnd: number;
  centralDirectory: number;
  eocd: number;
}

function layoutOf(apk: Buffer): Layout {
  const lowest = Math.max(0, apk.length - EOCD_BYTES - 0xffff);
  for (let at = apk.length - EOCD_BYTES; at >= lowest; at--) {
    if (apk.readUInt32LE(at) !== EOCD_MAGIC) continue;
    if (apk.readUInt16LE(at + 20) !== apk.length - at - EOCD_BYTES) continue;
    const centralDirectory = apk.readUInt32LE(at + 16);
    if (centralDirectory > at) throw new ApkSignError("This APK's zip directory isn't where it says.");
    let entriesEnd = centralDirectory;
    if (centralDirectory >= 32 && apk.subarray(centralDirectory - 16, centralDirectory).equals(BLOCK_MAGIC)) {
      const size = Number(apk.readBigUInt64LE(centralDirectory - 24));
      entriesEnd = centralDirectory - size - 8;
      if (entriesEnd < 0) throw new ApkSignError("This APK's signing block isn't valid.");
    }
    return { entriesEnd, centralDirectory, eocd: at };
  }
  throw new ApkSignError("This file isn't a zip.");
}

/** What v2 signs: every 1 MB chunk's hash, then a hash of those. The directory's offset reads as the signing block's start. */
function digestOf(apk: Buffer, { entriesEnd, centralDirectory, eocd }: Layout): Buffer {
  const end = Buffer.from(apk.subarray(eocd));
  end.writeUInt32LE(entriesEnd, 16);
  const sections = [apk.subarray(0, entriesEnd), apk.subarray(centralDirectory, eocd), end];
  const top = createHash("sha256");
  let chunks = 0;
  const hashes: Buffer[] = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += CHUNK_BYTES) {
      const chunk = section.subarray(at, at + CHUNK_BYTES);
      hashes.push(createHash("sha256").update(Buffer.from([0xa5])).update(u32(chunk.length)).update(chunk).digest());
      chunks++;
    }
  }
  top.update(Buffer.from([0x5a])).update(u32(chunks));
  for (const hash of hashes) top.update(hash);
  return top.digest();
}

function signingBlock(digest: Buffer, { key, certificate }: ApkKey): Buffer {
  const algorithm = key.asymmetricKeyType === "rsa" ? RSA_SHA256 : ECDSA_SHA256;
  const signedData = Buffer.concat([
    prefixed(prefixed(u32(algorithm), prefixed(digest))),
    prefixed(prefixed(certificate.raw)),
    prefixed(),
  ]);
  const signature = sign("sha256", signedData, key);
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
  const signer = prefixed(prefixed(signedData), prefixed(prefixed(u32(algorithm), prefixed(signature))), prefixed(publicKey));
  const value = prefixed(signer);
  const pair = Buffer.concat([u64(value.length + 4), u32(V2_BLOCK_ID), value]);

  // Size field, pairs, size field, magic. Android maps what follows in pages, so apksigner pads the block to 4 KB.
  const withoutPadding = 8 + pair.length + 8 + BLOCK_MAGIC.length;
  let extra = (BLOCK_ALIGN - (withoutPadding % BLOCK_ALIGN)) % BLOCK_ALIGN;
  if (extra > 0 && extra < 12) extra += BLOCK_ALIGN;
  const padding = extra ? Buffer.concat([u64(extra - 8), u32(PADDING_BLOCK_ID), Buffer.alloc(extra - 12)]) : Buffer.alloc(0);
  const size = u64(pair.length + padding.length + 8 + BLOCK_MAGIC.length);
  return Buffer.concat([size, pair, padding, size, BLOCK_MAGIC]);
}

/** The APK signed with `key`, replacing every signature it had. */
export function signApk(apk: Buffer, key: ApkKey): Buffer {
  const layout = layoutOf(apk);
  const block = signingBlock(digestOf(apk, layout), key);
  const end = Buffer.from(apk.subarray(layout.eocd));
  end.writeUInt32LE(layout.entriesEnd + block.length, 16);
  return Buffer.concat([apk.subarray(0, layout.entriesEnd), block, apk.subarray(layout.centralDirectory, layout.eocd), end]);
}

function readPrefixed(buffer: Buffer, at: number): { body: Buffer; next: number } {
  const length = buffer.readUInt32LE(at);
  return { body: buffer.subarray(at + 4, at + 4 + length), next: at + 4 + length };
}

/**
 * Checks a v2 signature as Android does and returns the certificate's SHA-256, or null when it doesn't hold. Runs on
 * every APK before it's offered, since a wrong signature only shows up at install, on someone's phone.
 */
export function apkSigner(apk: Buffer): string | null {
  try {
    const { entriesEnd, centralDirectory } = layoutOf(apk);
    if (entriesEnd === centralDirectory) return null;
    let at = entriesEnd + 8;
    const pairsEnd = centralDirectory - 24;
    let value: Buffer | null = null;
    while (at < pairsEnd) {
      const length = Number(apk.readBigUInt64LE(at));
      if (apk.readUInt32LE(at + 8) === V2_BLOCK_ID) value = apk.subarray(at + 12, at + 8 + length);
      at += 8 + length;
    }
    if (!value) return null;

    const signer = readPrefixed(readPrefixed(value, 0).body, 0).body;
    const signedData = readPrefixed(signer, 0);
    const signatures = readPrefixed(signer, signedData.next);
    const publicKey = readPrefixed(signer, signatures.next).body;
    const firstSignature = readPrefixed(signatures.body, 0).body;
    const signature = readPrefixed(firstSignature, 4).body;
    const key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
    if (!verify("sha256", signedData.body, key, signature)) return null;

    const digests = readPrefixed(signedData.body, 0);
    const claimed = readPrefixed(readPrefixed(digests.body, 0).body, 4).body;
    if (!claimed.equals(digestOf(apk, layoutOf(apk)))) return null;

    const certificates = readPrefixed(signedData.body, digests.next);
    const certificate = readPrefixed(certificates.body, 0).body;
    return createHash("sha256").update(certificate).digest("hex");
  } catch {
    return null;
  }
}
