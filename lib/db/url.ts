/**
 * Which Postgres this deployment uses. Everything that opens or migrates the database asks here: env.databaseUrl (so
 * db() in lib/db/client.ts), safeQuery in lib/queries.ts, scripts/migrate.ts and drizzle.config.ts. On Vercel, Preview
 * shares production's DATABASE_URL (and the Neon integration's other variables), so a preview that used it would read,
 * write and migrate production's data. Previews get their own database instead (README.md, Preview database):
 *
 *   VERCEL_ENV production, development or unset       DATABASE_URL, exactly as before
 *   DATABASE_URL "pglite:<folder>"                     that local folder, whatever VERCEL_ENV says (it can't be production)
 *   VERCEL_ENV preview, PREVIEW_DATABASE_URL set       PREVIEW_DATABASE_URL, the Neon branch "preview"
 *   VERCEL_ENV preview, PREVIEW_DATABASE_URL unset     no database: the site runs on its no-database paths, migrate skips
 *   VERCEL_ENV preview, PREVIEW_DATABASE_URL is prod   no database, and migrate refuses (exit 1), so the build stops
 *
 * Vercel's custom environments also run with VERCEL_ENV=preview, so they follow the preview rows.
 *
 * No imports: drizzle.config.ts loads this file, and lib/env.ts (which imports it) goes into the workflow bundle.
 */

type Env = Record<string, string | undefined>;

/** DATABASE_URL "pglite:<folder>" keeps Postgres in-process in a local folder (PGlite), for running on a laptop. */
export const LOCAL_DB_PREFIX = "pglite:";

export function localDbDir(url: string): string | null {
  return url.startsWith(LOCAL_DB_PREFIX) ? url.slice(LOCAL_DB_PREFIX.length) || ".data/pglite" : null;
}

/**
 * Variables that hold production's database on a preview: DATABASE_URL and the ones Vercel's Neon integration sets
 * beside it. All point at the same Neon branch, pooled or not.
 */
export const PRODUCTION_DATABASE_VARS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
] as const;

export const DATABASE_UNSET = "DATABASE_URL is not set. See .env.example.";
export const PREVIEW_DATABASE_UNSET =
  "This preview has no database: PREVIEW_DATABASE_URL is not set, and previews never use production's DATABASE_URL. See README.md, Preview database.";
export const PREVIEW_DATABASE_IS_PRODUCTION =
  "PREVIEW_DATABASE_URL points at production's database, and previews never touch it. Set it to the Neon branch \"preview\" (README.md, Preview database).";

export type DatabaseChoice =
  | { url: string; from: "DATABASE_URL" | "PREVIEW_DATABASE_URL" }
  | { url: null; why: "unset" | "preview_unset" | "preview_is_production"; message: string };

export function isPreview(e: Env = process.env): boolean {
  return (e.VERCEL_ENV ?? "").trim().toLowerCase() === "preview";
}

/**
 * Host, port and database name: what makes two connection strings the same database. Neon's pooled host is the
 * direct one with "-pooler" in its first label, and the user, password and options don't change the database. A
 * string that doesn't parse as a URL is compared as it is.
 */
function databaseKey(url: string): string {
  const text = url.trim();
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase().replace(/^([^.]+?)-pooler(?=\.|$)/, "$1");
    if (!host) return text;
    const name = decodeURIComponent(u.pathname.replace(/^\/+/, "")) || decodeURIComponent(u.username);
    return `${host}:${u.port || "5432"}/${name}`;
  } catch {
    return text;
  }
}

/** True when both connection strings reach the same database (see databaseKey). */
export function sameDatabase(a: string, b: string): boolean {
  return databaseKey(a) === databaseKey(b);
}

export function databaseChoice(e: Env = process.env): DatabaseChoice {
  const main = e.DATABASE_URL;
  if (main && localDbDir(main)) return { url: main, from: "DATABASE_URL" };
  if (!isPreview(e)) return main ? { url: main, from: "DATABASE_URL" } : { url: null, why: "unset", message: DATABASE_UNSET };
  const preview = e.PREVIEW_DATABASE_URL?.trim();
  if (!preview) return { url: null, why: "preview_unset", message: PREVIEW_DATABASE_UNSET };
  const production = PRODUCTION_DATABASE_VARS.map((name) => e[name]?.trim()).filter((v): v is string => Boolean(v));
  if (production.some((url) => sameDatabase(preview, url))) {
    return { url: null, why: "preview_is_production", message: PREVIEW_DATABASE_IS_PRODUCTION };
  }
  return { url: preview, from: "PREVIEW_DATABASE_URL" };
}

/** The connection string this deployment uses, or null when it has no database (see the table above). */
export function databaseUrl(e: Env = process.env): string | null {
  return databaseChoice(e).url;
}
