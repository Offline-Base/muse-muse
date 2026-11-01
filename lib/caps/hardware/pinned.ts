import { createHash, X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import { Readable } from "node:stream";
import tls from "node:tls";
import { isPrivateAddress } from "@/lib/tools/args";

/**
 * Talking to a paired board: TLS with its own self-signed certificate, trusted because its public key's hash matches what the
 * owner confirmed at pairing, and never because of a name or a certificate authority. The check happens on a finished handshake,
 * before a single byte of the request (with the token in it) is written.
 */

export class BoardPinError extends Error {
  constructor() {
    super("The board's certificate isn't the one that was paired.");
    this.name = "BoardPinError";
  }
}

/** SHA-256 of the certificate's public key, as `certificate_spki_sha256` in muse-device/server.py computes it. */
export function spkiSha256(cert: X509Certificate): string {
  return createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

/** The six digits both screens show, as `pair_check_number` in muse-device/server.py computes them. */
export function pairCheckNumber(spki: string): string {
  const head = createHash("sha256").update(`muse-pair-check:${spki}`).digest("hex").slice(0, 12);
  return String(parseInt(head, 16) % 1_000_000).padStart(6, "0");
}

/** On a hosted site a name can't resolve to a private address, even if it changed after the address check. */
function guardedLookup(hostname: string, options: object, callback: (err: Error | null, address: string, family: number) => void): void {
  dnsLookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (err) return callback(err, "", 0);
    if (process.env.VERCEL && isPrivateAddress(address)) return callback(new Error("That address isn't public."), "", 0);
    callback(null, address, family);
  });
}

function connect(url: URL, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket = tls.connect({
      host,
      port: Number(url.port || 443),
      // The pin decides, below. Not a CA, and the name doesn't matter.
      rejectUnauthorized: false,
      servername: /^[\d.:]+$/.test(host) ? undefined : host,
      lookup: guardedLookup as never,
      autoSelectFamily: false,
    } as tls.ConnectionOptions);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    if (signal?.aborted) return fail(new Error("Timed out."));
    signal?.addEventListener("abort", () => fail(new Error("Timed out.")), { once: true });
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

function peerSpki(socket: tls.TLSSocket): string {
  const cert = socket.getPeerX509Certificate();
  if (!cert) throw new BoardPinError();
  return spkiSha256(cert);
}

/** Reads the board's public key hash from a handshake. Sends nothing else. */
export async function readBoardPin(address: string, timeoutMs = 8_000): Promise<string> {
  const socket = await connect(new URL(address), AbortSignal.timeout(timeoutMs));
  try {
    return peerSpki(socket);
  } finally {
    socket.destroy();
  }
}

/** A fetch that reaches only the board with this key. Redirects aren't followed: one could carry the token to another host. */
export function pinnedFetch(pin: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new BoardPinError();
    const socket = await connect(url, init?.signal ?? undefined);
    if (peerSpki(socket) !== pin) {
      socket.destroy();
      throw new BoardPinError();
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = http.request(
        {
          createConnection: () => socket,
          method: request.method,
          path: url.pathname + url.search,
          headers: { ...Object.fromEntries(request.headers), host: url.host, connection: "close", ...(body ? { "content-length": String(body.length) } : {}) },
        },
        (res) => {
          const status = res.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            res.destroy();
            return reject(new Error("The board tried to redirect."));
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
          }
          const empty = status === 204 || status === 202 || status === 304 || request.method === "HEAD";
          if (empty) res.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }));
        },
      );
      outgoing.once("error", reject);
      init?.signal?.addEventListener("abort", () => outgoing.destroy(new Error("Timed out.")), { once: true });
      outgoing.end(body ?? undefined);
    });
  };
}
