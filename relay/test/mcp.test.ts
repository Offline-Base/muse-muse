import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { fromFrame } from "../src/device";
import { ORIGIN, answerFrames, connectDevice, linkApp, mcp, registerDevice } from "./helpers";

/** An invented JSON-RPC call, the kind Muse sends. */
const CALL = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_documents", arguments: { folder: "class-4b" } } });
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
  "mcp-session-id": "session-abc",
};

describe("OAuth metadata", () => {
  it("publishes authorization server metadata with dynamic registration and refresh tokens", async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const meta = await response.json<Record<string, unknown>>();
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(meta.grant_types_supported).toContain("refresh_token");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("publishes protected resource metadata for /mcp", async () => {
    const response = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const meta = await response.json<Record<string, unknown>>();
    expect(meta.resource).toBe(`${ORIGIN}/mcp`);
    expect(meta.authorization_servers).toEqual([ORIGIN]);
  });
});

describe("/mcp authentication", () => {
  it("rejects a request with no bearer token and points at the metadata", async () => {
    const response = await mcp(null, { headers: MCP_HEADERS, body: CALL });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("rejects a made-up token and a device secret used as a token", async () => {
    const device = await registerDevice();
    expect((await mcp("not-a-real-token", { headers: MCP_HEADERS, body: CALL })).status).toBe(401);
    expect((await mcp(device.secret, { headers: MCP_HEADERS, body: CALL })).status).toBe(401);
  });

  it("issues refresh tokens that work", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    expect(tokens.scope).toBe("mcp");
    expect(tokens.refresh_token).toBeTruthy();
    const refreshed = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<{ access_token: string }>();
    expect(next.access_token).not.toBe(tokens.access_token);
    // Offline device: the new token is accepted and reaches the device's object.
    expect((await mcp(next.access_token, { headers: MCP_HEADERS, body: CALL })).status).toBe(503);
  });
});

describe("/mcp forwarding", () => {
  it("sends the request down the device socket as a frame and returns the response frame", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    const seen: Record<string, any>[] = [];
    answerFrames(socket, (frame) => {
      seen.push(frame);
      return {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "session-xyz", "set-cookie": "dropped=1", "x-extra": "dropped" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "[Student A] essay.md" }] } }),
      };
    });

    const response = await mcp(tokens.access_token, { headers: { ...MCP_HEADERS, "x-not-forwarded": "1" }, body: CALL });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("mcp-session-id")).toBe("session-xyz");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-extra")).toBeNull();
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "[Student A] essay.md" }] } });

    expect(seen).toHaveLength(1);
    const frame = seen[0];
    expect(frame.type).toBe("request");
    expect(frame.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(frame.method).toBe("POST");
    expect(frame.body).toBe(CALL);
    // Only the MCP headers, lowercase; never the OAuth token.
    expect(frame.headers).toEqual(MCP_HEADERS);
    socket.close();
  });

  it("keeps no body anywhere: the device object holds only the secret hash, KV only the library's records", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    const marker = "Invented essay text 4471";
    answerFrames(socket, () => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: marker }) }));
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { marker } }) });
    expect(await response.text()).toContain(marker);

    const stored = await runInDurableObject(env.DEVICE.getByName(device.device_id), async (_instance, state) => [...(await state.storage.list()).entries()]);
    expect(stored).toEqual([["secret_sha256", await sha256Hex(device.secret)]]);

    const keys = (await env.OAUTH_KV.list()).keys.map((key) => key.name);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(marker);
      expect((await env.OAUTH_KV.get(key)) ?? "").not.toContain(marker);
    }
    socket.close();
  });

  it("forwards DELETE (end of session) with its method", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    let method = "";
    answerFrames(socket, (frame) => {
      method = frame.method;
      return { status: 204, headers: {}, body: "" };
    });
    const response = await mcp(tokens.access_token, { method: "DELETE", headers: { "mcp-session-id": "session-abc" } });
    expect(response.status).toBe(204);
    expect(method).toBe("DELETE");
    socket.close();
  });

  it("passes an event-stream body through as one body", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n';
    answerFrames(socket, () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse }));
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: CALL });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(sse);
    socket.close();
  });

  it("answers 405 to GET /mcp: no server-initiated stream in v1", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const response = await mcp(tokens.access_token, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
  });

  it("answers 503 when the device is offline", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: CALL });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "device offline" });
  });

  it("answers 503 when the device disconnects mid-request", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    socket.addEventListener("message", () => socket.close(1000, "bye"));
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: CALL });
    expect(response.status).toBe(503);
  });

  it("answers 504 when no response frame comes in time (timeout shortened in tests)", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    const started = Date.now();
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: CALL });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "device timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    socket.close();
  });

  it("ignores a response frame for an unknown id", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const socket = await connectDevice(device.secret);
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      socket.send(JSON.stringify({ type: "response", id: "someone-else", status: 200, headers: {}, body: "wrong" }));
      socket.send("not json");
      socket.send(JSON.stringify({ type: "response", id: frame.id, status: 200, headers: {}, body: "right" }));
    });
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: CALL });
    expect(await response.text()).toBe("right");
    socket.close();
  });

  it("refuses bodies over 4 MiB", async () => {
    const device = await registerDevice();
    const tokens = await linkApp(device.secret);
    const response = await mcp(tokens.access_token, { headers: MCP_HEADERS, body: "x".repeat(4 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
  });

  it("binds each grant to its own device", async () => {
    const [a, b] = [await registerDevice(), await registerDevice()];
    const tokensA = await linkApp(a.secret);
    const socketB = await connectDevice(b.secret);
    let reachedB = false;
    answerFrames(socketB, () => {
      reachedB = true;
      return { status: 200, headers: {}, body: "{}" };
    });
    // Only B is online; A's token must not reach B.
    expect((await mcp(tokensA.access_token, { headers: MCP_HEADERS, body: CALL })).status).toBe(503);
    expect(reachedB).toBe(false);
    socketB.close();
  });
});

describe("response frames", () => {
  it("are cleaned: bad status becomes 502, odd headers and non-text bodies are dropped", () => {
    expect(fromFrame({ status: 99, headers: null, body: 5 })).toEqual({ status: 502, headers: {}, body: "" });
    expect(fromFrame({ status: 200.5 }).status).toBe(502);
    expect(fromFrame({ status: 404, headers: { "content-type": "text/plain\r\nx: y", "mcp-session-id": "s" }, body: "nope" })).toEqual({
      status: 404,
      headers: { "mcp-session-id": "s" },
      body: "nope",
    });
  });
});
