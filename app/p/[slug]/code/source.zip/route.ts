import { eq } from "drizzle-orm";
import { canActAsOwner, isCrossSite } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { currentUser } from "@/lib/queries";
import { canReadCode, commitsFrom } from "@/lib/versions/policy";
import { keptBuildIds, productCommitBuilds, versionOf, versionZip } from "@/lib/versions/store";

// One saved version's source as a zip: /p/<slug>/code/source.zip?v=<number>. Each zip reads many stored files, so they're counted per hour.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PER_PRODUCT_HOUR = 12;
const SITE_HOUR = 120;

const text = (body: string, status: number) => new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) return text("There's no source here.", 404);
    if (isCrossSite(req.headers)) return text("Download the source from the product's Code page.", 403);
    const number = Number(new URL(req.url).searchParams.get("v"));
    const [product] = await db().select().from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
    if (!product || !canReadCode(product, canActAsOwner(await currentUser(), product.ownerId))) return text("There's no source here.", 404);
    const commit = commitsFrom(await productCommitBuilds(product.id), await keptBuildIds(product.id)).find((c) => c.number === number);
    const version = commit?.kept ? await versionOf(product.id, commit.id) : null;
    if (!commit || !version) return text("This version's source wasn't kept.", 404);

    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const productKey = `source-zip:${product.id}`;
    if ((await reserveCounter(productKey, hour, 1, PER_PRODUCT_HOUR)) === null) return text("This product's source has been downloaded a lot this hour. Try again later.", 429);
    if ((await reserveCounter("source-zip:all", hour, 1, SITE_HOUR)) === null) {
      await adjustCounter(productKey, hour, -1).catch(() => {});
      return text("This site has made all the source downloads it makes in an hour. Try again later.", 429);
    }
    const body = await versionZip(version.files);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${slug}-v${commit.number}-source.zip"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    console.error(`[versions] zip for ${slug} failed:`, err instanceof Error ? err.message : err);
    return text("Something went wrong.", 500);
  }
}
