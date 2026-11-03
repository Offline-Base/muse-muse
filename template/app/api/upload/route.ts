import { clientIpHeaders } from "../../../lib/meta/client";

// Upload tickets for lib/client/upload.ts. Forwards the Vercel Blob presigned-URL request to the Muse Muse gateway,
// which checks it and signs it, and returns the gateway's answer unchanged. Keep this file as it is.

/** Blob's token requests and upload-completed callbacks are a few hundred bytes of JSON. */
const MAX_BODY_BYTES = 16 * 1024;
const UPLOAD_EVENTS = new Set(["blob.generate-presigned-url", "blob.generate-client-token", "blob.upload-completed"]);

export async function POST(request: Request): Promise<Response> {
  const gateway = process.env.GATEWAY_URL;
  const token = process.env.PRODUCT_TOKEN;
  if (!gateway || !token) {
    return Response.json({ error: "Uploads are not configured on this server." }, { status: 503 });
  }

  // Only this product's own pages ask for tickets. Vercel's server-to-server callback sends no Sec-Fetch-Site.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Uploads only work from this product's own pages." }, { status: 403 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "The upload request is too large." }, { status: 413 });
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return Response.json({ error: "The upload request is too large." }, { status: 413 });
  }
  if (!isUploadEvent(body)) {
    return Response.json({ error: "Expected a Vercel Blob upload request." }, { status: 400 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...clientIpHeaders(request),
  };
  const signature = request.headers.get("x-vercel-signature");
  if (signature) headers["x-vercel-signature"] = signature;

  try {
    const upstream = await fetch(`${gateway.replace(/\/$/, "")}/uploads`, {
      method: "POST",
      headers,
      body,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: "The upload service is unreachable. Try again in a minute." }, { status: 502 });
  }
}

function isUploadEvent(text: string): boolean {
  try {
    const event = JSON.parse(text) as { type?: unknown; payload?: unknown } | null;
    return !!event && typeof event === "object" && UPLOAD_EVENTS.has(String(event.type)) && !!event.payload && typeof event.payload === "object";
  } catch {
    return false;
  }
}
