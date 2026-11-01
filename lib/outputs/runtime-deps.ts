/**
 * The runtime outputs' route dependencies, bound to the database, the session and Vercel's REST API. Server only. The
 * logic and its tests live in lib/outputs/runtime-serve.ts.
 */
import { and, eq, inArray } from "drizzle-orm";
import { canActAsOwner } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { findServableProduct } from "@/lib/mcp/store";
import { reserveKit, type RuntimeOutputDeps, type SelfHostDeps, type SelfHostProduct, type VercelReadDeps } from "@/lib/outputs/runtime-serve";
import { currentUser } from "@/lib/queries";

const API = "https://api.vercel.com";

export function runtimeOutputRouteDeps(): RuntimeOutputDeps {
  return { enabled: () => env.runtimeOutputs, findProduct: findServableProduct };
}

/** Read-only calls to Vercel's REST API with the token products are published with. */
function vercelRead(): VercelReadDeps | null {
  if (!process.env.VERCEL_TOKEN) return null;
  return {
    async api(path) {
      const url = new URL(path, API);
      if (env.vercelTeamId) url.searchParams.set("teamId", env.vercelTeamId);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${env.vercelToken}` }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (!res.ok) throw new Error(`Vercel answered ${res.status} for ${path.split("?")[0]!.replace(/\/files\/[^/]+$/, "/files/...")}`);
      return res;
    },
  };
}

async function selfHostProduct(slug: string): Promise<SelfHostProduct | null> {
  const [row] = await db()
    .select({
      id: schema.products.id,
      ownerId: schema.products.ownerId,
      vercelProjectId: schema.products.vercelProjectId,
      slug: schema.products.slug,
      name: schema.products.name,
      tagline: schema.products.tagline,
      liveUrl: schema.products.liveUrl,
      manifest: schema.products.manifest,
    })
    .from(schema.products)
    .where(and(eq(schema.products.slug, slug), inArray(schema.products.status, ["live", "partial"])))
    .limit(1);
  return row ?? null;
}

export function selfHostRouteDeps(): SelfHostDeps {
  return {
    enabled: () => env.runtimeOutputs,
    findProduct: selfHostProduct,
    isOwner: async (product) => canActAsOwner(await currentUser(), product.ownerId),
    vercel: vercelRead,
    reserve: async (product) => {
      const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
      return reserveKit(product, {
        take: async (key, limit) => (await reserveCounter(key, hour, 1, limit)) !== null,
        giveBack: (key) => adjustCounter(key, hour, -1),
      });
    },
    now: () => new Date(),
  };
}
