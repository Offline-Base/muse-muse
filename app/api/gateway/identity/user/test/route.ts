import { dataDeps } from "@/lib/caps/data/deps";
import { handleIdentityUserTest } from "@/lib/caps/data/handler";

// A build's tests sign in a made-up person (docs/CAPABILITIES.md, section 9). Build tokens only, 20 a build.
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleIdentityUserTest(req, dataDeps());
}
