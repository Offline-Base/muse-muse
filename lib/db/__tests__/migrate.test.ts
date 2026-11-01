/**
 * What scripts/migrate.ts migrates in each environment (README.md, Preview database): production and local runs as
 * before, a preview its own PREVIEW_DATABASE_URL or nothing (exit 0, the build goes on), and a preview pointed at
 * production's database not at all (exit 1). runMigrations is driven with fake migrators, then the script itself runs
 * in a child process for the skip, the refusal and a real PGlite folder. Nothing reaches Neon; every URL is made up.
 *
 *   npx tsx --test lib/db/__tests__/migrate.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { REFUSE_PREVIEW, SKIP_PREVIEW, SKIP_UNSET, runMigrations, type MigrateDeps } from "@/lib/db/migrate";

const PROD = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000-pooler.invalid/neondb?sslmode=require";
const PROD_UNPOOLED = "postgresql://prod_owner:fake-prod-secret@ep-prod-000000.invalid/neondb?sslmode=require";
const PREVIEW = "postgresql://prev_owner:fake-preview-secret@ep-preview-111111-pooler.invalid/neondb?sslmode=require";
const ROOT = join(import.meta.dirname, "../../..");

function fakeDeps() {
  const calls = { neon: [] as string[], local: [] as string[], log: [] as string[], error: [] as string[] };
  const deps: MigrateDeps = {
    neon: async (url) => void calls.neon.push(url),
    local: async (dir) => void calls.local.push(dir),
    log: (line) => void calls.log.push(line),
    error: (line) => void calls.error.push(line),
  };
  return { calls, deps };
}

describe("runMigrations", () => {
  it("production migrates DATABASE_URL, as before, and ignores PREVIEW_DATABASE_URL", async () => {
    const { calls, deps } = fakeDeps();
    assert.equal(await runMigrations({ VERCEL_ENV: "production", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }, deps), 0);
    assert.deepEqual(calls.neon, [PROD]);
    assert.deepEqual(calls.local, []);
    assert.match(calls.log.join("\n"), /^migrate: up to date in \d+ ms$/);
  });

  it("a local run migrates DATABASE_URL, and skips quietly without it", async () => {
    const run = fakeDeps();
    assert.equal(await runMigrations({ DATABASE_URL: PROD }, run.deps), 0);
    assert.deepEqual(run.calls.neon, [PROD]);
    const none = fakeDeps();
    assert.equal(await runMigrations({}, none.deps), 0);
    assert.deepEqual(none.calls, { neon: [], local: [], log: [SKIP_UNSET], error: [] });
    assert.equal(SKIP_UNSET, "migrate: DATABASE_URL is not set, skipping");
  });

  it("pglite:<folder> migrates that folder, on a preview too", async () => {
    for (const VERCEL_ENV of [undefined, "preview"]) {
      const { calls, deps } = fakeDeps();
      assert.equal(await runMigrations({ VERCEL_ENV, DATABASE_URL: "pglite:.data/room", PREVIEW_DATABASE_URL: PREVIEW }, deps), 0);
      assert.deepEqual(calls.local, [".data/room"]);
      assert.deepEqual(calls.neon, []);
      assert.match(calls.log[0]!, /^migrate: local database in \.data\/room up to date in \d+ ms$/);
    }
  });

  it("a preview with PREVIEW_DATABASE_URL migrates it and never DATABASE_URL", async () => {
    const { calls, deps } = fakeDeps();
    assert.equal(await runMigrations({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PREVIEW }, deps), 0);
    assert.deepEqual(calls.neon, [PREVIEW]);
    assert.match(calls.log[0]!, /^migrate: preview database \(PREVIEW_DATABASE_URL\) up to date in \d+ ms$/);
  });

  it("a preview without PREVIEW_DATABASE_URL says it skips, migrates nothing and lets the build go on", async () => {
    const { calls, deps } = fakeDeps();
    assert.equal(await runMigrations({ VERCEL_ENV: "preview", DATABASE_URL: PROD, POSTGRES_URL: PROD }, deps), 0);
    assert.deepEqual(calls, { neon: [], local: [], log: [SKIP_PREVIEW], error: [] });
    assert.match(SKIP_PREVIEW, /previews never touch production's database/);
  });

  it("a preview whose PREVIEW_DATABASE_URL is production's database is refused with exit 1", async () => {
    for (const PREVIEW_DATABASE_URL of [PROD, PROD_UNPOOLED]) {
      const { calls, deps } = fakeDeps();
      assert.equal(await runMigrations({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL }, deps), 1);
      assert.deepEqual(calls, { neon: [], local: [], log: [], error: [REFUSE_PREVIEW] });
    }
    for (const line of [SKIP_PREVIEW, REFUSE_PREVIEW]) assert.ok(!line.includes(String.fromCharCode(0x2014)), line);
  });
});

describe("scripts/migrate.ts", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** The script in a child with only these variables (no .env files), as the build runs it. */
  function migrateScript(vars: Record<string, string>) {
    const child = spawnSync(join(ROOT, "node_modules/.bin/tsx"), ["scripts/migrate.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(), ...vars },
    });
    return { status: child.status, out: child.stdout.trim(), err: child.stderr.trim() };
  }

  it("skips on a preview without PREVIEW_DATABASE_URL and exits 0, so next build runs", () => {
    const run = migrateScript({ VERCEL_ENV: "preview", DATABASE_URL: PROD });
    assert.equal(run.status, 0, run.err);
    assert.equal(run.out, SKIP_PREVIEW);
  });

  it("exits 1 on a preview whose PREVIEW_DATABASE_URL equals DATABASE_URL", () => {
    const run = migrateScript({ VERCEL_ENV: "preview", DATABASE_URL: PROD, PREVIEW_DATABASE_URL: PROD });
    assert.equal(run.status, 1);
    assert.equal(run.out, "");
    assert.equal(run.err, REFUSE_PREVIEW);
  });

  it("still skips quietly without DATABASE_URL", () => {
    const run = migrateScript({});
    assert.equal(run.status, 0, run.err);
    assert.equal(run.out, SKIP_UNSET);
  });

  it("still migrates a pglite folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-migrate-script-"));
    dirs.push(dir);
    const folder = join(dir, "db");
    const run = migrateScript({ DATABASE_URL: `pglite:${folder}` });
    assert.equal(run.status, 0, run.err);
    assert.match(run.out, /^migrate: local database in .+ up to date in \d+ ms$/);
    const client = new PGlite(folder);
    try {
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'products'",
      );
      assert.equal(rows[0]!.n, 1);
    } finally {
      await client.close();
    }
  });
});
