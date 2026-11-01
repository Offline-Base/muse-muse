import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Brief, TargetId } from "@/lib/brief/schema";
import type { DataScope } from "@/lib/caps/data/types";
import type { CapDrop } from "@/lib/caps/ready";
import type { DecisionRows, DecisionSpec } from "@/lib/decide/types";
import type { DocsHoldState } from "@/lib/docs/proxy/types";
import type { RoundPlanRecord } from "@/lib/engine/milestones";
import type { DriveActor, DriveAddress, DriveBuild, DriveFile, DriveModel, DrivePayment, DriveStatus, VerifyResult } from "@/lib/drive/types";
import type {
  NativeArtifactKind,
  NativeBudgetLane,
  NativeCheck,
  NativeJobInput,
  NativeJobKind,
  NativeJobResult,
  NativeJobStatus,
  NativeLabState,
  NativeLane,
  NativePlan,
  NativeRunStatus,
  NativeRunSummary,
  NativeSelftestReport,
  NativeSpendKind,
} from "@/lib/native/types";
import type { ToolFixtures, ToolPrincipal } from "@/lib/tools/ids";
import type { BuildEventBody, BuildStatus, Manifest, NativeOrigin, ProductClip, ProductStatus, Reference } from "@/lib/types";
import type {
  DatasetKind,
  DatasetStatus,
  EvalExample,
  EvalSummary,
  HubState,
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
  /** 0018_trust: when they said they're 18 or older (TRUST_AGE_GATE), or null. */
  adultConfirmedAt: timestamp("adult_confirmed_at", { withTimezone: true }),
  /** 0018_trust: the TERMS_VERSION (lib/trust/terms.ts) they accepted, or null. */
  termsVersion: text("terms_version"),
  /** 0018_trust: when they accepted terms_version. */
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  /** 0018_trust: set by an admin's ban (TRUST_REPORTS). A banned builder can't sign in or build. */
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  banReason: text("ban_reason"),
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
    /** Clips of it on a real device that its owner uploaded, shown under the demo. */
    extraClips: jsonb("extra_clips").$type<ProductClip[]>().notNull().default([]),
    status: text("status").$type<ProductStatus>().notNull().default("building"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * 0018_trust: set by an admin's takedown (TRUST_REPORTS): its page and gallery card are hidden and its live tokens
     * are revoked at this exact time, so undoing the takedown can give back just those. Null for every other product.
     */
    takenDownAt: timestamp("taken_down_at", { withTimezone: true }),
    takedownReason: text("takedown_reason"),
    /** 0018_trust: the status the takedown replaced with "disabled", which undoing it puts back. Null when it isn't down. */
    statusBeforeTakedown: text("status_before_takedown").$type<ProductStatus>(),
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
    /**
     * The Muse Code round running now, numbered as its log and mailbox are (bridgePaths in lib/sandbox/bridge-protocol.ts),
     * or null between runs. The build steps write it only while steering is on (env.steeringEnabled), and the owner's
     * controls (POST /api/builds/{id}/control) send only while it is set.
     */
    museRound: integer("muse_round"),
    /** Set by the owner's Stop. The workflow ends the build after its next Muse Code poll (lib/pipeline/workflow.ts). */
    stopRequested: boolean("stop_requested").notNull().default(false),
    previewUrl: text("preview_url"),
    /** The targets the person picked before the brief, or null to let the writer choose (docs/NATIVE.md). */
    requestedTargets: jsonb("requested_targets").$type<TargetId[]>(),
    /** Canned tool outputs for this build's tests, by Composio slug (docs/AGENT_TOOLS.md). Null without the agent target. */
    toolFixtures: jsonb("tool_fixtures").$type<ToolFixtures>(),
    /** 0019_engine: the engine's round plan (docs/CAPABILITIES.md, section 8), or null for a build on today's caps. */
    roundPlan: jsonb("round_plan").$type<RoundPlanRecord>(),
    /** 0019_engine: what the live check found after deploy (ENGINE_LIVE_SMOKE), or null when it didn't run. */
    liveCheck: jsonb("live_check").$type<{ ok: boolean; at: string; reason?: string; url: string }>(),
    /**
     * 0020_data: the caps this build's brief has blocks for but goes without, decided once at provision
     * (capsForBuild in lib/caps/ready.ts): switched off, or not in the builder snapshot. Every later step reads its
     * working copy of the brief through it, so a flag or snapshot change mid-build can't split the build. Null until
     * provision, and for builds from before it, whose steps decide again.
     */
    capsDropped: jsonb("caps_dropped").$type<CapDrop[]>(),
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
    /**
     * 0019_engine: the build a build token belongs to, so its caps rows and files live in the build namespace
     * b:<buildId> (docs/CAPABILITIES.md, 2.3). Null for live tokens and for build tokens of briefs with no caps.
     */
    buildId: uuid("build_id").references(() => builds.id),
  },
  (t) => [index("gateway_tokens_product_idx").on(t.productId), index("gateway_tokens_build_idx").on(t.buildId)],
);

/**
 * One row per Meta Model API call, from any source: the gateway (products and their tests), Muse Code runs, the
 * platform's own brief and judge calls, and the live docs demos ("docs", lib/docs/proxy). "Meta tokens driven" is the
 * sum of input and output tokens here. "tools" rows are the tool gateway's calls to Composio, with its slug as `model`.
 */
export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 0022_connect (unit 5) adds "fetch", "vault" and "sends" to the type only: the column is text, so no SQL changes.
    // Wave 3, unit 9: "exec" and "browse" are the code cap's sandboxes. A type change only, no migration.
    source: text("source").$type<"gateway" | "muse_code" | "platform" | "docs" | "tools" | "fetch" | "vault" | "sends" | "exec" | "browse">().notNull(),
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
    /** What a call counts in besides tokens: Meta web searches, or 1 for a tool call. A row with units is kept at $0. */
    units: integer("units").notNull().default(0),
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

/**
 * Fixed-window counters for the gateway's per-IP rate limit, in-flight slots and the docs proxy's per-IP limits. Old
 * windows are deleted by the cleanup cron. The docs proxy's per-day rows (lib/docs/proxy/limits.ts) are stored at the
 * end of their UTC day, so that hourly prune keeps them until the day is over.
 */
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
 * Files and stored responses that docs visitors created through the docs proxy (lib/docs/proxy), so a visitor can read,
 * delete or cancel only their own. `id` is Meta's (file-..., resp_...). `visitor` is the SHA-256 of the visitor's random
 * mm_docs cookie, never the cookie itself. The hourly cleanup deletes files after an hour and responses after a day,
 * upstream and here (lib/docs/proxy/cleanup.ts). `hold` is a background response's spend, still held at its worst
 * case until Meta reports what it used (lib/docs/proxy/background.ts); null once settled, and for everything else.
 */
export const docsObjects = pgTable(
  "docs_objects",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"file" | "response">().notNull(),
    visitor: text("visitor").notNull(),
    hold: jsonb("hold").$type<DocsHoldState>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("docs_objects_visitor_idx").on(t.visitor, t.kind),
    index("docs_objects_kind_created_idx").on(t.kind, t.createdAt),
  ],
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
    /** The judge's verdict on the job's eval items, written after the instance is terminated (lib/train/judge.ts). */
    evalSummary: jsonb("eval_summary").$type<EvalSummary>(),
    /**
     * A glimmer-serve job's demo server: the instance's IP (from Lambda), the port and the pinned certificate fingerprint
     * (from its "serving" callback), and when it started. The live demo proxy connects only here. Never sent to a browser.
     */
    serveEndpoint: jsonb("serve_endpoint").$type<ServeEndpoint>(),
    /**
     * A glimmer-lora job's Hugging Face state (lib/train/hub-steps.ts, docs/TRAINING.md "Hugging Face Hub"): where
     * publishing stands, the repos, the adapter's file manifest and small files, the oids the Hub has, the commits, the
     * admin's why and the story. Never the HF token or an upload URL. The admin page gets HubView, the public pages only
     * the links.
     */
    hub: jsonb("hub").$type<HubState>(),
    /**
     * The model that judged the job's eval items (JUDGE_MODEL in lib/train/judge.ts), saved when judging starts. Null
     * means Muse Spark 1.3, the model before Oct 29, 2026, for a job judged before the judge was recorded, or no judge
     * yet for a job that isn't judged (judgeModelOf in lib/train/models.ts).
     */
    judgeModel: text("judge_model"),
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
 * Training data a Muse model (writer_model) writes from a task description (lib/train/datasets.ts): prompts, then
 * answers, with 10% held out for eval. While it is "generating", answered examples are appended to `train`; the eval
 * items are moved out when it turns "ready". A GPU job reads it in pages with its job token (GET
 * /api/train/jobs/{id}/dataset).
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
    /**
     * The model that wrote the prompts and the answers (DATASET_MODEL in lib/train/datasets.ts), saved when the dataset
     * is created. Null means Muse Spark 1.3, the model before Oct 29, 2026, which wrote every dataset made before the
     * writer was recorded (writerModelOf in lib/train/models.ts). "person" for a decision dataset a person uploaded,
     * "public" for Muse Decide's public mix (PERSON_WRITER and PUBLIC_WRITER there).
     */
    writerModel: text("writer_model"),
    // ---------- 0017_decision_datasets (decision models) ----------
    /**
     * "chat" (written by a Muse model, rows in train and eval) or "decision" (docs/DECISION_MODELS.md: a person's
     * labeled rows, in decision and decision_rows, with train and eval left empty so no reader of chat datasets
     * changes). Migration 0017.
     */
    kind: text("kind").$type<DatasetKind>().notNull().default("chat"),
    /** A decision dataset's definition: its question, labels, seed and split counts. Null for chat datasets. */
    decision: jsonb("decision").$type<DecisionSpec>(),
    /**
     * A decision dataset's rows, split once when it is saved: the test split held out first, never trained on. Each
     * split is grouped by label in the labels' order (lib/train/decision-datasets.ts). {} for chat datasets.
     */
    decisionRows: jsonb("decision_rows").$type<DecisionRows | Record<string, never>>().notNull().default({}),
  },
  (t) => [index("training_datasets_created_idx").on(t.createdAt)],
);

/**
 * Flash drive order requests (docs/VIBE_TUNING.md, Feature 6; lib/drive). The site takes no payment: the owner emails an
 * invoice and moves the order along at /fine-tuning/orders, and the bench script (scripts/drive-bench.ts) flashes and
 * checks the stick. The order link's secret is kept only as its HMAC, as gateway tokens are. The buyer's name, email and
 * address, with the tracking number and the notes, are cleared 60 days after delivery or cancellation, and the quota
 * keys after 30 days (lib/drive/store.ts purgeDriveOrders).
 */
export const driveOrders = pgTable(
  "drive_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").$type<DriveStatus>().notNull().default("requested"),
    /** hashToken of the order link's secret (32 random bytes). The secret itself is never stored. */
    secretHash: text("secret_hash").notNull().unique(),
    /** What goes on the drive, as localFilesFor answered when the request came in. */
    trainingJobId: uuid("training_job_id")
      .notNull()
      .references(() => trainingJobs.id),
    build: text("build").$type<DriveBuild>().notNull(),
    ggufRepo: text("gguf_repo").notNull(),
    ggufCommit: text("gguf_commit").notNull(),
    files: jsonb("files").$type<DriveFile[]>().notNull(),
    model: jsonb("model").$type<DriveModel>().notNull(),
    imageVersion: text("image_version").notNull(),
    /** The buyer. Null once purged. */
    name: text("name"),
    email: text("email"),
    address: jsonb("address").$type<DriveAddress>(),
    /** How the buyer pays: "invoice" (the owner emails one) or "card" (Stripe Checkout when the order is placed). */
    payment: text("payment").$type<DrivePayment>().notNull().default("invoice"),
    /** A card order's latest Stripe Checkout Session, reused while it is still open. */
    checkoutSessionId: text("checkout_session_id"),
    /** The Stripe refund of a card order cancelled after it was paid. */
    refundRef: text("refund_ref"),
    /**
     * The owner's: the invoice they emailed, the amount as they wrote it, and a note. A card order keeps its Stripe
     * payment's id (pi_...) and the amount Stripe charged here instead.
     */
    invoiceRef: text("invoice_ref"),
    amountText: text("amount_text"),
    note: text("note"),
    /** Consent: the terms the buyer accepted, and their 18+ box. */
    termsVersion: text("terms_version").notNull(),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }).notNull(),
    ageOkAt: timestamp("age_ok_at", { withTimezone: true }).notNull(),
    /** HMACs with GATEWAY_TOKEN_PEPPER of the client IP and of a random cookie id, for the quotas. Never the raw IP. */
    clientKey: text("client_key"),
    browserKey: text("browser_key"),
    /** The bench: the stick's serial, its check after a replug, and the sha256 of the SHA256SUMS it wrote. */
    serial: text("serial"),
    verifyResult: text("verify_result").$type<VerifyResult>(),
    manifestSha256: text("manifest_sha256"),
    carrier: text("carrier"),
    tracking: text("tracking"),
    cancelledBy: text("cancelled_by").$type<DriveActor>(),
    createdAt: createdAt(),
    invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    flashingAt: timestamp("flashing_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("drive_orders_created_idx").on(t.createdAt),
    index("drive_orders_status_idx").on(t.status),
    index("drive_orders_client_idx").on(t.clientKey, t.createdAt),
    index("drive_orders_browser_idx").on(t.browserKey, t.createdAt),
  ],
);

/**
 * A product's Composio sessions, cached so a call doesn't make one each time, and updated when the config's hash changes
 * (docs/AGENT_TOOLS.md). composio_user_id is an HMAC of kind, product and subject, so no id is shared across products.
 */
export const toolSessions = pgTable(
  "tool_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    composioUserId: text("composio_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    configHash: text("config_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tool_sessions_user_idx").on(t.productId, t.composioUserId)],
);

/**
 * Accounts a principal connected for a product's personal tools. Only Composio's id for the account is stored, never a
 * credential. Disconnecting sets revoked_at, so at most one row per toolkit is active.
 */
export const toolConnections = pgTable(
  "tool_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    principal: text("principal").$type<ToolPrincipal>().notNull(),
    composioUserId: text("composio_user_id").notNull(),
    toolkit: text("toolkit").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tool_connections_active_idx").on(t.productId, t.composioUserId, t.toolkit).where(sql`${t.revokedAt} is null`),
    index("tool_connections_product_idx").on(t.productId),
  ],
);

/**
 * One run of the native lane for a product: package it, check it, keep the results (docs/NATIVE.md). Its `native` events
 * go to `build_id`'s log. Shipping and a refinement's re-check start at most one run per build; the agent and the owner
 * may start more.
 */
export const nativeRuns = pgTable(
  "native_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    buildId: uuid("build_id")
      .notNull()
      .references(() => builds.id),
    origin: text("origin").$type<NativeOrigin>().notNull(),
    targets: jsonb("targets").$type<TargetId[]>().notNull(),
    status: text("status").$type<NativeRunStatus>().notNull().default("planned"),
    plan: jsonb("plan").$type<NativePlan>(),
    summary: jsonb("summary").$type<NativeRunSummary>(),
    costUsd: real("cost_usd").notNull().default(0),
    workflowRunId: text("workflow_run_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("native_runs_once_idx").on(t.buildId, t.origin).where(sql`${t.origin} in ('ship', 'refine')`),
    index("native_runs_product_idx").on(t.productId, t.createdAt),
  ],
);

/**
 * The lab's queue. A box claims the next job for its lane with FOR UPDATE SKIP LOCKED (docs/NATIVE_LAB.md). token_hash
 * is the sha256 of the job's token, which exists in plain text only in the claim's reply.
 */
export const nativeJobs = pgTable(
  "native_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => nativeRuns.id),
    buildId: uuid("build_id")
      .notNull()
      .references(() => builds.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    lane: text("lane").$type<NativeLane>().notNull(),
    kind: text("kind").$type<NativeJobKind>().notNull(),
    priority: integer("priority").notNull().default(0),
    status: text("status").$type<NativeJobStatus>().notNull().default("queued"),
    input: jsonb("input").$type<NativeJobInput>().notNull(),
    result: jsonb("result").$type<NativeJobResult>(),
    selftest: jsonb("selftest").$type<NativeSelftestReport>(),
    tokenHash: text("token_hash"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    /** A job still queued after this is dropped: its preview may be gone. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("native_jobs_claim_idx").on(t.lane, t.status, t.priority, t.createdAt),
    index("native_jobs_run_idx").on(t.runId),
    index("native_jobs_build_idx").on(t.buildId),
  ],
);

/**
 * Files a native run made: downloads and what checks left behind. A newer package of the same kind sets superseded_at on
 * the old one. `check` is null for a package nobody has checked, which the product page says.
 */
export const nativeArtifacts = pgTable(
  "native_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => nativeRuns.id),
    /** The lab job that made it. Null for packages. */
    jobId: uuid("job_id").references(() => nativeJobs.id),
    kind: text("kind").$type<NativeArtifactKind>().notNull(),
    platform: text("platform"),
    device: text("device"),
    caption: text("caption"),
    url: text("url").notNull(),
    pathname: text("pathname").notNull(),
    bytes: integer("bytes").notNull().default(0),
    sha256: text("sha256"),
    shellVersion: text("shell_version"),
    check: text("check_result").$type<NativeCheck>(),
    createdAt: createdAt(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [index("native_artifacts_product_idx").on(t.productId, t.kind, t.supersededAt), index("native_artifacts_run_idx").on(t.runId)],
);

/** The append-only ledger behind native_budget: every reservation, commitment and release, in USD. */
export const nativeSpend = pgTable(
  "native_spend",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    lane: text("lane").$type<NativeBudgetLane>().notNull(),
    kind: text("kind").$type<NativeSpendKind>().notNull(),
    usd: real("usd").notNull(),
    /** What it was for: a Device Farm run's ARN, a Windows start. A release names what it releases. */
    ref: text("ref"),
    runId: uuid("run_id").references(() => nativeRuns.id),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("native_spend_lane_idx").on(t.lane, t.at), index("native_spend_run_idx").on(t.runId)],
);

/**
 * What each budget has reserved and committed, in cents. A reservation is one conditional UPDATE, as reserveUploadBytes
 * does it, so two runs can't both take the last of a cap. The caps themselves are in lib/env.ts.
 */
export const nativeBudget = pgTable("native_budget", {
  lane: text("lane").$type<NativeBudgetLane>().primaryKey(),
  reservedCents: integer("reserved_cents").notNull().default(0),
  committedCents: integer("committed_cents").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per lab box. token_hash is the sha256 of the lane's token, which only claims jobs. */
export const nativeLabs = pgTable("native_labs", {
  lane: text("lane").$type<NativeLane>().primaryKey(),
  tokenHash: text("token_hash").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  state: jsonb("state").$type<NativeLabState>(),
  version: text("version"),
  instanceId: text("instance_id"),
});

// ---------- Wave 3, 0018_trust (unit 1) ----------

/** Why someone reported a product (docs/CAPABILITIES.md, section 7). */
export const REPORT_REASONS = ["illegal", "harm", "privacy", "copyright", "impersonation", "broken", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = "open" | "closed" | "dismissed";

/**
 * Reports anyone can file from a product's Report link (TRUST_REPORTS). `reporter_key` is an HMAC of the reporter's IP
 * cut to 32 characters, for rate limits and spotting repeats. The IP itself is never stored or shown. `product_id` is
 * null when the slug matched no product.
 */
export const abuseReports = pgTable(
  "abuse_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").references(() => products.id),
    productSlug: text("product_slug").notNull(),
    reason: text("reason").$type<ReportReason>().notNull(),
    detail: text("detail").notNull().default(""),
    reporterKey: text("reporter_key").notNull(),
    status: text("status").$type<ReportStatus>().notNull().default("open"),
    handledBy: uuid("handled_by").references(() => users.id),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("abuse_reports_status_idx").on(t.status, t.createdAt)],
);

// ---------- Wave 3, 0020_data (unit 3) ----------

/**
 * Postgres bytea, read back as a Buffer whichever driver answered (Neon sends hex text, PGlite bytes). Written as bytes:
 * PGlite takes a Uint8Array for bytea, and Neon's driver sends a Buffer as hex text.
 */
const bytea = customType<{ data: Buffer; driverData: string | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) =>
    typeof value === "string" ? Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, value.startsWith("\\x") ? "hex" : "base64") : Buffer.from(value),
});

/**
 * People who signed in to a product through Muse Muse with a passkey (DATA_SIGN_IN, docs/CAPABILITIES.md, section 9).
 * No email and no password. A product never sees this id: it gets a subject made from it and its own id, so no two
 * products can tell they have the same person.
 */
export const endUsers = pgTable("end_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** What the person typed, up to 40 characters. Shown to the products they sign in to. */
  displayName: text("display_name"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A passkey's public half. `credential_id` is base64url. `public_key` is SPKI DER, ready for node:crypto. */
export const endUserPasskeys = pgTable(
  "end_user_passkeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => endUsers.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: bytea("public_key").notNull(),
    /** The authenticator's signature counter. A counter that goes back means a copied key, and the sign-in is refused. */
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: jsonb("transports").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("end_user_passkeys_user_idx").on(t.endUserId)],
);

/** Set on every write to product_rows, so live updates (unit 7) can stream a product's changes in order. */
export const productRowsSeq = pgSequence("product_rows_seq");

/**
 * What products save through {GATEWAY_URL}/data. `namespace` is `live`, or `b:<buildId>` for a build's test rows,
 * which are deleted when it ends. `owner_key` is the subject key of the visitor, owner or user the row belongs to
 * (mac("caps-subject", ...), cut to 32), never a raw id, and null for shared rows. A delete only sets `deleted_at`; the
 * hourly sweep removes the row an hour later.
 */
export const productRows = pgTable(
  "product_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    collection: text("collection").notNull(),
    scope: text("scope").$type<DataScope>().notNull(),
    ownerKey: text("owner_key"),
    docId: text("doc_id").notNull(),
    data: jsonb("data").notNull(),
    bytes: integer("bytes").notNull(),
    version: integer("version").notNull().default(1),
    seq: bigint("seq", { mode: "number" })
      .notNull()
      .default(sql`nextval('product_rows_seq')`),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // NULLS NOT DISTINCT: shared rows have no owner_key, and two of them must still clash on the same doc id.
    unique("product_rows_key").on(t.productId, t.namespace, t.collection, t.scope, t.ownerKey, t.docId).nullsNotDistinct(),
    index("product_rows_seq_idx").on(t.productId, t.namespace, t.seq),
    index("product_rows_owner_idx").on(t.productId, t.namespace, t.ownerKey),
  ],
);

/** Rows and bytes per product and namespace, changed in the same statement as each write, so quotas need no count. */
export const productDataCounts = pgTable(
  "product_data_counts",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    rows: integer("rows").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.namespace] })],
);

// ---------- Wave 3, 0022_connect (unit 5) ----------

/**
 * A product's key vault (CONNECT_VAULT, docs/CAPABILITIES.md, section 11): keys the product's owner brings for outside
 * services, sealed with AES-256-GCM (lib/secrets/box.ts, CONNECT_VAULT_KEY). Only the gateway opens one, to add it to a
 * brokered call; no route ever returns a value. `namespace` is `live`, or `b:<buildId>` for a build's made-up test keys,
 * deleted when it ends. `created_by` is a subject key, never a raw id. One active key per name: revoking sets
 * `revoked_at`, and the sweep removes revoked rows after a day.
 */
export const productSecrets = pgTable(
  "product_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default("live"),
    name: text("name").notNull(),
    service: text("service").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    tag: bytea("tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** sha256 of the value, first 16 hex characters, for a build's test keys only: verify's leak scan looks for them. */
    testHash: text("test_hash"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("product_secrets_active_idx").on(t.productId, t.namespace, t.name).where(sql`${t.revokedAt} is null`)],
);

/**
 * Each confirmed send (CONNECT_SENDS): one row per send, after its approval is spent. `recipient_hash` is a MAC of the
 * sorted recipients, never an address. `status` is `sent`, `simulated` (a build's, which never leaves the gateway) or
 * `failed`. `approval_nonce` is unique, so one confirmation sends once.
 */
export const productSends = pgTable(
  "product_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default("live"),
    channel: text("channel").notNull(),
    recipientHash: text("recipient_hash").notNull(),
    recipients: integer("recipients").notNull().default(1),
    approvalNonce: text("approval_nonce").notNull().unique(),
    status: text("status").$type<"sent" | "simulated" | "failed">().notNull(),
    providerId: text("provider_id"),
    createdAt: createdAt(),
  },
  (t) => [index("product_sends_product_idx").on(t.productId, t.namespace, t.createdAt)],
);

/**
 * fetchPublic's cache: one row per normalized request to an allowlisted keyless API (lib/caps/connect/apis.json). Shared
 * by every product, since the request names no one and the answer is public. The sweep removes expired rows.
 */
export const publicFetchCache = pgTable(
  "public_fetch_cache",
  {
    key: text("key").primaryKey(),
    api: text("api").notNull(),
    status: integer("status").notNull(),
    contentType: text("content_type"),
    body: bytea("body").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("public_fetch_cache_expires_idx").on(t.expiresAt)],
);

// ---------- Wave 3, 0024_code (unit 9) ----------

/**
 * One row per run of {GATEWAY_URL}/exec or /browse (docs/CAPABILITIES.md, section 15), for the build's proof
 * (`/caps/proof`) and the owner's record of what ran. `namespace` is `live`, or `b:<buildId>` for a build's runs.
 * `subject_key` is the caller's subject key (mac("caps-subject", ...), cut to 32), never a raw id, and null for a build.
 * No code, input, output or address is kept. Money is in `usage` (sources `exec` and `browse`), as for every call.
 */
export const execRuns = pgTable(
  "exec_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    kind: text("kind").$type<"exec" | "browse">().notNull(),
    principal: text("principal").$type<"build" | "owner" | "user" | "visitor">().notNull(),
    subjectKey: text("subject_key"),
    language: text("language").$type<"python" | "node">(),
    status: text("status").$type<"ok" | "error" | "timeout" | "failed" | "simulated">().notNull(),
    ms: integer("ms").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("exec_runs_product_idx").on(t.productId, t.namespace, t.createdAt)],
);
