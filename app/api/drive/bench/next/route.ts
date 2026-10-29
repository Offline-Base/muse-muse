import { toBenchOrder } from "@/lib/drive/logic";
import { benchNext } from "@/lib/drive/store";
import { env } from "@/lib/env";
import { route } from "@/lib/http";
import { noStore, requireBench } from "../../shared";

/**
 * GET -> {order}: the order the bench should flash next (docs/VIBE_TUNING.md, Feature 6, "Fulfillment"): one it already
 * claimed and didn't finish, else the oldest paid one, else null. Its repo and commit, the files with their sizes and
 * sha256, the model's system message, the image version, the order's serial, and the address the drive tells its buyer
 * to write to (DRIVE_CONTACT_EMAIL). Never the buyer's name, email or address: the owner prints the label from the admin
 * queue. The bench token, or an admin or automation.
 */
export const GET = route(async (req: Request) => {
  await requireBench(req);
  const row = await benchNext();
  return Response.json({ order: row ? { ...toBenchOrder(row), contact: env.driveContactEmail } : null }, { headers: noStore });
});
