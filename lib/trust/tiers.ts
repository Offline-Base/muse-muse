import { eq } from "drizzle-orm";
import { GUEST_EMAIL } from "@/lib/auth";
import { CAP_NEEDS_BUILDER, type CapId } from "@/lib/caps/ids";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Sign-in tiers (TRUST_SIGNED_IN_CAPS, docs/CAPABILITIES.md, section 7). Stateless products stay open to guests. Caps
 * marked CAP_NEEDS_BUILDER (saving data, files, connected accounts, jobs, running code, Python, hardware) need a
 * signed-in builder: anyone who signed in with the shared access code (decision 3), not the shared guest account
 * everyone builds as under OPEN_ACCESS=guest, and not someone an admin banned.
 */

export type BuilderTier = "admin" | "builder" | "guest" | "banned";

/** True for the shared guest account (OPEN_ACCESS=guest), whoever is using it. */
export function isGuestAccount(user: { email: string }): boolean {
  return user.email === GUEST_EMAIL;
}

/** Who a user is for tiers: an admin, a signed-in builder, the shared guest, or banned. */
export function builderTier(user: { email: string; isAdmin?: boolean; bannedAt?: Date | null }): BuilderTier {
  if (user.bannedAt) return "banned";
  if (isGuestAccount(user)) return "guest";
  return user.isAdmin ? "admin" : "builder";
}

/** True when a product owner of this tier may have products with builder caps (the cap gate's check 4, unit 3). */
export function tierMayUseBuilderCaps(tier: BuilderTier): boolean {
  return tier === "admin" || tier === "builder";
}

/**
 * The caps this builder's brief writer may pick: every enabled cap while TRUST_SIGNED_IN_CAPS is off, as today. With it
 * on, a guest or a banned builder gets only the caps that don't need a signed-in builder.
 */
export function capsForBuilder(
  tier: BuilderTier,
  enabled: readonly CapId[] = env.enabledCaps,
  signedInCaps: boolean = env.trustSignedInCaps,
): CapId[] {
  if (!signedInCaps || tierMayUseBuilderCaps(tier)) return [...enabled];
  return enabled.filter((c) => !CAP_NEEDS_BUILDER[c]);
}

/**
 * The writer rule a guest's brief gets while TRUST_SIGNED_IN_CAPS is on (section 7, "Brief"), so a note that asks to
 * save data gets the version that works without it, with that as a limit.
 */
export const GUEST_WRITER_RULE =
  "This person isn't signed in, so the product can't save data, connect accounts, run jobs, run code or use GPUs. Build the version that works without them and list that as a limit.";

/** What briefStep passes the brief writer about who is building. */
export interface BriefTier {
  caps: CapId[];
  guest: boolean;
}

/**
 * The brief writer's caps and guest rule for the user who started a build, or undefined while TRUST_SIGNED_IN_CAPS is
 * off, which reads nothing and leaves the writer exactly as it is today.
 */
export async function briefTierFor(userId: string): Promise<BriefTier | undefined> {
  if (!env.trustSignedInCaps) return undefined;
  const [row] = await db()
    .select({ email: schema.users.email, isAdmin: schema.users.isAdmin, bannedAt: schema.users.bannedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  // A user row that's gone is treated as the guest: the narrowest writer.
  const tier = row ? builderTier({ ...row, isAdmin: row.isAdmin && env.adminEmails.includes(row.email) }) : "guest";
  return { caps: capsForBuilder(tier), guest: !tierMayUseBuilderCaps(tier) };
}
