/**
 * The lab's three tokens (docs/NATIVE_LAB.md).
 *
 * - A lab token belongs to one lane and only claims jobs. native_labs keeps its sha256.
 * - A job token is made at claim and covers that one run of that job. native_jobs.token_hash keeps its sha256, and the
 *   plain token exists only in the claim's reply.
 * - A selftest token is an HMAC that names the job and the attempt. It's made at claim and goes in the claim's reply, so the
 *   shell can post its report, and it lets the shell do nothing else. It isn't stored. A retry gets a new one, so a shell
 *   left over from the last attempt can't stand in for this one.
 *
 * The first two are 32 random bytes, so a plain SHA-256 guards them as well as a pepper would.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** A new token for a lane. It goes in Parameter Store at /musemuse/lab/<lane>/token. */
export function newLabToken(): string {
  return `mmlab_${randomBytes(32).toString("base64url")}`;
}

/** A new token for one run of a job. It fits the agent's rule: 16 to 512 of A-Z a-z 0-9 . _ ~ - */
export function newJobToken(): string {
  return `mmjob_${randomBytes(32).toString("base64url")}`;
}

export function hashLabToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The token from "Authorization: Bearer <token>", or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= 512 ? token : null;
}

function selftestKey(): Buffer {
  return createHmac("sha256", env.gatewayTokenPepper).update("musemuse-native:selftest").digest();
}

function selftestSignature(jobId: string, attempt: number, expiresAtSeconds: number): string {
  return createHmac("sha256", selftestKey()).update(`${jobId}.${attempt}.${expiresAtSeconds}`).digest("base64url");
}

/** The token for this attempt's shell: "mmst2.<jobId>.<attempt>.<expiry>.<signature>". */
export function selftestToken(jobId: string, attempt: number, expiresAt: Date): string {
  const seconds = Math.ceil(expiresAt.getTime() / 1000);
  return `mmst2.${jobId}.${attempt}.${seconds}.${selftestSignature(jobId, attempt, seconds)}`;
}

/** The job and attempt a selftest token names, or null when it's forged, malformed or past its expiry. */
export function verifySelftestToken(token: string, now: Date = new Date()): { jobId: string; attempt: number } | null {
  const [version, jobId, attemptText, seconds, signature, ...rest] = token.split(".");
  if (version !== "mmst2" || rest.length || !jobId || !attemptText || !seconds || !signature) return null;
  const attempt = Number(attemptText);
  const expiry = Number(seconds);
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(expiry) || expiry * 1000 <= now.getTime()) return null;
  const given = Buffer.from(signature);
  const wanted = Buffer.from(selftestSignature(jobId, attempt, expiry));
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? { jobId, attempt } : null;
}
