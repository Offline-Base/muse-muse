import { createRequire } from "node:module";
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "@/lib/db/schema";

export type Db = NeonHttpDatabase<typeof schema>;

let cached: Db | null = null;

/** DATABASE_URL "pglite:<folder>" keeps Postgres in-process in a local folder (PGlite), for running on a laptop. */
export const LOCAL_DB_PREFIX = "pglite:";

export function localDbDir(url: string): string | null {
  return url.startsWith(LOCAL_DB_PREFIX) ? url.slice(LOCAL_DB_PREFIX.length) || ".data/pglite" : null;
}

/**
 * Drizzle over PGlite, shaped like the Neon one. Loaded with require so deployed builds never load PGlite. Kept on
 * globalThis so every route in the dev server shares one instance (two on one folder would corrupt it).
 */
function localDb(dir: string): Db {
  const g = globalThis as { __museMuseLocalDb?: Db };
  if (!g.__museMuseLocalDb) {
    const load = createRequire(import.meta.url);
    const { PGlite } = load("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = load("drizzle-orm/pglite");
    const local = drizzlePglite({ client: new PGlite(dir), schema });
    // Neon runs a batch as one transaction. PGlite has one connection, so this runs the statements in order instead.
    local.batch = async (queries: PromiseLike<unknown>[]) => {
      const results: unknown[] = [];
      for (const query of queries) results.push(await query);
      return results;
    };
    g.__museMuseLocalDb = local as Db;
  }
  return g.__museMuseLocalDb;
}

/**
 * Drizzle over Neon's HTTP driver: one round trip per query, no pool to manage in serverless functions.
 * It has no interactive transactions, so write multi-row changes as single statements or `db.batch([...])`.
 */
export function db(): Db {
  if (!cached) {
    const dir = localDbDir(env.databaseUrl);
    cached = dir ? localDb(dir) : drizzle({ client: neon(env.databaseUrl), schema });
  }
  return cached;
}

export { schema };
