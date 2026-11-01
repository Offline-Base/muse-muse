// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/connect-keys is where <KeySettings /> saves and removes the owner's keys. The gateway checks that
// the browser holds the owner's session; this route only passes the form on and goes back with a status. It never
// puts a key in a redirect, a log or an answer.
import { CapError } from "@/lib/platform/connect";
import { secrets } from "@/lib/platform/secrets";

function back(returnTo: FormDataEntryValue | null, status: string): Response {
  const raw = typeof returnTo === "string" ? returnTo : "/";
  const path = raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/";
  const url = new URL(path, "https://product.invalid");
  url.searchParams.set("key", status);
  return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  if (!form) return back("/", "error");
  const action = form.get("action");
  try {
    if (action === "save") {
      const service = form.get("service");
      const value = form.get("value");
      if (typeof service !== "string" || typeof value !== "string") return back(form.get("returnTo"), "error");
      await secrets(request).save(service, value.trim());
      return back(form.get("returnTo"), "saved");
    }
    if (action === "remove") {
      const name = form.get("name");
      if (typeof name !== "string") return back(form.get("returnTo"), "error");
      await secrets(request).remove(name);
      return back(form.get("returnTo"), "removed");
    }
  } catch (err) {
    return back(form.get("returnTo"), err instanceof CapError && /^[a-z_]{1,40}$/.test(err.code) ? err.code : "error");
  }
  return back(form.get("returnTo"), "error");
}
