/**
 * The bench token (docs/VIBE_TUNING.md, Feature 6, "Fulfillment"): scripts/drive-bench.ts sends it to the bench routes,
 * and the platform keeps only its hash, as DRIVE_BENCH_TOKEN_HASH. The token is 32 random bytes, so its plain SHA-256
 * guards it as well as the gateway's peppered HMAC would, and making a pair needs no platform secret: the bench Mac's
 * .env.local holds the token and nothing of production's.
 */
import { createHash, randomBytes } from "node:crypto";

/** A new bench token: "mm_bench_" and 32 random bytes. */
export function newBenchToken(): string {
  return `mm_bench_${randomBytes(32).toString("base64url")}`;
}

/** The hash DRIVE_BENCH_TOKEN_HASH holds for a bench token: its SHA-256, in hex. */
export function benchTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
