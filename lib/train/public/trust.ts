/**
 * The one place visitor training reads wave 3's trust tiers (docs/CAPABILITIES.md section 17, "Who may train"). Those
 * live in tg-cap-int's lib/trust/tiers.ts (builderTier, tierMayUseBuilderCaps) with users.banned_at (0018_trust) and
 * TRUST_SIGNED_IN_CAPS / TRUST_REPORTS in lib/env.ts, none of which is on tuned-model-options yet. Until they merge,
 * this is the fallback: nobody counts as a signed-in builder (only admins train as their own id, and caller.ts finds
 * them without this file) and nobody is banned, because there is no ban to read.
 *
 * When tg-cap-int lands, swap the bodies for (and nothing else in lib/train/public changes):
 *   signedInCapsOn  -> env.trustSignedInCaps
 *   tierFor         -> builderTier({ ...row, isAdmin: row.isAdmin && env.adminEmails.includes(row.email) }) from a
 *                      users read of email, is_admin, banned_at by id (a gone row is "guest", as briefTierFor does),
 *                      keeping the reserved-address line first: builderTier calls any row but the shared guest's a
 *                      builder, and a visitor trainer's hidden row must never be one
 *   mayTrainAsSelf  -> tierMayUseBuilderCaps
 *   isBanned        -> env.trustReports && Boolean(row?.bannedAt), one read by id (lib/auth.ts bannedNow)
 */

import { isReservedEmail } from "@/lib/train/public/reserved";

export type TrainerTier = "admin" | "builder" | "guest" | "banned";

/** TRUST_SIGNED_IN_CAPS. Fallback: off, so a signed-in non-admin trains as a cookie visitor. */
export function signedInCapsOn(): boolean {
  return false;
}

/**
 * The tier of a signed-in user. A reserved address (the shared guest, a visitor trainer's hidden row) is always "guest".
 * Fallback: admins are admins, everyone else counts as not signed in.
 */
export async function tierFor(user: { id: string; email: string; isAdmin: boolean }): Promise<TrainerTier> {
  if (isReservedEmail(user.email)) return "guest";
  return user.isAdmin ? "admin" : "guest";
}

/** tierMayUseBuilderCaps: admins and signed-in builders, never the shared guest or someone banned. */
export function mayTrainAsSelf(tier: TrainerTier): boolean {
  return tier === "admin" || tier === "builder";
}

/** True when an admin banned this account. Fallback: there is no ban column yet, so nobody is. */
export async function isBanned(_userId: string): Promise<boolean> {
  return false;
}
