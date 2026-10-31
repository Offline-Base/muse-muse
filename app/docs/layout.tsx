import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./docs.css";
import "@/components/docs/kit/kit.css";
import { DocsChat } from "@/components/docs/chat/DocsChat";
import { DocsVisitor } from "@/components/docs/page/DocsVisitor";
import { SearchPalette } from "@/components/docs/page/SearchPalette";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Docs · Muse Muse" },
};

/**
 * The docs frame (docs/DOCS_MIRROR.md, "Page layout"): each page lays out its content column and the "On this page"
 * column inside it, and the search palette (Search box, Cmd/Ctrl+K) is mounted once here for every docs page, as is
 * the visitor warm-up that gives a first-time reader their mm_docs cookie before any demo runs. The docs assistant
 * sidebar is mounted here too, so its conversation carries from page to page.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="docs-frame">
      {children}
      <SearchPalette />
      <DocsVisitor />
      <DocsChat />
    </div>
  );
}
