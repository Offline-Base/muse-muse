import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./lib/db/url";

// drizzle-kit (db:generate, db:push) is a local tool. It takes its database from lib/db/url.ts like everything else,
// so with VERCEL_ENV=preview in the environment it uses PREVIEW_DATABASE_URL or none, never production's.
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl() ?? "" },
});
