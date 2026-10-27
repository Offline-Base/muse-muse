// Upload tickets for lib/client/upload.ts. Forwards the Vercel Blob client-upload request to the Muse Muse gateway,
// which checks it and signs it, and returns the gateway's answer unchanged. Keep this file as it is.
export async function POST(request: Request): Promise<Response> {
  const gateway = process.env.GATEWAY_URL;
  const token = process.env.PRODUCT_TOKEN;
  if (!gateway || !token) {
    return Response.json({ error: "Uploads are not configured on this server." }, { status: 503 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const signature = request.headers.get("x-vercel-signature");
  if (signature) headers["x-vercel-signature"] = signature;

  try {
    const upstream = await fetch(`${gateway.replace(/\/$/, "")}/uploads`, {
      method: "POST",
      headers,
      body: await request.text(),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: "The upload service is unreachable. Try again in a minute." }, { status: 502 });
  }
}
