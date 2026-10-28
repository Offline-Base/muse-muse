import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Brief } from "@/lib/brief/schema";
import type { BuildEventBody, BuildStatus, Manifest, ProductStatus, Reference } from "@/lib/types";
import type {
  DatasetStatus,
  EvalExample,
  EvalSummary,
  RecipeId,
  ServeEndpoint,
  TrainArtifact,
  TrainEventBody,
  TrainExample,
  TrainProgress,
  TrainStatus,
} from "@/lib/train/types";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  isAdmin: boolean("is_admin").notNull().default(false),
  /** "scrypt$N$r$p$salt$hash". Null until the first sign-in, whose password claims the email. */
  passwordHash: text("password_hash"),
  dailyBuildQuota: integer("daily_build_quota").notNull().default(3),
  createdAt: createdAt(),
});

export const inspirations = pgTable(
  "inspirations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    note: text("note"),
    references: jsonb("references").$type<Reference[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("inspirations_user_idx").on(t.userId)],
);

/**
 * A product row is created as soon as the brief is approved (status "building"), so build-scoped gateway tokens and
 * usage can point at it. It becomes "live" or "partial" when the build ships, or "failed" when it doesn't.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    tagline: text("tagline").notNull().default(""),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    inspirationId: uuid("inspiration_id").references(() => inspirations.id),
    /** Catalog id from catalog/meta-resources.json when this product rebuilds one of Meta's demos. */
    rebuildOf: text("rebuild_of"),
    /** musemuse.json, set when a build passes. */
    manifest: jsonb("manifest").$type<Manifest>(),
    /** The build that produced the current live version. No FK, to avoid a cycle with builds.product_id. */
    latestBuildId: uuid("latest_build_id"),
    sandboxName: text("sandbox_name"),
    museSessionId: text("muse_session_id"),
    vercelProjectId: text("vercel_project_id"),
    liveUrl: text("live_url"),
    demoVideoUrl: text("demo_video_url"),
    /** A still from the demo for its <video> poster. Set with demoVideoUrl, so the two always match. */
    demoPosterUrl: text("demo_poster_url"),
    transcriptUrl: text("transcript_url"),
    status: text("status").$type<ProductStatus>().notNull().default("building"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("products_owner_idx").on(t.ownerId), index("products_rebuild_idx").on(t.rebuildOf)],
);

export const builds = pgTable(
  "builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inspirationId: uuid("inspiration_id").notNull().references(() => inspirations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** "build" makes a new product. "refine" resumes a shipped product's Muse Code session with a message. */
    kind: text("kind").$type<"build" | "refine">().notNull().default("build"),
    /** For refinements: the user's message. */
    message: text("message"),
    rebuildOf: text("rebuild_of"),
    productId: uuid("product_id").references(() => products.id),
    status: text("status").$type<BuildStatus>().notNull().default("queued"),
    /** The workflow step running now, for the build room's progress rail. */
    step: text("step"),
    brief: jsonb("brief").$type<Brief>(),
    buildModel: text("build_model"),
    sandboxName: text("sandbox_name"),
    museSessionId: text("muse_session_id"),
    workflowRunId: text("workflow_run_id"),
    fixRounds: integer("fix_rounds").notNull().default(0),
    previewUrl: text("preview_url"),
    /** Everything this build spent on Meta models: brief, Muse Code, judge, smoke tests. */
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("builds_inspiration_idx").on(t.inspirationId),
    index("builds_product_idx").on(t.productId),
    index("builds_user_started_idx").on(t.userId, t.startedAt),
    index("builds_rebuild_idx").on(t.rebuildOf),
  ],
);

/** Append-only log the build room streams. `id` is the SSE cursor (Last-Event-ID). */
export const buildEvents = pgTable(
  "build_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    buildId: uuid("build_id")
      .notNull()
      .references(() => builds.id),
    type: text("type").$type<BuildEventBody["type"]>().notNull(),
    payload: jsonb("payload").$type<BuildEventBody>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("build_events_build_id_idx").on(t.buildId, t.id)],
);

export const gatewayTokens = pgTable(
  "gateway_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    /** HMAC-SHA256 of the token with GATEWAY_TOKEN_PEPPER. The token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    scope: text("scope").$type<"build" | "live">().notNull(),
    allowedModels: jsonb("allowed_models").$type<string[]>().notNull(),
    dailyBudgetUsd: real("daily_budget_usd").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("gateway_tokens_product_idx").on(t.productId)],
);

/**
 * One row per Meta Model API call, from any source: the gateway (products and their tests), Muse Code runs, and the
 * platform's own brief and judge calls. "Meta tokens driven" is the sum of input and output tokens here.
 */
export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").$type<"gateway" | "muse_code" | "platform">().notNull(),
    productId: uuid("product_id").references(() => products.id),
    buildId: uuid("build_id").references(() => builds.id),
    tokenId: uuid("token_id").references(() => gatewayTokens.id),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    images: integer("images").notNull().default(0),
    videoFrames: integer("video_frames").notNull().default(0),
    audioSeconds: real("audio_seconds").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_product_at_idx").on(t.productId, t.at),
    index("usage_token_at_idx").on(t.tokenId, t.at),
    index("usage_build_idx").on(t.buildId),
    index("usage_at_idx").on(t.at),
  ],
);

/** Fixed-window counters for the gateway's per-IP rate limit. Old windows are deleted by the cleanup cron. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

/**
 * Fine-tuning jobs on the owner's Lambda Cloud account (docs/TRAINING.md). The instance reports back with a one-time
 * job token; only its HMAC is stored. Cost is the instance type's hourly price times the time from launch to
 * termination, the way Lambda bills.
 */
export const trainingJobs = pgTable(
  "training_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipe: text("recipe").$type<RecipeId>().notNull(),
    title: text("title").notNull(),
    status: text("status").$type<TrainStatus>().notNull().default("queued"),
    /** The recipe's parameters as the admin set them, after validation. */
    params: jsonb("params").$type<Record<string, string | number>>().notNull(),
    instanceType: text("instance_type").notNull(),
    region: text("region").notNull(),
    priceCentsPerHour: integer("price_cents_per_hour").notNull(),
    maxMinutes: integer("max_minutes").notNull(),
    maxUsd: real("max_usd").notNull(),
    /** Lambda's instance id once launched, and the name used to find it again on a retry. */
    instanceId: text("instance_id"),
    instanceName: text("instance_name").notNull(),
    instanceIp: text("instance_ip"),
    tokenHash: text("token_hash"),
    workflowRunId: text("workflow_run_id"),
    /** Set by Stop. The workflow terminates the instance on its next check. */
    stopRequested: boolean("stop_requested").notNull().default(false),
    progress: jsonb("progress").$type<TrainProgress>(),
    artifacts: jsonb("artifacts").$type<TrainArtifact[]>().notNull().default([]),
    summary: text("summary"),
    error: text("error"),
    costUsd: real("cost_usd").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
    firstHeartbeatAt: timestamp("first_heartbeat_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    /** Muse Spark 1.3's verdict on the job's eval items, written after the instance is terminated (lib/train/judge.ts). */
    evalSummary: jsonb("eval_summary").$type<EvalSummary>(),
    /**
     * A glimmer-serve job's demo server: the instance's IP (from Lambda), the port and the pinned certificate fingerprint
     * (from its "serving" callback), and when it started. The live demo proxy connects only here. Never sent to a browser.
     */
    serveEndpoint: jsonb("serve_endpoint").$type<ServeEndpoint>(),
  },
  (t) => [index("training_jobs_status_idx").on(t.status), index("training_jobs_created_idx").on(t.createdAt)],
);

/** Append-only log for a training job's page. */
export const trainingEvents = pgTable(
  "training_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => trainingJobs.id),
    type: text("type").$type<TrainEventBody["type"]>().notNull(),
    payload: jsonb("payload").$type<TrainEventBody>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("training_events_job_idx").on(t.jobId, t.id)],
);

/**
 * Training data Muse Spark 1.3 writes from a task description (lib/train/datasets.ts): prompts, then answers, with 10%
 * held out for eval. While it is "generating", answered examples are appended to `train`; the eval items are moved out
 * when it turns "ready". A GPU job reads it in pages with its job token (GET /api/train/jobs/{id}/dataset).
 */
export const trainingDatasets = pgTable(
  "training_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** What the tuned model should do, as the admin wrote it. */
    task: text("task").notNull(),
    status: text("status").$type<DatasetStatus>().notNull().default("generating"),
    /** How many examples the admin asked for, 20 to 1000. */
    requested: integer("requested").notNull(),
    train: jsonb("train").$type<TrainExample[]>().notNull().default([]),
    eval: jsonb("eval").$type<EvalExample[]>().notNull().default([]),
    trainCount: integer("train_count").notNull().default(0),
    evalCount: integer("eval_count").notNull().default(0),
    /** Everything Meta charged to write it. */
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    workflowRunId: text("workflow_run_id"),
  },
  (t) => [index("training_datasets_created_idx").on(t.createdAt)],
);
