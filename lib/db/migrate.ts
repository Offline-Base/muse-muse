/**
 * What scripts/migrate.ts does, as a function its test can drive with fake migrators. The database comes from
 * databaseChoice (lib/db/url.ts), so a preview migrates PREVIEW_DATABASE_URL or nothing, and never production's.
 * Drizzle's migrator applies drizzle/ in the journal's order, on the preview database as on production.
 */
import type { JournalEntry } from "@/lib/db/migration-order";
import { databaseChoice, localDbDir } from "@/lib/db/url";

export interface MigrateDeps {
  /** Applies drizzle/ to a Neon database. */
  neon(url: string): Promise<void>;
  /**
   * Applies drizzle/ to a PGlite folder, creating it first. Returns a message instead, and migrates nothing, when the
   * folder already ran a newer migration than one in the journal, since drizzle would skip that one silently
   * (lib/db/migration-order.ts).
   */
  local(dir: string): Promise<string | void>;
  log(line: string): void;
  error(line: string): void;
}

export const MIGRATIONS_FOLDER = "drizzle";

export const SKIP_UNSET = "migrate: DATABASE_URL is not set, skipping";
export const SKIP_PREVIEW =
  "migrate: skipping, this preview has no PREVIEW_DATABASE_URL, and previews never touch production's database";
export const REFUSE_PREVIEW =
  "migrate: refused, PREVIEW_DATABASE_URL points at production's database (the one DATABASE_URL or another of the Neon integration's URLs names), and previews never touch it. Set it to the \"preview\" database on the Neon branch \"preview\" (README.md, Preview database).";

const defaultDeps: MigrateDeps = {
  async neon(url) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    await migrate(drizzle({ client: neon(url) }), { migrationsFolder: MIGRATIONS_FOLDER });
  },
  async local(dir) {
    const { mkdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const { appliedMigrationTimes, skippedMessage, skippedMigrations } = await import("@/lib/db/migration-order");
    mkdirSync(dir, { recursive: true });
    const client = new PGlite(dir);
    try {
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: JournalEntry[] };
      const skipped = skippedMigrations(journal.entries, await appliedMigrationTimes((q) => client.query(q)));
      if (skipped.length) return skippedMessage(skipped, dir);
      await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.close();
    }
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Runs the migrations this environment calls for and returns the exit code: 1 for a preview pointed at production, or
 * for a local database that would skip a migration silently.
 */
export async function runMigrations(e: Record<string, string | undefined> = process.env, deps: MigrateDeps = defaultDeps): Promise<number> {
  const choice = databaseChoice(e);
  if (choice.url === null) {
    if (choice.why === "preview_is_production") {
      deps.error(REFUSE_PREVIEW);
      return 1;
    }
    deps.log(choice.why === "preview_unset" ? SKIP_PREVIEW : SKIP_UNSET);
    return 0;
  }
  const started = Date.now();
  const dir = localDbDir(choice.url);
  if (dir) {
    const stopped = await deps.local(dir);
    if (stopped) {
      deps.error(stopped);
      return 1;
    }
    deps.log(`migrate: local database in ${dir} up to date in ${Date.now() - started} ms`);
  } else {
    await deps.neon(choice.url);
    const which = choice.from === "PREVIEW_DATABASE_URL" ? "preview database (PREVIEW_DATABASE_URL) " : "";
    deps.log(`migrate: ${which}up to date in ${Date.now() - started} ms`);
  }
  return 0;
}
