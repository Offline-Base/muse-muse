import { AccountMenu, type AccountUser } from "@/components/shell/AccountMenu";
import { Brand } from "@/components/shell/Brand";
import { DISCLAIMER } from "@/components/shell/disclaimer";
import { DOCS_NAV } from "@/components/shell/docs-nav";
import { ShellNav } from "@/components/shell/ShellNav";
import { TrustLinks } from "@/components/trust/TrustLinks";
import { env } from "@/lib/env";

export { DISCLAIMER };

/**
 * Wide screens: the fixed left sidebar on the page color, with the account chip pinned to the bottom. On /docs/* its
 * rows become the docs navigation (ShellNav), from the docs nav computed here on the server.
 */
export function Sidebar({ user }: { user: AccountUser | null }) {
  return (
    <aside className="sidebar">
      <Brand />
      <ShellNav docsNav={DOCS_NAV} />
      <div className="sidebar-foot">
        <p className="disclaimer">{DISCLAIMER}</p>
        {env.trustLegalPages ? <TrustLinks /> : null}
        <AccountMenu user={user} />
      </div>
    </aside>
  );
}
