// U2 SHIM of U1's lib/train/sam/worker-auth.ts (tg-sam-core owns it). On merge, take U1's file and drop this one.
// The routes assume both throw HttpError(401, "unauthorized") on a bad secret or token, and that requireRunToken takes
// the token the route read (from the JSON body's jobToken, or the X-Job-Token header on /upload, whose body is the file).
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";

/** "Authorization: Bearer <worker secret>" whose sha256 is SAM_WORKER_TOKEN_SHA256. */
export async function requireWorker(req: Request): Promise<void> {
  const want = env.samWorkerTokenSha256;
  const header = req.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!want || !/^[0-9a-f]{64}$/.test(want) || !secret) throw new HttpError(401, "unauthorized");
  const got = createHash("sha256").update(secret).digest();
  if (!timingSafeEqual(got, Buffer.from(want, "hex"))) throw new HttpError(401, "unauthorized");
}

/** The run's own jobToken (stored hashed). Shim: refuses everything until U1's store is merged. */
export async function requireRunToken(_req: Request, _id: string, _token: string): Promise<void> {
  throw new HttpError(401, "unauthorized");
}
