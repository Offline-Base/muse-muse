import { mac, sameMac } from "@/lib/tools/sign";

/**
 * A job token (docs/CAPABILITIES.md, 2.2): `jr1.<product>.<run>.<exp>.<sig>`, 10 minutes, one run. The cron mints a live
 * one for each tick and /jobs/test-fire a build's. A build's is signed with its build id, so it never passes on a live
 * token's call, or on another build's.
 */
const LABEL = "job-run";
const NO_BUILD = "live";

const parts = (productId: string, runId: string, exp: string, buildId: string | null | undefined) => [productId, runId, exp, buildId ?? NO_BUILD];

export function mintJobToken(input: { productId: string; runId: string; buildId?: string | null; expiresAt: Date }): string {
  const exp = String(input.expiresAt.getTime());
  return `jr1.${input.productId}.${input.runId}.${exp}.${mac(LABEL, parts(input.productId, input.runId, exp, input.buildId))}`;
}

/** The run a job token names, when it is good for this product's token right now. Otherwise null. */
export function readJobToken(raw: string | null | undefined, token: { productId: string; buildId?: string | null }, now: Date): { runId: string; expiresAt: Date } | null {
  const bits = (raw ?? "").trim().split(".");
  if (bits.length !== 5 || bits[0] !== "jr1") return null;
  const [, productId, runId, exp, sig] = bits as [string, string, string, string, string];
  if (productId !== token.productId || !/^\d{1,16}$/.test(exp) || Number(exp) <= now.getTime()) return null;
  if (!sameMac(sig, mac(LABEL, parts(productId, runId, exp, token.buildId)))) return null;
  return { runId, expiresAt: new Date(Number(exp)) };
}
