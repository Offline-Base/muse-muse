/**
 * Who is looking at the fine-tuning pages. Not a page: Next only serves page.tsx files. The pages show every job's
 * logs, tracebacks, instance ids, IPs and artifact links, so they check admin the way the /api/train routes do
 * (requireUser in lib/auth.ts): a session's admin flag counts only while the user's row still says admin.
 */
import { unstable_rethrow } from "next/navigation";
import { isAdminNow, loadUser, type SessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { currentUser } from "@/lib/queries";

export interface ViewerDeps {
  currentUser: () => Promise<SessionUser | null>;
  loadUser: (id: string) => Promise<{ email: string; isAdmin: boolean } | null>;
  adminEmails: () => string[];
}

const defaultDeps: ViewerDeps = { currentUser, loadUser, adminEmails: () => env.adminEmails };

/**
 * The signed-in user, or null, with isAdmin confirmed against the database. The open-access account comes from
 * OPEN_ACCESS, not a cookie, so it is taken as it is. Never throws: when the database can't confirm, the user is not
 * an admin here. Unlike requireAdmin it doesn't refuse cross-site requests, so an admin can open a job page from a link.
 */
export async function pageViewer(deps: ViewerDeps = defaultDeps): Promise<SessionUser | null> {
  const user = await deps.currentUser();
  if (!user || !user.isAdmin || user.openAccess) return user;
  try {
    return { ...user, isAdmin: isAdminNow(user, await deps.loadUser(user.id), deps.adminEmails()) };
  } catch (err) {
    unstable_rethrow(err);
    console.error("[fine-tuning] couldn't confirm admin:", err instanceof Error ? err.message : err);
    return { ...user, isAdmin: false };
  }
}
