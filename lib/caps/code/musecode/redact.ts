/**
 * The secret scan (docs/CAPABILITIES.md, 15b; General's idea from the spike). Before a Muse Code session's events, logs,
 * final text or result files are stored or shown, they are scanned for the literal values of the platform's own
 * secrets and of the session's token, and every hit is replaced with REDACTED. The values are read from the platform's
 * environment in memory, used for comparing only, and never printed or stored.
 *
 * The session's sandbox gets none of these (its env holds only its own token), so a hit means something got out that
 * shouldn't have: the scan is the last line, not the plan.
 */
export const SECRET_ENV_NAMES = ["MODEL_API_KEY", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "BLOB_READ_WRITE_TOKEN", "GATEWAY_TOKEN_PEPPER"] as const;

export const REDACTED = "[redacted]";

/** Values shorter than this aren't scanned for: a short value would match ordinary text, and no real secret is that short. */
const MIN_SECRET_CHARS = 12;

/** The values to scan for: the platform's secrets from `source` (process.env by default) and any extra, longest first. */
export function secretValues(extra: readonly string[] = [], source: Record<string, string | undefined> = process.env): string[] {
  const values = [...SECRET_ENV_NAMES.map((name) => source[name]?.trim() ?? ""), ...extra.map((v) => v.trim())].filter((v) => v.length >= MIN_SECRET_CHARS);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** `text` with every secret value replaced. Counts the hits. */
export function redactText(text: string, secrets: readonly string[]): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const secret of secrets) {
    if (!out.includes(secret)) continue;
    const parts = out.split(secret);
    hits += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, hits };
}

/** A JSON value with every string in it redacted, keys included. The input is not changed. */
export function redactValue<T>(value: T, secrets: readonly string[]): { value: T; hits: number } {
  let hits = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const r = redactText(v, secrets);
      hits += r.hits;
      return r.text;
    }
    if (depth > 64 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k, depth + 1) as string, walk(x, depth + 1)]));
  };
  return { value: (secrets.length ? walk(value, 0) : value) as T, hits };
}

/** Bytes with every secret value replaced, compared as UTF-8 bytes, so a binary file is scanned too. */
export function redactBytes(bytes: Buffer, secrets: readonly string[]): { bytes: Buffer; hits: number } {
  let out = bytes;
  let hits = 0;
  const mark = Buffer.from(REDACTED, "utf8");
  for (const secret of secrets) {
    const needle = Buffer.from(secret, "utf8");
    let at = out.indexOf(needle);
    if (at < 0) continue;
    const parts: Buffer[] = [];
    let from = 0;
    while (at >= 0) {
      parts.push(out.subarray(from, at), mark);
      hits += 1;
      from = at + needle.length;
      at = out.indexOf(needle, from);
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
  }
  return { bytes: out, hits };
}
