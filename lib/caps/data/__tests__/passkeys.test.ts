/**
 * End users' sign-in (docs/CAPABILITIES.md, section 9): the codes and sessions, WebAuthn with a fake authenticator
 * (P-256 and Ed25519 keys made here), and the platform's ceremonies with their deps faked.
 *
 *   npx tsx --test lib/caps/data/__tests__/passkeys.test.ts
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, it } from "node:test";
import {
  cleanDisplayName,
  endUserSubject,
  mintPasskeyState,
  mintTestUserSession,
  mintUserCode,
  mintUserSession,
  readPasskeyState,
  readTestUserSession,
  readUserCode,
  readUserSession,
} from "@/lib/caps/data/identity";
import { handlePasskey, type PasskeyDeps } from "@/lib/caps/data/passkeys";
import type { StoredPasskey } from "@/lib/caps/data/users";
import { decodeCbor, verifyAssertion, verifyRegistration, type Cbor } from "@/lib/caps/data/webauthn";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-passkeys";

const NOW = new Date("2026-11-01T12:00:00Z");
const ORIGIN = "https://musemuse.example";
const RP = "musemuse.example";

// ---------------------------------------------------------------------------------------------------------------
// A fake authenticator: a CBOR writer, authenticator data and signatures, written for these tests.

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (v === null) return Buffer.from([0xf6]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported");
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest();
const b64u = (b: Buffer) => b.toString("base64url");

class Authenticator {
  readonly credentialId = Buffer.from("fake-credential-id-0123456789");
  counter = 0;
  private readonly keys: { privateKey: KeyObject; publicKey: KeyObject };
  constructor(readonly kind: "ec" | "ed25519" = "ec") {
    this.keys = kind === "ec" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
  }
  private cose(): Map<Cbor, Cbor> {
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y?: string };
    return this.kind === "ec"
      ? new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]])
      : new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, "base64url")]]);
  }
  private authData(flags: number, withCredential: boolean, rpId = RP): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags]), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, cbor(this.cose()));
    }
    return Buffer.concat(parts);
  }
  create(challenge: string, o: { origin?: string; rpId?: string; flags?: number; type?: string } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.create", challenge, origin: o.origin ?? ORIGIN }));
    const att = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(o.flags ?? 0x45, true, o.rpId)]]));
    return { id: b64u(this.credentialId), clientDataJSON: b64u(clientData), attestationObject: b64u(att) };
  }
  get(challenge: string, o: { origin?: string; rpId?: string; flags?: number; bump?: boolean } = {}) {
    if (o.bump !== false) this.counter += 1;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin ?? ORIGIN }));
    const auth = this.authData(o.flags ?? 0x05, false, o.rpId);
    const signed = Buffer.concat([auth, sha(clientData)]);
    const signature = this.kind === "ec" ? sign("sha256", signed, { key: this.keys.privateKey, dsaEncoding: "der" }) : sign(null, signed, this.keys.privateKey);
    return { id: b64u(this.credentialId), clientDataJSON: b64u(clientData), authenticatorData: b64u(auth), signature: b64u(signature) };
  }
}

const expected = (challenge = "challenge-abc") => ({ challenge, origin: ORIGIN, rpId: RP });

describe("codes and sessions", () => {
  it("a sign-in code is for one product, carries the name, expires in 5 minutes, and a forged one is nothing", () => {
    const code = mintUserCode({ productId: "p1", subject: "subj_1", name: "Ana Bé" }, NOW);
    const read = readUserCode(code, NOW);
    assert.equal(read?.productId, "p1");
    assert.equal(read?.subject, "subj_1");
    assert.equal(read?.name, "Ana Bé");
    assert.equal(readUserCode(code, new Date(NOW.getTime() + 5 * 60_000 + 1)), null, "expired");
    assert.equal(readUserCode(code.replace(".p1.", ".p2."), NOW), null, "the product is signed");
    assert.equal(readUserCode(code.slice(0, -2) + "xx", NOW), null, "forged");
    assert.equal(readUserCode(`uc1.p1.subj.${"A".repeat(2000)}`, NOW), null, "too long");
    // A session or an owner pass isn't a code.
    assert.equal(readUserCode(mintUserSession({ productId: "p1", subject: "s" }, NOW).session, NOW), null);
  });

  it("a session lasts 30 days, for its product only; a build's made-up person's, for its build only", () => {
    const { session, expiresAt } = mintUserSession({ productId: "p1", subject: "subj_1" }, NOW);
    assert.equal(expiresAt.getTime() - NOW.getTime(), 30 * 24 * 3_600_000);
    assert.equal(readUserSession(session, "p1", NOW)?.subject, "subj_1");
    assert.equal(readUserSession(session, "p2", NOW), null);
    assert.equal(readUserSession(session, "p1", new Date(expiresAt.getTime() + 1)), null);
    const test = mintTestUserSession({ productId: "p1", buildId: "b1", subject: "t1" }, NOW).session;
    assert.equal(readTestUserSession(test, "p1", "b1", NOW)?.subject, "t1");
    assert.equal(readTestUserSession(test, "p1", "b2", NOW), null);
    assert.equal(readUserSession(test, "p1", NOW), null, "a made-up person's session is never a real one");
  });

  it("a person's subject differs per product and never shows their id; names are one clean line of 40", () => {
    const a = endUserSubject("6f1b5e2a-0000-4000-8000-000000000001", "p1");
    assert.notEqual(a, endUserSubject("6f1b5e2a-0000-4000-8000-000000000001", "p2"));
    assert.ok(!a.includes("6f1b5e2a"));
    assert.equal(cleanDisplayName("  Ana\n‮B  "), "Ana B");
    assert.equal(cleanDisplayName("x".repeat(60))?.length, 40);
    assert.equal(cleanDisplayName("   "), null);
    assert.equal(cleanDisplayName(5), null);
  });

  it("a ceremony's state is signed for its kind and expires", () => {
    const state = mintPasskeyState({ kind: "register", challenge: "c", productId: "p1", returnTo: "/", endUserId: "u", name: "Ana" }, NOW);
    assert.equal(readPasskeyState(state, "register", NOW)?.name, "Ana");
    assert.equal(readPasskeyState(state, "login", NOW), null);
    assert.equal(readPasskeyState(state, "register", new Date(NOW.getTime() + 6 * 60_000)), null);
    assert.equal(readPasskeyState(state.replace(/.$/, state.endsWith("A") ? "B" : "A"), "register", NOW), null);
  });
});

describe("WebAuthn", () => {
  for (const kind of ["ec", "ed25519"] as const) {
    it(`registers and signs in with a ${kind} passkey, and the counter must go up`, () => {
      const a = new Authenticator(kind);
      const reg = verifyRegistration(a.create("challenge-abc"), expected());
      assert.ok(reg.ok, !reg.ok ? reg.reason : "");
      if (!reg.ok) return;
      assert.equal(reg.value.alg, kind === "ec" ? -7 : -8);
      const stored = { publicKey: reg.value.publicKey, counter: reg.value.counter };
      const first = verifyAssertion(a.get("challenge-2"), expected("challenge-2"), stored);
      assert.ok(first.ok, !first.ok ? first.reason : "");
      if (!first.ok) return;
      assert.equal(first.value.counter, 1);
      const replay = verifyAssertion(a.get("challenge-3", { bump: false }), expected("challenge-3"), { ...stored, counter: 1 });
      assert.deepEqual(replay, { ok: false, reason: "the passkey's counter went back, so it may be a copy" });
    });
  }

  it("refuses another challenge, origin, ceremony type or site, an absent person, and a changed credential id", () => {
    const a = new Authenticator();
    const cases: Array<[ReturnType<Authenticator["create"]>, RegExp]> = [
      [a.create("other"), /challenge/],
      [a.create("challenge-abc", { origin: "https://evil.example" }), /another site/],
      [a.create("challenge-abc", { type: "webauthn.get" }), /another ceremony/],
      [a.create("challenge-abc", { rpId: "evil.example" }), /for another site/],
      [a.create("challenge-abc", { flags: 0x44 }), /wasn't present/],
      [{ ...a.create("challenge-abc"), id: "c29tZXRoaW5nLWVsc2UtZW50aXJlbHk" }, /doesn't match/],
      [{ ...a.create("challenge-abc"), attestationObject: "!!!" }, /expected shape/],
    ];
    for (const [response, why] of cases) {
      const r = verifyRegistration(response, expected());
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, why);
    }
  });

  it("refuses a sign-in signed by another key, for another site, or from another origin", () => {
    const a = new Authenticator();
    const b = new Authenticator();
    const reg = verifyRegistration(a.create("challenge-abc"), expected());
    assert.ok(reg.ok);
    if (!reg.ok) return;
    const stored = { publicKey: reg.value.publicKey, counter: 0 };
    const wrongKey = verifyAssertion(b.get("c2"), expected("c2"), stored);
    assert.deepEqual(wrongKey, { ok: false, reason: "the signature doesn't check out" });
    assert.equal(verifyAssertion(a.get("c3", { rpId: "evil.example" }), expected("c3"), stored).ok, false);
    assert.equal(verifyAssertion(a.get("c4", { origin: "https://evil.example" }), expected("c4"), stored).ok, false);
    assert.equal(verifyAssertion(a.get("c5"), expected("c-other"), stored).ok, false);
  });

  it("reads only well-formed CBOR", () => {
    assert.deepEqual(decodeCbor(cbor([1, -2, "a", Buffer.from([7])])), [1, -2, "a", Buffer.from([7])]);
    assert.throws(() => decodeCbor(Buffer.from([0x5f])), /definite/);
    assert.throws(() => decodeCbor(Buffer.concat([cbor(1), cbor(2)])), /after/);
    assert.throws(() => decodeCbor(Buffer.from([0x59, 0xff, 0xff])), /early/);
    let deep: Cbor = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    assert.throws(() => decodeCbor(cbor(deep)), /deep/);
  });
});

describe("the ceremonies on the platform", () => {
  function deps(over: Partial<PasskeyDeps> = {}) {
    const users: Array<Parameters<PasskeyDeps["createEndUser"]>[0]> = [];
    const spent = new Set<string>();
    const passkeys = new Map<string, StoredPasskey>();
    const d: PasskeyDeps = {
      enabled: () => true,
      origin: ORIGIN,
      rpId: RP,
      productForSignIn: async (slug) => (slug === "lists" ? { id: "p1", name: "Lists", liveUrl: "https://lists.example" } : null),
      reserveCounter: async (key) => (spent.has(key) ? null : (spent.add(key), 1)),
      hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
      createEndUser: async (u) => {
        users.push(u);
        passkeys.set(u.credentialId, { id: "pk1", endUserId: u.endUserId, publicKey: u.publicKey, counter: u.counter, displayName: u.name });
      },
      findPasskey: async (id) => passkeys.get(id) ?? null,
      usePasskey: async (id, _u, from, to) => {
        const p = [...passkeys.values()].find((x) => x.id === id);
        if (!p || p.counter !== from) return false;
        p.counter = to;
        return true;
      },
      now: () => NOW,
      ...over,
    };
    return { d, users, passkeys };
  }
  const post = (kind: string, step: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) =>
    new Request(`${ORIGIN}/api/u/passkey/${kind}/${step}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("answer 404 while sign-in is off, and refuse other sites and other paths", async () => {
    const { d } = deps({ enabled: () => false });
    assert.equal((await handlePasskey(post("register", "options", {}), "register", "options", d)).status, 404);
    const on = deps().d;
    assert.equal((await handlePasskey(post("register", "options", {}), "admin", "options", on)).status, 404);
    assert.equal((await handlePasskey(post("register", "options", {}, { origin: "https://evil.example" }), "register", "options", on)).status, 403);
    assert.equal((await handlePasskey(post("register", "options", {}, { origin: ORIGIN, "sec-fetch-site": "cross-site" }), "register", "options", on)).status, 403);
    const busy = deps({ hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 11])) }).d;
    assert.equal((await handlePasskey(post("login", "options", { product: "lists" }, { origin: ORIGIN, "x-forwarded-for": "203.0.113.4" }), "login", "options", busy)).status, 429);
  });

  it("make a passkey, then sign in with it, each time back to the product's own live link with a code for it", async () => {
    const { d, users } = deps();
    const a = new Authenticator();
    const opts = (await (await handlePasskey(post("register", "options", { product: "lists", returnTo: "/mine", name: "Ana" }), "register", "options", d)).json()) as {
      state: string;
      publicKey: { challenge: string; rp: { id: string }; user: { id: string }; authenticatorSelection: { residentKey: string } };
    };
    assert.equal(opts.publicKey.rp.id, RP);
    assert.equal(opts.publicKey.authenticatorSelection.residentKey, "required");
    const created = a.create(opts.publicKey.challenge);
    const reg = await handlePasskey(post("register", "verify", { product: "lists", state: opts.state, credential: { id: created.id, type: "public-key", response: created } }), "register", "verify", d);
    assert.equal(reg.status, 200);
    const back = new URL(((await reg.json()) as { redirect: string }).redirect);
    assert.equal(back.origin, "https://lists.example");
    assert.equal(back.pathname, "/api/musemuse/user");
    assert.equal(back.searchParams.get("returnTo"), "/mine");
    const code = readUserCode(back.searchParams.get("code")!, NOW);
    assert.equal(code?.productId, "p1");
    assert.equal(code?.name, "Ana");
    assert.equal(code?.subject, endUserSubject(users[0]!.endUserId, "p1"));
    assert.equal(opts.publicKey.user.id, Buffer.from(users[0]!.endUserId.replace(/-/g, ""), "hex").toString("base64url"));

    // The same state can't make a second passkey.
    const again = await handlePasskey(post("register", "verify", { product: "lists", state: opts.state, credential: { id: created.id, type: "public-key", response: created } }), "register", "verify", d);
    assert.equal(again.status, 400);

    const login = (await (await handlePasskey(post("login", "options", { product: "lists", returnTo: "//evil.example" }), "login", "options", d)).json()) as { state: string; publicKey: { challenge: string } };
    const got = a.get(login.publicKey.challenge);
    const signedIn = await handlePasskey(post("login", "verify", { product: "lists", state: login.state, credential: { id: got.id, type: "public-key", response: got } }), "login", "verify", d);
    assert.equal(signedIn.status, 200);
    const to = new URL(((await signedIn.json()) as { redirect: string }).redirect);
    assert.equal(to.origin, "https://lists.example");
    assert.equal(to.searchParams.get("returnTo"), "/", "a returnTo that leaves the site becomes the home page");
    assert.equal(readUserCode(to.searchParams.get("code")!, NOW)?.subject, code?.subject, "the same person, the same subject");
  });

  it("refuse a product that isn't live with a collection list, a passkey it doesn't know, and someone else's user handle", async () => {
    const { d } = deps();
    assert.equal((await handlePasskey(post("login", "options", { product: "nope" }), "login", "options", d)).status, 404);
    assert.equal((await handlePasskey(post("register", "options", { product: "lists", name: " " }), "register", "options", d)).status, 400);
    const a = new Authenticator();
    const login = (await (await handlePasskey(post("login", "options", { product: "lists" }), "login", "options", d)).json()) as { state: string; publicKey: { challenge: string } };
    const got = a.get(login.publicKey.challenge);
    const unknown = await handlePasskey(post("login", "verify", { product: "lists", state: login.state, credential: { id: got.id, type: "public-key", response: got } }), "login", "verify", d);
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: string }).error, /isn't one Muse Muse knows/);
  });
});
