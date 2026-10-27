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
}

/** Bottom-of-sidebar account chip with a ⋯ menu, or a Sign in button when signed out. */
export function AccountMenu({ user }: { user: AccountUser | null }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!user) {
    const next = pathname.startsWith("/sign-in") ? "/" : pathname;
    return (
      <Link className="btn btn-outline account-signin" href={`/sign-in?next=${encodeURIComponent(next)}`}>
        <Icon name="user" size={18} />
        <span>Sign in</span>
      </Link>
    );
  }

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
        {initials(user.email)}
      </span>
      <span className="account-text">
        <span className="account-name" title={user.email}>
          {user.email}
        </span>
        <span className="account-sub">{user.isAdmin ? "Admin" : "Builder"}</span>
      </span>
      <Menu label="Account menu" icon="more" align="end" buttonClassName="icon-btn icon-btn-plain">
        <Link className="menu-item" href="/builds">
          <Icon name="layers" size={18} />
          My builds
        </Link>
        <button type="button" className="menu-item" onClick={signOut} disabled={busy}>
          <Icon name="logout" size={18} />
          {busy ? "Signing out" : "Sign out"}
        </button>
      </Menu>
    </div>
  );
}
