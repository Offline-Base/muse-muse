import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { GATE, MAX_ATTEMPTS, normalizeCode, newCode, type PairingGate } from "../src/pairing";
import { ORIGIN, connectDevice, freshIp, nextMessage, pairCode, registerDevice, startAuthorize, submitCode } from "./helpers";

const gate = () => env.PAIRING.getByName(GATE);
const ipHash = () => sha256Hex(`ip:${freshIp()}`);

describe("POST /device/register", () => {
  it("returns a device id and secret once and keeps only the secret's hash", async () => {
    const device = await registerDevice();
    expect(device.device_id).toMatch(/^dev_[0-9a-f]{32}$/);
    expect(device.secret.startsWith(`${device.device_id}.`)).toBe(true);

    const stored = await runInDurableObject(env.DEVICE.getByName(device.device_id), async (_instance, state) => {
      return [...(await state.storage.list()).entries()];
    });
    expect(stored).toEqual([["secret_sha256", await sha256Hex(device.secret)]]);
  });

  it("gives every device its own id and secret", async () => {
    const [a, b] = [await registerDevice(), await registerDevice()];
    expect(a.device_id).not.toBe(b.device_id);
    expect(a.secret).not.toBe(b.secret);
  });

  it("accepts an empty body and refuses a bad label", async () => {
    expect((await SELF.fetch(`${ORIGIN}/device/register`, { method: "POST", headers: { "CF-Connecting-IP": freshIp() } })).status).toBe(200);
    const bad = await SELF.fetch(`${ORIGIN}/device/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": freshIp() },
      body: JSON.stringify({ name: "x".repeat(65) }),
    });
    expect(bad.status).toBe(400);
  });

  it("limits registrations per IP", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await SELF.fetch(`${ORIGIN}/device/register`, { method: "POST", headers: { "CF-Connecting-IP": ip } })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("refuses other methods", async () => {
    expect((await SELF.fetch(`${ORIGIN}/device/register`)).status).toBe(405);
  });
});

describe("POST /device/pair", () => {
  it("returns an 8 character code from the unambiguous alphabet, valid for 600 seconds", async () => {
    const device = await registerDevice();
    const response = await SELF.fetch(`${ORIGIN}/device/pair`, { method: "POST", headers: { Authorization: `Bearer ${device.secret}` } });
    expect(response.status).toBe(200);
    const body = await response.json<{ code: string; expires_in: number }>();
    expect(body.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(body.expires_in).toBe(600);
  });

  it("needs the device's secret", async () => {
    const device = await registerDevice();
    const wrong = `${device.device_id}.${"A".repeat(43)}`;
    const unknown = `dev_${"0".repeat(32)}.${"A".repeat(43)}`;
    const tries: Record<string, string>[] = [{}, { Authorization: `Bearer ${wrong}` }, { Authorization: `Bearer ${unknown}` }, { Authorization: "Bearer nonsense" }];
    for (const headers of tries) {
      expect((await SELF.fetch(`${ORIGIN}/device/pair`, { method: "POST", headers })).status).toBe(401);
    }
  });

  it("stores only a hash of the code, with its expiry", async () => {
    const device = await registerDevice();
    const code = await pairCode(device.secret);
    const rows = await runInDurableObject(gate(), async (_instance: PairingGate, state) =>
      state.storage.sql.exec("SELECT * FROM codes WHERE device_id = ?", device.device_id).toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toBe(await sha256Hex(code));
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(Number(rows[0].expires_at) - Date.now()).toBeGreaterThan(590_000);
  });

  it("makes codes that never use 0, O, 1 or I", () => {
    for (let i = 0; i < 500; i++) expect(newCode()).toMatch(/^[^01OI]{8}$/);
    expect(normalizeCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeCode("ABCD 2345")).toBe("ABCD2345");
    expect(normalizeCode("ABCD0345")).toBeNull();
    expect(normalizeCode("ABC")).toBeNull();
  });
});

describe("pairing codes", () => {
  it("work once", async () => {
    const device = await registerDevice();
    const hash = await sha256Hex(await pairCode(device.secret));
    expect(await gate().redeem(await ipHash(), hash)).toEqual({ ok: true, deviceId: device.device_id });
    expect(await gate().redeem(await ipHash(), hash)).toEqual({ ok: false, reason: "wrong" });
  });

  it("expire after 10 minutes", async () => {
    const device = await registerDevice();
    const hash = await sha256Hex(await pairCode(device.secret));
    // Move the code's expiry into the past, as if 10 minutes went by.
    await runInDurableObject(gate(), async (_instance: PairingGate, state) => {
      state.storage.sql.exec("UPDATE codes SET expires_at = ? WHERE code_hash = ?", Date.now() - 1, hash);
    });
    expect(await gate().redeem(await ipHash(), hash)).toEqual({ ok: false, reason: "wrong" });
  });

  it("only the newest code for a device works", async () => {
    const device = await registerDevice();
    const first = await sha256Hex(await pairCode(device.secret));
    const second = await sha256Hex(await pairCode(device.secret));
    expect((await gate().redeem(await ipHash(), first)).ok).toBe(false);
    expect((await gate().redeem(await ipHash(), second)).ok).toBe(true);
  });

  it("allow at most 5 attempts per IP in 10 minutes, even with the right code", async () => {
    const device = await registerDevice();
    const right = await sha256Hex(await pairCode(device.secret));
    const ip = await ipHash();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await gate().redeem(ip, await sha256Hex(`WRONG${i}`))).toEqual({ ok: false, reason: "wrong" });
    }
    expect(await gate().redeem(ip, right)).toEqual({ ok: false, reason: "limited" });
    // Malformed input counts against the IP too.
    const other = await ipHash();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await gate().redeem(other, null);
    expect(await gate().redeem(other, right)).toEqual({ ok: false, reason: "limited" });
    // Another IP still gets in.
    expect(await gate().redeem(await ipHash(), right)).toEqual({ ok: true, deviceId: device.device_id });
  });

  it("allow at most 5 attempts per code value in 10 minutes, from any IP", async () => {
    const guess = await sha256Hex("ZZZZ9999");
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(await gate().redeem(await ipHash(), guess)).toEqual({ ok: false, reason: "wrong" });
    expect(await gate().redeem(await ipHash(), guess)).toEqual({ ok: false, reason: "limited" });
  });

  it("forget counters once the window passes", async () => {
    const ip = await ipHash();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await gate().redeem(ip, null);
    expect(await gate().redeem(ip, null)).toEqual({ ok: false, reason: "limited" });
    await runInDurableObject(gate(), async (_instance: PairingGate, state) => {
      state.storage.sql.exec("UPDATE hits SET reset_at = ? WHERE key = ?", Date.now() - 1, `ip:${ip}`);
    });
    expect(await gate().redeem(ip, null)).toEqual({ ok: false, reason: "wrong" });
  });
});

describe("authorize page", () => {
  it("asks for the pairing code, styled as Muse Privacy, and cannot be framed", async () => {
    const start = await startAuthorize();
    expect(start.html).toContain("Muse Privacy");
    expect(start.html).toContain("Private workspace on this device");
    expect(start.html).toContain('name="code"');
    expect(start.html).toContain("Muse (test)");
    expect(start.html).toContain("muse.example.com");
    expect(start.html).not.toMatch(/\bMeta\b/);
    expect(start.html).not.toContain("—");
    const page = await SELF.fetch(start.url);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("escapes the client's self-chosen name", async () => {
    const registration = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: '<script>alert("x")</script>', redirect_uris: ["https://app.example.org/cb"], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = await registration.json<{ client_id: string }>();
    const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://app.example.org/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    const html = await (await SELF.fetch(`${ORIGIN}/authorize?${query}`)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
  });

  it("refuses an unknown client without redirecting", async () => {
    const response = await SELF.fetch(`${ORIGIN}/authorize?response_type=code&client_id=nope&redirect_uri=https://evil.example.org/cb`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps the page usable after a wrong code, then links with the right one", async () => {
    const device = await registerDevice();
    const start = await startAuthorize();
    const code = await pairCode(device.secret);
    const ip = freshIp();
    const wrong = await submitCode(start, "ZZZZ2222", ip);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("That code did not work");
    const right = await submitCode(start, code.toLowerCase(), ip);
    expect(right.status).toBe(302);
    expect(right.headers.get("location")).toContain("code=");
  });

  it("refuses a used code", async () => {
    const device = await registerDevice();
    const code = await pairCode(device.secret);
    expect((await submitCode(await startAuthorize(), code, freshIp())).status).toBe(302);
    const again = await submitCode(await startAuthorize(), code, freshIp());
    expect(again.status).toBe(400);
  });

  it("shows a wait message after 5 tries from one IP", async () => {
    const device = await registerDevice();
    const start = await startAuthorize();
    const code = await pairCode(device.secret);
    const ip = freshIp();
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await submitCode(start, `ZZZZ222${i + 2}`, ip)).status).toBe(400);
    const limited = await submitCode(start, code, ip);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Too many tries");
  });

  it("sends the user back with access_denied on Cancel", async () => {
    const start = await startAuthorize();
    const response = await submitCode(start, "", freshIp(), "cancel");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("refuses a form without the browser's consent cookie, without using up the code", async () => {
    const device = await registerDevice();
    const start = await startAuthorize();
    const code = await pairCode(device.secret);
    const response = await submitCode({ ...start, cookie: "" }, code, freshIp());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This link did not work");
    expect((await submitCode(start, code, freshIp())).status).toBe(302);
  });

  it("refuses a forged cookie", async () => {
    const device = await registerDevice();
    const start = await startAuthorize();
    const forged = `${start.cookie.split("=")[0]}=${"0".repeat(64)}`;
    expect((await submitCode({ ...start, cookie: forged }, await pairCode(device.secret), freshIp())).status).toBe(400);
  });
});

describe("GET /device/connect", () => {
  it("needs a WebSocket upgrade and the device's secret", async () => {
    const device = await registerDevice();
    expect((await SELF.fetch(`${ORIGIN}/device/connect`, { headers: { Authorization: `Bearer ${device.secret}` } })).status).toBe(426);
    expect((await SELF.fetch(`${ORIGIN}/device/connect`, { headers: { Upgrade: "websocket" } })).status).toBe(401);
    const wrong = { Upgrade: "websocket", Authorization: `Bearer ${device.device_id}.${"B".repeat(43)}` };
    expect((await SELF.fetch(`${ORIGIN}/device/connect`, { headers: wrong })).status).toBe(401);
    const socket = await connectDevice(device.secret);
    expect(await env.DEVICE.getByName(device.device_id).isOnline()).toBe(true);
    socket.close();
  });

  it("answers ping with pong, in either JSON spelling", async () => {
    const device = await registerDevice();
    const socket = await connectDevice(device.secret);
    for (const ping of ['{"type": "ping"}', '{"type":"ping"}']) {
      const reply = nextMessage(socket);
      socket.send(ping);
      expect(await reply).toEqual({ type: "pong" });
    }
    socket.close();
  });

  it("replaces the old connection with a new one", async () => {
    const device = await registerDevice();
    const first = await connectDevice(device.secret);
    const closed = new Promise<number>((resolve) => first.addEventListener("close", (event) => resolve(event.code)));
    const second = await connectDevice(device.secret);
    expect(await closed).toBe(4000);
    const reply = nextMessage(second);
    second.send('{"type": "ping"}');
    expect(await reply).toEqual({ type: "pong" });
    second.close();
  });
});
