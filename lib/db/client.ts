import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "@/lib/db/schema";

export type Db = NeonHttpDatabase<typeof schema>;

let cached: Db | null = null;

/**
 * Drizzle over Neon's HTTP driver: one round trip per query, no pool to manage in serverless functions.
 * It has no interactive transactions, so write multi-row changes as single statements or `db.batch([...])`.
 */
export function db(): Db {
  if (!cached) cached = drizzle({ client: neon(env.databaseUrl), schema });
  return cached;
}

export { schema };
