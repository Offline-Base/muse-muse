/**
 * The addresses the platform keeps for accounts nobody signs in as: the shared guest (guest@musemuse.invalid) and each
 * visitor trainer's hidden row (t-<hex>@trainer.musemuse.invalid, lib/train/public/identity.ts). No imports, so the
 * sign-in check in lib/auth.ts can use it without pulling in the training code.
 */

/** Where visitor trainers' hidden users rows live. ".invalid" can never be a real address. */
export const TRAINER_EMAIL_DOMAIN = "trainer.musemuse.invalid";

/** The daily counters a trainer's day carries over to the user who adopts it (lib/train/public/limits.ts keys them). */
export const ADOPTED_COUNTERS = ["run", "dry", "dataset"] as const;
export const visitorCounterKey = (kind: (typeof ADOPTED_COUNTERS)[number], trainerId: string) => `train-pub:${kind}:v:${trainerId}`;

/**
 * True for an address at musemuse.invalid or any name under it, with or without a trailing dot. Sign-in refuses these,
 * so nobody can claim one.
 */
export function isReservedEmail(email: string): boolean {
  return /@(?:[^@\s]+\.)?musemuse\.invalid\.?$/i.test(email.trim());
}
