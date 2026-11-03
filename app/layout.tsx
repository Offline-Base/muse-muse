import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { docsFont } from "@/app/docs/font";
import { interFont } from "@/app/fonts/inter";
import { Intro } from "@/components/mascot/Intro";
import { Mascot } from "@/components/mascot/Mascot";
import { MobileNav } from "@/components/shell/MobileNav";
import { Sidebar } from "@/components/shell/Sidebar";
import { VoiceInputLayer } from "@/components/voice/VoiceInputLayer";
import { currentUser } from "@/lib/queries";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";
import "@/components/chat/chat.css";

export const metadata: Metadata = {
  title: { default: "Muse Muse", template: "%s · Muse Muse" },
  description:
    "Give it an example or some inspo and Muse makes it: a working product, tested and live at its own link.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#181819" },
  ],
};

// The shell in the look docs/BRAND.md sets out: a white page, a quiet sidebar and Inter, with no Meta logo, wordmark or
// typeface, a visible Concept tag and disclaimer, and nothing that asks for keys.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await currentUser();
  const user = session
    ? { email: session.email, isAdmin: session.isAdmin, openAccess: Boolean(session.openAccess) }
    : null;
  return (
    // The theme script sets data-theme before React hydrates, so <html> is allowed to differ (lib/theme.ts).
    <html lang="en" className={interFont.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={docsFont.variable}>
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
        <VoiceInputLayer />
        <Mascot />
        <Suspense fallback={null}>
          <Intro />
        </Suspense>
      </body>
    </html>
  );
}
