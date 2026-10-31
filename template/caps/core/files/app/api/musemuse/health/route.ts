// Platform file (Muse Muse platform services). Don't edit. The live check loads it after deploy: it says whether the
// product's server has the gateway settings it needs, without showing any value, and it makes no model call.
export const dynamic = "force-dynamic";

export function GET() {
  const gateway = Boolean(process.env.GATEWAY_URL && process.env.PRODUCT_TOKEN);
  return Response.json({ ok: gateway, gateway }, { headers: { "cache-control": "no-store" } });
}
