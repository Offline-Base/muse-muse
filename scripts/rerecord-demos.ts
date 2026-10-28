/**
 * Re-records the demo videos of products that already shipped, with no Muse Code run, so they get Demo Studio's video
 * and poster (docs/DEMO_STUDIO.md).
 *
 *   npx tsx --env-file=.env.local scripts/rerecord-demos.ts                 every live or partial product
 *   npx tsx --env-file=.env.local scripts/rerecord-demos.ts <id|slug> ...   exactly these
 *     --dry-run          render in a throwaway copy of each product's sandbox and download the video, poster,
 *                        studio.json, timeline.json and recorder.log to <out>/<slug>/: no uploads, no product, build or
 *                        token changes, and the product's own sandbox is left as it is
 *     --out=DIR          where a dry run saves its videos (default /tmp/musemuse-rerecord)
 *     --concurrency=N    products at a time (default 2)
 *     --force            also re-record a product whose sandbox may hold a change that never shipped
 *
 * For each product it reopens the persistent sandbox with a fresh build token, minted the way a refinement mints one
 * and revoked at the end, puts this checkout's platform files (template/, PLATFORM_FILES) in it and remakes the
 * pristine copy, writes the studio spec with the product's live URL, runs the demo task and uploads demo.mp4 and
 * poster.jpg. Then it points the product, and the recording in its latest build's room, at the new video and
 * hibernates the sandbox. A build that starts in the sandbox meanwhile wins: the new video isn't saved and the sandbox
 * is left running for it. It installs nothing else, and later refinements in that sandbox keep the new platform files.
 *
 * The smoke test calls the product's models, so every run spends a little. A real run calls them through the gateway
 * with its build token. A dry run's copy (builder.ts forkForDryRun) can't reach the platform and calls Meta directly
 * with the platform's key, which the sandbox firewall adds, so its calls don't show in the gateway's usage and a test
 * that uploads through the gateway (files over 4.5 MB) fails there. It needs DATABASE_URL, the sandbox credentials,
 * MODEL_API_KEY, and for a real run Blob access and PLATFORM_URL set to the platform whose gateway the sandbox can
 * reach and whose database DATABASE_URL is.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { and, desc, eq, gt, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { modelLabel } from "@/lib/format";
import { buildTokenBudgetFor } from "@/lib/gateway/policy";
import { mintToken } from "@/lib/gateway/tokens";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { stepTimeoutMs } from "@/lib/pipeline/steps";
import {
  deleteDryRunCopy,
  finishDemo,
  forkForDryRun,
  hibernate,
  killCommand,
  pollTask,
  refreshPlatformFiles,
  reopenSandbox,
  startTask,
  writeDemoSpec,
  type DemoVideo,
} from "@/lib/sandbox/builder";
import { DEMO_OUT_DIR, DEMO_RECORDING_DIR, PLATFORM_FILES, PRODUCT_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";
import { TERMINAL_STATUSES } from "@/lib/types";

const POLL_MS = 5000;
/** The same as the refine path's build token (lib/pipeline/build-steps.ts). */
const BUILD_TOKEN_TTL_HOURS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Product = typeof schema.products.$inferSelect;

interface Row {
  slug: string;
  status: "done" | "dry run" | "skipped" | "failed";
  ms: number;
  /** The uploaded video's URL, or where a dry run saved it. */
  video: string | null;
  note: string;
}

function flag(name: string): string | null {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

const dryRun = flag("dry-run") !== null;
const outDir = flag("out") || "/tmp/musemuse-rerecord";
const force = flag("force") !== null;
const concurrency = Math.max(1, Math.floor(Number(flag("concurrency") || 2)) || 2);
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/** This checkout's platform files, the ones refreshPlatformFiles puts in each sandbox. */
function templatePlatformFiles(): Array<{ path: string; content: Buffer }> {
  const dir = path.join(process.cwd(), "template");
  return PLATFORM_FILES.map((f) => {
    try {
      return { path: f, content: readFileSync(path.join(dir, f)) };
    } catch {
      throw new Error(`template/${f} is missing. Run this from a checkout with Demo Studio in template/.`);
    }
  });
}

/** The products to re-record, plus a row for each argument that matched none. */
async function pickProducts(): Promise<{ products: Product[]; unknown: Row[] }> {
  if (!wanted.length) {
    const products = await db()
      .select()
      .from(schema.products)
      .where(inArray(schema.products.status, ["live", "partial"]))
      .orderBy(desc(schema.products.updatedAt));
    return { products, unknown: [] };
  }
  const ids = wanted.filter((w) => UUID.test(w));
  const slugs = wanted.filter((w) => !UUID.test(w));
  const products = await db()
    .select()
    .from(schema.products)
    .where(or(ids.length ? inArray(schema.products.id, ids) : undefined, slugs.length ? inArray(schema.products.slug, slugs) : undefined));
  const unknown = wanted
    .filter((w) => !products.some((p) => p.id === w || p.slug === w))
    .map((w): Row => ({ slug: w, status: "skipped", ms: 0, video: null, note: "no product has this id or slug" }));
  return { products, unknown };
}

/** The id of a build of this product that is still running, and so using its sandbox, or null. */
async function runningBuild(p: Product): Promise<string | null> {
  const running = await db()
    .select({ id: schema.builds.id })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, p.id), notInArray(schema.builds.status, [...TERMINAL_STATUSES])))
    .limit(1);
  return running[0]?.id ?? null;
}

/** Why a product can't be re-recorded now, or null when it can. */
async function skipReason(p: Product): Promise<string | null> {
  if (p.status !== "live" && p.status !== "partial") return `it is ${p.status}, not live or partial`;
  if (!p.sandboxName) return "it has no sandbox";
  if (!p.latestBuildId) return "it has no shipped build";
  const running = await runningBuild(p);
  if (running) return `build ${running} is still running in its sandbox`;
  if (force) return null;
  const [shipped] = await db()
    .select({ startedAt: schema.builds.startedAt })
    .from(schema.builds)
    .where(eq(schema.builds.id, p.latestBuildId))
    .limit(1);
  if (!shipped) return null;
  // A refinement that failed after the shipped build may have left its change in the sandbox, so its demo would show
  // something that isn't live.
  const [unshipped] = await db()
    .select({ id: schema.builds.id })
    .from(schema.builds)
    .where(
      and(
        eq(schema.builds.productId, p.id),
        eq(schema.builds.kind, "refine"),
        eq(schema.builds.status, "failed"),
        gt(schema.builds.startedAt, shipped.startedAt),
      ),
    )
    .limit(1);
  return unshipped ? `refinement ${unshipped.id} failed after the live build and may have left its change in the sandbox (--force records anyway)` : null;
}

/** The product's brief: its shipped build's, or else the newest build's that has one. */
async function briefFor(p: Product) {
  const rows = await db()
    .select({ id: schema.builds.id, brief: schema.builds.brief })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, p.id), isNotNull(schema.builds.brief)))
    .orderBy(desc(schema.builds.startedAt))
    .limit(20);
  return (rows.find((r) => r.id === p.latestBuildId) ?? rows[0])?.brief ?? null;
}

/** Whatever the product's newest live token allows, for products without a brief (the refine path's fallback). */
async function liveTokenModels(productId: string): Promise<string[]> {
  const [row] = await db()
    .select({ allowedModels: schema.gatewayTokens.allowedModels })
    .from(schema.gatewayTokens)
    .where(and(eq(schema.gatewayTokens.productId, productId), eq(schema.gatewayTokens.scope, "live")))
    .orderBy(desc(schema.gatewayTokens.createdAt))
    .limit(1);
  return row?.allowedModels ?? ["muse-spark-1.3"];
}

/** Runs the demo task to the end, or stops it at the record step's cap like the workflow does. */
async function runDemo(sandboxName: string): Promise<{ exitCode: number | null; outputTail: string }> {
  const capMs = stepTimeoutMs("record");
  const started = Date.now();
  const { cmdId } = await startTask(sandboxName, "demo");
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const poll = await pollTask(sandboxName, cmdId);
    if (poll.done) return poll;
    if (Date.now() - started > capMs) {
      await killCommand(sandboxName, cmdId);
      throw new Error(`the demo ran past its ${capMs / 60_000}-minute cap and was stopped`);
    }
  }
}

/**
 * Copies the dry run's video and poster out of the sandbox, with what explains them: Demo Studio's summary, the
 * recorder's timeline and its log, when they are there. Returns the video's local path.
 */
async function download(p: Product, sandboxName: string, demo: DemoVideo): Promise<string | null> {
  const dir = path.join(outDir, p.slug);
  mkdirSync(dir, { recursive: true });
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const inSandbox = (url: string | null) => (url ? url.replace(`sandbox://${sandboxName}`, "") : null);
  const recording = `${PRODUCT_DIR}/${DEMO_RECORDING_DIR}`;
  let saved: string | null = null;
  for (const [from, name] of [
    [inSandbox(demo.videoUrl), "demo.mp4"],
    [inSandbox(demo.posterUrl), "poster.jpg"],
    [`${DEMO_OUT_DIR}/studio.json`, "studio.json"],
    [`${recording}/timeline.json`, "timeline.json"],
    [`${recording}/recorder.log`, "recorder.log"],
  ] as const) {
    if (!from) continue;
    const buf = await sandbox.readFileToBuffer({ path: from }).catch(() => null);
    if (!buf) continue;
    writeFileSync(path.join(dir, name), buf);
    if (name === "demo.mp4") saved = path.join(dir, name);
  }
  return saved;
}

/**
 * Points the product and its latest build's recording at the new video. updatedAt stays as it is, so re-recording
 * doesn't reorder the gallery. The build room shows the recording event's video, so its payload is updated in place.
 */
async function save(p: Product, demo: DemoVideo): Promise<void> {
  await db()
    .update(schema.products)
    .set({ demoVideoUrl: demo.videoUrl, demoPosterUrl: demo.posterUrl })
    .where(eq(schema.products.id, p.id));
  if (!p.latestBuildId || !demo.videoUrl) return;
  await db()
    .update(schema.buildEvents)
    .set({ payload: { type: "recording", url: demo.videoUrl, posterUrl: demo.posterUrl } })
    .where(and(eq(schema.buildEvents.buildId, p.latestBuildId), eq(schema.buildEvents.type, "recording")));
}

async function rerecord(p: Product, files: Array<{ path: string; content: Buffer }>): Promise<Row> {
  const started = Date.now();
  const row = (status: Row["status"], video: string | null, note: string): Row => ({ slug: p.slug, status, ms: Date.now() - started, video, note });
  const why = await skipReason(p);
  if (why) return row("skipped", null, why);
  const log = (text: string) => console.log(`[${p.slug}] ${text} (${((Date.now() - started) / 1000).toFixed(0)} s)`);

  const brief = await briefFor(p);
  // A real run reopens the product's sandbox with a fresh build token, as a refinement does. A dry run works in a
  // throwaway copy that needs no token, so the product, its sandbox and the database stay as they are.
  const models = dryRun ? [] : brief ? allowedModelsFor(brief) : await liveTokenModels(p.id);
  const token = dryRun
    ? null
    : await mintToken({
        productId: p.id,
        scope: "build",
        allowedModels: models,
        dailyBudgetUsd: buildTokenBudgetFor(models),
        ttlHours: BUILD_TOKEN_TTL_HOURS,
      });
  let copy: string | null = null;
  try {
    if (token) {
      await reopenSandbox({ sandboxName: p.sandboxName!, productId: p.id, buildToken: token.token, gatewayUrl: env.gatewayUrl, newReferences: [] });
      log("reopened");
    } else {
      copy = (await forkForDryRun(p.sandboxName!)).sandboxName;
      log(`copied the sandbox to ${copy}`);
    }
    const sandboxName = copy ?? p.sandboxName!;
    const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
    const built = await sh(sandbox, `[ -s ${q(`${PRODUCT_DIR}/.next/BUILD_ID`)} ]`, { allowFail: true });
    if (built.exitCode !== 0) return row("failed", null, "the sandbox has no build (.next) to start; a refinement rebuilds it");
    await refreshPlatformFiles(sandboxName, files);
    const models = brief ? brief.capabilities.map((c) => c.model) : (p.manifest?.models ?? []).map((m) => m.id);
    await writeDemoSpec(sandboxName, { title: p.name, tagline: p.tagline, models: [...new Set(models)].map(modelLabel), url: p.liveUrl });
    log("platform files and studio spec in place, recording");

    const run = await runDemo(sandboxName);
    log(`demo task exited ${run.exitCode}`);
    const demo = await finishDemo({ sandboxName, buildId: p.latestBuildId!, title: p.name, subtitle: p.tagline, skipUpload: dryRun });
    if (!demo.videoUrl) {
      const tail = run.outputTail.trim().split("\n").slice(-3).join(" | ");
      return row("failed", null, `the demo run did not pass, so nothing changed${tail ? `: ${tail}` : ""}`);
    }
    if (dryRun) return row("dry run", await download(p, sandboxName, demo), demo.posterUrl ? "with poster" : "no poster");
    // A refinement that started in the sandbox while this ran may have changed what the video shows.
    const started = await runningBuild(p);
    if (started) return row("skipped", null, `build ${started} started in the sandbox during the re-record, so the new video was not saved`);
    await save(p, demo);
    return row("done", demo.videoUrl, demo.posterUrl ? "with poster" : "no poster");
  } finally {
    if (copy) await deleteDryRunCopy(copy).catch((err: unknown) => console.error(`[${p.slug}] delete the copy ${copy}: ${String(err)}`));
    if (token) {
      await db()
        .update(schema.gatewayTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.gatewayTokens.id, token.id))
        .catch((err: unknown) => console.error(`[${p.slug}] revoke the build token ${token.id}: ${String(err)}`));
      // Never stop a build that is using the sandbox now. When that can't be told, the sandbox times out by itself.
      const busy = await runningBuild(p).catch((err: unknown) => `unknown (${String(err)})`);
      if (busy) console.error(`[${p.slug}] left the sandbox running for build ${busy}`);
      else await hibernate(p.sandboxName!).catch((err: unknown) => console.error(`[${p.slug}] hibernate: ${String(err)}`));
    }
  }
}

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function printTable(rows: Row[]): void {
  const header = `${cell("Product", 32)}  ${cell("Status", 8)}  ${"Min".padStart(5)}  Video or reason`;
  console.log(`\n${header}\n${"-".repeat(header.length + 40)}`);
  for (const r of rows) {
    const what = r.video ? `${r.video}${r.note ? ` (${r.note})` : ""}` : r.note;
    console.log(`${cell(r.slug, 32)}  ${cell(r.status, 8)}  ${(r.ms / 60_000).toFixed(1).padStart(5)}  ${what}`);
  }
}

async function main(): Promise<void> {
  const files = templatePlatformFiles();
  const { products, unknown } = await pickProducts();
  console.log(
    `${dryRun ? "Dry run: " : ""}re-recording ${products.length} ${products.length === 1 ? "product" : "products"}, ${concurrency} at a time, ${dryRun ? "in copies of their sandboxes that call Meta directly" : `through ${env.gatewayUrl}`}`,
  );
  const rows: Row[] = [...unknown];
  const queue = [...products];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const product = p;
      const r = await rerecord(product, files).catch((err: unknown): Row => {
        const message = err instanceof Error ? err.message : String(err);
        return { slug: product.slug, status: "failed", ms: 0, video: null, note: message.split("\n")[0]!.slice(0, 300) };
      });
      console.log(`[${product.slug}] ${r.status}: ${r.video ?? r.note}`);
      rows.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, worker));

  const order = new Map([...unknown.map((r) => r.slug), ...products.map((p) => p.slug)].map((slug, i) => [slug, i]));
  rows.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
  printTable(rows);
  const count = (status: Row["status"]) => rows.filter((r) => r.status === status).length;
  console.log(`\n${count(dryRun ? "dry run" : "done")} re-recorded, ${count("skipped")} skipped, ${count("failed")} failed`);
  if (count("failed")) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
