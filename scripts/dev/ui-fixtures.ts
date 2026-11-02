/**
 * Fills a local PGlite database with made-up products, musings, usage and fine-tuning data, so every page of the
 * platform can be looked at with no keys and no spend. Everything here is invented: example.com links, the repo's own
 * example photos, round numbers. Nothing calls a model.
 *
 *   DATABASE_URL=pglite:.data/ui npx tsx scripts/migrate.ts
 *   DATABASE_URL=pglite:.data/ui npx tsx scripts/dev/room-fixtures.ts     (optional: the detailed build rooms)
 *   DATABASE_URL=pglite:.data/ui npx tsx scripts/dev/ui-fixtures.ts
 *   DATABASE_URL=pglite:.data/ui OPEN_ACCESS=admin ADMIN_EMAILS=fixture@example.com npx next dev -H localhost -p 3011
 *
 * The owner is room-fixtures' user (fixture@example.com), so its build rooms show under Musings too. Run it again to
 * refresh the times: rows are keyed by fixed ids and skipped when they exist.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { IDS, brief as baseBrief } from "@/components/build/__tests__/room-fixture";
import { localDbDir } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type { Brief } from "@/lib/brief/schema";
import type { BuildStatus, ProductStatus } from "@/lib/types";

const dir = localDbDir(process.env.DATABASE_URL ?? "");
if (!dir) throw new Error("Set DATABASE_URL to pglite:<folder>.");

const client = new PGlite(dir);
const d = drizzle({ client, schema });
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000);
/** A fixed uuid per seed row, so a second run skips what's there. */
const id = (kind: number, n: number) => `00000000-0000-4000-9${String(kind).padStart(3, "0")}-${String(n).padStart(12, "0")}`;

interface Seed {
  slug: string;
  name: string;
  tagline: string;
  note: string;
  image: string;
  models: Brief["capabilities"];
  status: BuildStatus;
  minutesAgo: number;
  buildMinutes: number;
  cost: number;
  fixRounds: number;
  rebuildOf?: string;
  error?: string;
}

const WONDER = (need: string): Brief["capabilities"][number] => ({ need, model: "muse-wonder-1.0", why: "Reads the photo and writes the answer" });
const SEEDS: Seed[] = [
  { slug: "cake-order-desk", name: "Cake Order Desk", tagline: "Take custom cake orders with price and pickup time.", note: "An order page for a small bakery: pick a cake, size and flavor, see the price and pickup time.", image: "/examples/bakery.jpg", models: [WONDER("Price the order"), { need: "Draw the cake", model: "muse-image-1.0", why: "Makes a preview of the cake" }], status: "live", minutesAgo: 40, buildMinutes: 7, cost: 1.12, fixRounds: 1 },
  { slug: "fridge-to-dinner", name: "Fridge to Dinner", tagline: "Three dinners from a photo of your fridge.", note: "Snap a photo of my fridge and get three dinners I can make tonight.", image: "/examples/fridge.jpg", models: [WONDER("Spot the ingredients")], status: "live", minutesAgo: 180, buildMinutes: 6, cost: 0.94, fixRounds: 0 },
  { slug: "plant-pal", name: "Plant Pal", tagline: "Name a houseplant and get a watering plan.", note: "Take a photo of a houseplant, name it, and get a simple watering and light plan.", image: "/examples/plant.jpg", models: [{ need: "Outline the leaves", model: "sam-3.1", why: "Segments the plant" }, WONDER("Name the plant")], status: "live", minutesAgo: 420, buildMinutes: 9, cost: 1.48, fixRounds: 2 },
  { slug: "receipt-splitter", name: "Receipt Splitter", tagline: "Scan a receipt and see what everyone owes.", note: "Scan a dinner receipt, assign each item to a person, and show what everyone owes with tax and tip.", image: "/examples/receipt.jpg", models: [WONDER("Read the receipt")], status: "live", minutesAgo: 1500, buildMinutes: 5, cost: 0.71, fixRounds: 0, rebuildOf: "structured-image-extraction" },
  { slug: "habit-sketch", name: "Habit Sketch", tagline: "Your hand-drawn habit tracker, as a working app.", note: "Turn my hand-drawn sketch of a habit tracker into a working app with the same layout.", image: "/examples/sketch.jpg", models: [WONDER("Read the sketch")], status: "live", minutesAgo: 2900, buildMinutes: 8, cost: 1.31, fixRounds: 1 },
  { slug: "room-restyler", name: "Room Restyler", tagline: "Try three new looks on a photo of your living room.", note: "Upload a living room photo and see it in three styles.", image: "/docs-samples/living-room.jpg", models: [{ need: "Restyle the room", model: "muse-image-1.0", why: "Edits the photo" }], status: "live", minutesAgo: 4300, buildMinutes: 6, cost: 0.88, fixRounds: 0 },
  { slug: "sneaker-check", name: "Sneaker Check", tagline: "Is this pair worth the price? A quick second opinion.", note: "Photo of a sneaker, tell me the model and a fair resale price.", image: "/docs-samples/sneaker.jpg", models: [WONDER("Name the sneaker")], status: "partial", minutesAgo: 5800, buildMinutes: 11, cost: 1.95, fixRounds: 3 },
  { slug: "street-counter", name: "Street Counter", tagline: "Counts people and bikes in a short street clip.", note: "A short street video: count the people and the bikes that pass.", image: "/docs-samples/street.jpg", models: [{ need: "Track people and bikes", model: "sam-3.1", why: "Segments objects across frames" }], status: "partial", minutesAgo: 7300, buildMinutes: 12, cost: 2.4, fixRounds: 3 },
  { slug: "chart-explainer", name: "Chart Explainer", tagline: "Plain-language notes on any bar chart.", note: "Upload a chart and get three plain sentences about what it shows.", image: "/docs-samples/bar-chart.png", models: [WONDER("Read the chart")], status: "live", minutesAgo: 8700, buildMinutes: 5, cost: 0.62, fixRounds: 0, rebuildOf: "rich-documents" },
  { slug: "error-explainer", name: "Error Explainer", tagline: "Paste a screenshot of an error and get the fix.", note: "A screenshot of an error message, explained with the likely fix.", image: "/docs-samples/error-screenshot.png", models: [WONDER("Read the screenshot")], status: "failed", minutesAgo: 95, buildMinutes: 14, cost: 2.1, fixRounds: 3, error: "The checks still failed after 3 fix rounds: the upload button never enabled." },
  { slug: "sofa-finder", name: "Sofa Finder", tagline: "Find sofas like the one in your photo.", note: "Photo of a sofa I like, find similar ones and compare prices.", image: "/docs-samples/cat-sofa.jpg", models: [WONDER("Describe the sofa")], status: "building", minutesAgo: 4, buildMinutes: 0, cost: 0.31, fixRounds: 0 },
  { slug: "signup-review", name: "Signup Review", tagline: "A second look at your signup screen.", note: "Review this signup screen and suggest three fixes.", image: "/docs-samples/signup-screen.png", models: [WONDER("Review the screen")], status: "queued", minutesAgo: 1, buildMinutes: 0, cost: 0, fixRounds: 0 },
];

const shipped = (s: BuildStatus) => s === "live" || s === "partial";
const productStatus = (s: BuildStatus): ProductStatus => (s === "live" || s === "partial" || s === "failed" ? s : "building");

await d.insert(schema.users).values({ id: IDS.user, email: "fixture@example.com", isAdmin: true }).onConflictDoNothing();

for (const [i, s] of SEEDS.entries()) {
  const inspirationId = id(1, i);
  const productId = id(2, i);
  const buildId = id(3, i);
  const startedAt = ago(s.minutesAgo + s.buildMinutes);
  const finishedAt = shipped(s.status) || s.status === "failed" ? ago(s.minutesAgo) : null;
  const brief: Brief = { ...baseBrief, verdict: "yes", name: s.name, slug: s.slug, tagline: s.tagline, capabilities: s.models, limits: ["Made-up product for the local preview: its answers are examples."], actions: [], inspiration: { ...baseBrief.inspiration, summary: s.note, references: [] } };

  await d.insert(schema.inspirations).values({ id: inspirationId, userId: IDS.user, note: s.note, references: [] }).onConflictDoNothing();
  await d
    .insert(schema.products)
    .values({
      id: productId,
      slug: s.slug,
      name: s.name,
      tagline: s.tagline,
      ownerId: IDS.user,
      inspirationId,
      rebuildOf: s.rebuildOf ?? null,
      latestBuildId: buildId,
      liveUrl: shipped(s.status) ? `https://${s.slug}.example.com` : null,
      demoPosterUrl: shipped(s.status) ? s.image : null,
      status: productStatus(s.status),
      updatedAt: finishedAt ?? startedAt,
      createdAt: startedAt,
    })
    .onConflictDoNothing();
  await d
    .insert(schema.builds)
    .values({
      id: buildId,
      inspirationId,
      userId: IDS.user,
      productId,
      rebuildOf: s.rebuildOf ?? null,
      status: s.status,
      step: s.status === "building" ? "build" : null,
      brief: s.status === "queued" ? null : brief,
      buildModel: "muse-spark-1.3-contributor",
      fixRounds: s.fixRounds,
      costUsd: s.cost,
      error: s.error ?? null,
      startedAt,
      finishedAt,
    })
    .onConflictDoNothing();

  // The build's own spend, then 14 days of calls from the live product.
  if (s.cost > 0) {
    await d.insert(schema.usage).values({ source: "muse_code", buildId, productId, endpoint: "fixture", model: "muse-spark-1.3-contributor", inputTokens: Math.round(s.cost * 900_000), cachedInputTokens: Math.round(s.cost * 500_000), outputTokens: Math.round(s.cost * 30_000), costUsd: s.cost, at: startedAt });
  }
  if (shipped(s.status)) {
    for (let day = 0; day < 14; day++) {
      const calls = 3 + ((i * 7 + day * 5) % 11);
      const model = s.models[(day + i) % s.models.length]!.model;
      await d.insert(schema.usage).values({ source: "gateway", productId, endpoint: "/v1/responses", model, inputTokens: calls * 2_400, cachedInputTokens: calls * 800, outputTokens: calls * 350, images: model === "muse-image-1.0" ? calls : 0, costUsd: Math.round(calls * 0.004 * 1000) / 1000, at: ago(day * 1440 + 60 + i * 13) });
    }
  }
}

// Platform calls (brief and judge) spread over the same two weeks.
for (let day = 0; day < 14; day++) {
  await d.insert(schema.usage).values({ source: "platform", endpoint: "/v1/responses", model: "muse-spark-1.3-contributor", inputTokens: 40_000 + day * 1_500, outputTokens: 6_000, costUsd: 0.05, at: ago(day * 1440 + 200) });
}

// Fine-tuning: two datasets the lab wrote, and one finished tune judged against its base.
const example = (q: string, a: string) => ({ messages: [{ role: "user" as const, content: q }, { role: "assistant" as const, content: a }] });
await d
  .insert(schema.trainingDatasets)
  .values([
    {
      id: id(4, 0),
      title: "Cold room readings",
      task: "Read a controller reading and a probe reading, and say whether to trust the controller.",
      status: "ready",
      requested: 120,
      train: [example("Controller -18.0 C, probe -17.6 C.", "Trust the controller: the two agree."), example("Controller -18.0 C, probe -9.5 C.", "Don't trust the controller: the probe disagrees by 8.5 C.")],
      eval: [{ prompt: "Controller -20.0 C, probe -19.1 C.", reference: "Trust the controller." }],
      trainCount: 100,
      evalCount: 20,
      costUsd: 0.22,
      createdBy: IDS.user,
      createdAt: ago(3000),
      finishedAt: ago(2990),
      writerModel: "muse-spark-1.3-contributor",
    },
    {
      id: id(4, 1),
      title: "Receipt fields",
      task: "Turn a receipt's text into store, date, items and total.",
      status: "ready",
      requested: 200,
      train: [example("JOE'S DELI 11/02 BAGEL 3.50 COFFEE 2.25 TOTAL 5.75", '{"store":"Joe\'s Deli","total":5.75}')],
      eval: [{ prompt: "CORNER MART 10/30 MILK 4.10 TOTAL 4.10", reference: '{"store":"Corner Mart","total":4.10}' }],
      trainCount: 180,
      evalCount: 20,
      costUsd: 0.31,
      createdBy: IDS.user,
      createdAt: ago(6000),
      finishedAt: ago(5985),
      writerModel: "muse-spark-1.3-contributor",
    },
  ])
  .onConflictDoNothing();
await d
  .insert(schema.trainingJobs)
  .values({
    id: id(5, 0),
    recipe: "glimmer-lora",
    title: "Receipt fields on Muse Glimmer",
    status: "succeeded",
    params: { dataset: id(4, 1), steps: 140 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 90,
    maxUsd: 3,
    instanceName: "fixture-receipts",
    summary: "Made-up run for the local preview.",
    costUsd: 1.39,
    createdBy: IDS.user,
    createdAt: ago(5900),
    launchedAt: ago(5895),
    firstHeartbeatAt: ago(5893),
    lastHeartbeatAt: ago(5851),
    finishedAt: ago(5850),
    terminatedAt: ago(5850),
    evalSummary: { items: 20, tunedWins: 13, baseWins: 4, ties: 3, avgBaseScore: 5.1, avgTunedScore: 7.4, judgeCostUsd: 0.18 },
  })
  .onConflictDoNothing();

await client.close();
console.log(`Seeded ${SEEDS.length} musings (${SEEDS.filter((s) => shipped(s.status)).length} in the gallery), 14 days of usage, 2 datasets and 1 tune.`);
