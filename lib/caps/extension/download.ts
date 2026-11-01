import { dayWindow, docsClientIp, hourStart, secondsUntil } from "@/lib/docs/proxy/limits";

/**
 * GET /p/<slug>/get/extension (docs/CAPABILITIES.md, section 20): sends a visitor to the product's latest extension zip
 * on Blob, rate limited like the native downloads. With NATIVE_EXTENSION off (or the cap not ready) it answers exactly
 * what /p/<slug>/get/<kind> answered this path before it existed, touching nothing. The route only wires this up.
 */

export const EXTENSION_DOWNLOADS_PER_IP_PER_HOUR = 20;
export const EXTENSION_DOWNLOADS_PER_DAY = 2_000;

export const extensionDownloadKeys = {
  ip: (ip: string) => `extension-get-ip:${ip}`,
  day: "extension-get-day",
};

export interface ExtensionDownloadDeps {
  enabled(): boolean;
  /** A shipped product by slug, with whether its brief has an extension. Null when there's none. */
  findProduct(slug: string): Promise<{ id: string; liveUrl: string | null; hasExtension: boolean } | null>;
  /** Where its latest zip is and when it was saved, or null when none was made. */
  findZip(productId: string): Promise<{ url: string; uploadedAt?: Date } | null>;
  /** Takes one from a counter unless it's at its limit. Null means it's at its limit. */
  reserve(key: string, windowStart: Date, limit: number): Promise<number | null>;
  release(key: string, windowStart: Date): Promise<void>;
  now(): Date;
}

function say(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/**
 * As Blob's own download links do it, so a browser saves the file. The zip keeps one address and is replaced on each
 * ship, and Blob lets browsers keep a file for up to a month, so the link names the version it's sending (`v`, when it
 * was saved): a browser that has the older zip fetches the new one. A local run's /api/files/ path stays as it is.
 */
function asDownload(zip: { url: string; uploadedAt?: Date }): string {
  if (zip.url.startsWith("/")) return zip.url;
  const out = new URL(zip.url);
  out.searchParams.set("download", "1");
  const at = zip.uploadedAt?.getTime();
  if (at !== undefined && Number.isFinite(at)) out.searchParams.set("v", String(at));
  return out.toString();
}

const SLUG = /^[a-z0-9-]{1,80}$/;

export async function answerExtensionDownload(req: Request, slug: string, deps: ExtensionDownloadDeps): Promise<Response> {
  // Flag off: lib/native/downloads.ts's answer for a kind it doesn't know, which is what this path got before.
  if (!deps.enabled()) return say(404, "There's no download by that name.");
  try {
    const find = async () => {
      if (!SLUG.test(slug)) return null;
      const product = await deps.findProduct(slug);
      if (!product?.liveUrl || !product.hasExtension) return null;
      return deps.findZip(product.id);
    };
    // A HEAD is a link checker or a scanner's preview: it isn't a download, so it gets no address and isn't counted.
    if (req.method === "HEAD") {
      return (await find()) ? new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } }) : say(404, "This download isn't available.");
    }
    const now = deps.now();
    const hour = hourStart(now);
    const ipKey = extensionDownloadKeys.ip(docsClientIp(req.headers));
    if ((await deps.reserve(ipKey, hour, EXTENSION_DOWNLOADS_PER_IP_PER_HOUR)) === null) {
      return say(429, "Too many downloads from here. Try again later.", { "Retry-After": String(secondsUntil(new Date(hour.getTime() + 3_600_000), now)) });
    }
    const zip = await find();
    if (!zip) {
      await deps.release(ipKey, hour).catch((err: unknown) => console.error("[extension] couldn't give back a download:", err instanceof Error ? err.message : err));
      return say(404, "This download isn't available.");
    }
    const day = dayWindow(now);
    if ((await deps.reserve(extensionDownloadKeys.day, day, EXTENSION_DOWNLOADS_PER_DAY)) === null) {
      return say(429, "Downloads are full for today. Try again tomorrow.", { "Retry-After": String(secondsUntil(day, now)) });
    }
    return new Response(null, { status: 302, headers: { Location: asDownload(zip), "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[extension] download:", err instanceof Error ? err.message : err);
    return say(503, "This download isn't working right now. Try again soon.");
  }
}
