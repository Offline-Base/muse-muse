import { AuthError, requireAdmin, type SessionUser } from "@/lib/auth";

/**
 * Who may use the board registry (docs/CAPABILITIES.md, section 19, decision 16): a signed-in admin. OPEN_ACCESS=admin on a
 * preview acts as the first admin for anyone who opens it, so that isn't somebody a board can belong to.
 */
export async function requireBoardAdmin(): Promise<SessionUser> {
  const user = await requireAdmin();
  if (user.openAccess) throw new AuthError("Sign in first. Everyone shares this account, so it can't hold a board.", 403);
  return user;
}
