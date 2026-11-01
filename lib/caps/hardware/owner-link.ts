import { hardwareBlock } from "@/lib/caps/hardware/brief";

/**
 * "Open as owner" on a product's page, for a product with board tools or the drive tools: only its owner reaches the board
 * unless they open it to visitors, and the drive tools stay the owner's even then, so they need the owner pass. Null otherwise,
 * and with those tools' flags off.
 */
export function hardwareOwnerLink(
  product: { isOwner: boolean; liveUrl: string | null; slug: string; status: string; brief: object | null; served: boolean },
  boardTools?: boolean,
): string | null {
  if (!product.isOwner || !product.served || !product.liveUrl || product.status === "disabled" || product.status === "failed") return null;
  const block = hardwareBlock(product.brief, boardTools);
  if (!block?.boardTools && !block?.driveExport) return null;
  return `/api/products/${encodeURIComponent(product.slug)}/owner-pass`;
}
