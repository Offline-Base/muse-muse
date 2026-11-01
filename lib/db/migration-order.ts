/**
 * Which journal entries drizzle would skip on a database (docs/CAPABILITIES.md, section 4). drizzle-orm 0.45 applies
 * only the entries whose `when` is newer than the newest one the database already ran, so an entry merged with an older
 * time is skipped without a word, and the app then fails on its columns. Wave 3 hit this: databases that ran
 * 0019_engine before 0018_trust existed. scripts/migrate.ts checks a local PGlite database with this before migrating
 * and stops with a plain message instead. No imports, so the migrate script can load it before anything else.
 */

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** The entries never run on a database whose __drizzle_migrations rows have these created_at times, and never will be. */
export function skippedMigrations(journal: readonly JournalEntry[], applied: readonly number[]): JournalEntry[] {
  if (!applied.length) return [];
  const newest = Math.max(...applied);
  const ran = new Set(applied);
  return journal.filter((e) => e.when <= newest && !ran.has(e.when));
}

/** What scripts/migrate.ts says when it stops. */
export function skippedMessage(skipped: readonly JournalEntry[], dir: string): string {
  const tags = skipped.map((e) => e.tag).join(", ");
  return (
    `migrate: the local database in ${dir} already ran a newer migration than ${tags}, so drizzle would skip ` +
    `${skipped.length === 1 ? "it" : "them"} and the app would fail on the missing columns. It's a local copy: delete ${dir} and run this again.`
  );
}

/** The created_at times in drizzle's own table, or none on a database that never migrated. */
export async function appliedMigrationTimes(query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>): Promise<number[]> {
  const exists = await query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  if (!exists.rows[0]?.present) return [];
  const { rows } = await query("select created_at from drizzle.__drizzle_migrations");
  return rows.map((r) => Number(r.created_at));
}
