// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/user-sign-out forgets the signed-in person on this browser, then goes back to `returnTo` (a form
// field or JSON), a path on this site.
import { samePath } from "@/lib/platform/identity";
import { clearUserCookies } from "@/lib/platform/user";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "This only works from this product's own pages." }, { status: 403 });
  let back = "/";
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) back = samePath(((await request.json()) as { returnTo?: unknown }).returnTo);
    else if (type.includes("form")) back = samePath((await request.formData()).get("returnTo"));
  } catch {
    back = "/";
  }
  const headers = new Headers({ location: back, "cache-control": "no-store" });
  for (const c of clearUserCookies()) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}
