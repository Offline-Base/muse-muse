/**
 * Who may call the SAM tune worker routes (app/api/train/sam/worker/): the office board, holding the worker secret whose
 * sha256 is SAM_WORKER_TOKEN_SHA256. The plain secret lives only on the board. The id routes also need that run's job
 * token, handed to the board once at claim and stored only as a hash. Throws HttpError, so a route() handler answers
 * 404 with SAM_TUNE off, 401 for a missing or wrong secret, and 404 for a wrong job token or an ended run.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { runForToken, type SamRunRow } from "@/lib/train/sam/store";

/** The header the upload route's raw-bytes body carries its job token in (JSON routes send `jobToken` in the body). */
export const JOB_TOKEN_HEADER = "x-job-token";

/** 404 with SAM_TUNE off, as every SAM tune route is. */
export function requireSamTune(): void {
  if (!env.samTune) throw new HttpError(404, "not_found");
}

function bearer(req: Request): string | null {
  const got = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  return got ? got[1]! : null;
}

/** Whether `secret` hashes to SAM_WORKER_TOKEN_SHA256, compared in constant time. False when no hash is set. */
export function workerSecretMatches(secret: string | null): boolean {
  const wanted = env.samWorkerTokenSha256;
  if (!wanted || !secret) return false;
  const given = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, Buffer.from(wanted, "hex"));
}

/** The office board's worker secret, as a Bearer header. */
export function requireWorker(req: Request): void {
  requireSamTune();
  if (!workerSecretMatches(bearer(req))) throw new HttpError(401, "unauthorized");
}

/**
 * The worker secret and the run's own job token: `bodyToken` from a JSON body, else the X-Job-Token header (what worker.py and the upload route send).
 * Returns the run, still claimed or running.
 */
export async function requireRunToken(req: Request, id: string, bodyToken?: unknown): Promise<SamRunRow> {
  requireWorker(req);
  const token = bodyToken ?? req.headers.get(JOB_TOKEN_HEADER);
  const run = await runForToken(id, token);
  if (!run) throw new HttpError(404, "not_found");
  return run;
}
