import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { MobileNav } from "@/components/shell/MobileNav";
import { Sidebar } from "@/components/shell/Sidebar";
import { currentUser } from "@/lib/queries";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Muse Muse", template: "%s · Muse Muse" },
  description:
    "Give it an example or some inspo and Muse makes it: a working product, tested and live at its own link.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1013" },
  ],
};

// Dashboard-native shell (docs/DESIGN.md, "Dashboard-native UI"; docs/UI_PATTERNS.md): developer-dashboard
// patterns, no Meta logo, wordmark or font, a visible Concept tag and disclaimer, and nothing that asks for keys.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await currentUser();
  const user = session
    ? { email: session.email, isAdmin: session.isAdmin, openAccess: Boolean(session.openAccess) }
    : null;
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <Sidebar user={user} />
          <div className="main">
            <MobileNav user={user} />
            <div id="main" className="main-inner" tabIndex={-1}>
              {children}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
