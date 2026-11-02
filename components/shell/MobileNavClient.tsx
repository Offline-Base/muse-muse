"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icons";
import { AccountMenu, type AccountUser } from "@/components/shell/AccountMenu";
import { Brand } from "@/components/shell/Brand";
import { DISCLAIMER } from "@/components/shell/disclaimer";
import { StartMusing } from "@/components/shell/NavLinks";
import { ShellNav } from "@/components/shell/ShellNav";
import { UtilityNav } from "@/components/shell/UtilityNav";
import { TrustLinks } from "@/components/trust/TrustLinks";
import type { LocalNavSection } from "@/lib/docs/pages";

/**
 * Phones: a top bar with the brand and a menu button that opens the nav as a sheet (a modal <dialog>). The sheet
 * follows the sidebar's switch: the docs navigation on /docs/*, the platform's elsewhere.
 */
/** `legal` (TRUST_LEGAL_PAGES, wave 3 unit 1) adds the Terms and Privacy links under the disclaimer. */
export function MobileNavClient({ user, docsNav, legal }: { user: AccountUser | null; docsNav: LocalNavSection[]; legal?: boolean }) {
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
            <Brand onClick={close} />
            <button type="button" className="icon-btn icon-btn-plain" aria-label="Close menu" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          <StartMusing onNavigate={close} />
          <ShellNav docsNav={docsNav} onNavigate={close} />
          <div className="sheet-foot">
            <UtilityNav onNavigate={close} />
            <p className="disclaimer">{DISCLAIMER}</p>
            {legal ? <TrustLinks onNavigate={close} /> : null}
            <AccountMenu user={user} />
          </div>
        </div>
      </dialog>
    </header>
  );
}
