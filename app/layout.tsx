import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Muse Muse",
  description: "Give it an example or inspo and Muse makes it.",
};

// Dashboard-native shell (docs/DESIGN.md, "Dashboard-native UI"): developer-dashboard patterns,
// no Meta logo or wordmark, a visible Concept tag, and no sign-in or key pages styled like Meta's.
const NAV = [
  { href: "/", label: "Make" },
  { href: "/rebuilds", label: "Rebuilds" },
  { href: "/gallery", label: "Gallery" },
  { href: "/usage", label: "Usage" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidenav" aria-label="Muse Muse">
            <div className="brand">
              <span>Muse Muse</span>
              <span className="tag">Concept</span>
            </div>
            <nav aria-label="Sections">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </aside>
          <div className="content">
            {children}
            <footer className="site-foot">
              Muse Muse is an independent concept built on Meta&apos;s Model API. Not an official Meta product.
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
