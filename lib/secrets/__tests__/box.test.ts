/**
 * The sealed box (lib/secrets/box.ts): a round trip, the additional data binding each secret to its place, key rings
 * and rotation, and errors that never carry a secret.
 *
 *   npx tsx --test lib/secrets/__tests__/box.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newBoxKey, openSecret, parseKeyring, sealSecret, SecretBoxError, SECRET_MAX_BYTES } from "@/lib/secrets/box";

const SECRET = "ghp_madeUpTokenForTests1234567890";

describe("the sealed box", () => {
  it("opens what it sealed, with a fresh IV every time and no plaintext in the ciphertext", () => {
    const ring = parseKeyring(newBoxKey())!;
    const a = sealSecret(SECRET, ring, "vault:p1:github");
    const b = sealSecret(SECRET, ring, "vault:p1:github");
    assert.equal(openSecret(a, ring, "vault:p1:github"), SECRET);
    assert.notDeepEqual(a.iv, b.iv);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
    assert.equal(a.iv.length, 12);
    assert.equal(a.tag.length, 16);
    assert.equal(a.keyVersion, 1);
    assert.ok(!a.ciphertext.toString("utf8").includes("ghp_"));
  });

  it("refuses another place's additional data, a changed byte, a changed tag and another key, saying nothing more", () => {
    const ring = parseKeyring(newBoxKey())!;
    const sealed = sealSecret(SECRET, ring, "vault:p1:github");
    const tries = [
      () => openSecret(sealed, ring, "vault:p2:github"),
      () => openSecret(sealed, ring, "vault:p1:other"),
      () => openSecret({ ...sealed, ciphertext: Buffer.from(sealed.ciphertext.map((x, i) => (i === 0 ? x ^ 1 : x))) }, ring, "vault:p1:github"),
      () => openSecret({ ...sealed, tag: Buffer.alloc(16) }, ring, "vault:p1:github"),
      () => openSecret(sealed, parseKeyring(newBoxKey())!, "vault:p1:github"),
      () => openSecret({ ...sealed, iv: Buffer.alloc(8) }, ring, "vault:p1:github"),
    ];
    for (const t of tries) {
      assert.throws(t, (err: unknown) => err instanceof SecretBoxError && !String((err as Error).message).includes(SECRET));
    }
  });

  it("reads a key ring, seals with its newest version and still opens the older one's rows", () => {
    const [k1, k2] = [newBoxKey(), newBoxKey()];
    const old = parseKeyring(k1)!;
    const sealed = sealSecret(SECRET, old, "x");
    const ring = parseKeyring(`v1:${k1}, v2:${k2}`)!;
    assert.equal(ring.current, 2);
    assert.equal(openSecret(sealed, ring, "x"), SECRET);
    assert.equal(sealSecret(SECRET, ring, "x").keyVersion, 2);
    assert.throws(() => openSecret(sealed, parseKeyring(`v2:${k2}`)!, "x"), SecretBoxError);
  });

  it("is unset with no setting, and refuses a key that isn't 32 bytes or a ring with a repeated version", () => {
    assert.equal(parseKeyring(undefined), null);
    assert.equal(parseKeyring("  "), null);
    assert.throws(() => parseKeyring(Buffer.alloc(16).toString("base64")), SecretBoxError);
    assert.throws(() => parseKeyring("not base64 at all!"), SecretBoxError);
    const k = newBoxKey();
    assert.throws(() => parseKeyring(`v1:${k},v1:${k}`), SecretBoxError);
    assert.throws(() => parseKeyring(`v0:${k}`), SecretBoxError);
    assert.equal(parseKeyring(Buffer.alloc(32, 1).toString("base64url"))!.keys.get(1)!.length, 32, "base64url works too");
  });

  it("seals 1 byte to 8 KB, nothing else", () => {
    const ring = parseKeyring(newBoxKey())!;
    assert.throws(() => sealSecret("", ring, "x"), SecretBoxError);
    assert.throws(() => sealSecret("a".repeat(SECRET_MAX_BYTES + 1), ring, "x"), SecretBoxError);
    assert.equal(openSecret(sealSecret("a".repeat(SECRET_MAX_BYTES), ring, "x"), ring, "x").length, SECRET_MAX_BYTES);
  });
});
