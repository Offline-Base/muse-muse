import { defineConfig } from "drizzle-kit";
import { databaseUrl, isPreview } from "./lib/db/url";

/**
 * What drizzle-kit gets on a preview with no database of its own: an address that can't resolve (.invalid is reserved
 * for that), not "". drizzle-kit only refuses "" because its own check does today, and its Postgres pool fills an
 * address with no host from PGHOST and the other PG* variables, which on a preview are production's. db:generate and
 * check never connect, so they still work there.
 */
export const NO_PREVIEW_DATABASE = "postgresql://preview-has-no-database.invalid/see-readme-preview-database";

// drizzle-kit (db:generate, db:push) is a local tool. It takes its database from lib/db/url.ts like everything else,
// so with VERCEL_ENV=preview in the environment it uses PREVIEW_DATABASE_URL or none, never production's.
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl() ?? (isPreview() ? NO_PREVIEW_DATABASE : "") },
});
