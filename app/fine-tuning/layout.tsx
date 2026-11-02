import type { ReactNode } from "react";
import { SectionTabs } from "@/components/shell/SectionTabs";

/** The Fine-tuning tabs above this page (components/shell/nav.ts, SECTION_TABS). Pages under this route show none. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionTabs set="tuning" />
      {children}
    </>
  );
}
