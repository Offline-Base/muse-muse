/**
 * Applies drizzle/ migrations to Neon. Runs before `next build` on Vercel, where DATABASE_URL is set (it's a Secret,
 * so it isn't available locally). Skips quietly when DATABASE_URL is missing so local builds still work.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: DATABASE_URL is not set, skipping");
} else {
  const started = Date.now();
  await migrate(drizzle({ client: neon(url) }), { migrationsFolder: "drizzle" });
  console.log(`migrate: up to date in ${Date.now() - started} ms`);
}
