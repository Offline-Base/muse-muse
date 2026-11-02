"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { initials } from "@/lib/format";

export interface AccountUser {
  email: string;
  isAdmin: boolean;
  /** Sign-in is off (OPEN_ACCESS), so this is the shared account rather than the visitor's own. */
  openAccess?: boolean;
}

/**
 * Bottom-of-sidebar account chip with a ⋯ menu, or a Sign in button when signed out. While sign-in is off, the chip
 * names the shared account and the menu offers Sign in instead of Sign out, since there's no session to end.
 */
export function AccountMenu({ user }: { user: AccountUser | null }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const signInHref = `/sign-in?next=${encodeURIComponent(pathname.startsWith("/sign-in") ? "/" : pathname)}`;

  if (!user) {
    return (
      <Link className="btn btn-outline account-signin" href={signInHref}>
        <Icon name="user" size={18} />
        <span>Sign in</span>
      </Link>
    );
  }

  const name = user.openAccess && !user.isAdmin ? "Guest" : user.email;
  const role = user.isAdmin ? "Admin" : "Builder";

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
    } catch {
      // Navigating home below still clears what the page shows; the cookie expires on its own.
    } finally {
      setBusy(false);
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="account">
      <span className="avatar" aria-hidden>
        {initials(name)}
      </span>
      <span className="account-text">
        <span className="account-name" title={name}>
          {name}
        </span>
        <span className="account-sub">{user.openAccess ? `${role}, sign-in off` : role}</span>
      </span>
      <Menu label="Account menu" icon="more" align="end" buttonClassName="icon-btn icon-btn-plain">
        <Link className="menu-item" href="/builds">
          <Icon name="layers" size={18} />
          My musings
        </Link>
        {user.openAccess ? (
          <Link className="menu-item" href={signInHref}>
            <Icon name="user" size={18} />
            Sign in
          </Link>
        ) : (
          <button type="button" className="menu-item" onClick={signOut} disabled={busy}>
            <Icon name="logout" size={18} />
            {busy ? "Signing out" : "Sign out"}
          </button>
        )}
      </Menu>
    </div>
  );
}
