import { env } from "@/lib/env";
import { findServableProduct } from "@/lib/mcp/store";
import { cliFileName, cliSource, pluginFileName, pluginZip, publicActions, skillMarkdown, type OutputProduct } from "@/lib/outputs/generate";

export type OutputDownload = "cli" | "skill" | "claude_plugin";

/** What the download routes need. Tests pass their own. */
export interface OutputDeps {
  enabled: () => boolean;
  findProduct: (slug: string) => Promise<OutputProduct | null>;
  origin: () => Promise<string>;
}

const notFound = () => new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

const DOWNLOAD_HEADERS = {
  "x-content-type-options": "nosniff",
  // Rebuilt from the manifest on each request, so a short shared cache is all it needs.
  "cache-control": "public, max-age=60, s-maxage=60",
};

function attachment(fileName: string): Record<string, string> {
  return { "content-disposition": `attachment; filename="${fileName}"` };
}

/**
 * Answers /p/<slug>/get/<kind>: a live product's generated file, or a 404 when the flag is off, there is no such live
 * product, or it has no actions to offer. Files come back as attachments, so a browser saves them and never runs them on
 * this site.
 */
export async function outputResponse(kind: OutputDownload, slug: string, deps: OutputDeps, opts: { inline?: boolean } = {}): Promise<Response> {
  if (!deps.enabled() || !/^[a-z0-9-]{1,80}$/.test(slug)) return notFound();
  const product = await deps.findProduct(slug);
  if (!product?.liveUrl || !publicActions(product.manifest).length) return notFound();
  const origin = await deps.origin();
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
  return new Response(new Uint8Array(pluginZip(product, origin)), {
    headers: { ...DOWNLOAD_HEADERS, ...attachment(pluginFileName(slug)), "content-type": "application/zip" },
  });
}

export function outputRouteDeps(origin: () => Promise<string>): OutputDeps {
  return { enabled: () => env.productOutputs, findProduct: findServableProduct, origin };
}
