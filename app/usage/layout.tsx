import type { ReactNode } from "react";
import { SectionTabs } from "@/components/shell/SectionTabs";

/** The Usage tabs above this page (components/shell/nav.ts, SECTION_TABS). Pages under this route show none. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionTabs set="usage" />
      {children}
    </>
  );
}
