import { unavailablePage } from "@/lib/trust/pages";

// Where next.config.ts sends a request from a restricted territory (TRUST_GEO_BLOCK, lib/trust/geo-config.ts). Every
// method gets the same 451 answer. Without the flag nothing is rewritten here, and a direct visit gets the same page.
export const runtime = "nodejs";

function handle(): Response {
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
