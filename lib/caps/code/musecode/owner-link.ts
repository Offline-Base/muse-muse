import { codeBlock } from "@/lib/caps/code/brief";
import type { CodeParts } from "@/lib/caps/code/parts";

/**
 * The link the product page shows its owner to the owner pass (app/api/products/[slug]/owner-pass), or null. Muse Code
 * tasks are owner-only with MUSE_CODE_VISITORS off, so this is how an owner reaches them on a live product. Only for a live
 * product whose brief asks for Muse Code, with the part on, so with its flags off the page is what it was.
 */
export function museCodeOwnerLink(
  product: { isOwner: boolean; liveUrl: string | null; slug: string; status: string; brief: object | null; served: boolean },
  parts?: CodeParts,
): string | null {
  if (!product.isOwner || !product.served || !product.liveUrl || product.status === "disabled" || product.status === "failed") return null;
  if (codeBlock(product.brief, parts)?.museCode !== true) return null;
  return `/api/products/${encodeURIComponent(product.slug)}/owner-pass`;
}
