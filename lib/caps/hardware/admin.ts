import { AuthError, GUEST_EMAIL, isCrossSite, requireAdmin, requireUser, type SessionUser } from "@/lib/auth";
import { gadgetConnectOn } from "@/lib/caps/hardware/flags";

/**
 * Who may use the board registry (docs/CAPABILITIES.md, section 19, decision 16): a signed-in admin. OPEN_ACCESS=admin on a
 * preview acts as the first admin for anyone who opens it, so that isn't somebody a board can belong to.
 */
export async function requireBoardAdmin(): Promise<SessionUser> {
  const user = await requireAdmin();
  if (user.openAccess) throw new AuthError("Sign in first. Everyone shares this account, so it can't hold a board.", 403);
  return user;
}

/** The refusal a guest gets, in the words the page shows. */
export const SHARED_ACCOUNT_MESSAGE = "Sign in to pair a board. Guests all share one account here, so a board paired as a guest would be open to every other guest.";

/** False for anyone a board can't belong to: the guest everyone shares, and any open-access visitor. */
export function canOwnBoard(user: Pick<SessionUser, "email" | "openAccess"> | null | undefined): boolean {
  return Boolean(user) && !user!.openAccess && user!.email !== GUEST_EMAIL;
}

/**
 * Who may hold a board. With GADGET_CONNECT, anyone signed in with their own account, because every board and product check after
 * this compares that account's id. Never the shared guest: every guest has the same id, so those checks would pass for all of them.
 * With it off, admins only, as before.
 */
export async function requireBoardOwner(): Promise<SessionUser> {
  if (!gadgetConnectOn()) return requireBoardAdmin();
  const user = await requireUser();
  if (!canOwnBoard(user)) throw new AuthError(SHARED_ACCOUNT_MESSAGE, 403);
  return user;
}

/**
 * With GADGET_CONNECT on, a change to someone's boards comes only from Muse Muse's own pages. A product on a nearby domain would get
 * their Lax cookie, and readJson doesn't care about content type. With it off, nothing changes here.
 */
export function refuseCrossSite(req: Request): void {
  if (gadgetConnectOn() && isCrossSite(req.headers)) throw new AuthError("Requests from other sites can't change a board.", 403);
}
