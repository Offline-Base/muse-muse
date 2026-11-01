import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * A small sealed box for secrets the platform keeps for someone else (docs/CAPABILITIES.md, section 11): AES-256-GCM
 * with a 96-bit random IV, a 128-bit tag, and additional data that binds each ciphertext to where it belongs, so a row
 * copied to another product or another name doesn't open. Unit 5's key vault uses it with CONNECT_VAULT_KEY, and unit 13
 * reuses it for the board registry with a key of its own.
 *
 * Nothing here logs, and no error says anything about the plaintext or the key: an error is "doesn't open", nothing
 * more. Plaintext lives only in the caller's function, as briefly as it can.
 */

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** Which key of the ring sealed it, so keys can be rotated: old rows open with their own version. */
  keyVersion: number;
}

/** Every key a box knows, by version, and the version new secrets are sealed with. */
export interface BoxKeyring {
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

/** Thrown by openSecret and keyring problems. The message never holds a secret. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A sealed secret is at most this long before sealing. Keys and tokens are far shorter. */
export const SECRET_MAX_BYTES = 8 * 1024;

function decodeKey(text: string): Buffer | null {
  const t = text.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  const key = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === KEY_BYTES ? key : null;
}

/**
 * Reads a key setting: one 32-byte key in base64 (version 1), or a ring "v1:<base64>,v2:<base64>" whose highest version
 * seals new secrets. Null when unset. Throws SecretBoxError when it is set but isn't 32 bytes, so a typo can't seal
 * anything with a weak key.
 */
export function parseKeyring(raw: string | null | undefined): BoxKeyring | null {
  const text = raw?.trim();
  if (!text) return null;
  const keys = new Map<number, Buffer>();
  if (!text.includes(":")) {
    const key = decodeKey(text);
    if (!key) throw new SecretBoxError("The key isn't 32 bytes of base64.");
    keys.set(1, key);
    return { current: 1, keys };
  }
  for (const part of text.split(",")) {
    const m = part.trim().match(/^v(\d{1,4}):(.+)$/);
    const key = m ? decodeKey(m[2]!) : null;
    const version = m ? Number(m[1]) : 0;
    if (!m || !key || version < 1 || keys.has(version)) throw new SecretBoxError("The key ring is v<n>:<32 bytes of base64>, comma separated, each version once.");
    keys.set(version, key);
  }
  return { current: Math.max(...keys.keys()), keys };
}

/** Seals a secret with the ring's current key. `aad` names where it belongs, like "vault:<productId>:<name>". */
export function sealSecret(plaintext: string, ring: BoxKeyring, aad: string): SealedSecret {
  const bytes = Buffer.from(plaintext, "utf8");
  if (!bytes.length || bytes.length > SECRET_MAX_BYTES) throw new SecretBoxError(`A secret is 1 to ${SECRET_MAX_BYTES} bytes.`);
  const key = ring.keys.get(ring.current);
  if (!key) throw new SecretBoxError("The key ring has no current key.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  bytes.fill(0);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: ring.current };
}

/** Opens a sealed secret, or throws SecretBoxError: wrong key, wrong `aad`, or anything changed. */
export function openSecret(sealed: SealedSecret, ring: BoxKeyring, aad: string): string {
  const key = ring.keys.get(sealed.keyVersion);
  if (!key) throw new SecretBoxError("This secret was sealed with a key the ring no longer has.");
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) throw new SecretBoxError("This secret doesn't open.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("This secret doesn't open.");
  }
}

/** A fresh key for a setting such as CONNECT_VAULT_KEY: 32 random bytes in base64. */
export function newBoxKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
