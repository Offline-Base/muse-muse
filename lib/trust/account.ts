import { eq } from "drizzle-orm";
import type { SessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { builderSpendToday } from "@/lib/trust/spend";
import { TERMS_VERSION } from "@/lib/trust/terms";
import { builderTier } from "@/lib/trust/tiers";

/**
 * The builder's side of trust (docs/CAPABILITIES.md, section 7): the 18+ and terms confirmation at sign-in and before
 * building (TRUST_AGE_GATE), the ban (TRUST_REPORTS) and the builder's daily dollars (TRUST_SIGNED_IN_CAPS). Each reads
 * nothing while its flag is off.
 */

/** A guest's confirmation, remembered in that browser: the TERMS_VERSION they confirmed for. */
export const ADULT_COOKIE = "mm_adult";
export const ADULT_COOKIE_MAX_AGE = 365 * 86_400;

/** A refusal with a status and a plain sentence for the person. */
export class TrustRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 429,
    message: string,
  ) {
    super(message);
  }
}

export const MESSAGES = {
  banned: "This account can't sign in or build on Muse Muse. If you think that's a mistake, use the Report link on one of your products.",
  confirmAtSignIn: "Confirm you're 18 or older and agree to the terms to sign in.",
  confirmToBuild: "Confirm you're 18 or older and agree to the terms before you build. Open Sign in to confirm.",
  overBuilderCap: (cap: number) => `Your products have used today's $${cap.toFixed(2)} for model calls. It resets at 00:00 UTC.`,
} as const;

export interface ConfirmationRow {
  adultConfirmedAt: Date | null;
  termsVersion: string | null;
  bannedAt: Date | null;
}

/** True when this row confirmed 18+ for the current terms. */
export function isConfirmed(row: Pick<ConfirmationRow, "adultConfirmedAt" | "termsVersion"> | null): boolean {
  return Boolean(row?.adultConfirmedAt && row.termsVersion === TERMS_VERSION);
}

/** True when a guest's cookie confirmed 18+ for the current terms. */
export function cookieConfirmed(value: string | null | undefined): boolean {
  return value === TERMS_VERSION;
}

async function loadTrustRow(userId: string): Promise<ConfirmationRow | null> {
  const [row] = await db()
    .select({ adultConfirmedAt: schema.users.adultConfirmedAt, termsVersion: schema.users.termsVersion, bannedAt: schema.users.bannedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row ?? null;
}

/** Records 18+ and the current terms for a signed-in builder. The first confirmation's time is kept. */
export async function recordConfirmation(userId: string, now: Date = new Date()): Promise<void> {
  const row = await loadTrustRow(userId);
  await db()
    .update(schema.users)
    .set({ adultConfirmedAt: row?.adultConfirmedAt ?? now, termsVersion: TERMS_VERSION, termsAcceptedAt: now })
    .where(eq(schema.users.id, userId));
}

/**
 * What sign-in checks once the password and code are right, before the session cookie is set: a banned builder is
 * refused (TRUST_REPORTS), and with TRUST_AGE_GATE someone who hasn't confirmed for these terms must tick the box,
 * which is then recorded. Undefined with both flags off, so sign-in is today's.
 */
export function trustSignInCheck(input: { adult?: unknown; termsVersion?: unknown }): ((user: SessionUser) => Promise<void>) | undefined {
  if (!env.trustReports && !env.trustAgeGate) return undefined;
  return async (user) => {
    const row = await loadTrustRow(user.id);
    if (env.trustReports && row?.bannedAt) throw new TrustRefusal(403, MESSAGES.banned);
    if (!env.trustAgeGate || isConfirmed(row)) return;
    if (input.adult !== true || input.termsVersion !== TERMS_VERSION) throw new TrustRefusal(400, MESSAGES.confirmAtSignIn);
    await recordConfirmation(user.id);
  };
}

export type TrustBuildRefusal = { ok: false; status: 403 | 429; error: string };

/**
 * checkBuildAllowed's trust part, after storage and the platform's pause: a banned builder (TRUST_REPORTS), someone
 * who hasn't confirmed 18+ for these terms (TRUST_AGE_GATE; a guest by the cookie in their browser), and a signed-in
 * builder whose products are over TRUST_BUILDER_DAILY_USD today (TRUST_SIGNED_IN_CAPS). Null, reading nothing, with
 * the flags off.
 */
export async function trustBuildRefusal(user: SessionUser, adultCookie: () => Promise<string | null>): Promise<TrustBuildRefusal | null> {
  if (!env.trustReports && !env.trustAgeGate && !env.trustSignedInCaps) return null;
  const row = user.openAccess ? null : await loadTrustRow(user.id);
  if (env.trustReports && row?.bannedAt) return { ok: false, status: 403, error: MESSAGES.banned };
  if (env.trustAgeGate) {
    const ok = user.openAccess ? cookieConfirmed(await adultCookie()) : isConfirmed(row);
    if (!ok) return { ok: false, status: 403, error: MESSAGES.confirmToBuild };
  }
  if (env.trustSignedInCaps && !user.openAccess && builderTier({ email: user.email, isAdmin: user.isAdmin }) === "builder") {
    const cap = env.trustBuilderDailyUsd;
    if ((await builderSpendToday(user.id)) >= cap) return { ok: false, status: 429, error: MESSAGES.overBuilderCap(cap) };
  }
  return null;
}

/**
 * True when this viewer still has to confirm 18+ for these terms (TRUST_AGE_GATE): a signed-in builder by their
 * account, the shared guest by `adultCookie`. False with the flag off, or with nobody to ask.
 */
export async function needsConfirmation(user: SessionUser | null, adultCookie: () => Promise<string | null>): Promise<boolean> {
  if (!env.trustAgeGate || !user) return false;
  if (user.openAccess) return !cookieConfirmed(await adultCookie());
  return !isConfirmed(await loadTrustRow(user.id));
}
