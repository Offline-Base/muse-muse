/**
 * The skipped-migration check (lib/db/migration-order.ts) that scripts/migrate.ts runs on a local database, on a real
 * Postgres (PGlite): a database that ran tg-cap-int's journal, where 0019_engine came straight after 0015, would skip
 * this branch's 0018_trust, and the check names it. A database in order skips nothing.
 *
 *   npx tsx --test lib/db/__tests__/migration-order.test.ts
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { appliedMigrationTimes, skippedMessage, skippedMigrations, type JournalEntry } from "@/lib/db/migration-order";

const FOLDER = join(import.meta.dirname, "../../../drizzle");
const journal = JSON.parse(readFileSync(join(FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<JournalEntry & Record<string, unknown>> };
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A migrations folder with only these tags, in this order, as another branch's journal had them. */
function folderWith(tags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-order-"));
  dirs.push(dir);
  mkdirSync(join(dir, "meta"));
  const entries = tags.map((tag, idx) => ({ ...journal.entries.find((e) => e.tag === tag)!, idx }));
  for (const e of entries) copyFileSync(join(FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

describe("skippedMigrations", () => {
  const j = [
    { idx: 0, when: 10, tag: "0000_a" },
    { idx: 1, when: 20, tag: "0018_trust" },
    { idx: 2, when: 30, tag: "0019_engine" },
  ];
  it("names an entry older than the newest one run that never ran", () => {
    assert.deepEqual(skippedMigrations(j, [10, 30]).map((e) => e.tag), ["0018_trust"]);
  });
  it("names nothing for a database in order, behind, or new", () => {
    assert.deepEqual(skippedMigrations(j, [10, 20, 30]), []);
    assert.deepEqual(skippedMigrations(j, [10]), []);
    assert.deepEqual(skippedMigrations(j, []), []);
  });
  it("says what to do in plain words", () => {
    assert.match(skippedMessage([j[1]!], ".data/pglite-x"), /already ran a newer migration than 0018_trust, so drizzle would skip it .* delete \.data\/pglite-x and run this again/);
  });
});

describe("a local database that ran 0019_engine before 0018_trust existed", () => {
  const trust = journal.entries.find((e) => e.tag === "0018_trust");
  const engine = journal.entries.find((e) => e.tag === "0019_engine");

  it("is caught before drizzle skips 0018 silently", { skip: trust && engine ? false : "needs both entries" }, async () => {
    const upTo15 = journal.entries.filter((e) => e.idx <= 15).map((e) => e.tag);
    const client = new PGlite();
    const db = drizzle({ client });
    assert.deepEqual(await appliedMigrationTimes((q) => client.query(q)), [], "a database that never migrated");
    // tg-cap-int's journal: 0015, then 0019_engine.
    await migrate(db, { migrationsFolder: folderWith([...upTo15, "0019_engine"]) });
    const applied = await appliedMigrationTimes((q) => client.query(q));
    // General's 0017 now sits below 0018 too, so both would be skipped.
    assert.deepEqual(skippedMigrations(journal.entries, applied).map((e) => e.tag), ["0017_decision_datasets", "0018_trust"]);
    // What drizzle itself does with this branch's journal: nothing, and no error. The check is what stops it.
    await migrate(db, { migrationsFolder: FOLDER });
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'products' and column_name = 'taken_down_at'");
    assert.equal(rows[0]!.n, 0, "0018 was skipped");
    await client.close();
  });

  it("finds nothing to skip on a database migrated in order", async () => {
    const client = new PGlite();
    await migrate(drizzle({ client }), { migrationsFolder: FOLDER });
    assert.deepEqual(skippedMigrations(journal.entries, await appliedMigrationTimes((q) => client.query(q))), []);
    await client.close();
  });
});
