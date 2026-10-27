import { DurableObject } from "cloudflare:workers";
import { sameText, sha256Hex } from "./crypto";
import type { Env } from "./env";

/**
 * One object per device. It keeps the SHA-256 of the device's secret and holds the WebSocket
 * the device dialed out (hibernation API, so an idle device costs nothing). Each /mcp request
 * becomes a request frame on that socket and waits for the response frame with the same id.
 * Frames pass through memory only: no body is stored or logged.
 */

export interface ForwardRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface ForwardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const TAG = "device";
const DEFAULT_TIMEOUT_MS = 60_000;
/** Requests waiting on one device at once. */
export const MAX_PENDING = 32;
/** Response headers passed back to Muse. Everything else the device sends is dropped. */
const RESPONSE_HEADERS = ["content-type", "mcp-session-id"];
/** The Python client's default spelling, answered by the runtime without waking the object. */
const PING = '{"type": "ping"}';
const PONG = '{"type": "pong"}';

export function errorReply(status: number, error: string): ForwardResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error }) };
}

interface Pending {
  socket: WebSocket;
  resolve: (response: ForwardResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Frame {
  type?: unknown;
  id?: unknown;
  status?: unknown;
  headers?: unknown;
  body?: unknown;
}

/** A response frame as an HTTP answer: a valid status, only the allowed headers, a text body. */
export function fromFrame(frame: Frame): ForwardResponse {
  const status = typeof frame.status === "number" && Number.isInteger(frame.status) && frame.status >= 200 && frame.status <= 599 ? frame.status : 502;
  const headers: Record<string, string> = {};
  if (frame.headers && typeof frame.headers === "object") {
    const given = frame.headers as Record<string, unknown>;
    for (const name of RESPONSE_HEADERS) {
      const value = given[name];
      if (typeof value === "string" && !/[\r\n\0]/.test(value)) headers[name] = value;
    }
  }
  return { status, headers, body: typeof frame.body === "string" ? frame.body : "" };
}

export class DeviceHub extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Save the secret's hash for a new device. Never overwrites one. */
  async init(secretHash: string): Promise<boolean> {
    if (await this.ctx.storage.get("secret_sha256")) return false;
    await this.ctx.storage.put("secret_sha256", secretHash);
    return true;
  }

  async verify(secret: string): Promise<boolean> {
    const stored = await this.ctx.storage.get<string>("secret_sha256");
    return typeof stored === "string" && sameText(stored, await sha256Hex(secret));
  }

  async isOnline(): Promise<boolean> {
    return this.ctx.getWebSockets(TAG).length > 0;
  }

  /** The device's WebSocket. The Worker has already checked the secret and the Upgrade header. */
  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    for (const old of this.ctx.getWebSockets(TAG)) {
      this.failPending(old);
      try {
        old.close(4000, "Replaced by a newer connection");
      } catch {
        // already closing
      }
    }
    this.ctx.acceptWebSocket(server, [TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send one HTTP request to the device as a frame and wait for its response frame. */
  async forward(request: ForwardRequest): Promise<ForwardResponse> {
    const socket = this.ctx.getWebSockets(TAG)[0];
    if (!socket) return errorReply(503, "device offline");
    if (this.pending.size >= MAX_PENDING) return errorReply(429, "device busy");

    const id = crypto.randomUUID();
    const frame = JSON.stringify({ type: "request", id, method: request.method, headers: request.headers, body: request.body });
    const timeoutMs = Number(this.env.REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    return new Promise<ForwardResponse>((resolve) => {
      const timer = setTimeout(() => this.settle(id, errorReply(504, "device timeout")), timeoutMs);
      this.pending.set(id, { socket, resolve, timer });
      try {
        socket.send(frame);
      } catch {
        this.settle(id, errorReply(503, "device offline"));
      }
    });
  }

  private settle(id: string, response: ForwardResponse): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.resolve(response);
  }

  /** Requests sent down a socket that went away can never be answered. */
  private failPending(socket: WebSocket): void {
    for (const [id, waiting] of this.pending) {
      if (waiting.socket === socket) this.settle(id, errorReply(503, "device offline"));
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let frame: Frame;
    try {
      frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "ping") {
      socket.send(PONG);
      return;
    }
    if (frame.type !== "response" || typeof frame.id !== "string") return;
    const waiting = this.pending.get(frame.id);
    // Unknown ids are late replies to requests that already timed out.
    if (!waiting || waiting.socket !== socket) return;
    this.settle(frame.id, fromFrame(frame));
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.failPending(socket);
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.failPending(socket);
  }
}
