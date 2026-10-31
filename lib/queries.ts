import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import resources from "@/catalog/meta-resources.json";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { databaseUrl } from "@/lib/db/url";
import { env } from "@/lib/env";
import { newestPerRebuild, parseManifest } from "@/lib/format";
import type { Brief, BuildEvent, MuseLogLine, RebuildFit } from "@/lib/types";
import type {
  BuildSummary,
  BuildView,
  InspirationView,
  ProductCardView,
  ProductView,
  RebuildCardView,
  RebuildRef,
} from "@/components/view-types";

/**
 * Every read the platform pages make. Server only. Pages wrap calls in safeQuery so the site still renders (with a
 * "Not connected yet" card) before Neon is provisioned or while it is unreachable.
 */

export type QueryResult<T> =
  { ok: true; data: T } | { ok: false; reason: "not_configured" | "unreachable"; message: string };

/** A deployment with no database (DATABASE_URL unset, or a preview without its own: lib/db/url.ts) never runs `fn`. */
export async function safeQuery<T>(fn: () => Promise<T>): Promise<QueryResult<T>> {
  if (!databaseUrl()) {
    return { ok: false, reason: "not_configured", message: "The database isn't connected yet." };
  }
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    console.error("[queries] read failed:", err);
    return { ok: false, reason: "unreachable", message: "The database didn't answer." };
  }
}

/** The signed-in user, or null. Never throws, so a missing SESSION_SECRET can't take the shell down. */
export async function currentUser(): Promise<SessionUser | null> {
  try {
    return await getSessionUser();
  } catch (err) {
    unstable_rethrow(err);
    return null;
  }
}

/** The platform's public origin, for connector URLs. Prefers the configured or production URL. */
export async function platformOrigin(): Promise<string> {
  if (process.env.PLATFORM_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL) {
    return env.platformUrl;
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return env.platformUrl;
  const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

type BuildRow = typeof schema.builds.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;
type InspirationRow = typeof schema.inspirations.$inferSelect;

function toBuildView(b: BuildRow): BuildView {
  return {
    id: b.id,
    kind: b.kind,
    message: b.message,
    rebuildOf: b.rebuildOf,
    productId: b.productId,
    userId: b.userId,
    inspirationId: b.inspirationId,
    status: b.status,
    step: b.step,
    brief: b.brief ?? null,
    buildModel: b.buildModel,
    museSessionId: b.museSessionId,
    fixRounds: b.fixRounds,
    previewUrl: b.previewUrl,
    costUsd: num(b.costUsd),
    error: b.error,
    startedAt: b.startedAt.toISOString(),
    finishedAt: iso(b.finishedAt),
  };
}

function toProductView(p: ProductRow): ProductView {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    ownerId: p.ownerId,
    inspirationId: p.inspirationId,
    rebuildOf: p.rebuildOf,
    manifest: parseManifest(p.manifest),
    latestBuildId: p.latestBuildId,
    liveUrl: p.liveUrl,
    demoVideoUrl: p.demoVideoUrl,
    demoPosterUrl: p.demoPosterUrl,
    transcriptUrl: p.transcriptUrl,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toInspirationView(i: InspirationRow): InspirationView {
  return {
    id: i.id,
    note: i.note,
    references: Array.isArray(i.references) ? i.references : [],
    createdAt: i.createdAt.toISOString(),
  };
}

/** Catalog lookups for rebuilds. Covers both Meta's videos and the "doesn't have yet" demos. */
export function rebuildRef(id: string | null | undefined): RebuildRef | null {
  if (!id) return null;
  const video = resources.videos.find((v) => v.id === id);
  if (video) return { id, title: video.title, url: video.url, fit: video.rebuild.fit as RebuildFit };
  const missing = resources.missing.find((m) => m.id === id);
  if (missing) return { id, title: missing.note, url: resources.source, fit: null };
  return null;
}

// ---------- Build room ----------

export interface BuildRoomData {
  build: BuildView;
  inspiration: InspirationView | null;
  product: ProductView | null;
  events: BuildEvent[];
  history: BuildSummary[];
  tokens: { input: number; cached: number; output: number };
}

export async function getBuildRoom(buildId: string): Promise<BuildRoomData | null> {
  if (!isUuid(buildId)) return null;
  const d = db();
  const [b] = await d.select().from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  if (!b) return null;

  const [inspirationRows, productRows, eventRows, history, tokenRows] = await Promise.all([
    d.select().from(schema.inspirations).where(eq(schema.inspirations.id, b.inspirationId)).limit(1),
    b.productId
      ? d.select().from(schema.products).where(eq(schema.products.id, b.productId)).limit(1)
      : Promise.resolve([] as ProductRow[]),
    d
      .select()
      .from(schema.buildEvents)
      .where(eq(schema.buildEvents.buildId, b.id))
      .orderBy(asc(schema.buildEvents.id))
      .limit(5000),
    b.productId ? productBuilds(b.productId, 20) : Promise.resolve([] as BuildSummary[]),
    d
      .select({
        input: sql<number>`coalesce(sum(${schema.usage.inputTokens}), 0)::float8`,
        cached: sql<number>`coalesce(sum(${schema.usage.cachedInputTokens}), 0)::float8`,
        output: sql<number>`coalesce(sum(${schema.usage.outputTokens}), 0)::float8`,
      })
      .from(schema.usage)
      .where(eq(schema.usage.buildId, b.id)),
  ]);

  return {
    build: toBuildView(b),
    inspiration: inspirationRows[0] ? toInspirationView(inspirationRows[0]) : null,
    product: productRows[0] ? toProductView(productRows[0]) : null,
    events: eventRows.map((r) => ({ ...r.payload, id: r.id, at: r.at.toISOString() }) as BuildEvent),
    history,
    tokens: {
      input: num(tokenRows[0]?.input),
      cached: num(tokenRows[0]?.cached),
      output: num(tokenRows[0]?.output),
    },
  };
}

const summaryColumns = {
  id: schema.builds.id,
  kind: schema.builds.kind,
  status: schema.builds.status,
  startedAt: schema.builds.startedAt,
  finishedAt: schema.builds.finishedAt,
  costUsd: schema.builds.costUsd,
  fixRounds: schema.builds.fixRounds,
  message: schema.builds.message,
  rebuildOf: schema.builds.rebuildOf,
  briefName: sql<string | null>`${schema.builds.brief}->>'name'`,
  productName: schema.products.name,
  slug: schema.products.slug,
  note: schema.inspirations.note,
};

type SummaryRow = {
  id: string;
  kind: "build" | "refine";
  status: BuildView["status"];
  startedAt: Date;
  finishedAt: Date | null;
  costUsd: number;
  fixRounds: number;
  message: string | null;
  rebuildOf: string | null;
  briefName: string | null;
  productName: string | null;
  slug: string | null;
  note: string | null;
};

function toSummary(r: SummaryRow): BuildSummary {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    costUsd: num(r.costUsd),
    fixRounds: r.fixRounds,
    message: r.message,
    name: r.productName ?? r.briefName ?? null,
    slug: r.slug,
    note: r.note,
    rebuildOf: r.rebuildOf,
  };
}

async function productBuilds(productId: string, limit: number): Promise<BuildSummary[]> {
  const rows = await db()
    .select(summaryColumns)
    .from(schema.builds)
    .leftJoin(schema.products, eq(schema.builds.productId, schema.products.id))
    .leftJoin(schema.inspirations, eq(schema.builds.inspirationId, schema.inspirations.id))
    .where(eq(schema.builds.productId, productId))
    .orderBy(desc(schema.builds.startedAt))
    .limit(limit);
  return rows.map(toSummary);
}

// ---------- My builds ----------

export async function listUserBuilds(userId: string, limit = 100): Promise<BuildSummary[]> {
  const rows = await db()
    .select(summaryColumns)
    .from(schema.builds)
    .leftJoin(schema.products, eq(schema.builds.productId, schema.products.id))
    .leftJoin(schema.inspirations, eq(schema.builds.inspirationId, schema.inspirations.id))
    .where(eq(schema.builds.userId, userId))
    .orderBy(desc(schema.builds.startedAt))
    .limit(limit);
  return rows.map(toSummary);
}

// ---------- Gallery and home strip ----------

function briefModels(brief: BuildRow["brief"] | null | undefined): string[] {
  const caps = brief?.capabilities;
  return Array.isArray(caps) ? [...new Set(caps.map((c) => c.model))] : [];
}

/**
 * Each product's newest brief. Refinements have no brief of their own, so once one ships, the product's latest build
 * has none and the brief comes from the newest build that does.
 */
async function latestBriefs(productIds: string[]): Promise<Map<string, Brief>> {
  if (!productIds.length) return new Map();
  const rows = await db()
    .selectDistinctOn([schema.builds.productId], { productId: schema.builds.productId, brief: schema.builds.brief })
    .from(schema.builds)
    .where(and(inArray(schema.builds.productId, productIds), isNotNull(schema.builds.brief)))
    .orderBy(schema.builds.productId, desc(schema.builds.startedAt));
  return new Map(rows.flatMap((r) => (r.productId && r.brief ? [[r.productId, r.brief] as const] : [])));
}

export async function listShippedProducts(limit = 60): Promise<ProductCardView[]> {
  const rows = await db()
    .select({
      product: schema.products,
      startedAt: schema.builds.startedAt,
      finishedAt: schema.builds.finishedAt,
      costUsd: schema.builds.costUsd,
      fixRounds: schema.builds.fixRounds,
      brief: schema.builds.brief,
      note: schema.inspirations.note,
    })
    .from(schema.products)
    .leftJoin(schema.builds, eq(schema.products.latestBuildId, schema.builds.id))
    .leftJoin(schema.inspirations, eq(schema.products.inspirationId, schema.inspirations.id))
    .where(inArray(schema.products.status, ["live", "partial"]))
    .orderBy(desc(schema.products.updatedAt))
    .limit(limit);
  const briefs = await latestBriefs(rows.filter((r) => !r.brief).map((r) => r.product.id));

  const cards = rows.map((r) => {
    const p = r.product;
    const manifest = parseManifest(p.manifest);
    const brief = r.brief ?? briefs.get(p.id) ?? null;
    const models = manifest?.models.length ? manifest.models.map((m) => m.id) : briefModels(brief);
    return {
      slug: p.slug,
      name: p.name,
      tagline: p.tagline || manifest?.tagline || brief?.tagline || "",
      status: p.status,
      liveUrl: p.liveUrl,
      demoVideoUrl: p.demoVideoUrl,
      demoPosterUrl: p.demoPosterUrl,
      muse: manifest?.inspiration || r.note || brief?.inspiration.summary || null,
      models: [...new Set(models)],
      buildMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      costUsd: r.costUsd == null ? null : num(r.costUsd),
      fixRounds: r.fixRounds ?? null,
      rebuildOf: p.rebuildOf,
    };
  });
  return newestPerRebuild(cards);
}

// ---------- Product page ----------

export interface ProductPageData {
  product: ProductView;
  latestBuild: BuildView | null;
  /** The newest brief of the product, which is an earlier build's once a refinement has shipped. */
  brief: Brief | null;
  inspiration: InspirationView | null;
  history: BuildSummary[];
  events: BuildEvent[];
  /** What the product itself has driven through the gateway. */
  runs: { calls: number; tokens: number; costUsd: number };
}

export async function getProductPage(slug: string): Promise<ProductPageData | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const d = db();
  const [p] = await d.select().from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!p) return null;

  const [latestRows, inspirationRows, history, runRows] = await Promise.all([
    p.latestBuildId
      ? d.select().from(schema.builds).where(eq(schema.builds.id, p.latestBuildId)).limit(1)
      : d
          .select()
          .from(schema.builds)
          .where(eq(schema.builds.productId, p.id))
          .orderBy(desc(schema.builds.startedAt))
          .limit(1),
    p.inspirationId
      ? d.select().from(schema.inspirations).where(eq(schema.inspirations.id, p.inspirationId)).limit(1)
      : Promise.resolve([] as InspirationRow[]),
    productBuilds(p.id, 20),
    d
      .select({
        calls: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${schema.usage.inputTokens} + ${schema.usage.outputTokens}), 0)::float8`,
        cost: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)::float8`,
      })
      .from(schema.usage)
      .where(and(eq(schema.usage.productId, p.id), eq(schema.usage.source, "gateway"))),
  ]);

  const latest = latestRows[0] ?? null;
  const [eventRows, briefs] = await Promise.all([
    latest
      ? d
          .select()
          .from(schema.buildEvents)
          .where(eq(schema.buildEvents.buildId, latest.id))
          .orderBy(asc(schema.buildEvents.id))
          .limit(5000)
      : [],
    latest?.brief ? new Map<string, Brief>() : latestBriefs([p.id]),
  ]);

  return {
    product: toProductView(p),
    latestBuild: latest ? toBuildView(latest) : null,
    brief: latest?.brief ?? briefs.get(p.id) ?? null,
    inspiration: inspirationRows[0] ? toInspirationView(inspirationRows[0]) : null,
    history,
    events: eventRows.map((r) => ({ ...r.payload, id: r.id, at: r.at.toISOString() }) as BuildEvent),
    runs: { calls: num(runRows[0]?.calls), tokens: num(runRows[0]?.tokens), costUsd: num(runRows[0]?.cost) },
  };
}

/**
 * Log lines for the build room only, kept off the public product page: the agent's own build_note lines (its words,
 * which must not sit beside the platform's checks) and how a round runs. Other lines that start with "Muse Code", such
 * as "Muse Code was stopped after 25 minutes.", stay.
 */
const ROOM_ONLY_LOG = /^(Muse Code: |Muse Code runs this round |The session bridge )/;

/** Short facts about how a build went, for the product page's "How it was built". */
export function buildHighlights(events: BuildEvent[], build: BuildView | null): string[] {
  const out: string[] = [];
  let tools = 0;
  let edits = 0;
  let files = 0;
  let added = 0;
  let removed = 0;
  let rounds = 0;
  let checks = 0;
  let lastJudge: { pass: boolean; reasons: string[] } | null = null;
  let lastVerifyPassed: boolean | null = null;
  const notes: string[] = [];
  const seenRounds = new Set<number>();
  // A session bridge line comes again under its item id whenever it changes, as a tool call that runs across polls
  // does. Each item counts once, as its last version, the way the build room shows it.
  const items = new Map<string, MuseLogLine>();
  const count = (l: MuseLogLine) => {
    if (l.kind === "tool") tools++;
    if (l.kind === "edit") {
      edits++;
      files += l.files ?? 0;
      added += l.added ?? 0;
      removed += l.removed ?? 0;
    }
  };

  for (const e of events) {
    if (e.type === "muse") {
      seenRounds.add(e.round);
      for (const l of e.lines as MuseLogLine[]) {
        if (l.itemId === undefined) count(l);
        else items.set(`${e.round}:${l.itemId}`, l);
      }
    } else if (e.type === "verify") {
      checks++;
      lastVerifyPassed = e.summary.passed;
    } else if (e.type === "judge") {
      lastJudge = e.verdict;
    } else if (e.type === "log" && e.text.trim() && !ROOM_ONLY_LOG.test(e.text.trim())) {
      notes.push(e.text.trim());
    }
  }
  for (const l of items.values()) count(l);
  rounds = Math.max(0, seenRounds.size - 1);

  if (tools || edits) {
    out.push(
      `Muse Code made ${plural(tools, "tool call")} and ${plural(edits, "edit")} across ${plural(files, "file")} (+${added} −${removed}).`,
    );
  }
  if (checks) {
    const fixText = rounds ? ` after ${plural(rounds, "fix round")}` : " on the first try";
    out.push(
      lastVerifyPassed
        ? `npm run verify passed${fixText}.`
        : `npm run verify did not fully pass after ${plural(checks, "try", "tries")}.`,
    );
  }
  if (lastJudge) {
    const reason = lastJudge.reasons[0];
    out.push(`Screenshot judge: ${lastJudge.pass ? "pass" : "fail"}${reason ? `. ${reason}` : "."}`);
  }
  if (build?.finishedAt) {
    const ms = Date.parse(build.finishedAt) - Date.parse(build.startedAt);
    out.push(`Built in ${shortMs(ms)} for about $${build.costUsd.toFixed(2)} in model calls (est.).`);
  }
  return [...out, ...notes.slice(-4)];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

// ---------- Rebuilds ----------

export interface RebuildsData {
  videos: RebuildCardView[];
  missing: Array<RebuildCardView & { model: string; why: string; note: string }>;
  totals: { rebuilt: number; of: number; totalMs: number; totalCostUsd: number; firstDemos: number };
}

export async function listRebuilds(): Promise<RebuildsData> {
  const d = db();
  const [buildRows, productRows] = await Promise.all([
    d
      .select({
        id: schema.builds.id,
        rebuildOf: schema.builds.rebuildOf,
        status: schema.builds.status,
        startedAt: schema.builds.startedAt,
        finishedAt: schema.builds.finishedAt,
        costUsd: schema.builds.costUsd,
      })
      .from(schema.builds)
      .where(isNotNull(schema.builds.rebuildOf))
      .orderBy(desc(schema.builds.startedAt))
      .limit(1000),
    d
      .select({
        slug: schema.products.slug,
        name: schema.products.name,
        status: schema.products.status,
        liveUrl: schema.products.liveUrl,
        demoVideoUrl: schema.products.demoVideoUrl,
        demoPosterUrl: schema.products.demoPosterUrl,
        rebuildOf: schema.products.rebuildOf,
        updatedAt: schema.products.updatedAt,
      })
      .from(schema.products)
      .where(isNotNull(schema.products.rebuildOf))
      .orderBy(desc(schema.products.updatedAt)),
  ]);
  return joinRebuilds(buildRows, productRows);
}

type RebuildBuildRow = {
  id: string;
  rebuildOf: string | null;
  status: BuildView["status"];
  startedAt: Date;
  finishedAt: Date | null;
  costUsd: number;
};
type RebuildProductRow = {
  slug: string;
  name: string;
  status: ProductView["status"];
  liveUrl: string | null;
  demoVideoUrl: string | null;
  demoPosterUrl: string | null;
  rebuildOf: string | null;
};

const SHIPPED = new Set(["live", "partial"]);

/** Pure join of the catalog with build and product rows. Exported for tests. */
export function joinRebuilds(buildRows: RebuildBuildRow[], productRows: RebuildProductRow[]): RebuildsData {
  const card = (
    id: string,
    base: Omit<RebuildCardView, "latestBuild" | "product" | "attempts" | "totalMs" | "totalCostUsd">,
  ) => {
    const builds = buildRows.filter((b) => b.rebuildOf === id);
    const latest = builds[0] ?? null;
    const products = productRows.filter((p) => p.rebuildOf === id);
    const product = products.find((p) => SHIPPED.has(p.status)) ?? products[0] ?? null;
    return {
      ...base,
      latestBuild: latest
        ? {
            id: latest.id,
            status: latest.status,
            startedAt: latest.startedAt.toISOString(),
            finishedAt: iso(latest.finishedAt),
            costUsd: num(latest.costUsd),
          }
        : null,
      product: product
        ? {
            slug: product.slug,
            name: product.name,
            status: product.status,
            liveUrl: product.liveUrl,
            demoVideoUrl: product.demoVideoUrl,
            demoPosterUrl: product.demoPosterUrl,
          }
        : null,
      attempts: builds.length,
      totalMs: builds.reduce((s, b) => s + (b.finishedAt ? b.finishedAt.getTime() - b.startedAt.getTime() : 0), 0),
      totalCostUsd: builds.reduce((s, b) => s + num(b.costUsd), 0),
    } satisfies RebuildCardView;
  };

  const videos = resources.videos.map((v) =>
    card(v.id, {
      id: v.id,
      title: v.title,
      url: v.url,
      era: v.era,
      demonstrates: v.demonstrates,
      fit: v.rebuild.fit as RebuildFit,
      models: v.rebuild.models,
      plan: v.rebuild.plan,
    }),
  );
  const missing = resources.missing.map((m) => ({
    ...card(m.id, {
      id: m.id,
      title: m.note,
      url: resources.source,
      era: "New",
      demonstrates: m.why,
      fit: "clean" as RebuildFit,
      models: [m.model],
      plan: m.note,
    }),
    model: m.model,
    why: m.why,
    note: m.note,
  }));

  const isShipped = (c: RebuildCardView) => Boolean(c.product && SHIPPED.has(c.product.status));
  const all = [...videos, ...missing];
  return {
    videos,
    missing,
    totals: {
      rebuilt: videos.filter(isShipped).length,
      of: videos.length,
      firstDemos: missing.filter(isShipped).length,
      totalMs: all.reduce((s, c) => s + c.totalMs, 0),
      totalCostUsd: all.reduce((s, c) => s + c.totalCostUsd, 0),
    },
  };
}

// ---------- Usage ----------

export type UsageView = "total" | "model";

export interface UsageFilters {
  productId: string | null;
  model: string | null;
  view: UsageView;
  rangeDays: 7 | 14 | 30 | 90;
  /** Last day shown, YYYY-MM-DD in UTC. */
  end: string;
}

export interface UsageSeries {
  key: string;
  label: string;
  values: number[];
}

export interface UsageData {
  days: string[];
  /** Per-day calls and tokens across every source and model, for the dashboard's cards. */
  perDay: { calls: number[]; input: number[]; output: number[] };
  tokens: UsageSeries[];
  spend: UsageSeries[];
  builds: UsageSeries[];
  totals: {
    tokens: number;
    productTokens: number;
    buildingTokens: number;
    /** The live docs demos (usage source "docs"), which run on the platform's key with no product. */
    docsTokens: number;
    input: number;
    cached: number;
    output: number;
    costUsd: number;
    calls: number;
    builds: number;
    shipped: number;
    failed: number;
    refused: number;
    inProgress: number;
  };
  products: Array<{
    productId: string | null;
    /** True for the row that sums the live docs demos, which have no product. */
    docs?: boolean;
    name: string | null;
    slug: string | null;
    status: string | null;
    tokens: number;
    calls: number;
    costUsd: number;
  }>;
  options: { products: Array<{ id: string; name: string }>; models: string[] };
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Reads /usage search params into safe filters. */
export function parseUsageFilters(sp: Record<string, string | string[] | undefined>): UsageFilters {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const product = one("product");
  const model = one("model");
  const range = Number(one("range"));
  const today = todayUtc();
  let end = one("end") ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || Number.isNaN(Date.parse(end)) || end > today) end = today;
  return {
    productId: product && isUuid(product) ? product : null,
    model: model && /^[a-z0-9.-]{1,60}$/.test(model) ? model : null,
    view: one("view") === "model" ? "model" : "total",
    rangeDays: range === 14 ? 14 : range === 30 ? 30 : range === 90 ? 90 : 7,
    end,
  };
}

export async function getUsage(f: UsageFilters): Promise<UsageData> {
  const d = db();
  const u = schema.usage;
  const b = schema.builds;
  const startDay = addDays(f.end, -(f.rangeDays - 1));
  const start = new Date(`${startDay}T00:00:00Z`);
  const endExclusive = new Date(`${addDays(f.end, 1)}T00:00:00Z`);
  const days = Array.from({ length: f.rangeDays }, (_, i) => addDays(startDay, i));
  const dayIndex = new Map(days.map((day, i) => [day, i]));

  const usageWhere = and(
    gte(u.at, start),
    lt(u.at, endExclusive),
    f.productId ? eq(u.productId, f.productId) : undefined,
    f.model ? eq(u.model, f.model) : undefined,
  );
  const usageDay = sql<string>`to_char(${u.at} at time zone 'UTC', 'YYYY-MM-DD')`;
  const buildDay = sql<string>`to_char(${b.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const [daily, perProduct, buildRows, productOptions, modelOptions] = await Promise.all([
    d
      .select({
        day: usageDay,
        source: u.source,
        model: u.model,
        input: sql<number>`coalesce(sum(${u.inputTokens}), 0)::float8`,
        cached: sql<number>`coalesce(sum(${u.cachedInputTokens}), 0)::float8`,
        output: sql<number>`coalesce(sum(${u.outputTokens}), 0)::float8`,
        cost: sql<number>`coalesce(sum(${u.costUsd}), 0)::float8`,
        calls: sql<number>`count(*)::int`,
      })
      .from(u)
      .where(usageWhere)
      .groupBy(usageDay, u.source, u.model),
    d
      .select({
        productId: u.productId,
        docs: sql<boolean>`(${u.source} = 'docs')`,
        name: schema.products.name,
        slug: schema.products.slug,
        status: schema.products.status,
        tokens: sql<number>`coalesce(sum(${u.inputTokens} + ${u.outputTokens}), 0)::float8`,
        calls: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${u.costUsd}), 0)::float8`,
      })
      .from(u)
      .leftJoin(schema.products, eq(u.productId, schema.products.id))
      .where(usageWhere)
      .groupBy(
        u.productId,
        sql`(${u.source} = 'docs')`,
        schema.products.name,
        schema.products.slug,
        schema.products.status,
      )
      .orderBy(desc(sql`coalesce(sum(${u.inputTokens} + ${u.outputTokens}), 0)`))
      .limit(100),
    d
      .select({ day: buildDay, status: b.status, count: sql<number>`count(*)::int` })
      .from(b)
      .where(
        and(
          gte(b.startedAt, start),
          lt(b.startedAt, endExclusive),
          f.productId ? eq(b.productId, f.productId) : undefined,
        ),
      )
      .groupBy(buildDay, b.status),
    d
      .select({ id: schema.products.id, name: schema.products.name })
      .from(schema.products)
      .orderBy(asc(schema.products.name))
      .limit(200),
    d.selectDistinct({ model: u.model }).from(u).where(isNotNull(u.model)).limit(50),
  ]);

  const zero = () => days.map(() => 0);
  const perDay = { calls: zero(), input: zero(), output: zero() };
  const tokensBySource = { gateway: zero(), building: zero(), docs: zero() };
  const spendBySource = { gateway: zero(), building: zero(), docs: zero() };
  const tokensByModel = new Map<string, number[]>();
  const spendByModel = new Map<string, number[]>();
  const totals: UsageData["totals"] = {
    tokens: 0,
    productTokens: 0,
    buildingTokens: 0,
    docsTokens: 0,
    input: 0,
    cached: 0,
    output: 0,
    costUsd: 0,
    calls: 0,
    builds: 0,
    shipped: 0,
    failed: 0,
    refused: 0,
    inProgress: 0,
  };

  for (const r of daily) {
    const i = dayIndex.get(r.day);
    if (i === undefined) continue;
    const input = num(r.input);
    const output = num(r.output);
    const tokens = input + output;
    const cost = num(r.cost);
    const bucket = r.source === "gateway" ? "gateway" : r.source === "docs" ? "docs" : "building";
    perDay.calls[i] += num(r.calls);
    perDay.input[i] += input;
    perDay.output[i] += output;
    tokensBySource[bucket][i] += tokens;
    spendBySource[bucket][i] += cost;
    const model = r.model ?? "other";
    if (!tokensByModel.has(model)) tokensByModel.set(model, zero());
    if (!spendByModel.has(model)) spendByModel.set(model, zero());
    tokensByModel.get(model)![i] += tokens;
    spendByModel.get(model)![i] += cost;
    totals.tokens += tokens;
    totals[bucket === "gateway" ? "productTokens" : bucket === "docs" ? "docsTokens" : "buildingTokens"] += tokens;
    totals.input += input;
    totals.cached += num(r.cached);
    totals.output += output;
    totals.costUsd += cost;
    totals.calls += num(r.calls);
  }

  const shipped = zero();
  const failed = zero();
  for (const r of buildRows) {
    const i = dayIndex.get(r.day);
    if (i === undefined) continue;
    const n = num(r.count);
    totals.builds += n;
    if (r.status === "live" || r.status === "partial") {
      shipped[i] += n;
      totals.shipped += n;
    } else if (r.status === "failed") {
      failed[i] += n;
      totals.failed += n;
    } else if (r.status === "refused") {
      totals.refused += n;
    } else {
      totals.inProgress += n;
    }
  }

  const modelSeries = (m: Map<string, number[]>): UsageSeries[] =>
    [...m.entries()]
      .map(([key, values]) => ({ key, label: key, values }))
      .sort((a, b2) => sum(b2.values) - sum(a.values));

  const models = [...new Set(modelOptions.map((r) => r.model).filter((m): m is string => Boolean(m)))].sort();
  // The docs demos get their own series only when they ran in this range, so the chart is unchanged otherwise.
  const docsRan = sum(spendBySource.docs) > 0 || sum(tokensBySource.docs) > 0;
  const bySource = (m: { gateway: number[]; building: number[]; docs: number[] }): UsageSeries[] => [
    { key: "gateway", label: "Products", values: m.gateway },
    { key: "building", label: "Building", values: m.building },
    ...(docsRan ? [{ key: "docs", label: "Docs demos", values: m.docs }] : []),
  ];

  return {
    days,
    perDay,
    tokens: f.view === "model" ? modelSeries(tokensByModel) : bySource(tokensBySource),
    spend: f.view === "model" ? modelSeries(spendByModel) : bySource(spendBySource),
    builds: [
      { key: "shipped", label: "Shipped", values: shipped },
      { key: "failed", label: "Failed", values: failed },
    ],
    totals,
    products: perProduct.map((r) => ({
      productId: r.productId,
      docs: r.docs === true || undefined,
      name: r.name,
      slug: r.slug,
      status: r.status,
      tokens: num(r.tokens),
      calls: num(r.calls),
      costUsd: num(r.cost),
    })),
    options: { products: productOptions, models },
  };
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/**
 * Calls per model in the usage records since `since`, for /models. One grouped count, bounded on the indexed `at`
 * column, so it stays cheap as the usage records grow. Rows with no model (tool calls) are left out.
 */
export async function modelCallCounts(since: Date): Promise<Record<string, number>> {
  const u = schema.usage;
  const rows = await db()
    .select({ model: u.model, calls: sql<number>`count(*)::int` })
    .from(u)
    .where(and(gte(u.at, since), isNotNull(u.model)))
    .groupBy(u.model)
    .limit(100);
  return Object.fromEntries(rows.flatMap((r) => (r.model ? [[r.model, num(r.calls)] as const] : [])));
}
