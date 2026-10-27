import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  dailyBuildQuota: integer("daily_build_quota").notNull().default(3),
  createdAt: createdAt(),
});

export const inspirations = pgTable(
  "inspirations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    note: text("note"),
    references: jsonb("references")
      .$type<Array<{ url: string; kind: "image" | "video" | "audio" | "pdf"; fileName: string }>>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
  },
  (t) => [index("inspirations_user_idx").on(t.userId)],
);

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  manifest: jsonb("manifest").notNull(),
  vercelProjectId: text("vercel_project_id"),
  liveUrl: text("live_url"),
  demoVideoUrl: text("demo_video_url"),
  status: text("status", { enum: ["live", "partial", "disabled"] }).notNull(),
  createdAt: createdAt(),
});

export const builds = pgTable(
  "builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inspirationId: uuid("inspiration_id").notNull().references(() => inspirations.id),
    rebuildOf: text("rebuild_of"),
    productId: uuid("product_id").references(() => products.id),
    status: text("status").notNull(),
    brief: jsonb("brief"),
    sandboxName: text("sandbox_name"),
    museSessionId: text("muse_session_id"),
    fixRounds: integer("fix_rounds").notNull().default(0),
    previewUrl: text("preview_url"),
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("builds_inspiration_idx").on(t.inspirationId), index("builds_product_idx").on(t.productId)],
);

export const buildEvents = pgTable(
  "build_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    buildId: uuid("build_id").notNull().references(() => builds.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    at: createdAt(),
  },
  (t) => [index("build_events_build_seq_idx").on(t.buildId, t.seq)],
);

export const gatewayTokens = pgTable(
  "gateway_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id),
    tokenHash: text("token_hash").notNull().unique(),
    scope: text("scope", { enum: ["build", "live"] }).notNull(),
    allowedModels: jsonb("allowed_models").$type<string[]>().notNull(),
    dailyBudgetUsd: real("daily_budget_usd").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("gateway_tokens_product_idx").on(t.productId)],
);

export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id),
    tokenId: uuid("token_id").notNull().references(() => gatewayTokens.id),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    units: real("units").notNull(),
    unitType: text("unit_type").notNull(),
    costUsd: real("cost_usd").notNull(),
    at: createdAt(),
  },
  (t) => [index("usage_product_at_idx").on(t.productId, t.at)],
);
