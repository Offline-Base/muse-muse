import { Figtree } from "next/font/google";

/**
 * The docs' typeface. dev.meta.ai sets its docs in Meta's own typeface, which isn't ours to ship; Figtree (SIL Open
 * Font License) is the closest free match, within 1 percent of its line widths. It only loads where app/docs/docs.css
 * asks for it, so the rest of Muse Muse keeps its own (Inter, app/fonts/inter.ts).
 */
export const docsFont = Figtree({ subsets: ["latin"], display: "swap", preload: false, variable: "--font-docs" });
