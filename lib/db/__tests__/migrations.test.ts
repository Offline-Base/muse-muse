/**
 * The migrations themselves, on a real Postgres (PGlite): the journal agrees with the folder and with lib/db/schema.ts,
 * a fresh database gets every table, and a database already at 0012 keeps its rows and gets the new columns' defaults.
 * So does one at 0015 with a chat dataset, which 0017 (decision datasets) leaves a chat dataset.
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
/**
 * Numbers never used. 0016 was set aside for General's code_sessions, which was never built; 0017 (decision models)
 * landed first and chains to 0015's snapshot, so 0016 is retired for good: drizzle's migrator only applies entries newer
 * than the newest applied one, so a later 0016 would be skipped. New migrations take the next free number.
 * 21 is unit 4's 0021_files, not built when unit 5's 0022_connect was: the integrator merges 0021 first (or drops it)
 * and takes 21 out of this set, then re-chains 0022's snapshot (docs/CAPABILITIES.md, section 4).
 */
const RESERVED = new Set([16]);
/**
 * Wave 3 numbers below this branch's newest migration whose unit hasn't merged in yet (docs/CAPABILITIES.md, section 4),
 * named one by one: a migration's journal idx is its tag number, so a later unit's can sit above a gap. Each must really
 * be missing, and no other number may be, so the list has to be emptied (or the higher migration renumbered to the next
 * free number) as each lower unit merges. drizzle applies only entries newer than the newest applied one, so a database
 * that ran a migration above a gap would skip the gap's migration for good: no branch with a gap goes near a shared
 * database. With MIGRATIONS_FOR=main (the merge to main, or any shared database) a gap fails outright.
 */
const PENDING_WAVE3 = new Set([23]);
const pendingWave3 = (i: number) => PENDING_WAVE3.has(i);
const snapshot = (idx: number) => JSON.parse(readFileSync(join(FOLDER, `meta/${String(idx).padStart(4, "0")}_snapshot.json`), "utf8"));

const database = (client: PGlite) => drizzle({ client, schema });

/**
 * Wave 3's migrations, in the agreed order (docs/CAPABILITIES.md, section 4), after General's 0017 (0016 is retired).
 * Each wave 3 unit appends its tag here. Their journal times follow the contract's rule.
 */
const WAVE3_TAGS = ["0018_trust", "0019_engine", "0020_data", "0021_files", "0022_connect", "0024_code", "0025_gpu"];
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
  it("leaves exactly the named wave 3 numbers pending, each still missing, and none at all for main", () => {
    for (const i of PENDING_WAVE3) {
      assert.ok(!journal.entries.some((e) => e.idx === i), `${i} has landed: take it off PENDING_WAVE3, or renumber what sits above it`);
      assert.ok(journal.entries.at(-1)!.idx > i, `${i} is pending, so something above it must be here`);
    }
    if (process.env.MIGRATIONS_FOR === "main") assert.deepEqual([...PENDING_WAVE3], [], "a branch with a gap below a migration must not reach main or a shared database");
  });


  it("has a journal that runs in order from 0000, each entry with its file and snapshot, skipping only a reserved number", () => {
    const last = journal.entries.at(-1)!.idx;
    const expected = Array.from({ length: last + 1 }, (_, i) => i).filter((i) => (!RESERVED.has(i) && !pendingWave3(i)) || journal.entries.some((e) => e.idx === i));
    assert.deepEqual(journal.entries.map((e) => e.idx), expected);
    journal.entries.forEach((e) => {
      assert.ok(e.tag.startsWith(String(e.idx).padStart(4, "0")), e.tag);
      assert.ok(existsSync(join(FOLDER, `${e.tag}.sql`)), `${e.tag}.sql`);
      assert.ok(existsSync(join(FOLDER, `meta/${String(e.idx).padStart(4, "0")}_snapshot.json`)), `snapshot ${e.idx}`);
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
    for (let i = 1; i < journal.entries.length; i++) {
      const [prev, e] = [journal.entries[i - 1]!, journal.entries[i]!];
      assert.equal(snapshot(e.idx).prevId, snapshot(prev.idx).id, `snapshot ${e.idx}`);
    }
  });

  it("names the unit's three migrations in the agreed order", () => {
    assert.deepEqual(journal.entries.slice(13, 16).map((e) => e.tag), ["0013_agents", "0014_native", "0015_product_clips"]);
  });

  it("puts wave 3's migrations after 0017, in the agreed order, with the agreed journal times", () => {
    const after17 = journal.entries.filter((e) => e.idx > 17).map((e) => e.tag);
    assert.deepEqual(after17, WAVE3_TAGS.filter((t) => after17.includes(t)), "wave 3 tags in contract order");
    for (const e of journal.entries.filter((x) => x.idx > 17)) assert.equal(e.when, 1793431490646 + (tagNumber(e.tag) - 15) * 60000, e.tag);
    assert.equal(snapshot(18).prevId, snapshot(17).id, "0018 chains to 0017");
  });

  it("has each wave 3 migration's SQL exactly as drizzle-kit generates it from the snapshot before it", async () => {
    const { generateMigration } = await import("drizzle-kit/api");
    const entries = journal.entries.filter((e) => e.idx > 17);
    for (const e of entries) {
      const prev = journal.entries[journal.entries.indexOf(e) - 1]!;
      const statements = await generateMigration(snapshot(prev.idx), snapshot(e.idx));
      const file = readFileSync(join(FOLDER, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.trim());
      assert.deepEqual(statements.map((x) => x.trim()), file, e.tag);
    }
  });

  it("puts decision datasets at 0017, after 0015 and the time it was given, three columns and nothing else", () => {
    const e = journal.entries.find((x) => x.tag === "0017_decision_datasets");
    assert.ok(e, "0017_decision_datasets is in the journal");
    assert.equal(e.idx, 17);
    assert.equal(e.when, 1793431610646);
    assert.equal(snapshot(17).prevId, snapshot(15).id, "chained to 0015 until 0016 lands");
    const statements = readFileSync(join(FOLDER, "0017_decision_datasets.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim());
    assert.deepEqual(statements, [
      `ALTER TABLE "training_datasets" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;`,
      `ALTER TABLE "training_datasets" ADD COLUMN "decision" jsonb;`,
      `ALTER TABLE "training_datasets" ADD COLUMN "decision_rows" jsonb DEFAULT '{}'::jsonb NOT NULL;`,
    ]);
  });

  it("has 0017's SQL exactly as drizzle-kit generates it between 0015's snapshot and 0017's", async () => {
    const { generateMigration } = await import("drizzle-kit/api");
    const statements = await generateMigration(snapshot(15), snapshot(17));
    const file = readFileSync(join(FOLDER, "0017_decision_datasets.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim());
    assert.deepEqual(statements.map((x) => x.trim()), file);
  });

  it("matches lib/db/schema.ts: generating now would write nothing", async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const last = snapshot(journal.entries.at(-1)!.idx);
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
    for (const column of ["kind", "decision", "decision_rows"]) assert.ok((await columns(client, "training_datasets")).has(column), column);
    for (const table of ["tool_sessions", "tool_connections", "native_runs", "native_jobs", "native_artifacts", "native_spend", "native_budget", "native_labs", "abuse_reports"]) {
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

  it("0018_trust: a database at 0015 keeps its users and products, which read null for the new columns", async () => {
    const dir = folderThrough(15);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.ok(!(await columns(client, "users")).has("banned_at"));
    assert.equal((await columns(client, "abuse_reports")).size, 0);
    const [userId, productId] = [randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email, password_hash) values ('${userId}', 'old@example.com', 'scrypt$x');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    const [user] = await typed.select().from(schema.users);
    assert.equal(user!.email, "old@example.com");
    assert.equal(user!.passwordHash, "scrypt$x");
    for (const k of ["adultConfirmedAt", "termsVersion", "termsAcceptedAt", "bannedAt", "banReason"] as const) assert.equal(user![k], null, k);
    const [product] = await typed.select().from(schema.products);
    assert.equal(product!.status, "live");
    assert.equal(product!.takenDownAt, null);
    assert.equal(product!.takedownReason, null);
    assert.equal(product!.statusBeforeTakedown, null);
    for (const c of ["adult_confirmed_at", "terms_version", "terms_accepted_at", "banned_at", "ban_reason"]) {
      assert.equal((await columns(client, "users")).get(c)?.nullable, true, c);
    }
    const [report] = await typed.insert(schema.abuseReports).values({ productId, productSlug: "old-one", reason: "broken", reporterKey: "k".repeat(32) }).returning();
    assert.equal(report!.status, "open");
    assert.equal(report!.detail, "");
    assert.equal(report!.handledBy, null);
    await client.close();
  });

  it("leaves a chat dataset made before 0017 a chat dataset, with no decision and no decision rows", async () => {
    const dir = folderThrough(15);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.ok(!(await columns(client, "training_datasets")).has("kind"));
    const datasetId = randomUUID();
    await client.exec(`
      insert into training_datasets (id, title, task, status, requested, train, train_count, writer_model)
      values ('${datasetId}', 'Python errors', 'Explain Python errors to beginners.', 'ready', 20, '[{"messages":[]}]'::jsonb, 1, 'muse-wonder-1.0');
    `);

    await migrate(db, { migrationsFolder: FOLDER });

    const [row] = await database(client).select().from(schema.trainingDatasets);
    assert.equal(row!.kind, "chat");
    assert.equal(row!.decision, null);
    assert.deepEqual(row!.decisionRows, {});
    assert.equal(row!.trainCount, 1);
    assert.equal(row!.writerModel, "muse-wonder-1.0");
    const kind = (await columns(client, "training_datasets")).get("kind");
    assert.equal(kind?.nullable, false);
    await client.close();
  });

  it("0020_data: a database at 0019 keeps its builds, which read null for caps_dropped, and gets the data tables", async () => {
    const dir = folderThrough(19);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.ok(!(await columns(client, "builds")).has("caps_dropped"));
    assert.equal((await columns(client, "product_rows")).size, 0);
    const [userId, museId, productId, buildId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into inspirations (id, user_id, note) values ('${museId}', '${userId}', 'An old muse');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
      insert into builds (id, inspiration_id, user_id, product_id, status) values ('${buildId}', '${museId}', '${userId}', '${productId}', 'live');
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    const [build] = await typed.select().from(schema.builds);
    assert.equal(build!.status, "live");
    assert.equal(build!.capsDropped, null);
    assert.equal((await columns(client, "builds")).get("caps_dropped")?.nullable, true);
    for (const t of ["end_users", "end_user_passkeys", "product_rows", "product_data_counts"]) assert.ok((await columns(client, t)).size > 0, t);
    // Two shared rows (no owner_key) still clash on one doc id: the key is NULLS NOT DISTINCT.
    const row = { productId, namespace: "live", collection: "items", scope: "shared" as const, docId: "a", data: { n: 1 }, bytes: 7 };
    const [first] = await typed.insert(schema.productRows).values(row).returning();
    await assert.rejects(async () => typed.insert(schema.productRows).values(row));
    const [second] = await typed.insert(schema.productRows).values({ ...row, docId: "b" }).returning();
    assert.equal(first!.version, 1);
    assert.equal(first!.deletedAt, null);
    assert.ok(second!.seq > first!.seq, "seq comes from the sequence, in write order");
    // A passkey's public key comes back as the bytes that went in.
    const [person] = await typed.insert(schema.endUsers).values({ displayName: "Ana" }).returning();
    const key = Buffer.from([0x30, 0x59, 0x00, 0xff, 0x5c, 0x78]);
    await typed.insert(schema.endUserPasskeys).values({ endUserId: person!.id, credentialId: "cred-1", publicKey: key });
    const [passkey] = await typed.select().from(schema.endUserPasskeys);
    assert.ok(Buffer.isBuffer(passkey!.publicKey));
    assert.deepEqual([...passkey!.publicKey], [...key]);
    assert.equal(passkey!.counter, 0);
    assert.deepEqual(passkey!.transports, []);
    // Removing the product removes its rows and counts with it (decision 13).
    await typed.insert(schema.productDataCounts).values({ productId, namespace: "live", rows: 2, bytes: 14 });
    await client.exec(`delete from builds; delete from products where id = '${productId}'`);
    assert.equal((await typed.select().from(schema.productRows)).length, 0);
    assert.equal((await typed.select().from(schema.productDataCounts)).length, 0);
    await client.close();
  });

  it("0021_files: a database at 0020 keeps its rows, and gets the files tables, whose index finds text and goes with its product", async () => {
    const dir = folderThrough(20);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.equal((await columns(client, "product_files")).size, 0);
    const [userId, productId] = [randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
      insert into product_rows (product_id, namespace, collection, scope, doc_id, data, bytes) values ('${productId}', 'live', 'items', 'shared', 'a', '{"n":1}', 7);
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    assert.equal((await typed.select().from(schema.productRows)).length, 1, "0020's rows are kept");
    const [file] = await typed.insert(schema.productFiles).values({ productId, namespace: "live", scope: "shared", name: "notes.pdf", contentType: "application/pdf", bytes: 10, blobPath: "caps/files/x" }).returning();
    assert.equal(file!.status, "pending");
    assert.equal(file!.sha256, null);
    assert.equal(file!.deletedAt, null);
    await typed.insert(schema.productSearchDocs).values({ productId, namespace: "live", scope: "shared", source: { fileId: file!.id }, sourceKey: `file:${file!.id}`, title: "Field notes", body: "Herons nest by the reservoir" });
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from product_search_docs where tsv @@ websearch_to_tsquery('simple', 'heron* OR reservoir')`);
    assert.equal(rows[0]!.n, 1, "the generated tsvector is there and indexed");
    await typed.insert(schema.productDatasetReads).values({ productId, namespace: "b:x", datasetId: "palmer-penguins", file: "penguins.csv" });
    await client.exec(`delete from product_rows; delete from products where id = '${productId}'`);
    for (const t of [schema.productFiles, schema.productSearchDocs, schema.productDatasetReads]) assert.equal((await typed.select().from(t)).length, 0);
    await client.close();
  });

  it("0022_connect: a database at 0020 keeps its rows and gets the vault, sends and fetch cache tables", async () => {
    const dir = folderThrough(20);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.equal((await columns(client, "product_secrets")).size, 0);
    const [userId, productId] = [randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
      insert into product_rows (product_id, namespace, collection, scope, doc_id, data, bytes) values ('${productId}', 'live', 'items', 'shared', 'a', '{}', 2);
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    assert.equal((await typed.select().from(schema.products)).length, 1);
    assert.equal((await typed.select().from(schema.productRows)).length, 1);
    const sealed = { productId, name: "github", service: "github", ciphertext: Buffer.from([1, 2, 0, 255]), iv: Buffer.alloc(12, 7), tag: Buffer.alloc(16, 9), keyVersion: 1 };
    const [secret] = await typed.insert(schema.productSecrets).values(sealed).returning();
    assert.equal(secret!.namespace, "live");
    assert.deepEqual([...secret!.ciphertext], [1, 2, 0, 255]);
    // One active key per name and namespace; a revoked one doesn't count.
    await assert.rejects(async () => typed.insert(schema.productSecrets).values(sealed));
    await client.exec(`update product_secrets set revoked_at = now()`);
    await typed.insert(schema.productSecrets).values(sealed);
    await typed.insert(schema.productSecrets).values({ ...sealed, namespace: "b:x" });
    // One send per approval.
    const send = { productId, channel: "email", recipientHash: "h", approvalNonce: "n1", status: "simulated" as const };
    await typed.insert(schema.productSends).values(send);
    await assert.rejects(async () => typed.insert(schema.productSends).values(send));
    await typed.insert(schema.publicFetchCache).values({ key: "k", api: "nws", status: 200, body: Buffer.from("{}"), expiresAt: new Date(Date.now() + 60_000) });
    // The vault and sends go with the product; the cache is shared and stays.
    await client.exec(`delete from product_rows; delete from products where id = '${productId}'`);
    assert.equal((await typed.select().from(schema.productSecrets)).length, 0);
    assert.equal((await typed.select().from(schema.productSends)).length, 0);
    assert.equal((await typed.select().from(schema.publicFetchCache)).length, 1);
    await client.close();
  });

  it("0024_code: a database at 0022 keeps its products, and gets exec_runs, which goes with its product", async () => {
    const dir = folderThrough(22);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.equal((await columns(client, "exec_runs")).size, 0);
    const [userId, productId] = [randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    const [product] = await typed.select().from(schema.products);
    assert.equal(product!.slug, "old-one");
    const [run] = await typed.insert(schema.execRuns).values({ productId, namespace: "live", kind: "exec", principal: "owner", language: "python", status: "ok" }).returning();
    assert.equal(run!.ms, 0);
    assert.equal(run!.costUsd, 0);
    assert.equal(run!.subjectKey, null);
    assert.equal((await columns(client, "exec_runs")).get("language")?.nullable, true);
    await client.exec(`delete from products where id = '${productId}'`);
    assert.equal((await typed.select().from(schema.execRuns)).length, 0);
    await client.close();
  });

  it("0025_gpu: a database at 0024 keeps its training jobs with no product, and gets glimmer_windows, one open at a time", async () => {
    const dir = folderThrough(24);
    dirs.push(dir);
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: dir });
    assert.equal((await columns(client, "glimmer_windows")).size, 0);
    const [userId, productId, jobId] = [randomUUID(), randomUUID(), randomUUID()];
    await client.exec(`
      insert into users (id, email) values ('${userId}', 'old@example.com');
      insert into products (id, slug, name, owner_id, status) values ('${productId}', 'old-one', 'Old One', '${userId}', 'live');
      insert into training_jobs (id, recipe, title, params, instance_type, region, price_cents_per_hour, max_minutes, max_usd, instance_name)
        values ('${jobId}', 'glimmer-lora', 'Old job', '{}', 'gpu', 'r', 100, 60, 5, 'n');
    `);
    await migrate(db, { migrationsFolder: FOLDER });
    const typed = database(client);
    const [job] = await typed.select().from(schema.trainingJobs);
    assert.equal(job!.title, "Old job");
    assert.equal(job!.productId, null);
    assert.equal((await columns(client, "training_jobs")).get("product_id")?.nullable, true);
    const at = new Date();
    const open = { startsAt: at, endsAt: at, capUsd: 3, adapterJobId: jobId };
    const [first] = await typed.insert(schema.glimmerWindows).values(open).returning();
    assert.equal(first!.status, "open");
    assert.equal(first!.costUsd, null);
    assert.equal(first!.sparkOpen, false);
    await assert.rejects(() => typed.insert(schema.glimmerWindows).values(open));
    await typed.insert(schema.glimmerWindows).values({ ...open, status: "closed" });
    await typed.update(schema.trainingJobs).set({ productId });
    await client.exec(`delete from products where id = '${productId}'`);
    assert.equal((await typed.select().from(schema.trainingJobs))[0]!.productId, null, "a job outlives its product");
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
