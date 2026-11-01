// Platform file (Muse Muse trust). Don't edit: the platform puts it back before every check.
//
// POST from the age page: remembers that this browser's visitor is 18 or older for these terms (the mm_age cookie, a
// year), then goes back to where they were headed. On https the cookie is SameSite=None and Partitioned, so the gate
// also works when the app is shown in a frame on another site.
import { AGE_COOKIE, safeNext, TRUST } from "@/lib/platform/trust";

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const next = safeNext(typeof form?.get("next") === "string" ? (form?.get("next") as string) : null);
  const secure = new URL(req.url).protocol === "https:";
  const cookie = [
    `${AGE_COOKIE}=${encodeURIComponent(TRUST.termsVersion)}`,
    "Path=/",
    `Max-Age=${365 * 86_400}`,
    "HttpOnly",
    ...(secure ? ["Secure", "SameSite=None", "Partitioned"] : ["SameSite=Lax"]),
  ].join("; ");
  return new Response(null, { status: 303, headers: { location: next, "set-cookie": cookie } });
}
