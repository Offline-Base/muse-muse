/**
 * The live demo's platform side (docs/TRAINING.md "Live demo"). A glimmer-serve job's demo server answers HTTPS on
 * SERVE_PORT with a self-signed certificate it makes at start, and requires "Authorization: Bearer <serving key>".
 * This file derives that key, so it is never stored, and makes the proxy's one call to the server
 * (app/api/lab/[id]/try): TLS without CA validation, pinned to the SHA-256 fingerprint the job reported in its
 * "serving" callback. The fingerprint is checked before a single byte of the request, and so before the key, is sent.
 * Server only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { request } from "node:http";
import { isIP } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import { env } from "@/lib/env";
import { certFingerprint } from "@/lib/train/logic";
import type { DecideLiveScores, DecideServeItem } from "@/lib/decide/types";
import type { TryLiveAnswer } from "@/lib/train/types";

/** The most of a demo server's answer the proxy reads. Two answers of 400 new tokens are far smaller. */
const ANSWER_BYTES_MAX = 256 * 1024;
/** Each answer is cut to this many characters before it goes to the browser. */
export const ANSWER_TEXT_MAX = 8000;

/**
 * How long the TCP connect and the TLS handshake may take before the server counts as unreachable, and how long the
 * proxy waits for both answers (the GPU writes up to 400 new tokens for each), and how long it waits for a decision
 * model's scores (two forward passes of at most 3 prompts, well under 2 s on the GPU). Tests shorten these; nothing
 * else should change them.
 */
export const serveTiming = { connectMs: 10_000, answerMs: 120_000, decideMs: 30_000 };

/**
 * The serving key of a glimmer-serve job: HMAC-SHA256 with GATEWAY_TOKEN_PEPPER of "serve:<job id>:<token hash>", in
 * hex. launchStep puts it in the job's job.json next to the job token; the proxy derives it again from the job's row
 * for each call. Only the token's hash is stored, so the key is never in the database.
 */
export function serveKeyFor(jobId: string, tokenHash: string): string {
  return createHmac("sha256", env.gatewayTokenPepper).update(`serve:${jobId}:${tokenHash}`).digest("hex");
}

/** Where a serve job's demo server answers: the IP Lambda reported, the port and the pinned certificate fingerprint. */
export interface ServeTarget {
  ip: string;
  port: number;
  certSha256: string;
}

/**
 * A demo call that didn't get an answer. "unreachable": no TCP or TLS connection in time (or it dropped);
 * "pin_mismatch": the server's certificate isn't the one its job reported, so nothing was sent; "timeout": no
 * answer in time; "busy": the server is answering another prompt; "stopping": the server's minutes are up and it is
 * shutting down; "bad_prompt": it refused the prompt; "refused": it refused the key or answered with another error;
 * "bad_answer": its answer wasn't the JSON it should be.
 */
export class ServeError extends Error {
  constructor(
    readonly code: "unreachable" | "pin_mismatch" | "timeout" | "busy" | "stopping" | "bad_prompt" | "refused" | "bad_answer",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ServeError";
  }
}

function sameText(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * POSTs `body` to the demo server over TLS pinned to `target.certSha256` and returns its status and text. The TLS
 * connection is made first, with no CA check, and the peer certificate's SHA-256 fingerprint is compared with the
 * pinned one; only when they match is the HTTP request (with its Authorization header) written to that connection.
 * The whole call ends after `timeoutMs`, the connect and handshake after serveTiming.connectMs. Never follows a
 * redirect and never reads more than ANSWER_BYTES_MAX.
 */
export function pinnedPost(
  target: ServeTarget,
  path: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const pinned = certFingerprint(target.certSha256);
  if (!pinned) return Promise.reject(new ServeError("pin_mismatch", "No certificate fingerprint to pin, so nothing was sent."));
  if (!isIP(target.ip) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    return Promise.reject(new ServeError("unreachable", "The demo server has no usable address."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: TLSSocket | null = null;
    const finish = (err: ServeError | null, value?: { status: number; text: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(connecting);
      socket?.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const overall = setTimeout(
      () => finish(new ServeError("timeout", `The demo server didn't answer within ${Math.round(timeoutMs / 1000)} s.`)),
      timeoutMs,
    );
    const connecting = setTimeout(
      () => finish(new ServeError("unreachable", "The demo server didn't accept a connection in time.")),
      Math.min(serveTiming.connectMs, timeoutMs),
    );
    // No CA validation: the certificate is self-signed, and the fingerprint below is the only check that counts.
    const tls = connect({ host: target.ip, port: target.port, rejectUnauthorized: false });
    socket = tls;
    tls.on("error", (err) => finish(new ServeError("unreachable", `The demo server's connection failed: ${messageOf(err)}`)));
    tls.once("secureConnect", () => {
      clearTimeout(connecting);
      const got = certFingerprint(tls.getPeerCertificate()?.fingerprint256);
      if (!got || !sameText(got, pinned)) {
        finish(new ServeError("pin_mismatch", "The demo server's certificate isn't the one its job reported, so nothing was sent."));
        return;
      }
      const req = request({
        createConnection: () => tls,
        host: target.ip,
        port: target.port,
        method: "POST",
        path,
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)), connection: "close" },
      });
      req.on("error", (err) => finish(new ServeError("unreachable", `The demo request failed: ${messageOf(err)}`)));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > ANSWER_BYTES_MAX) finish(new ServeError("bad_answer", "The demo server's answer was too large."));
          else chunks.push(chunk);
        });
        res.on("error", (err) => finish(new ServeError("unreachable", `The demo answer was cut off: ${messageOf(err)}`)));
        res.on("end", () => finish(null, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.end(body);
    });
  });
}

/**
 * Asks a serve job's demo server for the base and the tuned answer to `prompt`: POST /generate {prompt} with the
 * serving key, pinned to the job's certificate. Returns {base, tuned, ms}, each answer cut to ANSWER_TEXT_MAX
 * characters. Throws ServeError: busy for 409, 423 or 429, stopping for 503 (the server answers that once its minutes
 * are up), bad_prompt for 400, 413 or 422, refused for any other error status, bad_answer for an answer that isn't
 * {base, tuned, ms}, and as pinnedPost does.
 */
export async function askLive(target: ServeTarget, key: string, prompt: string, timeoutMs: number): Promise<TryLiveAnswer> {
  const { status, text } = await pinnedPost(
    target,
    "/generate",
    { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    JSON.stringify({ prompt }),
    timeoutMs,
  );
  if (status === 409 || status === 423 || status === 429) {
    throw new ServeError("busy", "The demo server is answering another prompt.", status);
  }
  if (status === 503) throw new ServeError("stopping", "The demo server's minutes are up and it is shutting down.", status);
  if (status === 400 || status === 413 || status === 422) throw new ServeError("bad_prompt", "The demo server refused the prompt.", status);
  if (status < 200 || status >= 300) throw new ServeError("refused", `The demo server answered HTTP ${status}.`, status);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ServeError("bad_answer", "The demo server's answer isn't JSON.", status);
  }
  const { base, tuned, ms } = (data ?? {}) as { base?: unknown; tuned?: unknown; ms?: unknown };
  if (typeof base !== "string" || typeof tuned !== "string") {
    throw new ServeError("bad_answer", "The demo server's answer has no base and tuned text.", status);
  }
  const took = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0;
  return { base: base.slice(0, ANSWER_TEXT_MAX), tuned: tuned.slice(0, ANSWER_TEXT_MAX), ms: took };
}

/** The most of a decision model's answer the proxy reads: 3 prompts of 5 numbers each, twice, are far smaller. */
const DECIDE_BYTES_MAX = 64 * 1024;

/** rows when it is items.length lists of finite numbers, list i as long as items[i]'s letters; else null. */
function scoreRows(rows: unknown, items: readonly DecideServeItem[]): number[][] | null {
  if (!Array.isArray(rows) || rows.length !== items.length) return null;
  const out: number[][] = [];
  for (const [i, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length !== items[i]!.letters.length) return null;
    if (!row.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    out.push(row as number[]);
  }
  return out;
}

/** masses when it is items.length finite numbers, else a list of zeros (letter mass is a health number only). */
function massRow(masses: unknown, items: readonly DecideServeItem[]): number[] {
  if (Array.isArray(masses) && masses.length === items.length && masses.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return masses as number[];
  }
  return items.map(() => 0);
}

/**
 * Asks a decision model's demo server (a glimmer-serve job whose adapter has decide.json, docs/DECISION_MODELS.md "On
 * the lab's GPU") to score 1 to 3 prompts: POST /decide {items} with the serving key, pinned to the job's certificate,
 * as askLive does. Returns each item's letters' log-probabilities from base Glimmer and from the tuned model (not
 * renormalized: decisionFromScores in lib/decide/format.ts renormalizes, combines groups and applies T), their letter
 * mass and the GPU's ms. Throws ServeError: busy for 409, 423 or 429, stopping for 503, bad_prompt for 400, 413 or 422
 * (a prompt over 2,048 tokens is 422), refused for any other error status, bad_answer for an answer whose numbers aren't
 * one finite number per letter of every item, and as pinnedPost does. Never sends anything but the rendered messages
 * and letters.
 */
export async function askDecide(
  target: ServeTarget,
  key: string,
  items: readonly DecideServeItem[],
  timeoutMs: number,
): Promise<DecideLiveScores> {
  const body = JSON.stringify({ items: items.map((i) => ({ messages: i.messages, letters: i.letters })) });
  const { status, text } = await pinnedPost(
    target,
    "/decide",
    { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body,
    timeoutMs,
  );
  if (status === 409 || status === 423 || status === 429) {
    throw new ServeError("busy", "The decision model's server is scoring another request.", status);
  }
  if (status === 503) throw new ServeError("stopping", "The decision model's minutes are up and its server is shutting down.", status);
  if (status === 400 || status === 413 || status === 422) {
    throw new ServeError("bad_prompt", `The decision model's server refused the prompts (HTTP ${status}).`, status);
  }
  if (status < 200 || status >= 300) throw new ServeError("refused", `The decision model's server answered HTTP ${status}.`, status);
  if (Buffer.byteLength(text) > DECIDE_BYTES_MAX) throw new ServeError("bad_answer", "The decision model's answer was too large.", status);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ServeError("bad_answer", "The decision model's answer isn't JSON.", status);
  }
  const d = (data ?? {}) as Record<string, unknown>;
  const base = scoreRows(d.base, items);
  const tuned = scoreRows(d.tuned, items);
  if (!base || !tuned) {
    throw new ServeError("bad_answer", "The decision model's answer doesn't have a score for every letter of every prompt.", status);
  }
  const took = typeof d.ms === "number" && Number.isFinite(d.ms) && d.ms >= 0 ? Math.round(d.ms) : 0;
  return { base, tuned, baseMass: massRow(d.baseMass, items), tunedMass: massRow(d.tunedMass, items), ms: took };
}
