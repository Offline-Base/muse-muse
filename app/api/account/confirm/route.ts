import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { ADULT_COOKIE, ADULT_COOKIE_MAX_AGE, recordConfirmation } from "@/lib/trust/account";
import { TERMS_VERSION } from "@/lib/trust/terms";

/**
 * POST {adult: true, termsVersion} -> 200 {ok, termsVersion}. Records that the person is 18 or older and accepts these
 * terms (TRUST_AGE_GATE, docs/CAPABILITIES.md, section 7): on a signed-in builder's account, and in a cookie for this
 * browser, which is all the shared guest account has. 400 without the box ticked, 409 when the terms changed since the
 * page loaded, 401 signed out, 404 with the flag off.
 */
export const POST = route(async (req: Request) => {
  if (!env.trustAgeGate) return errorJson(404, "not_found");
  const user = await requireUser();
  const body = await readJson(req, 4096);
  if (body.adult !== true) return errorJson(400, "Tick the box to confirm you're 18 or older.");
  if (body.termsVersion !== TERMS_VERSION) return errorJson(409, "The terms changed since this page opened. Reload it and read them again.");
  if (!user.openAccess) await recordConfirmation(user.id);
  (await cookies()).set(ADULT_COOKIE, TERMS_VERSION, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADULT_COOKIE_MAX_AGE,
  });
  return Response.json({ ok: true, termsVersion: TERMS_VERSION });
});
