import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/montserrat";
import { Footer } from "@/components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "Muse Muse product",
  description: "Built with Muse Muse on Meta's models.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#252728" },
  ],
};

// Set metadata.title above to the product's name. Optional: data-accent on <html> picks the hue of the product's
// signature element: "cherry", "grape", "lemon", "lime", "pink" or "teal" (meta-ui skill). Leave it off for Meta blue.
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
