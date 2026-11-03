// U3 SHIM of U1's lib/train/sam/store.ts (tg-sam-core owns it). Only the one read the SAM tune page makes, with the
// signature U2's shim (tg-sam-routes) also assumes: getRunView(id) is the full view (photos and distractors included),
// or null. It throws until U1 merges. On merge, take U1's file and drop this one.
import type { SamRunView } from "@/lib/train/sam/types";

const NOT_MERGED = "lib/train/sam/store.ts is U3's shim: merge tg-sam-core (U1).";

export async function getRunView(_id: string): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
