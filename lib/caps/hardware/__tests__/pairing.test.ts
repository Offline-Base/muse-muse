/**
 * Pairing and pinned TLS. The pin is exercised on a real TLS server with a real self-signed certificate (openssl), so it can't pass by
 * mocking the part that matters. Other deps are fakes. No board, no model.
 *
 *   npx tsx --test lib/caps/hardware/__tests__/pairing.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { newBoxKey, parseKeyring } from "@/lib/secrets/box";
import { BoardPinError, pairCheckNumber, pinnedFetch, readBoardPin } from "../pinned";
import { boardOrigin, finishPairing, startPairing, type PairDeps } from "../pairing";
import { boardKindOf, servedModelName, targetForBoardKind } from "../targets";
import { canOwnBoard } from "../admin";

const ring = parseKeyring(newBoxKey())!;
const PIN = "b".repeat(64);
const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function deps(over: Partial<PairDeps> = {}): PairDeps & { inserted: unknown[] } {
  const inserted: unknown[] = [];
  return {
    inserted,
    ring: () => ring,
    check: async () => ({ ok: true, trust: "pinned_tls" }),
    readPin: async () => PIN,
    redeem: async (_o, pin, code) => (pin === PIN && code === "ABCD2345" ? "t".repeat(43) : null),
    describe: async () => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ simulated: true, robot: true, model: "Simulated NVIDIA Jetson Orin Nano Developer Kit", cameras: [], microphones: [] }) }] }),
    served: async () => ["muse-glimmer-30b-IQ1_S"],
    count: async () => 0,
    insert: (async (row: unknown) => void inserted.push(row)) as PairDeps["insert"],
    ...over,
  } as PairDeps & { inserted: unknown[] };
}

describe("pairing", () => {
  it("shows the same check number as muse-device/server.py", () => {
    // muse-device/test_pairing.py holds the same vector.
    assert.equal(pairCheckNumber("a".repeat(64)), "489031");
  });

  it("takes only https board addresses, without a path or a password", () => {
    assert.equal(boardOrigin("board.example:8765"), "https://board.example:8765");
    assert.equal(boardOrigin("https://board.example/mcp"), "https://board.example");
    for (const bad of ["http://board.example", "https://u:p@board.example", "https://board.example/other", "https://board.example?x=1", "", 5, null]) {
      assert.equal(boardOrigin(bad), null, String(bad));
    }
  });

  it("pairs: the check number, then the code, then a sealed row with no plain token or address", async () => {
    const d = deps();
    const start = await startPairing({ address: "board.example:8765" }, OWNER, d);
    assert.ok(start.ok);
    assert.equal(start.checkNumber, pairCheckNumber(PIN));
    const done = await finishPairing({ ticket: start.ticket, code: "abcd2345", name: "Greenhouse", confirmed: true }, OWNER, d);
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.target, "Muse Glimmer, one bit");
    const row = d.inserted[0] as { pin: string; ownerUserId: string; facts: { kind: string; target: string; simulated: boolean; robot: boolean }; url: { ciphertext: Buffer }; token: { ciphertext: Buffer } };
    assert.equal(row.pin, PIN);
    assert.equal(row.ownerUserId, OWNER);
    assert.deepEqual([row.facts.kind, row.facts.target, row.facts.simulated, row.facts.robot], ["jetson_orin_nano", "muse-glimmer-30b-IQ1_S", true, true]);
    assert.ok(!row.token.ciphertext.toString().includes("ttt"));
    assert.ok(!row.url.ciphertext.toString().includes("board.example"));
  });

  it("won't finish unless the person said the numbers match", async () => {
    const d = deps();
    const start = await startPairing({ address: "board.example" }, OWNER, d);
    assert.ok(start.ok);
    assert.deepEqual(await finishPairing({ ticket: start.ticket, code: "ABCD2345", name: "x", confirmed: false }, OWNER, d), { ok: false, error: "not_confirmed" });
    assert.deepEqual(await finishPairing({ ticket: start.ticket, code: "ABCD2345", name: "x", confirmed: "true" }, OWNER, d), { ok: false, error: "not_confirmed" });
    assert.equal(d.inserted.length, 0);
  });

  it("another account can't finish someone's pairing: the ticket names its person", async () => {
    const d = deps();
    const start = await startPairing({ address: "board.example" }, OWNER, d);
    assert.ok(start.ok);
    assert.deepEqual(await finishPairing({ ticket: start.ticket, code: "ABCD2345", name: "x", confirmed: true }, OTHER, d), { ok: false, error: "pair_expired" });
    assert.equal(d.inserted.length, 0);
  });

  it("a ticket expires, a wrong code stores nothing, and a bad code never reaches the board", async () => {
    const start = await startPairing({ address: "board.example" }, OWNER, deps());
    assert.ok(start.ok);
    const later = deps({ now: () => new Date(Date.now() + 11 * 60_000) });
    assert.deepEqual(await finishPairing({ ticket: start.ticket, code: "ABCD2345", name: "x", confirmed: true }, OWNER, later), { ok: false, error: "pair_expired" });
    const d = deps();
    assert.deepEqual(await finishPairing({ ticket: start.ticket, code: "ZZZZ2345", name: "x", confirmed: true }, OWNER, d), { ok: false, error: "wrong_code" });
    assert.equal(d.inserted.length, 0);
    let called = false;
    const never = deps({ redeem: async () => ((called = true), null) });
    assert.deepEqual(await finishPairing({ ticket: start.ticket, code: "has space", name: "x", confirmed: true }, OWNER, never), { ok: false, error: "invalid_code" });
    assert.equal(called, false);
  });

  it("no key, no pairing", async () => {
    assert.deepEqual(await startPairing({ address: "board.example" }, OWNER, deps({ ring: () => null })), { ok: false, error: "key_missing" });
  });

  it("a served model's name is a file name, never the board's folders", () => {
    assert.equal(servedModelName("/home/me/models/Llama-3.2-3B-Q4_K_M.gguf"), "Llama-3.2-3B-Q4_K_M");
    assert.equal(servedModelName("x".repeat(300)), null);
    assert.equal(servedModelName(7), null);
  });

  it("a board's kind picks its model: Jetson one-bit Glimmer, others a small Llama, and never anything else", () => {
    assert.equal(boardKindOf("NVIDIA Jetson Orin Nano Developer Kit"), "jetson_orin_nano");
    assert.equal(boardKindOf("Raspberry Pi 5 Model B"), "raspberry_pi");
    assert.equal(boardKindOf(undefined), "other");
    assert.equal(targetForBoardKind("jetson_orin_nano").id, "muse-glimmer-30b-IQ1_S");
    for (const kind of ["raspberry_pi", "other"] as const) assert.match(targetForBoardKind(kind).id, /^Llama-/);
  });

  it("the shared guest can never own a board", () => {
    assert.equal(canOwnBoard({ email: "guest@musemuse.invalid", openAccess: false }), false);
    assert.equal(canOwnBoard({ email: "guest@musemuse.invalid", openAccess: true }), false);
    assert.equal(canOwnBoard({ email: "a@example.com", openAccess: true }), false, "open access acts as a shared account");
    assert.equal(canOwnBoard(null), false);
    assert.equal(canOwnBoard({ email: "a@example.com", openAccess: false }), true);
  });
});

describe("pinned TLS, on a real self-signed server", () => {
  let dir = "";
  let server: https.Server;
  let origin = "";
  let realPin = "";
  const seen: string[] = [];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pinned-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=muse-device"], { stdio: "ignore" });
    server = https.createServer({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
      seen.push(String(req.headers.authorization));
      if (req.url === "/huge") {
        const chunk = Buffer.alloc(1024 * 1024);
        res.writeHead(200);
        const send = () => {
          while (!res.destroyed && res.write(chunk));
          if (!res.destroyed) res.once("drain", send);
        };
        res.on("error", () => {});
        return send();
      }
      if (req.url === "/moved") {
        res.writeHead(302, { location: "https://elsewhere.example/" });
        return res.end();
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    realPin = await readBoardPin(origin);
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the same key hash openssl does", () => {
    const pub = execFileSync("openssl", ["x509", "-in", path.join(dir, "c.pem"), "-pubkey", "-noout"]);
    const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: pub });
    assert.equal(realPin, execFileSync("openssl", ["dgst", "-sha256", "-hex"], { input: der }).toString().trim().split(" ").pop());
  });

  it("reaches the board with the right pin", async () => {
    const res = await pinnedFetch(realPin)(`${origin}/v1/models`, { headers: { authorization: "Bearer good" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: "/v1/models", method: "GET" });
    assert.equal(seen.at(-1), "Bearer good");
  });

  it("sends a body", async () => {
    const res = await pinnedFetch(realPin)(`${origin}/x`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(((await res.json()) as { method: string }).method, "POST");
  });

  it("with the wrong pin, refuses before a byte of the token is sent", async () => {
    const before = seen.length;
    await assert.rejects(pinnedFetch("0".repeat(64))(`${origin}/v1/models`, { headers: { authorization: "Bearer secret" } }), BoardPinError);
    assert.equal(seen.length, before, "the server never saw the request");
  });

  it("cuts off a reply too large to hold", async () => {
    const res = await pinnedFetch(realPin)(`${origin}/huge`);
    await assert.rejects(res.arrayBuffer());
  });

  it("doesn't follow a redirect", async () => {
    await assert.rejects(pinnedFetch(realPin)(`${origin}/moved`, { headers: { authorization: "Bearer x" } }), /redirect/);
  });
});
