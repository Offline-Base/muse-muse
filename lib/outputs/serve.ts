import { env } from "@/lib/env";
import { dayWindow, docsClientIp, hourStart, secondsUntil } from "@/lib/docs/proxy/limits";
import { findServableProduct } from "@/lib/mcp/store";
import { DOWNLOADS_PER_DAY, DOWNLOADS_PER_IP_PER_HOUR } from "@/lib/native/downloads";
import { gadgetFileName, gadgetZip } from "@/lib/outputs/gadget";
import { cliFileName, cliSource, pluginFileName, pluginZip, publicActions, skillMarkdown, type OutputProduct } from "@/lib/outputs/generate";

export type OutputDownload = "cli" | "skill" | "claude_plugin" | "gadget";

/** What the download routes need. Tests pass their own. */
export interface OutputDeps {
  enabled: () => boolean;
  findProduct: (slug: string) => Promise<OutputProduct | null>;
  origin: () => Promise<string>;
}

/** The counters a rate-limited download uses, as the native downloads do (lib/native/downloads.ts). */
export interface OutputLimitDeps {
  /** Takes one from a counter unless it's at its limit. Null means it's at its limit. */
  reserve(key: string, windowStart: Date, limit: number): Promise<number | null>;
  /** Gives one back to a counter. */
  release(key: string, windowStart: Date): Promise<void>;
  now(): Date;
}

export const outputDownloadKeys = {
  ip: (ip: string) => `outputs-get-ip:${ip}`,
  day: "outputs-get-day",
};

const notFound = () => new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

const DOWNLOAD_HEADERS = {
  "x-content-type-options": "nosniff",
  // Rebuilt from the manifest on each request, so a short shared cache is all it needs.
  "cache-control": "public, max-age=60, s-maxage=60",
};

function attachment(fileName: string): Record<string, string> {
  return { "content-disposition": `attachment; filename="${fileName}"` };
}

const validSlug = (slug: string) => /^[a-z0-9-]{1,80}$/.test(slug);

/** The live product an output is made from, or null when there's none to offer: no such product, no live link, no public action. */
async function servable(slug: string, deps: OutputDeps): Promise<OutputProduct | null> {
  const product = await deps.findProduct(slug);
  return product?.liveUrl && publicActions(product.manifest).length ? product : null;
}

function fileResponse(kind: OutputDownload, product: OutputProduct, origin: string, opts: { inline?: boolean }): Response {
  const { slug } = product;
  if (kind === "cli") {
    return new Response(cliSource(product, origin), {
      headers: { ...DOWNLOAD_HEADERS, ...attachment(cliFileName(slug)), "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (kind === "skill") {
    return new Response(skillMarkdown(product, origin), {
      headers: { ...DOWNLOAD_HEADERS, ...(opts.inline ? {} : attachment("SKILL.md")), "content-type": "text/markdown; charset=utf-8" },
    });
  }
  if (kind === "gadget") {
    // Counted on each request, so no shared cache answers for the counter.
    return new Response(new Uint8Array(gadgetZip(product)), {
      headers: { ...DOWNLOAD_HEADERS, "cache-control": "no-store", ...attachment(gadgetFileName(slug)), "content-type": "application/zip" },
    });
  }
  return new Response(new Uint8Array(pluginZip(product, origin)), {
    headers: { ...DOWNLOAD_HEADERS, ...attachment(pluginFileName(slug)), "content-type": "application/zip" },
  });
}

/**
 * Answers /p/<slug>/get/<kind>: a live product's generated file, or a 404 when the flag is off, there is no such live
 * product, or it has no actions to offer. Files come back as attachments, so a browser saves them and never runs them on
 * this site.
 */
export async function outputResponse(kind: OutputDownload, slug: string, deps: OutputDeps, opts: { inline?: boolean } = {}): Promise<Response> {
  if (!deps.enabled() || !validSlug(slug)) return notFound();
  const product = await servable(slug, deps);
  if (!product) return notFound();
  return fileResponse(kind, product, await deps.origin(), opts);
}

function say(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}

/**
 * outputResponse with the native downloads' limits: each address may start DOWNLOADS_PER_IP_PER_HOUR an hour, and
 * everyone together DOWNLOADS_PER_DAY a day. A 404 doesn't use up the address's limit. A HEAD says whether the file is
 * there, and isn't counted.
 */
export async function limitedOutputResponse(kind: OutputDownload, req: Request, slug: string, deps: OutputDeps, limits: OutputLimitDeps): Promise<Response> {
  if (!deps.enabled() || !validSlug(slug)) return notFound();
  if (req.method === "HEAD") return (await servable(slug, deps)) ? new Response(null, { status: 200, headers: { "cache-control": "no-store" } }) : notFound();

  // The address's limit comes first, so a flood stops here and not after the queries.
  const now = limits.now();
  const hour = hourStart(now);
  const ipKey = outputDownloadKeys.ip(docsClientIp(req.headers));
  if ((await limits.reserve(ipKey, hour, DOWNLOADS_PER_IP_PER_HOUR)) === null) {
    return say(429, "Too many downloads from here. Try again later.", { "retry-after": String(secondsUntil(new Date(hour.getTime() + 3_600_000), now)) });
  }
  const product = await servable(slug, deps);
  if (!product) {
    await limits.release(ipKey, hour).catch((err: unknown) => console.error("[outputs] couldn't give back a download:", err instanceof Error ? err.message : err));
    return notFound();
  }
  const day = dayWindow(now);
  if ((await limits.reserve(outputDownloadKeys.day, day, DOWNLOADS_PER_DAY)) === null) {
    return say(429, "Downloads are full for today. Try again tomorrow.", { "retry-after": String(secondsUntil(day, now)) });
  }
  return fileResponse(kind, product, await deps.origin(), {});
}

export function outputRouteDeps(origin: () => Promise<string>): OutputDeps {
  return { enabled: () => env.productOutputs, findProduct: findServableProduct, origin };
}
