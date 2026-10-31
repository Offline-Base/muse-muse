import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter/opsz.css";
import { Footer } from "@/components/Footer";
import "./globals.css";
import "./muse-app.css";

export const metadata: Metadata = {
  title: "Muse Muse product",
  description: "Built with Muse Muse on Meta's models.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#181819" },
  ],
};

// Set metadata.title above to the product's name. A product made from one of Meta's developer videos credits it with
// <Footer credit="<the video's link>" />.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Footer />
      </body>
    </html>
  );
}
