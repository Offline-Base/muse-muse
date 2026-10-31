/**
 * The terms the drive request form shows, and their version (docs/VIBE_TUNING.md, Feature 6, "Legal and trust"): one
 * set for orders paid by an emailed invoice, one for orders paid by card on Stripe Checkout. Each order saves the
 * version its buyer accepted. DRIVE_TERMS_VERSION can name another version of the invoice terms; change both together
 * whenever that text changes, and bump DRIVE_CARD_TERMS_VERSION whenever the card terms change. No imports, so
 * lib/env.ts can read the versions.
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

/** The version of DRIVE_CARD_TERMS. Bump it whenever their text changes. */
export const DRIVE_CARD_TERMS_VERSION = "2026-10-30.card1";

/** The terms for an order paid by card on Stripe Checkout, one plain sentence each. */
export const DRIVE_CARD_TERMS: readonly string[] = [
  "You pay the price shown by card on Stripe's checkout page. US shipping is included. Nothing is charged until you pay there.",
  "You can cancel until we start writing your drive, and we refund your card in full.",
  "We ship to US addresses only, within 2 business days after payment. If we can't, we email you and you can cancel for a full refund.",
  "If the drive arrives broken or a file on it doesn't match its checksum, write to us for a replacement or a refund at the address on your order page. That is our refund policy, not a warranty.",
  "The model is a fine-tune of Meta's Muse Glimmer 30B, under the Apache License 2.0. Meta didn't make, review or endorse it.",
  "Meta's Usage Policy for Muse Glimmer applies to how you use it, and it is not intended for anyone under 18.",
  "We keep your name, email and address to ship the drive, and delete them 60 days after delivery or cancellation. Stripe handles your card; we never see its number.",
  "An order you don't pay for within 7 days is cancelled.",
];
