/**
 * The server's check, made again for every build, change, verify and publish (docs/BUILD_KEYS.md): whether this build
 * gets the owner's shared accounts. With BUILD_SHARED_KEYS off it reads nothing and gives null, so everything is as
 * before. The grant holds real values: keep it inside the step that asked, and never return it from one.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import {
  principalMayUseSharedKeys,
  sharedKeysOn,
  sharedServicesFrom,
  warnSkipped,
  type EnvSource,
  type SharedGrant,
  type SharedPrincipalUser,
} from "@/lib/keys/shared";

export interface GrantDeps {
  loadUser(userId: string): Promise<SharedPrincipalUser | null>;
  adminEmails(): readonly string[];
  source(): EnvSource;
}

const liveDeps: GrantDeps = {
  async loadUser(userId) {
    const [row] = await db()
      .select({ email: schema.users.email, isAdmin: schema.users.isAdmin, bannedAt: schema.users.bannedAt, passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    // Only whether a password is set leaves this function, never the hash.
    return row ? { email: row.email, isAdmin: row.isAdmin, bannedAt: row.bannedAt ?? null, hasPassword: Boolean(row.passwordHash) } : null;
  },
  adminEmails: () => env.adminEmails,
  source: () => process.env,
};

/** The build's grant, or null: flag off, nothing set up, or not started by a signed-in builder. */
export async function sharedKeysForBuild(
  build: { userId: string | null; kind: string; rebuildOf: string | null },
  deps: GrantDeps = liveDeps,
): Promise<SharedGrant | null> {
  const source = deps.source();
  if (!sharedKeysOn(source)) return null;
  const { grant, skipped } = sharedServicesFrom(source);
  warnSkipped(skipped);
  if (!grant.services.length) return null;
  const user = build.userId ? await deps.loadUser(build.userId) : null;
  const ok = principalMayUseSharedKeys({ kind: build.kind === "refine" ? "refine" : "build", rebuildOf: build.rebuildOf, user }, deps.adminEmails());
  return ok ? grant : null;
}
