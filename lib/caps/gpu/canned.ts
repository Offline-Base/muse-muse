import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/tools/sign";

/**
 * What a build token gets from the shared endpoint (docs/CAPABILITIES.md, 2.7): a sample reply, never a model and never a
 * GPU. The pick is hash(normalized arguments) % n, so a verify run sees the same reply every time. A product's tests assert
 * that a reply shows, not these words.
 */
export const GLIMMER_CANNED_REPLIES = [
  "Here is a sample answer from Muse Glimmer. In this test run no model wrote it.",
  "This is a sample reply standing in for Muse Glimmer while the product is being tested.",
  "Sample answer: Muse Glimmer would answer here once a demo window is open.",
] as const;

export function cannedGlimmerReply(args: unknown): string {
  const hash = createHash("sha256").update(canonicalJson(args)).digest();
  return GLIMMER_CANNED_REPLIES[hash.readUInt32BE(0) % GLIMMER_CANNED_REPLIES.length]!;
}
