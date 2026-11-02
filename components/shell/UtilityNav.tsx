"use client";

import { usePathname } from "next/navigation";
import { HelpDialog } from "@/components/shell/HelpDialog";
import { NavRow } from "@/components/shell/NavLinks";
import { USAGE_ITEM } from "@/components/shell/nav";

/**
 * The sidebar's bottom utilities, above the disclaimer and the account chip: Usage, then Help, which opens a window
 * like meta.ai's Settings with How it works and the Model API docs (HelpDialog).
 */
export function UtilityNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav nav-utility" aria-label="Utilities">
      <ul className="nav-group">
        <li>
          <NavRow item={USAGE_ITEM} pathname={pathname} onNavigate={onNavigate} />
        </li>
        <li>
          <HelpDialog onNavigate={onNavigate} />
        </li>
      </ul>
    </nav>
  );
}
