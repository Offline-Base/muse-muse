/** A real Postgres (in-memory PGlite with the repo's migrations) and small row makers, for lib/train/public's tests. */
import { randomUUID } from "node:crypto";
import * as schema from "@/lib/db/schema";

export type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof schema>;

export async function makeTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
  return { db, close: () => client.close() };
}

/** Test values for the signing keys and session, never real ones. */
export function testSecrets(): void {
  process.env.TOOLS_SIGNING_SECRET = "test-tools-signing-secret-open-train";
  process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-open-train";
  process.env.SESSION_SECRET = "test-session-secret-open-train";
}

export async function addUser(db: TestDb, email: string = `${randomUUID()}@example.com`, isAdmin = false): Promise<string> {
  const [row] = await db.insert(schema.users).values({ email, isAdmin }).returning({ id: schema.users.id });
  return row.id;
}

export async function addDataset(db: TestDb, createdBy: string | null, title = "made-up dataset"): Promise<string> {
  const [row] = await db
    .insert(schema.trainingDatasets)
    .values({ title, task: "Answer questions for a made-up bakery.", requested: 40, createdBy })
    .returning({ id: schema.trainingDatasets.id });
  return row.id;
}

export async function addJob(
  db: TestDb,
  createdBy: string | null,
  over: Partial<typeof schema.trainingJobs.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.trainingJobs)
    .values({
      recipe: "glimmer-lora",
      title: "made-up job",
      params: { maxSteps: 120 },
      instanceType: "gpu_1x_a100_sxm4",
      region: "us-east-1",
      priceCentsPerHour: 129,
      maxMinutes: 60,
      maxUsd: 4,
      instanceName: `mm-${randomUUID().slice(0, 8)}`,
      status: "running",
      createdBy,
      ...over,
    })
    .returning({ id: schema.trainingJobs.id });
  return row.id;
}

/** A Request with these headers, for the cookie and IP readers. */
export function req(headers: Record<string, string> = {}, url = "https://muse-muse.example.test/api/train/runs"): Request {
  return new Request(url, { method: "POST", headers });
}
