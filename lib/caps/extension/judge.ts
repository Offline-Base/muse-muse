import type { Brief } from "@/lib/brief/schema";

/** The judge's note for a product with a browser extension (docs/CAPABILITIES.md, section 20). */
export function extensionJudgeNote(_brief: Brief): string {
  return "The extension popup was opened in a test browser as a page at popup size, not from the browser's toolbar, so no toolbar or page shows around it.";
}
