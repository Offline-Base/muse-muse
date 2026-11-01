import { dataDeps } from "@/lib/caps/data/deps";
import { handleIdentityUserLink } from "@/lib/caps/data/handler";

// The platform's passkey page for this product, for its Sign in link (docs/CAPABILITIES.md, section 9).
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleIdentityUserLink(req, dataDeps());
}
