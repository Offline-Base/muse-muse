/** A real Postgres (PGlite) with the repo's migrations, and a product with a native run, for the lab's tests. */
import { randomUUID } from "node:crypto";
import * as schema from "@/lib/db/schema";
import type { NativeJobInput } from "@/lib/native/types";

export type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof schema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

export async function makeTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db: TestDb = Object.assign(drizzle({ client, schema }), {
    batch: async (queries: PromiseLike<unknown>[]) => {
      const results: unknown[] = [];
      for (const q of queries) results.push(await q);
      return results;
    },
  });
  await migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return { db, close: () => client.close() };
}

export interface Seeded {
  userId: string;
  inspirationId: string;
  buildId: string;
  productId: string;
  runId: string;
}

/** A product with a shipped build and a run. Each call makes its own, under a unique slug and email. */
export async function seedRun(db: TestDb, origin: "ship" | "agent" = "agent"): Promise<Seeded> {
  const tag = randomUUID();
  const [user] = await db.insert(schema.users).values({ email: `${tag}@example.com` }).returning();
  const [inspiration] = await db.insert(schema.inspirations).values({ userId: user!.id }).returning();
  const [product] = await db.insert(schema.products).values({ slug: `p-${tag}`, name: "Demo", ownerId: user!.id }).returning();
  const [build] = await db.insert(schema.builds).values({ inspirationId: inspiration!.id, userId: user!.id, productId: product!.id }).returning();
  const [run] = await db.insert(schema.nativeRuns).values({ productId: product!.id, buildId: build!.id, origin, targets: ["web", "phone", "desktop"] }).returning();
  return { userId: user!.id, inspirationId: inspiration!.id, buildId: build!.id, productId: product!.id, runId: run!.id };
}

/** A job input the lab's own validator accepts for a Mac app. */
export function macInput(over: Partial<NativeJobInput> = {}): NativeJobInput {
  return {
    v: 1,
    limitSeconds: 240,
    target: { url: "https://demo-product.vercel.app/" },
    product: { name: "Demo", slug: "demo" },
    app: { kind: "mac_zip", variant: "product", version: "1.0.0", url: "https://abc.public.blob.vercel-storage.com/native/shells/1/mac.zip", sha256: "a".repeat(64) },
    ...over,
  };
}
