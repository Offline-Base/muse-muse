import localFont from "next/font/local";

/**
 * The platform's typeface: Inter (SIL Open Font License, app/fonts/Inter.LICENSE.txt), with its optical size axis.
 * Vendored from @fontsource-variable/inter 5.3.0 rather than fetched, so nothing depends on a font CDN. docs/BRAND.md,
 * "The font", has the measurements behind the choice. The class goes on <html>, because --font reads it on :root.
 */
export const interFont = localFont({
  src: "./inter-latin-opsz-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-inter",
});
