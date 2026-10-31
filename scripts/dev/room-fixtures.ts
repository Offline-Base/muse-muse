/**
 * Fills a local PGlite database with the stored builds in components/build/__tests__/room-fixture.ts, so the build room
 * can be looked at with no sandbox and no keys:
 *
 *   DATABASE_URL=pglite:.data/room npx tsx scripts/migrate.ts
 *   DATABASE_URL=pglite:.data/room npx tsx scripts/dev/room-fixtures.ts [path to a small .mp4 for the demo]
 *   DATABASE_URL=pglite:.data/room OPEN_ACCESS=admin MUSE_ENGINE=serve npx next dev -H localhost -p 3023
 *
 * Then open /b/<id> for each id it prints.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { FIXTURES, IDS, inspiration, tokens } from "@/components/build/__tests__/room-fixture";
import { localDbDir } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const dir = localDbDir(process.env.DATABASE_URL ?? "");
if (!dir) throw new Error("Set DATABASE_URL to pglite:<folder>.");

const video = process.argv[2] ? `data:video/mp4;base64,${readFileSync(process.argv[2]).toString("base64")}` : null;

// The stored times are fixed. Move them so the builds read as just now.
const shift = Date.now() - 900_000 - Date.parse(FIXTURES.running.build.startedAt);
const moved = (iso: string) => new Date(Date.parse(iso) + shift);

const client = new PGlite(dir);
const d = drizzle({ client, schema });

await d.insert(schema.users).values({ id: IDS.user, email: "fixture@example.com" }).onConflictDoNothing();
await d.insert(schema.inspirations).values({ id: IDS.inspiration, userId: IDS.user, note: inspiration.note, references: inspiration.references }).onConflictDoNothing();
for (const [name, f] of Object.entries(FIXTURES)) {
  const b = f.build;
  const p = f.product;
  await d
    .insert(schema.products)
    .values({ id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, ownerId: IDS.user, inspirationId: IDS.inspiration, status: p.status, liveUrl: p.liveUrl, latestBuildId: p.latestBuildId })
    .onConflictDoNothing();
  await d
    .insert(schema.builds)
    .values({
      id: b.id,
      inspirationId: IDS.inspiration,
      userId: IDS.user,
      kind: b.kind,
      productId: p.id,
      status: b.status,
      step: b.step,
      brief: b.brief,
      buildModel: b.buildModel,
      museSessionId: b.museSessionId,
      fixRounds: b.fixRounds,
      previewUrl: b.previewUrl,
      costUsd: b.costUsd,
      error: b.error,
      startedAt: moved(b.startedAt),
      finishedAt: b.finishedAt ? moved(b.finishedAt) : null,
    })
    .onConflictDoNothing();
  for (const e of f.events) {
    const { id: _id, at: when, ...body } = e;
    const payload = (body.type === "recording" && video ? { ...body, url: video } : body) as typeof body;
    await d.insert(schema.buildEvents).values({ buildId: b.id, type: payload.type, payload, at: moved(when) });
  }
  await d.insert(schema.usage).values({ source: "muse_code", buildId: b.id, productId: p.id, model: "muse-wonder-1.0", endpoint: "fixture", inputTokens: tokens.input, cachedInputTokens: tokens.cached, outputTokens: tokens.output, costUsd: b.costUsd });
  console.log(`${name}: /b/${b.id}`);
}
await client.close();
