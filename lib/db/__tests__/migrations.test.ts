/**
 * The migrations themselves, on a real Postgres (PGlite): the journal agrees with the folder and with lib/db/schema.ts,
 * a fresh database gets every table, and a database already at 0012 keeps its rows and gets the new columns' defaults.
 *
 *   npx tsx --test lib/db/__tests__/migrations.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import { NATIVE_JOB_PRIORITY } from "@/lib/native/types";

const FOLDER = join(import.meta.dirname, "../../../drizzle");

interface Entry {
  idx: number;
  when: number;
  tag: string;
  version: string;
  breakpoints: boolean;
}
const journal = JSON.parse(readFileSync(join(FOLDER, "meta/_journal.json"), "utf8")) as { version: string; dialect: string; entries: Entry[] };
const snapshot = (idx: number) => JSON.parse(readFileSync(join(FOLDER, `meta/${String(idx).padStart(4, "0")}_snapshot.json`), "utf8"));

const database = (client: PGlite) => drizzle({ client, schema });

/**
 * Wave 3's migrations, in the agreed order (docs/CAPABILITIES.md, section 4). 0016 and 0017 are the General session's;
 * each wave 3 unit appends its tag here. Until every lower number has merged, a wave 3 entry's tag number can be ahead
 * of its index: the journal stays in order and its times follow the contract's rule.
 */
const WAVE3_TAGS = ["0016_code_sessions", "0017_decide", "0018_trust", "0019_engine"];
const tagNumber = (tag: string) => Number(tag.slice(0, 4));

/** A copy of the migrations that stops at `lastIdx`, as a database that hasn't had the newer ones would have seen. */
function folderThrough(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-migrations-"));
  mkdirSync(join(dir, "meta"));
  const entries = journal.entries.filter((e) => e.idx <= lastIdx);
  for (const e of entries) copyFileSync(join(FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

async function columns(client: PGlite, table: string): Promise<Map<string, { nullable: boolean; fallback: string | null }>> {
  const { rows } = await client.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
    "select column_name, is_nullable, column_default from information_schema.columns where table_name = $1",
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, { nullable: r.is_nullable === "YES", fallback: r.column_default }]));
}

describe("the migration folder", () => {
  it("has a journal that runs in order from 0000, each entry with its file and snapshot", () => {
    journal.entries.forEach((e, i) => {
      assert.equal(e.idx, i);
      if (i <= 15) assert.ok(e.tag.startsWith(String(i).padStart(4, "0")), e.tag);
      else assert.ok(WAVE3_TAGS.includes(e.tag) && tagNumber(e.tag) >= i, e.tag);
      assert.ok(existsSync(join(FOLDER, `${e.tag}.sql`)), `${e.tag}.sql`);
      assert.ok(existsSync(join(FOLDER, `meta/${String(i).padStart(4, "0")}_snapshot.json`)), `snapshot ${i}`);
    });
    const files = readdirSync(FOLDER).filter((f) => f.endsWith(".sql")).sort();
    assert.deepEqual(files, journal.entries.map((e) => `${e.tag}.sql`), "no migration file outside the journal");
  });

  it("has times that only go up, or a database that has the last one would skip the next", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      assert.ok(journal.entries[i]!.when > journal.entries[i - 1]!.when, journal.entries[i]!.tag);
    }
  });

  it("has snapshots that each follow the last", () => {
    for (let i = 1; i < journal.entries.length; i++) assert.equal(snapshot(i).prevId, snapshot(i - 1).id, `snapshot ${i}`);
  });

  it("names 0013 to 0015 and then wave 3's migrations in the agreed order, with the agreed journal times", () => {
    const tags = journal.entries.slice(13).map((e) => e.tag);
    assert.deepEqual(tags.slice(0, 3), ["0013_agents", "0014_native", "0015_product_clips"]);
    const wave3 = tags.slice(3);
    assert.deepEqual(wave3, WAVE3_TAGS.filter((t) => wave3.includes(t)), "wave 3 tags in contract order");
    for (const e of journal.entries.slice(16)) assert.equal(e.when, 1793431490646 + (tagNumber(e.tag) - 15) * 60000, e.tag);
  });

  it("matches lib/db/schema.ts: generating now would write nothing", async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const last = snapshot(journal.entries.length - 1);
    const statements = await generateMigration(last, generateDrizzleJson(schema, last.id));
    assert.deepEqual(statements, []);
  });
});

describe("a fresh database", () => {
  let client: PGlite;
  let db: ReturnType<typeof database>;
  let productId: string;
  let buildId: string;

  before(async () => {
    client = new PGlite();
    db = database(client);
    await migrate(db, { migrationsFolder: FOLDER });
    const [user] = await db.insert(schema.users).values({ email: "owner@example.com" }).returning();
    const [muse] = await db.insert(schema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await db.insert(schema.products).values({ slug: "bird-count", name: "Bird Count", ownerId: user!.id }).returning();
    const [build] = await db.insert(schema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id }).returning();
    productId = product!.id;
    buildId = build!.id;
  });
  after(() => client.close());

  it("has every new table", async () => {
    for (const table of ["tool_sessions", "tool_connections", "native_runs", "native_jobs", "native_artifacts", "native_spend", "native_budget", "native_labs"]) {
      assert.ok((await columns(client, table)).size > 0, table);
    }
  });

  it("gives old rows' new columns harmless defaults", async () => {
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    assert.deepEqual(product!.extraClips, []);
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, buildId));
    assert.equal(build!.requestedTargets, null);
    assert.equal(build!.toolFixtures, null);
    const [usage] = await db.insert(schema.usage).values({ source: "tools", endpoint: "tools/execute", productId }).returning();
    assert.equal(usage!.units, 0);
  });

  it("lets a product have one active connection per toolkit, and another after a disconnect", async () => {
    const row = { productId, principal: "owner" as const, composioUserId: "mmo_abc", toolkit: "gmail", connectedAccountId: "ca_1" };
    const [first] = await db.insert(schema.toolConnections).values(row).returning();
    await assert.rejects(async () => db.insert(schema.toolConnections).values({ ...row, connectedAccountId: "ca_2" }));
    await db.insert(schema.toolConnections).values({ ...row, toolkit: "slack" });
    await db.update(schema.toolConnections).set({ revokedAt: new Date() }).where(eq(schema.toolConnections.id, first!.id));
    await db.insert(schema.toolConnections).values({ ...row, connectedAccountId: "ca_3" });
  });

  it("keeps one Composio session per product and user", async () => {
    const row = { productId, composioUserId: "mmp_abc", sessionId: "s1", configHash: "h1" };
    await db.insert(schema.toolSessions).values(row);
    await assert.rejects(async () => db.insert(schema.toolSessions).values({ ...row, sessionId: "s2" }));
  });

  it("starts at most one run per build from shipping, and any number from the agent", async () => {
    const run = { productId, buildId, targets: ["web" as const, "phone" as const] };
    await db.insert(schema.nativeRuns).values({ ...run, origin: "ship" });
    await assert.rejects(async () => db.insert(schema.nativeRuns).values({ ...run, origin: "ship" }));
    await db.insert(schema.nativeRuns).values({ ...run, origin: "agent" });
    await db.insert(schema.nativeRuns).values({ ...run, origin: "agent" });
    await db.insert(schema.nativeRuns).values({ ...run, origin: "refine" });
    const rows = await db.select().from(schema.nativeRuns);
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.status, "planned");
    assert.equal(rows[0]!.costUsd, 0);
  });

  it("holds a job, its artifact and the ledger, and the queue's claim statement finds the job", async () => {
    const [run] = await db.select().from(schema.nativeRuns).limit(1);
    const expiresAt = new Date(Date.now() + 45 * 60_000);
    const [job] = await db
      .insert(schema.nativeJobs)
      .values({ runId: run!.id, buildId, productId, lane: "mac", kind: "ios_sim", input: { v: 1, limitSeconds: 300 }, expiresAt })
      .returning();
    assert.equal(job!.status, "queued");
    assert.equal(job!.attempts, 0);
    const claimed = await db.execute(
      sql`UPDATE native_jobs SET status = 'claimed', claimed_at = now(), attempts = attempts + 1, deadline_at = now() + (input->>'limitSeconds')::int * interval '1 second'
          WHERE id = (SELECT id FROM native_jobs WHERE lane = 'mac' AND status = 'queued' AND expires_at > now() AND kind = ANY(ARRAY['ios_sim'])
                      ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`,
    );
    assert.equal((claimed as unknown as { rows: Array<{ id: string }> }).rows[0]!.id, job!.id);
    const [artifact] = await db
      .insert(schema.nativeArtifacts)
      .values({ productId, runId: run!.id, jobId: job!.id, kind: "clip", url: "https://blob.example/clip.mp4", pathname: `native/runs/${run!.id}/${job!.id}/clip.mp4`, check: "passed" })
      .returning();
    assert.equal(artifact!.check, "passed");
    await db.insert(schema.nativeSpend).values({ lane: "windows", kind: "reserve", usd: 0.38, ref: "start", runId: run!.id });
    await db.insert(schema.nativeBudget).values({ lane: "windows" });
    await db.insert(schema.nativeLabs).values({ lane: "mac", tokenHash: "a".repeat(64), state: { slots: 1 } });
    await assert.rejects(async () => db.insert(schema.nativeLabs).values({ lane: "mac", tokenHash: "b".repeat(64) }), "one row per lane");
  });

  it("claims the highest priority first, and a claim clears a retried job's selftest report", async () => {
    const [run] = await db.select().from(schema.nativeRuns).limit(1);
    const job = { runId: run!.id, buildId, productId, lane: "windows" as const, kind: "desktop_windows" as const, input: { v: 1 as const, limitSeconds: 300 }, expiresAt: new Date(Date.now() + 6 * 3_600_000) };
    const [backfill] = await db.insert(schema.nativeJobs).values({ ...job, priority: NATIVE_JOB_PRIORITY.backfill }).returning();
    const [agent] = await db.insert(schema.nativeJobs).values({ ...job, priority: NATIVE_JOB_PRIORITY.agent, selftest: { at: "2026-11-01T12:00:00.000Z", ok: true } }).returning();
    assert.equal(backfill!.selftest, null);
    assert.deepEqual(agent!.selftest, { at: "2026-11-01T12:00:00.000Z", ok: true });
    const claimed = await db.execute(
      sql`UPDATE native_jobs SET status = 'claimed', selftest = NULL
          WHERE id = (SELECT id FROM native_jobs WHERE lane = 'windows' AND status = 'queued' AND expires_at > now()
                      ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, selftest`,
    );
    const row = (claimed as unknown as { rows: Array<{ id: string; selftest: unknown }> }).rows[0]!;
    assert.equal(row.id, agent!.id, "the older backfill waits");
    assert.equal(row.selftest, null);
  });
});

describe("a database already at 0012", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("keeps every row, and gains the new columns and tables with their defaults", async () => {
    const dir = folderThrough(12);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.ok(!(await columns(client, "builds")).has("requested_targets"));
    assert.equal((await columns(client, "native_runs")).size, 0);

    const [userId, museId, productId, buildId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into inspirations (id, user_id, note) values ('${museId}', '${userId}', 'An old muse');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
      insert into builds (id, inspiration_id, user_id, product_id, status, cost_usd) values ('${buildId}', '${museId}', '${userId}', '${productId}', 'live', 3.5);
      insert into usage (source, endpoint, product_id, build_id, input_tokens, cost_usd) values ('gateway', 'responses', '${productId}', '${buildId}', 120, 0.01);
    `);

    await migrate(db, { migrationsFolder: FOLDER });

    const typed = database(client);
    const [product] = await typed.select().from(schema.products);
    assert.equal(product!.slug, "old-one");
    assert.deepEqual(product!.extraClips, []);
    const [build] = await typed.select().from(schema.builds);
    assert.equal(build!.costUsd, 3.5);
    assert.equal(build!.requestedTargets, null);
    assert.equal(build!.toolFixtures, null);
    const [usage] = await typed.select().from(schema.usage);
    assert.equal(usage!.inputTokens, 120);
    assert.equal(usage!.units, 0);
    assert.ok((await columns(client, "native_jobs")).has("token_hash"));
    assert.ok((await columns(client, "native_jobs")).has("selftest"));
    // 0019_engine: nullable, no default, so old rows read null and nothing was backfilled.
    assert.equal(build!.roundPlan, null);
    assert.equal(build!.liveCheck, null);
    assert.equal((await columns(client, "builds")).get("round_plan")?.nullable, true);
    assert.equal((await columns(client, "gateway_tokens")).get("build_id")?.nullable, true);

    const units = (await columns(client, "usage")).get("units");
    assert.equal(units?.nullable, false);
    await client.close();
  });

  it("0019_engine: a database at 0015 keeps its builds and tokens, which read null for the new columns", async () => {
    const dir = folderThrough(15);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.ok(!(await columns(client, "gateway_tokens")).has("build_id"));
    const [userId, museId, productId, buildId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into inspirations (id, user_id, note) values ('${museId}', '${userId}', 'An old muse');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
      insert into builds (id, inspiration_id, user_id, product_id, status) values ('${buildId}', '${museId}', '${userId}', '${productId}', 'live');
      insert into gateway_tokens (product_id, token_hash, scope, allowed_models, daily_budget_usd) values ('${productId}', 'h1', 'live', '["muse-wonder-1.0"]', 2);
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    const [token] = await typed.select().from(schema.gatewayTokens);
    assert.equal(token!.tokenHash, "h1");
    assert.equal(token!.buildId, null);
    const [build] = await typed.select().from(schema.builds);
    assert.equal(build!.status, "live");
    assert.equal(build!.roundPlan, null);
    await typed.update(schema.gatewayTokens).set({ buildId }).where(eq(schema.gatewayTokens.id, token!.id));
    const [tied] = await typed.select().from(schema.gatewayTokens);
    assert.equal(tied!.buildId, buildId);
    await client.close();
  });

  it("runs the whole chain again without a change, so a redeploy is safe", async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: FOLDER });
    const before = (await columns(client, "builds")).size;
    await migrate(db, { migrationsFolder: FOLDER });
    assert.equal((await columns(client, "builds")).size, before);
    await client.close();
  });
});
