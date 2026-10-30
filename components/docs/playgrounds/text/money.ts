/**
 * A dollar amount that keeps small values readable: "$0.000044" where the kit's formatUsd says "under $0.0001",
 * since the caching demo is about exactly that difference. Cents from a dollar up ("$2.00"); below a dollar, two
 * significant digits ("$0.010", "$0.033", "$0.50"), so $0.0104 doesn't read as a flat cent next to "$0.033".
 */
export function usdExact(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const decimals = Math.min(10, Math.max(2, Math.ceil(-Math.log10(usd)) + 1));
  return `$${usd.toFixed(decimals)}`;
}
