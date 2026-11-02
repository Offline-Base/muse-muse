/**
 * The code a non-admin types to start a run (TUNE_START_CODE, docs/TRAINING.md "Anyone can fine-tune"). Checked here on
 * the server at every way a visitor starts a run, and never sent to the browser. Wrong tries are limited per person and
 * per IP. It keeps out drive-by traffic: it is shared, so it identifies nobody and gives nobody a limit of their own.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { hourStart, secondsUntil } from "@/lib/docs/proxy/limits";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import type { Refusal } from "@/lib/train/public/identity";

/** Tries an hour. A right code is given back, so only wrong tries use them up. */
export const CODE_TRIES_PER_PERSON = 10;
export const CODE_TRIES_PER_IP = 30;
const HOUR_MS = 60 * 60_000;
const CODE_MAX = 200;

const shape = (code: string) => createHash("sha256").update(code.trim().toLowerCase()).digest();

/** True when `given` is the code, ignoring case and surrounding spaces. Constant time over the hashes. */
export function startCodeMatches(given: string, expected: string): boolean {
  return timingSafeEqual(shape(given), shape(expected));
}

export const START_CODE_UNSET: Refusal = { ok: false, status: 403, code: "start_code_unset", error: "Starting a run isn't open right now." };
const REQUIRED: Refusal = { ok: false, status: 403, code: "start_code_required", error: "Enter the start code to start a run." };
const WRONG: Refusal = { ok: false, status: 403, code: "start_code_wrong", error: "That start code isn't right." };

/**
 * Null when `given` is the code. Refuses when none is set, none was sent, too many wrong tries were made this hour, or
 * it is wrong. A try is taken first, in one statement, so tries sent at once can't get past the limit.
 */
export async function checkStartCode(who: { key: string | null; ip: string }, given: unknown, now: Date = new Date()): Promise<Refusal | null> {
  const expected = env.tuneStartCode;
  if (!expected) return START_CODE_UNSET;
  if (typeof given !== "string" || !given.trim()) return REQUIRED;
  const hour = hourStart(now);
  const until = new Date(hour.getTime() + HOUR_MS);
  const limited: Refusal = {
    ok: false,
    status: 429,
    code: "start_code_tries",
    error: "Too many wrong start codes. Try again in a while.",
    retryAfterSeconds: secondsUntil(until, now),
  };
  const keys = [{ key: `tune-code:ip:${who.ip}`, limit: CODE_TRIES_PER_IP }, ...(who.key ? [{ key: `tune-code:v:${who.key}`, limit: CODE_TRIES_PER_PERSON }] : [])];
  const taken: string[] = [];
  const giveBack = () => Promise.all(taken.map((k) => adjustCounter(k, hour, -1)));
  for (const { key, limit } of keys) {
    if ((await reserveCounter(key, hour, 1, limit)) === null) {
      await giveBack();
      return limited;
    }
    taken.push(key);
  }
  if (given.length <= CODE_MAX && startCodeMatches(given, expected)) {
    await giveBack();
    return null;
  }
  return WRONG;
}
