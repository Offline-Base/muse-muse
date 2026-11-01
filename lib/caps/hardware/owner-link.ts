import { hardwareBlock } from "@/lib/caps/hardware/brief";

/**
 * "Open as owner" on a product's page, for a product with board tools: only its owner reaches the board unless they open
 * it to visitors, so they need the owner pass. Null otherwise, and with HARDWARE_BOARD_TOOLS off.
 */
export function hardwareOwnerLink(
  product: { isOwner: boolean; liveUrl: string | null; slug: string; status: string; brief: object | null; served: boolean },
  boardTools?: boolean,
): string | null {
  if (!product.isOwner || !product.served || !product.liveUrl || product.status === "disabled" || product.status === "failed") return null;
  if (!hardwareBlock(product.brief, boardTools)?.boardTools) return null;
  return `/api/products/${encodeURIComponent(product.slug)}/owner-pass`;
}
