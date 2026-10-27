"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icons";
import { AccountMenu, type AccountUser } from "@/components/shell/AccountMenu";
import { Brand } from "@/components/shell/Brand";
import { NavLinks } from "@/components/shell/NavLinks";

/** Phones: a top bar with the brand and a menu button that opens the nav as a sheet (a modal <dialog>). */
export function MobileNav({ user }: { user: AccountUser | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();

  const close = () => dialog.current?.close();
  useEffect(() => {
    close();
  }, [pathname]);

  return (
    <header className="topbar">
      <Brand />
      <button
        type="button"
        className="icon-btn icon-btn-plain"
        aria-label="Open menu"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <Icon name="menu" />
      </button>
      <dialog
        ref={dialog}
        className="sheet"
        aria-label="Menu"
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself.
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="sheet-inner">
          <div className="sheet-head">
            <Link href="/" className="brand" onClick={close}>
              <span className="brand-name">Muse Muse</span>
              <span className="concept">Concept</span>
            </Link>
            <button type="button" className="icon-btn icon-btn-plain" aria-label="Close menu" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          <NavLinks onNavigate={close} />
          <div className="sheet-foot">
            <AccountMenu user={user} />
          </div>
        </div>
      </dialog>
    </header>
  );
}
