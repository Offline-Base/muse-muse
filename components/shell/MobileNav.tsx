import type { AccountUser } from "@/components/shell/AccountMenu";
import { DOCS_NAV } from "@/components/shell/docs-nav";
import { MobileNavClient } from "@/components/shell/MobileNavClient";
import { env } from "@/lib/env";

/**
 * Phones: the top bar and its menu sheet (MobileNavClient). A server component so the docs nav is computed here and
 * passed down as props, while the root layout keeps rendering <MobileNav user={...} /> as before.
 */
export function MobileNav({ user }: { user: AccountUser | null }) {
  return <MobileNavClient user={user} docsNav={DOCS_NAV} {...(env.trustLegalPages ? { legal: true } : {})} />;
}
