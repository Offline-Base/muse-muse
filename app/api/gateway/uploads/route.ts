import { notImplemented } from "@/lib/http";

// Issues short-lived upload tickets so a product's browser can send large files straight to Vercel Blob,
// staying clear of the 4.5 MB function body limit. Files expire after DEFAULT_LIMITS.uploadTtlHours.
// TODO(kickoff, day 3): verify the product token, enforce type and size limits, return a Blob client token.
export async function POST() {
  return notImplemented("Issue an upload ticket for a product");
}
