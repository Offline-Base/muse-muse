import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Passkeys for end users (docs/CAPABILITIES.md, section 9), checked with node:crypto alone: a small CBOR reader for
 * what an authenticator sends, the authenticator data, COSE keys (ES256, EdDSA, RS256) and the two ceremonies' checks.
 * Attestation isn't trusted or needed: the platform asks for "none" and only keeps the public key, so a passkey proves
 * the same person comes back, nothing about their device. Written for this platform from the WebAuthn Level 3 spec.
 */

// ---------------------------------------------------------------------------------------------------------------
// CBOR (RFC 8949), only what WebAuthn sends: definite lengths, integers, byte and text strings, arrays, maps, tags and
// the simple values. Anything else is refused.

export type Cbor = number | bigint | string | Buffer | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

export class CborError extends Error {}

const MAX_DEPTH = 16;

function readLength(buf: Buffer, at: number, info: number): { value: number; next: number } {
  if (info < 24) return { value: info, next: at };
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (!size) throw new CborError("CBOR length isn't definite.");
  if (at + size > buf.length) throw new CborError("CBOR ends early.");
  if (size === 8) {
    const big = buf.readBigUInt64BE(at);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("CBOR number is too big.");
    return { value: Number(big), next: at + 8 };
  }
  return { value: buf.readUIntBE(at, size), next: at + size };
}

function readItem(buf: Buffer, at: number, depth: number): { value: Cbor; next: number } {
  if (depth > MAX_DEPTH) throw new CborError("CBOR nests too deep.");
  if (at >= buf.length) throw new CborError("CBOR ends early.");
  const head = buf[at]!;
  const major = head >> 5;
  const info = head & 31;
  if (major === 7) {
    if (info === 20) return { value: false, next: at + 1 };
    if (info === 21) return { value: true, next: at + 1 };
    if (info === 22) return { value: null, next: at + 1 };
    if (info === 23) return { value: undefined, next: at + 1 };
    if (info === 25 && at + 3 <= buf.length) return { value: halfFloat(buf.readUInt16BE(at + 1)), next: at + 3 };
    if (info === 26 && at + 5 <= buf.length) return { value: buf.readFloatBE(at + 1), next: at + 5 };
    if (info === 27 && at + 9 <= buf.length) return { value: buf.readDoubleBE(at + 1), next: at + 9 };
    throw new CborError("CBOR has a value this reader doesn't take.");
  }
  const { value: n, next } = readLength(buf, at + 1, info);
  switch (major) {
    case 0:
      return { value: n, next };
    case 1:
      return { value: -1 - n, next };
    case 2:
    case 3: {
      if (next + n > buf.length) throw new CborError("CBOR ends early.");
      const bytes = buf.subarray(next, next + n);
      return { value: major === 2 ? Buffer.from(bytes) : bytes.toString("utf8"), next: next + n };
    }
    case 4: {
      const out: Cbor[] = [];
      let p = next;
      for (let i = 0; i < n; i++) {
        const item = readItem(buf, p, depth + 1);
        out.push(item.value);
        p = item.next;
      }
      return { value: out, next: p };
    }
    case 5: {
      const out = new Map<Cbor, Cbor>();
      let p = next;
      for (let i = 0; i < n; i++) {
        const key = readItem(buf, p, depth + 1);
        const value = readItem(buf, key.next, depth + 1);
        out.set(key.value, value.value);
        p = value.next;
      }
      return { value: out, next: p };
    }
    case 6:
      return readItem(buf, next, depth + 1);
    default:
      throw new CborError("CBOR has a value this reader doesn't take.");
  }
}

function halfFloat(h: number): number {
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** One CBOR item from the start of `buf`, and where it ends. */
export function decodeCborFirst(buf: Buffer): { value: Cbor; length: number } {
  const { value, next } = readItem(buf, 0, 0);
  return { value, length: next };
}

/** Exactly one CBOR item, with nothing after it. */
export function decodeCbor(buf: Buffer): Cbor {
  const { value, length } = decodeCborFirst(buf);
  if (length !== buf.length) throw new CborError("CBOR has bytes after its value.");
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Authenticator data and COSE keys

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  coseKey?: Map<Cbor, Cbor>;
}

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new CborError("The authenticator data is too short.");
  const rpIdHash = data.subarray(0, 32);
  const flags = data[32]!;
  const signCount = data.readUInt32BE(33);
  const out: AuthData = { rpIdHash: Buffer.from(rpIdHash), flags, signCount };
  let at = 37;
  if (flags & FLAG_AT) {
    if (data.length < at + 18) throw new CborError("The authenticator data has no room for a credential.");
    at += 16; // aaguid
    const idLength = data.readUInt16BE(at);
    at += 2;
    if (idLength > 1023 || data.length < at + idLength) throw new CborError("The credential id doesn't fit.");
    out.credentialId = Buffer.from(data.subarray(at, at + idLength));
    at += idLength;
    const { value, length } = decodeCborFirst(data.subarray(at));
    if (!(value instanceof Map)) throw new CborError("The credential's key isn't a COSE key.");
    out.coseKey = value;
    at += length;
  }
  if (flags & FLAG_ED) at += decodeCborFirst(data.subarray(at)).length;
  if (at !== data.length) throw new CborError("The authenticator data has bytes after it.");
  return out;
}

/** The COSE algorithms a passkey may use: ES256, EdDSA (Ed25519) and RS256. */
export const PASSKEY_ALGS = [-7, -8, -257] as const;

const b64u = (b: unknown) => {
  if (!Buffer.isBuffer(b)) throw new CborError("A COSE key field isn't bytes.");
  return b.toString("base64url");
};

/** A COSE public key as a node KeyObject, and its algorithm. */
export function coseToKey(cose: Map<Cbor, Cbor>): { key: KeyObject; alg: number } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (typeof alg !== "number" || !(PASSKEY_ALGS as readonly number[]).includes(alg)) throw new CborError("The passkey uses an algorithm this platform doesn't take.");
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) throw new CborError("The passkey's curve isn't P-256.");
    return { key: createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) }, format: "jwk" }), alg };
  }
  if (kty === 1 && alg === -8) {
    if (cose.get(-1) !== 6) throw new CborError("The passkey's curve isn't Ed25519.");
    return { key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(cose.get(-2)) }, format: "jwk" }), alg };
  }
  if (kty === 3 && alg === -257) {
    return { key: createPublicKey({ key: { kty: "RSA", n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) }, format: "jwk" }), alg };
  }
  throw new CborError("The passkey's key type and algorithm don't match.");
}

// ---------------------------------------------------------------------------------------------------------------
// The two ceremonies

export interface Expected {
  challenge: string;
  /** The platform's origin, like https://musemuse.example. */
  origin: string;
  /** The relying party id: the platform's host name. */
  rpId: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function fromB64u(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length > 64 * 1024 || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return Buffer.from(value, "base64url");
}

function clientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", expected: Expected): string | null {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(raw.toString("utf8")) as typeof data;
  } catch {
    return "the browser's client data isn't JSON";
  }
  if (data.type !== type) return "the browser's client data is for another ceremony";
  if (typeof data.challenge !== "string" || data.challenge !== expected.challenge) return "the challenge doesn't match";
  if (data.origin !== expected.origin) return "it came from another site";
  if (data.crossOrigin === true) return "it came from inside another site's frame";
  return null;
}

/** What a new passkey's response carries, base64url as browsers send it in JSON. */
export interface RegistrationResponse {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}

export interface NewPasskey {
  credentialId: string;
  /** SPKI DER. */
  publicKey: Buffer;
  alg: number;
  counter: number;
}

export function verifyRegistration(response: RegistrationResponse, expected: Expected): Checked<NewPasskey> {
  const raw = fromB64u(response.clientDataJSON);
  const attestation = fromB64u(response.attestationObject);
  if (!raw || !attestation) return fail("the passkey's answer isn't in the expected shape");
  const problem = clientData(raw, "webauthn.create", expected);
  if (problem) return fail(problem);
  let auth: AuthData;
  try {
    const att = decodeCbor(attestation);
    if (!(att instanceof Map) || !Buffer.isBuffer(att.get("authData"))) return fail("the passkey's answer has no authenticator data");
    auth = parseAuthData(att.get("authData") as Buffer);
  } catch (err) {
    return fail(err instanceof CborError ? err.message : "the passkey's answer couldn't be read");
  }
  if (!auth.rpIdHash.equals(sha256(expected.rpId))) return fail("the passkey is for another site");
  if (!(auth.flags & FLAG_UP)) return fail("the person wasn't present");
  if (!auth.credentialId || !auth.coseKey) return fail("the passkey's answer has no new credential");
  if (auth.credentialId.toString("base64url") !== response.id) return fail("the credential id doesn't match");
  try {
    const { key, alg } = coseToKey(auth.coseKey);
    return { ok: true, value: { credentialId: response.id, publicKey: key.export({ type: "spki", format: "der" }) as Buffer, alg, counter: auth.signCount } };
  } catch (err) {
    return fail(err instanceof CborError ? err.message : "the passkey's key couldn't be read");
  }
}

/** What a sign-in with a passkey carries. */
export interface AssertionResponse {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/**
 * Checks a sign-in against the stored key. A counter that doesn't go up (when either side counts) means the key was
 * copied, so the sign-in is refused. Returns the new counter to store.
 */
export function verifyAssertion(response: AssertionResponse, expected: Expected, stored: { publicKey: Buffer; counter: number }): Checked<{ counter: number }> {
  const raw = fromB64u(response.clientDataJSON);
  const authRaw = fromB64u(response.authenticatorData);
  const signature = fromB64u(response.signature);
  if (!raw || !authRaw || !signature) return fail("the passkey's answer isn't in the expected shape");
  const problem = clientData(raw, "webauthn.get", expected);
  if (problem) return fail(problem);
  let auth: AuthData;
  try {
    auth = parseAuthData(authRaw);
  } catch (err) {
    return fail(err instanceof CborError ? err.message : "the authenticator data couldn't be read");
  }
  if (!auth.rpIdHash.equals(sha256(expected.rpId))) return fail("the passkey is for another site");
  if (!(auth.flags & FLAG_UP)) return fail("the person wasn't present");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: stored.publicKey, format: "der", type: "spki" });
  } catch {
    return fail("the stored key couldn't be read");
  }
  const signed = Buffer.concat([authRaw, sha256(raw)]);
  const good =
    key.asymmetricKeyType === "ed25519"
      ? verify(null, signed, key, signature)
      : key.asymmetricKeyType === "ec"
        ? verify("sha256", signed, { key, dsaEncoding: "der" }, signature)
        : key.asymmetricKeyType === "rsa"
          ? verify("sha256", signed, key, signature)
          : false;
  if (!good) return fail("the signature doesn't check out");
  if ((auth.signCount !== 0 || stored.counter !== 0) && auth.signCount <= stored.counter) return fail("the passkey's counter went back, so it may be a copy");
  return { ok: true, value: { counter: auth.signCount } };
}
