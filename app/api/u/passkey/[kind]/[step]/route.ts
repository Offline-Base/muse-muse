import { passkeyDeps } from "@/lib/caps/data/deps";
import { handlePasskey } from "@/lib/caps/data/passkeys";

// The passkey ceremonies for products' people (docs/CAPABILITIES.md, section 9): register or login, options or verify.
// Same origin only. 404 while the data cap or DATA_SIGN_IN is off.
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ kind: string; step: string }> }) {
  const { kind, step } = await params;
  return handlePasskey(req, kind, step, passkeyDeps());
}
