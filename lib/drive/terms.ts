/**
 * The terms the drive request form shows, and their version (docs/VIBE_TUNING.md, Feature 6, "Legal and trust"). Each
 * order saves the version its buyer accepted. DRIVE_TERMS_VERSION can name another version; change both together
 * whenever this text changes. No imports, so lib/env.ts can read the version.
 */

export const DRIVE_TERMS_DEFAULT_VERSION = "2026-10-28.2";

/** The terms, one plain sentence each. The form shows them folded under the box that accepts them. */
export const DRIVE_TERMS: readonly string[] = [
  "This is a request, not a purchase. Nothing is charged on this site.",
  "We email an invoice with the price within 2 business days. You pay it from the email, and you can cancel until we start writing your drive. If you cancel after paying, we refund what you paid.",
  "We ship to US addresses only, within 2 business days after payment. If we can't, we email you and you can cancel for a full refund.",
  "If the drive arrives broken or a file on it doesn't match its checksum, write to us for a replacement or a refund: reply to your invoice's email, or use the address on your order page. That is our refund policy, not a warranty.",
  "The model is a fine-tune of Meta's Muse Glimmer 30B, under the Apache License 2.0. Meta didn't make, review or endorse it.",
  "Meta's Usage Policy for Muse Glimmer applies to how you use it, and it is not intended for anyone under 18.",
  "We keep your name, email and address to ship the drive, and delete them 60 days after delivery or cancellation.",
];
