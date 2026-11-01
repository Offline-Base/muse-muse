/**
 * Applies drizzle/ migrations. Runs before `next build` on Vercel, where DATABASE_URL is Neon (it's a Secret, so it
 * isn't available locally), and before `npm run dev:local`, where DATABASE_URL is "pglite:<folder>". Skips quietly
 * when DATABASE_URL is missing so local builds still work. A local database that already ran a newer migration than one
 * in the journal stops here with a plain message (lib/db/migration-order.ts), since drizzle would skip that one silently.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { localDbDir } from "@/lib/db/client";

const url = process.env.DATABASE_URL;
const localDir = url ? localDbDir(url) : null;
if (!url) {
  console.log("migrate: DATABASE_URL is not set, skipping");
} else if (localDir) {
  const started = Date.now();
  const { mkdirSync } = await import("node:fs");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate: migratePglite } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(localDir, { recursive: true });
  const client = new PGlite(localDir);
  // A local database that ran a newer migration than one in the journal would skip it silently (lib/db/migration-order.ts).
  const { appliedMigrationTimes, skippedMessage, skippedMigrations } = await import("@/lib/db/migration-order");
  const { readFileSync } = await import("node:fs");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const skipped = skippedMigrations(journal.entries, await appliedMigrationTimes((q) => client.query(q)));
  if (skipped.length) {
    await client.close();
    console.error(skippedMessage(skipped, localDir));
    process.exit(1);
  }
  await migratePglite(drizzlePglite({ client }), { migrationsFolder: "drizzle" });
  await client.close();
  console.log(`migrate: local database in ${localDir} up to date in ${Date.now() - started} ms`);
} else {
  const started = Date.now();
  await migrate(drizzle({ client: neon(url) }), { migrationsFolder: "drizzle" });
  console.log(`migrate: up to date in ${Date.now() - started} ms`);
}
