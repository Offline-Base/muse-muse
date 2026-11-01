import { TARGETS, type TargetId } from "@/lib/brief/schema";
import { databaseChoice, isPreview, previewHasOwnDatabase } from "@/lib/db/url";
import { DRIVE_CARD_TERMS_VERSION, DRIVE_TERMS_DEFAULT_VERSION } from "@/lib/drive/terms";
import { parseNativeTargets } from "@/lib/native/targets";
import type { MuseEngine } from "@/lib/sandbox/bridge-protocol";
import { agentCapacity } from "@/lib/sandbox/agent-capacity";
import { type PlatformBypass, publicHost } from "@/lib/sandbox/policy";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * Server environment. Getters throw a clear error when a required value is missing, so a misconfigured deploy fails
 * at the call that needs the value instead of at import time.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

function number(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A dollar amount that may be 0: "0" turns off what it pays for (number() would read it as unset and use the
 * fallback). Unset, empty or not a number gives the fallback, so a typo can't switch spending off by accident.
 */
function dollars(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * A whole count that may be 0: "0" turns off what it counts (number() would read it as unset and use the fallback).
 * Unset, empty, negative or not a number gives the fallback; a fraction is rounded down.
 */
function wholeCount(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** True when a switch is "1", "true", "yes" or "on" (any case). Anything else is off. */
function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

/** A trimmed setting, or null when it is unset or empty. */
function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

/**
 * A preview with a database of its own (lib/db/url.ts, previewHasOwnDatabase) is its own platform: its origin is its
 * branch URL, else its deployment URL. Null on anything else, and on such a preview with neither URL.
 */
function previewOwnOrigin(): string | null {
  if (!previewHasOwnDatabase()) return null;
  const own = process.env.VERCEL_BRANCH_URL?.trim() || process.env.VERCEL_URL?.trim();
  return own ? `https://${own}`.replace(/\/$/, "") : null;
}

/** env.publishOffReason on a Vercel preview. It reads after "because" and inside "Publishing is off for this run (...)". */
export const PUBLISH_OFF_ON_PREVIEW = "it's a Vercel preview, and a product published here would deploy into production's Vercel projects";

/** Muse Wonder, Meta's strongest model, is every platform role's default (docs/DESIGN.md, Model routing). */
export const DEFAULT_PLATFORM_MODEL = "muse-wonder-1.0";

const warnedSpark = new Set<string>();

/**
 * TEST_MODEL: the cheap model for test and example builds. Only Spark 1.3 Contributor is accepted. Meta may train on that
 * tier, so it never applies on production, where real people's references and briefs go through. When it's set, the
 * brief, the build, the judge and a build's own product test calls all run on it. Live products aren't affected.
 */
export function testModel(): typeof SPARK_STANDIN | null {
  if (process.env.TEST_MODEL?.trim() !== SPARK_STANDIN) return null;
  return process.env.VERCEL_ENV === "production" ? null : SPARK_STANDIN;
}

/** A model id from the environment, or the fallback. Muse Spark 1.3 becomes Spark 1.3 Contributor, with one warning. */
function model(name: string, fallback: string): string {
  const test = testModel();
  if (test) return test;
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (value === RETIRED_SPARK) {
    if (!warnedSpark.has(name)) {
      warnedSpark.add(name);
      console.warn(`${name} names ${RETIRED_SPARK}, which this platform doesn't use, so ${SPARK_STANDIN} is used instead.`);
    }
    return SPARK_STANDIN;
  }
  return value;
}

export const env = {
  /** The platform's Meta key. Server only. Never sent to products or sandboxes (the firewall injects it). */
  get modelApiKey() {
    return required("MODEL_API_KEY");
  },
  /** Writes the brief, and checks refinement requests against the same policy (lib/brief/policy.ts). */
  get briefModel() {
    return model("BRIEF_MODEL", DEFAULT_PLATFORM_MODEL);
  },
  /** Judges the screenshots against the brief (lib/judge.ts). */
  get judgeModel() {
    return model("JUDGE_MODEL", DEFAULT_PLATFORM_MODEL);
  },
  /** Muse Code's model for simple and standard briefs. Fix rounds resume the build on its own model. */
  get buildModel() {
    return model("BUILD_MODEL", DEFAULT_PLATFORM_MODEL);
  },
  /** Muse Code's model for briefs marked complex. */
  get complexBuildModel() {
    return model("COMPLEX_BUILD_MODEL", DEFAULT_PLATFORM_MODEL);
  },
  /**
   * DATABASE_URL, or on a Vercel preview PREVIEW_DATABASE_URL (lib/db/url.ts). Throws when this deployment has no
   * database: DATABASE_URL unset, or a preview without a database of its own (it never falls back to production's).
   */
  get databaseUrl() {
    const choice = databaseChoice();
    if (choice.url === null) throw new Error(choice.message);
    return choice.url;
  },
  /**
   * Vercel's Protection Bypass for Automation secret (VERCEL_AUTOMATION_BYPASS_SECRET) and the one host it is for: this
   * preview's own, when the preview is its own platform (previewOwnOrigin). README.md, Preview database. The build
   * firewall adds it as the x-vercel-protection-bypass header to a sandbox's requests to that host only
   * (lib/sandbox/policy.ts), so sandboxes reach a protected preview's gateway without the secret ever entering the
   * sandbox. Null everywhere else: production, local runs, and a preview with no database of its own or with no URL of
   * its own, whose platformUrl is another site's.
   */
  get previewBypass(): PlatformBypass | null {
    const secret = isPreview() ? optional("VERCEL_AUTOMATION_BYPASS_SECRET") : null;
    const origin = secret ? previewOwnOrigin() : null;
    const host = origin ? publicHost(origin) : null;
    return secret && host ? { host, secret } : null;
  },
  /**
   * BLOB_READ_WRITE_TOKEN, or undefined. Blob stores connected the old way set this token. Stores connected the new way
   * set BLOB_STORE_ID instead and sign in with the deployment's OIDC token, so lib/storage.ts passes this as `token`
   * only when it is set, and otherwise lets @vercel/blob use OIDC with BLOB_STORE_ID. When both are set, this wins.
   */
  get blobReadWriteToken(): string | undefined {
    return process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
  },
  /** BLOB_STORE_ID, or undefined. Used with the OIDC token (VERCEL_OIDC_TOKEN or the request's) when there's no read-write token. */
  get blobStoreId(): string | undefined {
    return process.env.BLOB_STORE_ID?.trim() || undefined;
  },
  /** True when either Blob credential is set. Every "is there file storage" check asks this (lib/local-files.ts). */
  get blobConfigured(): boolean {
    return Boolean(env.blobReadWriteToken || env.blobStoreId);
  },
  /**
   * BLOB_READ_WRITE_TOKEN, required. Only for flows that sign client tokens with it locally (handleUpload,
   * generateClientTokenFromReadWriteToken): product uploads through the gateway and training uploads. Those have no
   * OIDC form, so a store connected with BLOB_STORE_ID only can't serve them.
   */
  get blobToken() {
    return required("BLOB_READ_WRITE_TOKEN");
  },
  /** Vercel REST API token for publishing products as their own projects. */
  get vercelToken() {
    return required("VERCEL_TOKEN");
  },
  /**
   * Why products aren't published to their own link here, or null when they are. A local run never publishes, even
   * with VERCEL_TOKEN set: the product would call this machine's gateway (GATEWAY_URL), which Vercel can't reach. A
   * Vercel preview never publishes either (README.md, Preview database): its products live in the preview's own
   * database, but a publish goes into the Vercel project musemuse-<slug> (or the one a row copied from production
   * names), which is production's live product, and would give it a token production's gateway doesn't know.
   */
  get publishOffReason(): string | null {
    if (isPreview()) return PUBLISH_OFF_ON_PREVIEW;
    if (!process.env.VERCEL_TOKEN) return "VERCEL_TOKEN isn't set";
    if (!publicHost(env.platformUrl)) return "it's a local run, and a published product couldn't reach this machine's gateway";
    return null;
  },
  get vercelTeamId() {
    return process.env.VERCEL_TEAM_ID || undefined;
  },
  get builderSnapshotId() {
    return process.env.BUILDER_SNAPSHOT_ID || undefined;
  },
  /**
   * Public origin of this platform, with no trailing slash. Products and build sandboxes reach the gateway here. A
   * preview with a database of its own (lib/db/url.ts, previewHasOwnDatabase) is its own platform, at its branch URL
   * or else its deployment URL: its builds and gateway tokens live only in that database, so production's gateway
   * would refuse them. Everything else, including a preview with no database, keeps the rule below.
   */
  get platformUrl() {
    const own = previewOwnOrigin();
    if (own) return own;
    const explicit = process.env.PLATFORM_URL;
    if (explicit && !explicit.includes("localhost")) return explicit.replace(/\/$/, "");
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (vercel) return `https://${vercel}`;
    return (explicit || "http://localhost:3000").replace(/\/$/, "");
  },
  /** What products set as GATEWAY_URL. lib/meta/client.ts in the template appends /v1. */
  get gatewayUrl() {
    return `${env.platformUrl}/api/gateway`;
  },
  get gatewayTokenPepper() {
    return required("GATEWAY_TOKEN_PEPPER");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  /** Shared code people type to sign in. Hand it to judges and testers. */
  get accessCode() {
    return required("PLATFORM_ACCESS_CODE");
  },
  /**
   * Second code, typed in place of PLATFORM_ACCESS_CODE, that makes an ADMIN_EMAILS sign-in an admin one. Never share
   * it. Sign-in can't grant admin while it's unset, and it never counts when it equals the shared code. OPEN_ACCESS=admin
   * is the one other way to admin (see openAccess).
   */
  get adminAccessCode() {
    return process.env.ADMIN_ACCESS_CODE || undefined;
  },
  get adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * OPEN_ACCESS as set: "guest", "admin", or "off" for anything else. It turns sign-in off for demos. Where "admin"
   * actually applies is decided per request by effectiveOpenAccess in lib/auth.ts (Vercel previews and localhost only).
   */
  get openAccess(): "off" | "guest" | "admin" {
    const mode = (process.env.OPEN_ACCESS || "").trim().toLowerCase();
    return mode === "admin" || mode === "guest" ? mode : "off";
  },
  /** Bearer secret that lets scripts start batch rebuilds as the first admin (lib/auth.ts requireAdminOrAutomation). */
  get automationSecret() {
    return process.env.AUTOMATION_SECRET || undefined;
  },
  get cronSecret() {
    return process.env.CRON_SECRET || undefined;
  },
  get maxBuildsPerUserPerDay() {
    return number("MAX_BUILDS_PER_USER_PER_DAY", 3);
  },
  get maxFixRounds() {
    return number("MAX_FIX_ROUNDS", 3);
  },
  /**
   * MUSE_ENGINE: "serve" runs each Muse Code round through the session bridge over `muse serve`; anything else, unset
   * included, keeps one-shot `muse exec` (docs/MUSE_CODE_FULL.md, "The engine"). A round whose bridge can't start runs
   * on exec anyway.
   */
  get museEngine(): MuseEngine {
    return (process.env.MUSE_ENGINE ?? "").trim().toLowerCase() === "serve" ? "serve" : "exec";
  },
  /**
   * True when MUSE_FULL is "1", "true", "yes" or "on" (any case): every Muse Code run gets the platform's settings,
   * hooks and build MCP server (lib/sandbox/muse-config.ts). Off by default.
   */
  get museFull(): boolean {
    return ["1", "true", "yes", "on"].includes((process.env.MUSE_FULL ?? "").trim().toLowerCase());
  },
  /** MUSE_AGENT_CAPACITY: Muse Code's agents.execution_capacity under MUSE_FULL. Default 6, held to 1 through 64. */
  get museAgentCapacity(): number {
    return agentCapacity(process.env.MUSE_AGENT_CAPACITY);
  },
  /**
   * True when a running build's owner may steer it from the build room (docs/MUSE_CODE_FULL.md, "The owner steers"): the
   * session bridge reads their commands, or MUSE_FULL's hook hands their notes to `muse exec`. Off by default, so the
   * build room shows no controls and POST /api/builds/{id}/control answers 503 steering_off.
   */
  get steeringEnabled(): boolean {
    return env.museEngine === "serve" || env.museFull;
  },
  /** Lambda Cloud API key for fine-tuning jobs (lib/train). Platform only: never sent to an instance or a sandbox. */
  get lambdaApiKey() {
    return required("LAMBDA_API_KEY");
  },
  /** Training jobs that may hold a GPU at once. */
  get trainMaxActive() {
    return number("TRAIN_MAX_ACTIVE", 1);
  },
  /** Daily cap on estimated Lambda spend across all training jobs, in USD. New jobs are refused once it's reached. */
  get trainDailyUsd() {
    return number("TRAIN_DAILY_USD", 20);
  },
  /** Ceiling on any one job's limits, whatever the admin asks for. */
  get trainJobMaxUsd() {
    return number("TRAIN_JOB_MAX_USD", 5);
  },
  get trainJobMaxMinutes() {
    return number("TRAIN_JOB_MAX_MINUTES", 120);
  },
  /**
   * Platform-wide daily spend cap across every build and product, in USD. The kill switch for runaway cost. A build on
   * Muse Wonder costs about $4, so the default allows about 25 builds a day.
   */
  get dailySpendCapUsd() {
    return number("DAILY_SPEND_CAP_USD", 100);
  },
  /**
   * HF_TOKEN, required: a Hugging Face token that can write repos under HF_NAMESPACE, for publishing tuned adapters
   * (lib/train/hub.ts). Platform only. lib/train/hub.ts reads it inside each call it makes to the Hub, so it is never a
   * workflow step's argument or result (those are persisted), and it is never logged, never sent to a GPU and never
   * sent to a browser.
   */
  get hfToken() {
    // Trimmed: a pasted token often ends in a line break, which no header takes.
    return required("HF_TOKEN").trim();
  },
  /** HF_NAMESPACE: the Hugging Face user or organization the model and dataset repos are made under, or undefined. */
  get hfNamespace(): string | undefined {
    return process.env.HF_NAMESPACE?.trim() || undefined;
  },
  /**
   * True when HF_PUBLIC asks for public repos: unset or empty (the default, "1"), "1", "true", "yes" or "on". "0",
   * "false", "no", "off" and anything else keep published repos private, so a value that isn't understood fails closed.
   */
  get hfPublic(): boolean {
    const v = (process.env.HF_PUBLIC ?? "").trim().toLowerCase();
    return v === "" || ["1", "true", "yes", "on"].includes(v);
  },
  /**
   * QUANT_ENABLED: "1", "true", "yes" or "on" (any case) lets admins start glimmer-quantize jobs, which make a judged
   * adapter's GGUF files (docs/TRAINING.md "Local files"). Off when unset or anything else.
   */
  get quantEnabled(): boolean {
    return ["1", "true", "yes", "on"].includes((process.env.QUANT_ENABLED ?? "").trim().toLowerCase());
  },
  /** HF_ENDPOINT, https://huggingface.co by default, with no trailing slash. Tests point it at a fake Hub. */
  get hfEndpoint(): string {
    return (process.env.HF_ENDPOINT?.trim() || "https://huggingface.co").replace(/\/+$/, "");
  },
  /**
   * Why tuned adapters aren't published to the Hugging Face Hub here, or null when they are. Only says which setting is
   * missing, never a value.
   */
  get hubOffReason(): string | null {
    if (!process.env.HF_TOKEN?.trim()) return "HF_TOKEN isn't set";
    const namespace = env.hfNamespace;
    if (!namespace) return "HF_NAMESPACE isn't set";
    // A user or organization name, under the Hub's rules for repo names.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/.test(namespace) || /--|\.\./.test(namespace)) {
      return "HF_NAMESPACE isn't a Hugging Face user or organization name";
    }
    // Every call to the Hub carries the token, so it only goes over https. Plain http is for a fake Hub on this machine.
    const origin = env.hfEndpoint;
    const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
    if (!local && !/^https:\/\/[^/\s?#@]+$/.test(origin)) return "HF_ENDPOINT isn't an https origin (plain http only on localhost)";
    return null;
  },

  // ---------- Fine-tune like a build (General; docs/TRAINING.md "Fine-tune like a build") ----------

  /**
   * TUNE_COMPOSER: "1", "true", "yes" or "on" gives admins /fine-tuning/new (one box, a plan card, Start) and the run
   * room at /fine-tuning/runs/{id}. Off by default: both pages and POST /api/train/plan, POST /api/train/runs and GET
   * /api/train/runs/{id} answer 404, and nothing else anywhere changes.
   */
  get tuneComposer(): boolean {
    return flag("TUNE_COMPOSER");
  },
  /**
   * TUNE_DEFAULT_EXAMPLES: how many examples a new run's plan has Muse Wonder write, 200 by default, held to the
   * datasets route's 20 to 1000 (DATASET_MIN_COUNT and DATASET_MAX_COUNT in lib/train/logic.ts).
   */
  get tuneDefaultExamples(): number {
    return Math.min(1000, Math.max(20, Math.floor(number("TUNE_DEFAULT_EXAMPLES", 200))));
  },

  // ---------- Anyone can fine-tune (General; lib/train/public, open-train.md) ----------

  /**
   * PUBLIC_TRAINING: "1", "true", "yes" or "on" lets visitors without admin start runs, under the limits below, with a
   * signed mm_trainer cookie as their identity (lib/train/public/identity.ts). Off by default: trainCaller is exactly
   * requireAdminOrAutomation, no cookie is ever minted, and nothing else anywhere changes.
   */
  get publicTraining(): boolean {
    return flag("PUBLIC_TRAINING");
  },
  /**
   * PUBLIC_DATASETS: the owner's switch for visitors having Muse Wonder write their datasets. Off, and nothing reads it
   * as a yes yet: Meta's terms (10.1(ix)) cover systematic collection of Outputs for training, so visitors train on the
   * lab's ready datasets or their own rows only (visitorDatasetSource in lib/train/public/limits.ts refuses Wonder-written
   * data for visitors whatever this says).
   */
  get publicDatasets(): boolean {
    return flag("PUBLIC_DATASETS");
  },
  /** Real GPU runs one visitor may start per UTC day. Like the other counts here, 0 turns it off. */
  get publicTrainRunsPerDay(): number {
    return wholeCount("PUBLIC_TRAIN_RUNS_PER_DAY", 1);
  },
  /** Dry runs (dryRun 1) one visitor may start per UTC day. */
  get publicTrainDryRunsPerDay(): number {
    return wholeCount("PUBLIC_TRAIN_DRY_RUNS_PER_DAY", 1);
  },
  /** Datasets of their own rows one visitor may add per UTC day. */
  get publicTrainDatasetsPerDay(): number {
    return wholeCount("PUBLIC_TRAIN_DATASETS_PER_DAY", 2);
  },
  /** The most rows a visitor's dataset may have, and the most examples a visitor's run may ask for. */
  get publicTrainDatasetMaxRows(): number {
    return Math.min(1000, Math.floor(number("PUBLIC_TRAIN_DATASET_MAX_ROWS", 100)));
  },
  /** One IP may do this many times what one visitor may, since a cookie can be cleared. */
  get publicTrainIpFactor(): number {
    return Math.floor(number("PUBLIC_TRAIN_IP_FACTOR", 2));
  },
  /** New mm_trainer cookies one IP may get per UTC day. */
  get publicTrainCookiesPerIp(): number {
    return wholeCount("PUBLIC_TRAIN_COOKIES_PER_IP", 3);
  },
  /** A visitor job's limits, each within the lab's own ceiling (TRAIN_JOB_MAX_MINUTES, TRAIN_JOB_MAX_USD). */
  get publicTrainJobMaxMinutes(): number {
    return Math.min(env.trainJobMaxMinutes, Math.floor(number("PUBLIC_TRAIN_JOB_MAX_MINUTES", 60)));
  },
  get publicTrainJobMaxUsd(): number {
    return Math.min(env.trainJobMaxUsd, number("PUBLIC_TRAIN_JOB_MAX_USD", 4));
  },
  get publicTrainJobMaxSteps(): number {
    return Math.floor(number("PUBLIC_TRAIN_JOB_MAX_STEPS", 120));
  },
  /** Visitor jobs that may hold a GPU at once, inside TRAIN_MAX_ACTIVE. 0 pauses visitor runs. */
  get publicTrainMaxActive(): number {
    return Math.min(env.trainMaxActive, wholeCount("PUBLIC_TRAIN_MAX_ACTIVE", 1));
  },
  /**
   * What every visitor together may commit to GPUs per UTC day, in USD, inside TRAIN_DAILY_USD (so visitors can never
   * take more than the lab's whole day). 0 pauses visitor runs.
   */
  get publicTrainDailyUsd(): number {
    return Math.min(env.trainDailyUsd, dollars("PUBLIC_TRAIN_DAILY_USD", 15));
  },

  // ---------- Gadgets as a build option (docs/GADGETS.md) ----------

  /**
   * True when GADGETS_ENABLED is "1", "true", "yes" or "on" (any case). Off by default: the brief writer isn't offered
   * muse-gadget, so no new product picks it until the builder snapshot has the gadget helper and skill.
   */
  get gadgetsEnabled(): boolean {
    return ["1", "true", "yes", "on"].includes((process.env.GADGETS_ENABLED ?? "").trim().toLowerCase());
  },

  // ---------- How a product looks (docs/BRAND.md) ----------

  /**
   * MUSE_APP_LOOK: new builds get the muse-app overlay (template/targets/muse-app) and its muse-app-ui skill, and the
   * build, fix and change prompts and the judge name that look. Off by default, which keeps meta-ui and every prompt as
   * it was. Turn it on only after the builder snapshot has the overlay: the live site can't add it.
   */
  get museAppLook(): boolean {
    return flag("MUSE_APP_LOOK");
  },

  // ---------- Where a product runs (docs/NATIVE.md). Every switch is off by default ----------

  /**
   * NATIVE_TARGETS: a comma list of "phone" and "desktop", the targets the native lane makes apps for. Empty or unset is
   * exactly today's behavior: the same brief schema and prompts, no pill, no native run. Other words are ignored, since
   * vr, glasses and agent have switches of their own.
   */
  get nativeTargets(): TargetId[] {
    return parseNativeTargets(process.env.NATIVE_TARGETS);
  },
  /** VR_ENABLED: the brief writer may pick vr. Turn it on only after the builder snapshot has the VR overlay. */
  get vrEnabled(): boolean {
    return flag("VR_ENABLED");
  },
  /** GLASSES_ENABLED: the brief writer may pick glasses. Turn it on only after the snapshot has the glasses overlay. */
  get glassesEnabled(): boolean {
    return flag("GLASSES_ENABLED");
  },
  /** AGENTS_ENABLED: the brief writer may pick agent. Turn it on only after the snapshot has the agent kit. */
  get agentsEnabled(): boolean {
    return flag("AGENTS_ENABLED");
  },
  /** The targets a new brief may add to web, in TARGETS order. Empty means every brief is web only, as it is today. */
  get enabledTargets(): TargetId[] {
    const native = env.nativeTargets;
    return TARGETS.filter(
      (t) =>
        native.includes(t) ||
        (t === "vr" && env.vrEnabled) ||
        (t === "glasses" && env.glassesEnabled) ||
        (t === "agent" && env.agentsEnabled),
    );
  },

  // ---------- What every product comes with, and proving it works (docs/PRODUCT_OUTPUTS.md) ----------

  /** PRODUCT_OUTPUTS: products offer a CLI, a skill file, a Claude plugin and Muse gadget commands, and show how to connect each. */
  get productOutputs(): boolean {
    return flag("PRODUCT_OUTPUTS");
  },
  /** PROVE_IT: after a product is live, run each output for real against it and record a video. Needs PRODUCT_OUTPUTS. */
  get proveIt(): boolean {
    return flag("PRODUCT_OUTPUTS") && flag("PROVE_IT");
  },
  /** What one Prove it run may spend at Meta, in USD, charged to its build. */
  get proveItCapUsd(): number {
    return dollars("PROVE_IT_CAP_USD", 1.5);
  },
  /** PROVE_NIGHTLY: re-check live products each night on Muse Spark Contributor. Needs PROVE_IT. */
  get proveNightly(): boolean {
    return flag("PRODUCT_OUTPUTS") && flag("PROVE_IT") && flag("PROVE_NIGHTLY");
  },
  /**
   * PROVE_PUT_FILES: a local run's knob. The stage writes the CLI, skill and plugin straight into its copy instead of
   * downloading them, for a site whose deployed code doesn't have those routes yet, and its results say so.
   */
  get provePutFiles(): boolean {
    return flag("PROVE_PUT_FILES");
  },
  /** How many products a nightly re-check takes, the ones checked longest ago first. */
  get proveNightlyProducts(): number {
    return Math.max(0, Math.floor(number("PROVE_NIGHTLY_PRODUCTS", 5)));
  },

  // ---------- The native lane: the device lab, Device Farm and their spend (docs/NATIVE.md) ----------

  /** NATIVE_LAB: products are checked on the AWS Mac and Windows lab boxes. */
  get nativeLab(): boolean {
    return flag("NATIVE_LAB");
  },
  /** NATIVE_DEVICE_FARM: admin builds may run on real phones in AWS Device Farm. */
  get nativeDeviceFarm(): boolean {
    return flag("NATIVE_DEVICE_FARM");
  },
  /** GLASSES_NATIVE_CHECKS: a shipped glasses product also gets the iPhone Simulator check with Meta's mock glasses. */
  get glassesNativeChecks(): boolean {
    return flag("GLASSES_NATIVE_CHECKS");
  },
  /** All AWS spend on the lab through the event, in USD. AWS Budgets alerts are the separate backstop. */
  get nativeSpendCapUsd(): number {
    return dollars("NATIVE_SPEND_CAP_USD", 150);
  },
  /** The ledger warns the admin page at this total, in USD. */
  get nativeSpendAlertUsd(): number {
    return dollars("NATIVE_SPEND_ALERT_USD", 120);
  },
  get nativeDeviceFarmCapUsd(): number {
    return dollars("NATIVE_DEVICE_FARM_CAP_USD", 40);
  },
  get nativeWindowsCapUsd(): number {
    return dollars("NATIVE_WINDOWS_CAP_USD", 15);
  },
  get nativeMacHourlyUsd(): number {
    return dollars("NATIVE_MAC_HOURLY_USD", 0.65);
  },
  /** t3.large on Windows, the box docs/NATIVE_LAB.md sets up. The same size on Linux is about $0.083. */
  get nativeWindowsHourlyUsd(): number {
    return dollars("NATIVE_WINDOWS_HOURLY_USD", 0.111);
  },
  /** When the Mac host was allocated and when it will be released, as ISO dates. Its whole span is a fixed cost. */
  get nativeMacAllocatedAt(): string | null {
    return optional("NATIVE_MAC_ALLOCATED_AT");
  },
  get nativeMacReleaseAt(): string | null {
    return optional("NATIVE_MAC_RELEASE_AT");
  },
  get nativeMacInstanceId(): string | null {
    return optional("NATIVE_MAC_INSTANCE_ID");
  },
  get nativeWindowsInstanceId(): string | null {
    return optional("NATIVE_WINDOWS_INSTANCE_ID");
  },
  /** The role the platform reaches AWS through, with its Vercel OIDC identity. There are no long-lived AWS keys. */
  get awsRoleArn(): string | null {
    return optional("AWS_ROLE_ARN");
  },
  /** The lab boxes' region. Not AWS_REGION, which a Vercel function may have set to its own region. */
  get nativeAwsRegion(): string {
    return optional("NATIVE_AWS_REGION") ?? "us-east-1";
  },
  get deviceFarmProjectArn(): string | null {
    return optional("DEVICE_FARM_PROJECT_ARN");
  },
  /** DEVICE_FARM_ANDROID_DEVICE_ARNS: a comma list. */
  get deviceFarmAndroidDeviceArns(): string[] {
    return (process.env.DEVICE_FARM_ANDROID_DEVICE_ARNS ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
  },
  /** The packager sandbox's snapshot. Separate from the builder's, and it holds only platform code. */
  get packagerSnapshotId(): string | null {
    return optional("PACKAGER_SNAPSHOT_ID");
  },
  /**
   * The Android signing key: base64 of a PEM file holding the private key and its certificate. Platform only. It never
   * reaches the packager sandbox, because lib/native/apk-sign.ts signs each APK after it leaves. Never logged.
   */
  get nativeApkKeystoreB64(): string | null {
    return optional("NATIVE_APK_KEYSTORE_B64");
  },
  /** The PEM key's passphrase, if it has one. */
  get nativeApkKeystorePassword(): string | null {
    return optional("NATIVE_APK_KEYSTORE_PASSWORD");
  },

  // ---------- Agent tools (docs/AGENT_TOOLS.md) ----------

  /** The Composio key. Platform only: never in a sandbox, a product, a browser or a log. */
  get composioApiKey(): string {
    return required("COMPOSIO_API_KEY").trim();
  },
  /** Whether the key is there, without reading it for anything else. Live tools answer tools_paused when it isn't. */
  get composioConfigured(): boolean {
    return optional("COMPOSIO_API_KEY") !== null;
  },
  /** COMPOSIO_PERSONAL_ENABLED: Gmail, Calendar and Slack work for a product's owner, on the owner's own accounts. */
  get composioPersonalEnabled(): boolean {
    return flag("COMPOSIO_PERSONAL_ENABLED");
  },
  /** What all tools together may spend per UTC day, in USD. Composio has no cap of its own, so this is the only one. 0 pauses them. */
  get toolsDailySpendCapUsd(): number {
    return dollars("TOOLS_DAILY_SPEND_CAP_USD", 10);
  },
  /** Tool calls per UTC day across every product, which keeps the platform under Composio's 100k calls a month. */
  get toolsDailyCalls(): number {
    return number("TOOLS_DAILY_CALLS", 3000);
  },
  /** TOOLS_SIGNING_SECRET, or null: toolKey in lib/tools/keys.ts then derives its keys from GATEWAY_TOKEN_PEPPER. */
  get toolsSigningSecret(): string | null {
    return optional("TOOLS_SIGNING_SECRET");
  },
  /** Products' share of the team's Muse Wonder tokens per minute, so agents can't starve builds. */
  get gatewayWonderTpm(): number {
    return number("GATEWAY_WONDER_TPM", 1_500_000);
  },

  // ---------- Flash drive order requests (docs/VIBE_TUNING.md, Feature 6; lib/drive) ----------

  /** True when DRIVE_ENABLED is "1", "true", "yes" or "on" (any case). Off by default: no offer, no form, no requests. */
  get driveEnabled(): boolean {
    return ["1", "true", "yes", "on"].includes((process.env.DRIVE_ENABLED ?? "").trim().toLowerCase());
  },
  /** DRIVE_PRICE_TEXT, such as "$59 with US shipping, invoiced by email", or null to say a quote comes first. */
  get drivePriceText(): string | null {
    return process.env.DRIVE_PRICE_TEXT?.trim().slice(0, 200) || null;
  },
  /**
   * DRIVE_NOTIFY_URL: a Slack or Discord webhook that gets one line per new request (never the buyer's name, email or
   * address), or null. https only, or plain http on localhost for tests.
   */
  get driveNotifyUrl(): string | null {
    const url = process.env.DRIVE_NOTIFY_URL?.trim() ?? "";
    return /^https:\/\/[^\s]+$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/.test(url) ? url : null;
  },
  /**
   * DRIVE_CONTACT_EMAIL: where buyers write about an order (a lost link, a refund, a drive that arrived broken), shown on
   * the request form, the order pages and the drive itself, and where "Stuck?" on the run-locally page sends people.
   * Null when it isn't an email address: the pages then point to the invoice's email.
   */
  get driveContactEmail(): string | null {
    const email = process.env.DRIVE_CONTACT_EMAIL?.trim() ?? "";
    return email.length <= 200 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email) ? email : null;
  },
  /** Requests per client (its IP's key or its browser's key) per rolling 24 hours. */
  get driveClientRequests() {
    return number("DRIVE_CLIENT_REQUESTS", 3);
  },
  /** Requests from everyone together per rolling 24 hours. */
  get driveDailyRequests() {
    return number("DRIVE_DAILY_REQUESTS", 20);
  },
  /** The version of the terms the request form shows (lib/drive/terms.ts). Change it whenever their text changes. */
  get driveTermsVersion(): string {
    return process.env.DRIVE_TERMS_VERSION?.trim().slice(0, 40) || DRIVE_TERMS_DEFAULT_VERSION;
  },
  /**
   * The version of the terms the request form shows for the way this site takes payment: the card terms while
   * driveCheckout is on, the invoice terms otherwise.
   */
  get driveOrderTermsVersion(): string {
    return env.driveCheckout ? DRIVE_CARD_TERMS_VERSION : env.driveTermsVersion;
  },
  /**
   * STRIPE_SECRET_KEY: the Stripe key drive orders are paid with (sk_ or rk_, test or live), or null. Server only: never
   * in a reply, a header or a log. A restricted key needs Checkout Sessions and Refunds write access.
   *
   * Always null on a Vercel preview (README.md, Preview database), so a preview takes no card payments, settles no
   * session and refunds nothing. Stripe's webhook is production's: it would ignore a preview's own order after charging
   * the card, and a preview's copy of a production order names that order and its real payment.
   */
  get stripeSecretKey(): string | null {
    if (isPreview()) return null;
    const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    return /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(key) ? key : null;
  },
  /** STRIPE_WEBHOOK_SECRET: the signing secret (whsec_...) of the webhook endpoint at /api/drive/stripe, or null. */
  get stripeWebhookSecret(): string | null {
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
    return /^whsec_[A-Za-z0-9+/=]{8,}$/.test(secret) ? secret : null;
  },
  /** True for a live Stripe key: real cards are charged. */
  get stripeLive(): boolean {
    return Boolean(env.stripeSecretKey?.includes("_live_"));
  },
  /**
   * DRIVE_PRICE_CENTS: what a drive costs by card, in US cents with US shipping included (5900 is $59), or null. Between
   * $1 and $1,000.
   */
  get drivePriceCents(): number | null {
    const raw = process.env.DRIVE_PRICE_CENTS?.trim() ?? "";
    if (!/^\d+$/.test(raw)) return null;
    const cents = Number(raw);
    return cents >= 100 && cents <= 100_000 ? cents : null;
  },
  /**
   * True when DRIVE_LIVE_SALES is "1", "true", "yes" or "on". A live Stripe key takes real money only with it, after the
   * counsel, tax and insurance review the plan asks for before live sales (docs/VIBE_TUNING.md, "Legal and trust").
   */
  get driveLiveSales(): boolean {
    return ["1", "true", "yes", "on"].includes((process.env.DRIVE_LIVE_SALES ?? "").trim().toLowerCase());
  },
  /**
   * True when drive orders are paid by card on Stripe Checkout: DRIVE_ENABLED, STRIPE_SECRET_KEY,
   * STRIPE_WEBHOOK_SECRET and DRIVE_PRICE_CENTS are all set, and the key is a test key or DRIVE_LIVE_SALES is on.
   * Otherwise orders are requests the owner invoices by email, as before.
   */
  get driveCheckout(): boolean {
    if (!env.driveEnabled || !env.stripeSecretKey || !env.stripeWebhookSecret || env.drivePriceCents === null) return false;
    return !env.stripeLive || env.driveLiveSales;
  },
  /**
   * DRIVE_BENCH_TOKEN_HASH: the SHA-256 of the bench script's token (benchTokenHash in lib/drive/token.ts), or null. The
   * token itself lives only on the bench Mac, as DRIVE_BENCH_TOKEN; `npx tsx scripts/drive-bench.ts token` makes a pair
   * without any platform secret.
   */
  get driveBenchTokenHash(): string | null {
    const hash = process.env.DRIVE_BENCH_TOKEN_HASH?.trim().toLowerCase() ?? "";
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  },

  // ---------- Live docs demos (docs/DOCS_MIRROR.md "Proxy" and "Defaults"; lib/docs/proxy) ----------

  /**
   * The Meta key the docs proxy calls with: DOCS_MODEL_API_KEY, or MODEL_API_KEY when it isn't set, so the docs can
   * run on a separate key with its own limits. Server only, like modelApiKey: never in a reply, a header or a log.
   */
  get docsModelApiKey(): string {
    return process.env.DOCS_MODEL_API_KEY?.trim() || env.modelApiKey;
  },
  /**
   * False when DOCS_LIVE is "off", "0", "false" or "no" (any case): every live docs call then answers 503 docs_paused.
   * Also false on Vercel without DOCS_MODEL_API_KEY, so public visitors never spend the platform's own key: live
   * products and builds depend on it. The fallback in docsModelApiKey is for local runs.
   */
  get docsLive(): boolean {
    if (process.env.VERCEL && !process.env.DOCS_MODEL_API_KEY?.trim()) return false;
    return !["off", "0", "false", "no"].includes((process.env.DOCS_LIVE ?? "").trim().toLowerCase());
  },
  /**
   * What every docs visitor together may spend on Meta per UTC day, in USD. DAILY_SPEND_CAP_USD still applies on top.
   * 0 pauses the demos that cost money and keeps the free calls; DOCS_LIVE=off pauses everything.
   */
  get docsDailySpendCapUsd() {
    return dollars("DOCS_DAILY_SPEND_CAP_USD", 25);
  },
  /** What one client IP may spend on live docs demos per UTC day, in USD. 0 pauses the paid demos, as above. */
  get docsIpDailyUsd() {
    return dollars("DOCS_IP_DAILY_USD", 2);
  },
  /** Live docs calls one client IP may make per minute, across the proxy, Ask and realtime transcription. */
  get docsIpRequestsPerMinute() {
    return number("DOCS_IP_REQUESTS_PER_MINUTE", 20);
  },
  /** Live docs calls one client IP may make per UTC day. */
  get docsIpRequestsPerDay() {
    return number("DOCS_IP_REQUESTS_PER_DAY", 400);
  },
  /** Live docs calls one client IP may have running at once. */
  get docsIpInFlight() {
    return number("DOCS_IP_IN_FLIGHT", 4);
  },
};
