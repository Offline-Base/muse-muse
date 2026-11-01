import { modelLabel } from "@/lib/format";
import { MODEL_RESTRICTED_COUNTRIES } from "@/lib/trust/geo";
import { unavailablePage } from "@/lib/trust/pages";

// Where next.config.ts sends a request from a restricted territory (TRUST_GEO_BLOCK, lib/trust/geo-config.ts). Every
// method gets the same 451 answer. Without the flag nothing is rewritten here, and a direct visit gets the same page.
// With ?model= naming a model that has its own country rule (Muse Image in India), the answer is JSON for an API caller.
export const runtime = "nodejs";

function handle(req: Request): Response {
  const model = new URL(req.url).searchParams.get("model");
  if (model && Object.hasOwn(MODEL_RESTRICTED_COUNTRIES, model)) {
    const message = `${modelLabel(model)} isn't available where you are: Meta's terms don't allow it to be used from this country.`;
    return Response.json({ error: { type: "permission_error", code: "unavailable_here", message } }, { status: 451, headers: { "cache-control": "no-store" } });
  }
  return new Response(unavailablePage(), {
    status: 451,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
