/**
 * GET /p/<slug>/get/<kind>: sends a visitor to a package's file on Blob and counts it (docs/NATIVE.md). The route only
 * wires this up, so the rules are tested with fakes.
 */
import { NATIVE_DOWNLOADS, type NativeDownload } from "@/lib/native/types";
import { dayWindow, docsClientIp, hourStart, secondsUntil } from "@/lib/docs/proxy/limits";

/** Each address may start this many downloads an hour, and everyone together this many a day. */
export const DOWNLOADS_PER_IP_PER_HOUR = 20;
export const DOWNLOADS_PER_DAY = 2_000;

export const downloadKeys = {
  ip: (ip: string) => `native-get-ip:${ip}`,
  day: "native-get-day",
};

export interface DownloadDeps {
  /** The package to send, or null when there's none a visitor may have: not shipped, not made, or its check failed. */
  findPackage(slug: string, download: NativeDownload): Promise<{ artifactId: string; url: string } | null>;
  /** Takes one from a counter unless it's at its limit. Null means it's at its limit. */
  reserve(key: string, windowStart: Date, limit: number): Promise<number | null>;
  /** Adds one to the package's count. */
  count(artifactId: string): Promise<void>;
  now(): Date;
}

function say(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** The file as a download, as Blob's own download links do it, so a browser saves it and doesn't try to show it. */
function asDownload(url: string): string {
  const out = new URL(url);
  out.searchParams.set("download", "1");
  return out.toString();
}

export function isDownload(kind: string): kind is NativeDownload {
  return Object.hasOwn(NATIVE_DOWNLOADS, kind);
}

export async function answerDownload(req: Request, slug: string, kind: string, deps: DownloadDeps): Promise<Response> {
  if (!isDownload(kind)) return say(404, "There's no download by that name.");
  try {
    const pack = await deps.findPackage(slug, kind);
    if (!pack) return say(404, "This download isn't available.");
    // A HEAD is a link checker or a scanner's preview. It isn't a download.
    if (req.method === "HEAD") return new Response(null, { status: 302, headers: { Location: asDownload(pack.url), "Cache-Control": "no-store" } });

    const now = deps.now();
    const hour = hourStart(now);
    if ((await deps.reserve(downloadKeys.ip(docsClientIp(req.headers)), hour, DOWNLOADS_PER_IP_PER_HOUR)) === null) {
      const retryAfter = secondsUntil(new Date(hour.getTime() + 3_600_000), now);
      return say(429, "Too many downloads from here. Try again later.", { "Retry-After": String(retryAfter) });
    }
    const day = dayWindow(now);
    if ((await deps.reserve(downloadKeys.day, day, DOWNLOADS_PER_DAY)) === null) {
      return say(429, "Downloads are full for today. Try again tomorrow.", { "Retry-After": String(secondsUntil(day, now)) });
    }
    // A count that fails shouldn't cost the visitor their download.
    await deps.count(pack.artifactId).catch((err: unknown) => console.error("[native] couldn't count a download:", err instanceof Error ? err.message : err));
    return new Response(null, { status: 302, headers: { Location: asDownload(pack.url), "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[native] download:", err instanceof Error ? err.message : err);
    return say(503, "This download isn't working right now. Try again soon.");
  }
}
