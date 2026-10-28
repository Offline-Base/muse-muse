import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "Muse Muse product",
  description: "Built with Muse Muse on Meta's models.",
};

// Set data-theme to the theme that fits this product: "warm", "playful", "fresh" or "ink" (product-ui skill, Look).
// Leave it off for the default blue. Set metadata.title above to the product's name.
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
