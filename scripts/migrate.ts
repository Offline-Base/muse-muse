/**
 * Applies drizzle/ migrations. Runs before `next build` on Vercel, and before `npm run dev:local`, where DATABASE_URL
 * is "pglite:<folder>". Which database it migrates comes from lib/db/url.ts (the logic is runMigrations in
 * lib/db/migrate.ts):
 *
 *   Production (and local runs): DATABASE_URL, Neon on Vercel (it's a Secret, so it isn't available locally). Skips
 *     quietly when DATABASE_URL is missing so local builds still work.
 *   Preview: PREVIEW_DATABASE_URL, the Neon branch "preview". Without it, it says so and skips, and the build goes on
 *     (the preview then runs with no database). It exits 1 when PREVIEW_DATABASE_URL is production's database.
 */
import { runMigrations } from "@/lib/db/migrate";

process.exitCode = await runMigrations(process.env);
