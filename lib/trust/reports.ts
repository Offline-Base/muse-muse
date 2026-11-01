import { createHmac } from "node:crypto";
import { REPORT_REASONS, type ReportReason } from "@/lib/db/schema";

/**
 * Reports (TRUST_REPORTS, docs/CAPABILITIES.md, section 7). Anyone can file one from a product's Report link, at most 3
 * a minute and 5 a day from one IP. The IP is kept only as reporterKey: an HMAC cut to 32 characters, so repeats can be
 * limited and spotted, and the address itself is never stored or shown.
 */

export const REPORT_LIMITS = { perMinute: 3, perDay: 5, detailMaxChars: 1000 } as const;

/** What each reason means, in the words the report form shows. */
export const REASON_LABELS: Record<ReportReason, string> = {
  illegal: "It's illegal, or helps someone break the law",
  harm: "It could hurt someone",
  privacy: "It shares or collects personal information, or I want my data removed",
  copyright: "It copies someone's work, brand or product",
  impersonation: "It pretends to be a real person or organization",
  broken: "It doesn't work",
  other: "Something else",
};

export interface ReportInput {
  slug: string;
  reason: ReportReason;
  detail: string;
}

/** The body's report, or a plain sentence saying what's wrong with it. */
export function parseReport(body: Record<string, unknown>): { ok: true; value: ReportInput } | { ok: false; error: string } {
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return { ok: false, error: "That product link isn't one Muse Muse made." };
  const reason = body.reason;
  if (typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: "Pick what's wrong with it." };
  }
  const detail = typeof body.detail === "string" ? body.detail.trim() : body.detail == null ? "" : null;
  if (detail === null) return { ok: false, error: "Send the details as text." };
  if (detail.length > REPORT_LIMITS.detailMaxChars) {
    return { ok: false, error: `Keep the details under ${REPORT_LIMITS.detailMaxChars.toLocaleString("en-US")} characters.` };
  }
  for (const k of Object.keys(body)) {
    if (!["slug", "reason", "detail"].includes(k)) return { ok: false, error: "The report has a field it doesn't take." };
  }
  return { ok: true, value: { slug, reason: reason as ReportReason, detail } };
}

/** The reporter's first IP as Vercel forwards it, or "unknown". */
export function reporterIp(h: Headers): string {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown";
}

/** HMAC of the IP with a key only the platform holds, cut to 32 characters. */
export function reporterKey(ip: string, secret: Buffer | string): string {
  return createHmac("sha256", secret).update(`musemuse-report:${ip}`).digest("base64url").slice(0, 32);
}

/** The start of now's minute, and the end of now's UTC day (where daily counters live, so the hourly prune keeps them). */
export function reportWindows(now: Date): { minute: Date; day: Date } {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const day = new Date(now);
  day.setUTCHours(24, 0, 0, 0);
  return { minute, day };
}

export interface ReportDeps {
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  findProductId(slug: string): Promise<string | null>;
  insertReport(row: { productId: string | null; productSlug: string; reason: ReportReason; detail: string; reporterKey: string }): Promise<void>;
  now(): Date;
}

export type ReportResult = { ok: true } | { ok: false; status: 429; error: string };

/** Counts the report against the reporter's minute and day, then saves it. */
export async function fileReport(input: ReportInput, key: string, deps: ReportDeps): Promise<ReportResult> {
  const { minute, day } = reportWindows(deps.now());
  const perMinute = await deps.hitRateLimits([`report-min:${key}`], minute);
  if ((perMinute[`report-min:${key}`] ?? 0) > REPORT_LIMITS.perMinute) {
    return { ok: false, status: 429, error: "That's a lot of reports at once. Wait a minute, then try again." };
  }
  const perDay = await deps.hitRateLimits([`report-day:${key}`], day);
  if ((perDay[`report-day:${key}`] ?? 0) > REPORT_LIMITS.perDay) {
    return { ok: false, status: 429, error: `You've sent ${REPORT_LIMITS.perDay} reports today, the most one person can. Try again tomorrow.` };
  }
  await deps.insertReport({ productId: await deps.findProductId(input.slug), productSlug: input.slug, reason: input.reason, detail: input.detail, reporterKey: key });
  return { ok: true };
}
