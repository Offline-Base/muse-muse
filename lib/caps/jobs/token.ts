import { mac, sameMac } from "@/lib/tools/sign";

/**
 * A job token (docs/CAPABILITIES.md, 2.2): `jr1.<product>.<run>.<tick>.<attempt>.<exp>.<sig>`, 10 minutes, one try of one
 * tick of one run. The cron mints a live one for each try and /jobs/test-fire a build's. A build's is signed with its build
 * id, so it never passes on a live token's call, or on another build's. The tick and try are signed so that a handler
 * outliving its try can't close the tick that came after it.
 */
const LABEL = "job-run";
const NO_BUILD = "live";

const parts = (productId: string, runId: string, tick: string, attempt: string, exp: string, buildId: string | null | undefined) => [productId, runId, tick, attempt, exp, buildId ?? NO_BUILD];

export function mintJobToken(input: { productId: string; runId: string; tick: number; attempt: number; buildId?: string | null; expiresAt: Date }): string {
  const exp = String(input.expiresAt.getTime());
  const [tick, attempt] = [String(input.tick), String(input.attempt)];
  return `jr1.${input.productId}.${input.runId}.${tick}.${attempt}.${exp}.${mac(LABEL, parts(input.productId, input.runId, tick, attempt, exp, input.buildId))}`;
}

/** The run, tick and try a job token names, when it is good for this product's token right now. Otherwise null. */
export function readJobToken(raw: string | null | undefined, token: { productId: string; buildId?: string | null }, now: Date): { runId: string; tick: number; attempt: number; expiresAt: Date } | null {
  const bits = (raw ?? "").trim().split(".");
  if (bits.length !== 7 || bits[0] !== "jr1") return null;
  const [, productId, runId, tick, attempt, exp, sig] = bits as [string, string, string, string, string, string, string];
  if (productId !== token.productId || !/^\d{1,16}$/.test(exp) || !/^\d{1,6}$/.test(tick) || !/^\d{1,6}$/.test(attempt) || Number(exp) <= now.getTime()) return null;
  if (!sameMac(sig, mac(LABEL, parts(productId, runId, tick, attempt, exp, token.buildId)))) return null;
  return { runId, tick: Number(tick), attempt: Number(attempt), expiresAt: new Date(Number(exp)) };
}
