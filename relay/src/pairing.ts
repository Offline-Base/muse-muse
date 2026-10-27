import { DurableObject } from "cloudflare:workers";
import { sameText } from "./crypto";
import type { Env } from "./env";

/**
 * Pairing codes and attempt counters, in one Durable Object so that "single use" and
 * "at most 5 tries" hold even when two requests race (KV cannot promise either).
 *
 * Stored: SHA-256 of each live code, the device it links, and its expiry; and per-window hit
 * counts keyed by SHA-256 of the client IP or of the code tried. Nothing else.
 */

/** No 0, O, 1 or I. 32 symbols, so `byte & 31` picks each one with equal chance. */
export const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_TTL_SECONDS = 600;
/** At most this many pairing attempts per IP and per code value in each window. */
export const MAX_ATTEMPTS = 5;
export const WINDOW_MS = 10 * 60 * 1000;
/** The single gate instance's name. */
export const GATE = "gate";

export function newCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))].map((byte) => ALPHABET[byte & 31]).join("");
}

/** "abcd 2345", "ABCD-2345" and "ABCD2345" are the same code. Anything else is null. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH || [...code].some((char) => !ALPHABET.includes(char))) return null;
  return code;
}

export type Redeemed = { ok: true; deviceId: string } | { ok: false; reason: "limited" | "wrong" };

export class PairingGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS codes (code_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
      sql.exec("CREATE INDEX IF NOT EXISTS codes_by_device ON codes (device_id)");
      sql.exec("CREATE TABLE IF NOT EXISTS hits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)");
    });
  }

  private sweep(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM codes WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE reset_at <= ?", now);
  }

  private count(key: string): number {
    const row = this.ctx.storage.sql.exec<{ count: number }>("SELECT count FROM hits WHERE key = ?", key).toArray()[0];
    return row?.count ?? 0;
  }

  private bump(key: string, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO hits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1",
      key,
      now + WINDOW_MS,
    );
  }

  /** Count one use of `key`. False when `limit` uses already landed in this window. */
  async take(key: string, limit: number): Promise<boolean> {
    const now = Date.now();
    this.sweep(now);
    if (this.count(key) >= limit) return false;
    this.bump(key, now);
    return true;
  }

  /** Store a device's new code (by hash). Only the newest code per device works. False on a collision. */
  async issue(deviceId: string, codeHash: string): Promise<boolean> {
    const now = Date.now();
    this.sweep(now);
    if (this.ctx.storage.sql.exec("SELECT 1 FROM codes WHERE code_hash = ?", codeHash).toArray().length) return false;
    this.ctx.storage.sql.exec("DELETE FROM codes WHERE device_id = ?", deviceId);
    this.ctx.storage.sql.exec(
      "INSERT INTO codes (code_hash, device_id, expires_at) VALUES (?, ?, ?)",
      codeHash,
      deviceId,
      now + CODE_TTL_SECONDS * 1000,
    );
    return true;
  }

  /**
   * One pairing attempt from `ipHash` with the code whose hash is `codeHash` (null when the
   * input was not even shaped like a code). Counts against the IP and the code value, then uses
   * the code up if it is live. SQL calls are synchronous, so the whole check runs as one step.
   */
  async redeem(ipHash: string, codeHash: string | null): Promise<Redeemed> {
    const now = Date.now();
    this.sweep(now);
    const keys = [`ip:${ipHash}`, ...(codeHash ? [`code:${codeHash}`] : [])];
    if (keys.some((key) => this.count(key) >= MAX_ATTEMPTS)) return { ok: false, reason: "limited" };
    for (const key of keys) this.bump(key, now);
    if (!codeHash) return { ok: false, reason: "wrong" };

    const row = this.ctx.storage.sql
      .exec<{ code_hash: string; device_id: string; expires_at: number }>(
        "SELECT code_hash, device_id, expires_at FROM codes WHERE code_hash = ?",
        codeHash,
      )
      .toArray()[0];
    // The lookup key is a hash of the guess, so its timing says nothing about the live code;
    // the stored hash is still compared in constant time before it counts.
    if (!row || row.expires_at <= now || !sameText(row.code_hash, codeHash)) return { ok: false, reason: "wrong" };
    this.ctx.storage.sql.exec("DELETE FROM codes WHERE code_hash = ?", codeHash);
    return { ok: true, deviceId: row.device_id };
  }
}
