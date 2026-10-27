import { AccountMenu, type AccountUser } from "@/components/shell/AccountMenu";
import { Brand } from "@/components/shell/Brand";
import { NavLinks } from "@/components/shell/NavLinks";

export const DISCLAIMER = "Independent concept built on Meta's Model API. Not an official Meta product.";

/** Wide screens: the fixed left sidebar on the page color, with the account chip pinned to the bottom. */
export function Sidebar({ user }: { user: AccountUser | null }) {
  return (
    <aside className="sidebar">
      <Brand />
      <NavLinks />
      <div className="sidebar-foot">
        <p className="disclaimer">{DISCLAIMER}</p>
        <AccountMenu user={user} />
      </div>
    </aside>
  );
}
