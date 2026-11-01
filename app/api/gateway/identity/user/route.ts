import { dataDeps } from "@/lib/caps/data/deps";
import { handleIdentityUser } from "@/lib/caps/data/handler";

// A live product trades the sign-in code from /u/sign-in for a 30-day session (docs/CAPABILITIES.md, section 9).
// 404 unknown_endpoint while DATA_ENABLED or DATA_SIGN_IN is off.
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleIdentityUser(req, dataDeps());
}
