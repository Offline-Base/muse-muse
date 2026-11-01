import { TARGETS, type TargetId } from "@/lib/brief/schema";
import { CAP_FLAG, CAP_IDS, CAP_NEEDS_BUILDER, CAP_READY, type CapId } from "@/lib/caps/ids";
import { codePartsOn } from "@/lib/caps/code/parts";
import { connectMoreToolsOn, connectSendsOn, connectVaultOn } from "@/lib/caps/connect/flags";
import { jobsWebhooksOn } from "@/lib/caps/jobs/flags";
import { dataSignInOn } from "@/lib/caps/data/types";
import { filesDatasetsOn, filesSearchOn } from "@/lib/caps/files/types";
import { liveUpdatesOn } from "@/lib/caps/live/parts";
import { mediaPartsFromEnv, type MediaPartId } from "@/lib/caps/media/parts";
import { capOverlaysNeeded } from "@/lib/caps/overlays";
import { databaseChoice, isPreview, previewHasOwnDatabase } from "@/lib/db/url";
import { DRIVE_CARD_TERMS_VERSION, DRIVE_TERMS_DEFAULT_VERSION } from "@/lib/drive/terms";
import { parseNativeTargets } from "@/lib/native/targets";
import type { MuseEngine } from "@/lib/sandbox/bridge-protocol";
import { agentCapacity } from "@/lib/sandbox/agent-capacity";
import { snapshotCapOverlays } from "@/lib/sandbox/snapshots";
import { type PlatformBypass, publicHost } from "@/lib/sandbox/policy";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";
import { parseGeoCountries } from "@/lib/trust/geo";

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

/**
 * BUILDS_ON_CONTRIBUTOR: the owner's decision to run every build on Spark 1.3 Contributor, on production too, with real
 * people's notes and files. Meta may train on that tier and its terms (6.2) bar sensitive, confidential or personal
 * information there, so every box that feeds a build shows ContributorNotice. It covers builds only: fine-tuning keeps
 * testModel(), and a live product's calls stay on Muse Wonder.
 */
export function contributorBuildsOn(): boolean {
  return flag("BUILDS_ON_CONTRIBUTOR");
}

/** What a build runs on instead of its usual models: Contributor with BUILDS_ON_CONTRIBUTOR, else TEST_MODEL's guarded answer. */
export function buildTestModel(): typeof SPARK_STANDIN | null {
  return contributorBuildsOn() ? SPARK_STANDIN : testModel();
}

/**
 * Whether an admin may have Spark 1.3 Contributor write a fine-tuning dataset. Meta's terms (6.2) bar sensitive, confidential or
 * personal information on that tier and Meta may train on it, so it takes TRAIN_CONTRIBUTOR_WRITER=1 on production, an admin,
 * and a statement that the task is made up. Anywhere TEST_MODEL is on, it's on already.
 */
export function contributorWriterOn(): boolean {
  return process.env.TRAIN_CONTRIBUTOR_WRITER?.trim() === "1" || testModel() !== null;
}

/** A model id from the environment, or the fallback. Muse Spark 1.3 becomes Spark 1.3 Contributor, with one warning. */
function model(name: string, fallback: string): string {
  const test = buildTestModel();
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
  /**
   * The most one person's Lambda GPU jobs may ever cost, in USD, counting running jobs at their full dollar limit. Not a
   * daily amount: it never resets. 0 stops them. The shared guest account would be one person here, so one pool.
   */
  get trainUserLimitUsd(): number {
    return dollars("TRAIN_USER_LIMIT_USD", 100);
  },
  /** The same across everyone: the most the platform's Lambda GPU jobs may ever cost, in USD. 0 stops them all. */
  get trainTotalLimitUsd(): number {
    return dollars("TRAIN_TOTAL_LIMIT_USD", 3000);
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
  /** True when HF_PUBLIC is set at all. Auto uploads stay private until it says public (hubFinishStep). */
  get hfPublicSet(): boolean {
    return (process.env.HF_PUBLIC ?? "").trim() !== "";
  },
  /**
   * QUANT_ENABLED: "1", "true", "yes" or "on" (any case) lets admins start glimmer-quantize jobs, which make a judged
   * adapter's GGUF files (docs/TRAINING.md "Local files"). Off when unset or anything else.
   */
  get quantEnabled(): boolean {
    return ["1", "true", "yes", "on"].includes((process.env.QUANT_ENABLED ?? "").trim().toLowerCase());
  },
  /**
   * QUANT_TARGETS: local files for small bases and one-bit Muse Glimmer, and the device targets (lib/train/quant-targets.ts,
   * docs/TRAINING.md "Device targets"). Off when unset: quantizing stays r30b's three builds, and Llama adapters are refused.
   */
  get quantTargets(): boolean {
    return flag("QUANT_TARGETS");
  },
  /** The board loop: tune, GGUF, board, serve, test, demo, try page (docs/BOARD_LOOP.md). Off by default. */
  get boardLoop(): boolean {
    return flag("BOARD_LOOP");
  },
  /** Which board the loop reaches: "simulated" (the default), "fleet" or "device". */
  get boardLoopTarget(): "simulated" | "fleet" | "device" {
    const target = process.env.BOARD_LOOP_TARGET?.trim();
    return target === "fleet" || target === "device" ? target : "simulated";
  },
  /** Visitors may use a real board's try page. The simulated board's canned text needs no such switch; admins always can. */
  get boardTryPublic(): boolean {
    return flag("BOARD_TRY_PUBLIC");
  },
  /**
   * SIM_TUNE: admins can run a tuned model's smallest GGUF on the lab's Android emulator (docs/TRAINING.md "Emulator
   * runs"). Also needs NATIVE_LAB. Off when unset.
   */
  get simTune(): boolean {
    return flag("SIM_TUNE");
  },
  /**
   * SIM_TUNE_MAX_GGUF_MB: the largest file an emulator run may load. The default fits the 4 GB of RAM setup/mac.sh gives
   * mm_pixel. Raise it only after giving the emulator more. The runner still checks the device's real RAM and disk.
   */
  get simTuneMaxBytes(): number {
    const mb = Number((process.env.SIM_TUNE_MAX_GGUF_MB ?? "").trim());
    return (Number.isFinite(mb) && mb > 0 ? mb : 3072) * 1024 * 1024;
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
   * STORY_PAGES: "1", "true", "yes" or "on" shows /offline, the clearer /private and the frontier section on
   * /how-it-works (docs/STORY.md). Off: /offline answers 404 and the other two are as they were.
   * All three are static, so this is read at build time and a change takes a deploy.
   */
  get storyPages(): boolean {
    return flag("STORY_PAGES");
  },
  /**
   * TUNE_LOOP: "1", "true", "yes" or "on" lets admins run a repeat-until-good tuning loop on a judged run
   * (docs/TRAINING.md "Tuning loop"). Off by default: its routes and page answer 404 and the run room shows nothing new.
   */
  get tuneLoop(): boolean {
    return flag("TUNE_LOOP");
  },
  /**
   * TUNE_RESEARCH: "1", "true", "yes" or "on" lets admins research data for a fine-tune (lib/train/research). Off by
   * default: the pages and /api/train/research routes answer 404, the New dataset card offers nothing new, and no dataset
   * reads grounding notes.
   */
  get tuneResearch(): boolean {
    return flag("TUNE_RESEARCH");
  },
  /** TUNE_RESEARCH_MAX_USD: the most one research run may spend on Meta, $2 by default. DAILY_SPEND_CAP_USD applies on top. */
  get tuneResearchMaxUsd(): number {
    return dollars("TUNE_RESEARCH_MAX_USD", 2);
  },
  /**
   * TUNE_DEFAULT_EXAMPLES: how many examples a new run's plan has Muse Wonder write, 200 by default, held to the
   * datasets route's 20 to 1000 (DATASET_MIN_COUNT and DATASET_MAX_COUNT in lib/train/logic.ts).
   */
  get tuneDefaultExamples(): number {
    return Math.min(1000, Math.max(20, Math.floor(number("TUNE_DEFAULT_EXAMPLES", 200))));
  },
  /**
   * TUNE_FROM_BUILDS: "1", "true", "yes" or "on" gives a live or partial build whose brief picked muse-glimmer an "Its
   * own model" row in its build room (components/build/OwnModelRow.tsx), for the product's owner or an admin, whose
   * Plan it opens /fine-tuning/new prefilled from the brief. It needs TUNE_COMPOSER too. Training starts only when that
   * person presses Start, never on its own, and the build is live without waiting for it. Off by default: the build
   * room renders exactly as before, and POST /api/train/plan refuses fromBuildId with 404.
   */
  get tuneFromBuilds(): boolean {
    return flag("TUNE_FROM_BUILDS");
  },
  /**
   * GUEST_EDITS: "1", "true", "yes" or "on" lets the browser that made a guest build refine it, holding an httpOnly
   * signed pass (lib/edit-pass.ts), under the same spend and rate checks as a guest build. Off by default: guests get
   * the 403 they always did and no pass is handed out.
   */
  get guestEdits(): boolean {
    return flag("GUEST_EDITS");
  },
  /**
   * GITHUB_EXPORT: "1", "true", "yes" or "on" shows Connect GitHub and Export to GitHub on a product's Code page
   * (docs/GITHUB_EXPORT.md). Off by default: no button, no reads, and the routes answer 404.
   */
  get githubExport(): boolean {
    return flag("GITHUB_EXPORT");
  },
  get githubClientId() {
    return process.env.GITHUB_OAUTH_CLIENT_ID?.trim() || undefined;
  },
  get githubClientSecret() {
    return process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() || undefined;
  },
  /** Seals connected accounts' tokens (lib/connected/store.ts): 32 bytes of base64, or a v1:,v2: ring. */
  get connectedAccountsKey() {
    return process.env.CONNECTED_ACCOUNTS_KEY?.trim() || undefined;
  },
  /**
   * TUNE_AUTO_PUBLISH: an admin's tune run uploads its model to Hugging Face by itself once it succeeds and is judged
   * (docs/TRAINING.md "Auto upload"). Off by default: runs stay at publish 0 until someone presses Publish.
   */
  get tuneAutoPublish(): boolean {
    return flag("TUNE_AUTO_PUBLISH");
  },

  /**
   * TUNE_ANY_BASE: admins may fine-tune any allowed Meta base, Llama or Glimmer (docs/TRAINING.md "Any Meta base"). Off:
   * every job trains on r30b, and a base in a request is refused.
   */
  get tuneAnyBase(): boolean {
    return flag("TUNE_ANY_BASE");
  },

  /**
   * TUNE_RL: admins may start the rl-grpo recipe, GRPO on made-up arithmetic (docs/TRAINING.md "rl-grpo recipe"). Off: the
   * recipe isn't offered and a request for it is refused.
   */
  get tuneRl(): boolean {
    return flag("TUNE_RL");
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
    // Builds on Contributor always get the look (BUILDS_ON_CONTRIBUTOR, the owner's Nov 1 decision).
    return flag("MUSE_APP_LOOK") || contributorBuildsOn();
  },
  /**
   * PLAN_ART: once a new build's brief is written, one Muse Image edit of the owner's mascot (public/muse/muse-present.jpg)
   * doing something that fits the plan, about $0.01 a build, metered like the platform's other calls. The build room's
   * plan card shows it in place of the stock mascot (lib/pipeline/plan-art.ts). Off by default: no call, no picture, and
   * the card shows the stock mascot by state.
   */
  get planArt(): boolean {
    return flag("PLAN_ART");
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
  /** RECIPES_ENABLED: the brief writer may pick recipes (lib/recipes), and a build gets their skills. No snapshot needed. */
  get recipesEnabled(): boolean {
    return flag("RECIPES_ENABLED");
  },
  /** AGENT_LONG_RUNS: recipes that run dozens of turns may be picked, and get the long run limits. Needs RECIPES_ENABLED. */
  get agentLongRuns(): boolean {
    return flag("AGENT_LONG_RUNS");
  },
  /** AGENT_LONG_DAILY_USD: a long-run product's daily Meta budget, in place of the normal $10 ceiling. */
  get agentLongDailyUsd(): number {
    return number("AGENT_LONG_DAILY_USD", 25);
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
  /** VERIFY_AGENTS: the "What was checked" panel and the judge's agent rules. The agent claims check also needs PROVE_IT, and recipe-verified-agent also needs RECIPES_ENABLED and AGENTS_ENABLED. */
  get verifyAgents(): boolean {
    return flag("VERIFY_AGENTS");
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

  // ---------- Wave 3, unit 1: trust (docs/CAPABILITIES.md) ----------

  /**
   * TRUST_SIGNED_IN_CAPS: caps marked CAP_NEEDS_BUILDER (data, files, connect, jobs, code, runtime, hardware) need a
   * signed-in builder. A guest's brief writer doesn't get them (capsForBuilder in lib/trust/tiers.ts), and each
   * signed-in builder's products share TRUST_BUILDER_DAILY_USD a day.
   */
  get trustSignedInCaps(): boolean {
    return flag("TRUST_SIGNED_IN_CAPS");
  },
  /** What one signed-in builder's products may spend together per UTC day, every source counted. Read only with the flag above. 0 pauses them. */
  get trustBuilderDailyUsd(): number {
    return dollars("TRUST_BUILDER_DAILY_USD", 5);
  },
  /** TRUST_AGE_GATE: 18 and over on platform sign-in and before building, and an age gate in new products. */
  get trustAgeGate(): boolean {
    return flag("TRUST_AGE_GATE");
  },
  /** TRUST_LEGAL_PAGES: /privacy and /terms on the platform, and privacy and terms pages in new products. */
  get trustLegalPages(): boolean {
    return flag("TRUST_LEGAL_PAGES");
  },
  /** TRUST_GEO_BLOCK: requests from the territories in TRUST_GEO_COUNTRIES are refused, on the platform and in new products. */
  get trustGeoBlock(): boolean {
    return flag("TRUST_GEO_BLOCK");
  },
  /** TRUST_GEO_COUNTRIES: ISO codes and region codes (UA-43), or "meta" for Meta's list (lib/trust/geo.ts). Empty blocks nothing. */
  get trustGeoCountries(): string[] {
    return parseGeoCountries(process.env.TRUST_GEO_COUNTRIES);
  },
  /** TRUST_REPORTS: the Report link on products, /admin/reports, takedown and ban. */
  get trustReports(): boolean {
    return flag("TRUST_REPORTS");
  },
  /** TRUST_SPARK_TO_WONDER: a live product's retired Spark 1.3 calls run on Muse Wonder instead of Contributor (Meta terms 6.2). */
  get trustSparkToWonder(): boolean {
    return flag("TRUST_SPARK_TO_WONDER");
  },
  /**
   * TRUST_DEPLOY_TOTAL_MB: the most one product deployment's files may add up to, in MB (lib/publish/vercel.ts). 100 by
   * default, Vercel's Hobby number for uploaded source files; raise it on a Pro team (1 GB there). Bigger fails by name.
   */
  get trustDeployTotalMb(): number {
    return number("TRUST_DEPLOY_TOTAL_MB", 100);
  },
  /** True while any trust flag a product carries is on, so new builds get the trust overlay (template/caps/trust). */
  get trustProductOverlay(): boolean {
    return env.trustAgeGate || env.trustLegalPages || env.trustGeoBlock || env.trustReports;
  },

  // ---------- Full builds (docs/FULL_BUILDS.md) ----------

  /** FULL_BUILDS: briefs list every requirement, a separate check holds them to the note, and every requirement is tested and judged. */
  get fullBuilds(): boolean {
    return flag("FULL_BUILDS");
  },
  /** The longest a full build may run, in minutes. Held to 90 (the engine's wall) through 150, which stays clear of the 3-hour sweep. */
  get fullBuildWallMinutes(): number {
    return Math.min(150, Math.max(90, number("FULL_BUILD_WALL_MINUTES", 120)));
  },

  // ---------- Chained builds (docs/CHAINED_BUILDS.md) ----------

  /** CHAINED_BUILDS: a signed-in builder's big full build runs across many sessions through a milestone plan. Needs FULL_BUILDS. */
  get chainedBuilds(): boolean {
    return flag("CHAINED_BUILDS") && flag("FULL_BUILDS");
  },
  /** What one chained build may spend in all, in USD. */
  get chainedTotalUsd(): number {
    return dollars("CHAINED_TOTAL_USD", 60);
  },
  /** What one session of a chain may spend, in USD. */
  get chainedSessionUsd(): number {
    return dollars("CHAINED_SESSION_USD", 15);
  },
  /** How long one session runs, in minutes. Held to 45 through 120, so a session and its checks stay inside the sandbox's limits. */
  get chainedSessionMinutes(): number {
    return Math.min(120, Math.max(45, number("CHAINED_SESSION_MINUTES", 85)));
  },
  get chainedMaxSessions(): number {
    return Math.min(40, Math.max(1, Math.floor(number("CHAINED_MAX_SESSIONS", 12))));
  },
  /** The longest a chain may take, in hours. Held to 3 through 72. The sweep gives a chain this long. */
  get chainedMaxHours(): number {
    return Math.min(72, Math.max(3, number("CHAINED_MAX_HOURS", 24)));
  },

  // ---------- Platform powers (docs/PLATFORM_POWERS.md) ----------

  /** What one product's powers may commit per UTC day, in USD. Everything is counted at its worst case, when it starts. 0 pauses them. */
  get powersProductDailyUsd(): number {
    return dollars("PLATFORM_POWERS_PRODUCT_DAILY_USD", 20);
  },
  /** What all products' powers together may commit per UTC day, in USD. 0 pauses them. */
  get powersAllDailyUsd(): number {
    return dollars("PLATFORM_POWERS_ALL_DAILY_USD", 50);
  },
  /** The most one metered key may spend, in USD. */
  get powersKeyMaxUsd(): number {
    return dollars("PLATFORM_POWERS_KEY_MAX_USD", 5);
  },
  /** What a product's new build is counted at: above the build token's $10, for the brief and the judge. */
  get powersBuildUsd(): number {
    return dollars("PLATFORM_POWERS_BUILD_USD", 12);
  },

  // ---------- Wave 3, unit 2: engine (docs/CAPABILITIES.md) ----------

  /** ENGINE_CHECK_ON_TIMEOUT: a first round that hits its time cap goes on to the checks and fix rounds instead of failing. */
  get engineCheckOnTimeout(): boolean {
    return flag("ENGINE_CHECK_ON_TIMEOUT");
  },
  /** ENGINE_ROUND_SCALING: round time grows with the brief (roundCapMs in lib/pipeline/steps.ts). */
  get engineRoundScaling(): boolean {
    return flag("ENGINE_ROUND_SCALING");
  },
  /** The longest a scaled first round may run, in minutes. Held to 25 (today's round) through 90 (the build's wall). */
  get engineRoundMaxMinutes(): number {
    return Math.min(90, Math.max(25, number("ENGINE_ROUND_MAX_MINUTES", 45)));
  },
  /** ENGINE_MILESTONES: the brief writer may split a big brief into 2 or 3 milestones, built in chained rounds. */
  get engineMilestones(): boolean {
    return flag("ENGINE_MILESTONES");
  },
  /** ENGINE_LIVE_SMOKE: after deploy, the live link is loaded (no model call) before the product is marked live. */
  get engineLiveSmoke(): boolean {
    return flag("ENGINE_LIVE_SMOKE");
  },
  /** ENGINE_EXACT_LOGIC: the brief writer says when a product's main claim needs real code (a parser, a solver), not a model. */
  get engineExactLogic(): boolean {
    return flag("ENGINE_EXACT_LOGIC");
  },
  /**
   * ENGINE_FIT_OUTPUT: a Responses call whose max_output_tokens the token's budget can't cover runs with a lower
   * max_output_tokens instead of being refused (fitOutputToBudget in lib/gateway/estimate.ts).
   */
  get engineFitOutput(): boolean {
    return flag("ENGINE_FIT_OUTPUT");
  },
  /**
   * The caps a new brief may ask for (docs/CAPABILITIES.md, 2.1): ready and switched on. On production, caps that need a
   * signed-in builder stay off until TRUST_SIGNED_IN_CAPS (unit 1) is on. Empty means every brief is as it is today.
   */
  get enabledCaps(): CapId[] {
    // ---------- Wave 3, unit 3: and only caps whose overlays the builder snapshot has (2.4a) ----------
    // capsOnSite is the rule above this line was: ready, switched on, and on production a signed-in builder's. The
    // snapshot is read only when some cap passes that, so with every flag off nothing new is read or logged.
    const onSite = env.capsOnSite;
    if (!onSite.length) return onSite;
    const snapshot = env.snapshotCaps;
    return snapshot === null ? onSite : onSite.filter((c) => capOverlaysNeeded(c).every((o) => snapshot.includes(o)));
    // ---------- end Wave 3, unit 3 ----------
  },

  // ---------- Wave 3, unit 3: data (docs/CAPABILITIES.md) ----------

  /**
   * The caps the site serves: ready (CAP_READY) and switched on. Their gateway routes answer (the cap gate's check 1),
   * whatever the builder snapshot has, so a live product never breaks when the snapshot changes.
   */
  get servedCaps(): CapId[] {
    // Unit 8: media is on only with at least one of its parts on (MEDIA_SPEECH and the rest), so MEDIA_ENABLED alone
    // behaves exactly like MEDIA_ENABLED off.
    const partsOn = (c: CapId) => c !== "media" || mediaPartsFromEnv().length > 0;
    return CAP_IDS.filter((c) => CAP_READY[c] && flag(CAP_FLAG[c]) && partsOn(c));
  },
  /** servedCaps, less those that need a signed-in builder on production while TRUST_SIGNED_IN_CAPS is off (2.1). */
  get capsOnSite(): CapId[] {
    const production = process.env.VERCEL_ENV === "production";
    const signedIn = flag("TRUST_SIGNED_IN_CAPS");
    return env.servedCaps.filter((c) => !production || signedIn || !CAP_NEEDS_BUILDER[c]);
  },
  /**
   * The cap overlays in the builder snapshot (2.4a): on Vercel, lib/sandbox/snapshots.json's entry for
   * BUILDER_SNAPSHOT_ID, or [] with one warning when it has none. Null locally, where provisioning copies any missing
   * overlay from this checkout's template/caps.
   */
  get snapshotCaps(): string[] | null {
    if (!process.env.VERCEL) return null;
    return snapshotCapOverlays(process.env.BUILDER_SNAPSHOT_ID || undefined);
  },
  /** DATA_SIGN_IN: products with a data block may sign people in with a passkey through Muse Muse (/u/sign-in). */
  get dataSignIn(): boolean {
    return dataSignInOn();
  },
  /** The most rows one product keeps in its live namespace. */
  get dataProductRows(): number {
    return number("DATA_PRODUCT_ROWS", 10_000);
  },
  /** The most one product's live rows may add up to, in MB. */
  get dataProductMb(): number {
    return number("DATA_PRODUCT_MB", 50);
  },
  /** Writes one product may make in a UTC day, live namespace. */
  get dataDailyWrites(): number {
    return number("DATA_DAILY_WRITES", 5_000);
  },

  // ---------- Wave 3, unit 4: files and search (docs/CAPABILITIES.md) ----------

  /**
   * FILES_SEARCH: products with a files block may index text and search it ({GATEWAY_URL}/search). FILES_ENABLED, the
   * files themselves, is CAP_FLAG.files, read through enabledCaps above, and search also needs it.
   */
  get filesSearch(): boolean {
    return filesSearchOn();
  },
  /** FILES_DATASETS: products may read the vetted public datasets in lib/caps/files/datasets.json ({GATEWAY_URL}/datasets). */
  get filesDatasets(): boolean {
    return filesDatasetsOn();
  },
  /** What one product's live files may add up to, in MB. */
  get filesProductMb(): number {
    return number("FILES_PRODUCT_MB", 500);
  },
  /** The biggest file a product may store, in MB. */
  get filesMaxFileMb(): number {
    return number("FILES_MAX_FILE_MB", 25);
  },
  /**
   * FILES_BLOB_STORE_ID: a private Vercel Blob store for products' files, reached with the deployment's OIDC token
   * (decision 14). Unset: the platform's own public store with unguessable paths. A store id isn't a credential.
   */
  get filesBlobStoreId(): string | null {
    return optional("FILES_BLOB_STORE_ID");
  },

  // ---------- Wave 3, unit 5: connect (docs/CAPABILITIES.md) ----------

  /**
   * CONNECT_MORE_TOOLS: more read-only tools through the tool gateway, owners only (decision 17). Nothing reads it yet:
   * the tools need `npm run tools:sync` against Composio first (docs/CAPABILITIES.md, 11a).
   */
  get connectMoreTools(): boolean {
    return connectMoreToolsOn();
  },
  /**
   * CONNECT_VAULT: the per-product key vault and brokered calls ({GATEWAY_URL}/vault). It also needs CONNECT_VAULT_KEY;
   * without one the vault answers caps_paused. CONNECT_ENABLED, the cap's own flag, is read through enabledCaps above.
   */
  get connectVault(): boolean {
    return connectVaultOn();
  },
  /**
   * CONNECT_VAULT_KEY: 32 bytes in base64, or a ring "v1:<key>,v2:<key>" (lib/secrets/box.ts). Platform only: it never
   * goes into a build or a product.
   */
  get connectVaultKey(): string | null {
    return optional("CONNECT_VAULT_KEY");
  },
  /**
   * CONNECT_SENDS: messages sent with the builder's own key, one confirmation each ({GATEWAY_URL}/send). Needs the vault.
   * On production it also needs CONNECT_SENDS_PRODUCTION, the owner's switch (decision 8), which stays off.
   */
  get connectSends(): boolean {
    return connectSendsOn();
  },

  // ---------- Wave 3, unit 6: jobs (docs/CAPABILITIES.md) ----------

  /**
   * JOBS_WEBHOOKS: other services can start a product's jobs ({GATEWAY_URL}/hooks). JOBS_ENABLED, the cap's own flag, is
   * read through enabledCaps above.
   */
  get jobsWebhooks(): boolean {
    return jobsWebhooksOn();
  },
  /** JOBS_DAILY_RUNS: job ticks the cron starts in a UTC day, across all products. 0 pauses them. */
  get jobsDailyRuns(): number {
    return wholeCount("JOBS_DAILY_RUNS", 2000);
  },
  /** JOBS_DAILY_USD: what job runs may spend at Meta in a UTC day, across all products. 0 pauses them. */
  get jobsDailyUsd(): number {
    return dollars("JOBS_DAILY_USD", 5);
  },
  /** JOBS_PRODUCT_DAILY_RUNS: job ticks one product may start in a UTC day. Three 15-minute schedules take 288. */
  get jobsProductDailyRuns(): number {
    return wholeCount("JOBS_PRODUCT_DAILY_RUNS", 400);
  },
  /** JOBS_PRODUCT_DAILY_USD: what one product's job runs may spend at Meta in a UTC day. */
  get jobsProductDailyUsd(): number {
    return dollars("JOBS_PRODUCT_DAILY_USD", 1);
  },
  /** JOBS_RUN_USD: where one run stops, at most $0.50. 0 pauses new runs. */
  get jobsRunUsd(): number {
    return Math.min(dollars("JOBS_RUN_USD", 0.1), 0.5);
  },
  /** JOBS_PAUSE_DAYS: schedules pause after this many days with no visit from the owner. */
  get jobsPauseDays(): number {
    return number("JOBS_PAUSE_DAYS", 14);
  },

  // ---------- Wave 3, unit 7: live (docs/CAPABILITIES.md) ----------

  /**
   * LIVE_UPDATES: {GATEWAY_URL}/live, changes to a saved collection reaching every open browser. Needs the data cap served
   * too. LIVE_ENABLED, near-live captions and the writer, is CAP_FLAG.live, read through enabledCaps above.
   */
  get liveUpdates(): boolean {
    return liveUpdatesOn();
  },
  /** Audio minutes of captions per visitor per UTC day. */
  get liveCaptionMinutes(): number {
    return number("LIVE_CAPTION_MINUTES", 10);
  },

  // ---------- Wave 3, unit 8: media (docs/CAPABILITIES.md) ----------

  /**
   * The media cap's parts (lib/caps/media), each its own switch on top of MEDIA_ENABLED, which is CAP_FLAG.media, read
   * through enabledCaps above: MEDIA_SPEECH (speech in the page), MEDIA_VIDEO (video from pictures), MEDIA_MUSIC (MIDI)
   * and MEDIA_SAM_TILING (SAM past 16 objects, and long clips in chunks). The writer offers only the parts that are on.
   */
  get mediaParts(): MediaPartId[] {
    return mediaPartsFromEnv();
  },

  // ---------- Wave 3, unit 9: code (docs/CAPABILITIES.md) ----------

  /**
   * CODE_EXEC: {GATEWAY_URL}/exec runs a product's Python or Node program in a fresh sandbox with no network. Off: the
   * route answers 404 and touches nothing. CODE_ENABLED, Pyodide and QuickJS in the browser, is CAP_FLAG.code, read
   * through enabledCaps above, and /exec also needs it.
   */
  get codeExec(): boolean {
    return flag("CODE_EXEC");
  },
  /**
   * CODE_EXEC_VISITORS: visitors and signed-in end users may run /exec too, not only the product's owner. Off until the
   * owner has read Meta's terms 1, 3.1, 6.2 and 10.1(i) (docs/CAPABILITIES.md, decision 10). Never applies to /browse.
   */
  get codeExecVisitors(): boolean {
    return flag("CODE_EXEC_VISITORS");
  },
  /** What /exec may spend on sandboxes across the platform per UTC day. 0 pauses it. */
  get codeExecDailyUsd(): number {
    return dollars("CODE_EXEC_DAILY_USD", 3);
  },
  /** A Vercel Sandbox snapshot with Python 3 and Node for /exec. Unset: each run starts from Vercel's own image. */
  get codeExecSnapshotId(): string | null {
    return optional("CODE_EXEC_SNAPSHOT_ID");
  },
  /**
   * CODE_BROWSE: {GATEWAY_URL}/browse opens one page the person typed, in a sandbox that reaches only that host. It
   * starts from BUILDER_SNAPSHOT_ID, which has Chromium. Off: the route answers 404 and touches nothing.
   */
  get codeBrowse(): boolean {
    return flag("CODE_BROWSE");
  },
  /** What /browse may spend on sandboxes across the platform per UTC day. 0 pauses it. */
  get codeBrowseDailyUsd(): number {
    return dollars("CODE_BROWSE_DAILY_USD", 2);
  },
  /**
   * MUSE_CODE_ENABLED: products may run Muse Code sessions for their owner ({GATEWAY_URL}/code/sessions, the code cap's
   * museCode part, docs/CAPABILITIES.md 15b). Each session is its own sandbox from BUILDER_SNAPSHOT_ID, $1 and 15
   * minutes at most. Needs CODE_ENABLED and a builder snapshot with the musecode overlay. Off: the routes answer 404.
   */
  get museCodeEnabled(): boolean {
    return codePartsOn().museCode === true;
  },
  /**
   * MUSE_CODE_VISITORS: visitors and signed-in end users may start sessions too, 3 a day per address. Off until the owner
   * has read Meta's terms 1, 3.1, 6.2 and 10.1(i) for this (decision 10): it is a terms decision as well as a spending one.
   */
  get museCodeVisitors(): boolean {
    return codePartsOn().museCodeVisitors === true;
  },

  // ---------- Wave 3, unit 10: runtime (docs/CAPABILITIES.md) ----------

  /**
   * RUNTIME_OUTPUTS: a live product also offers a VS Code extension and a GitHub Action made from its musemuse.json, and
   * its owner can download a self-host kit made from its live source (lib/outputs/{vscode,github-action,selfhost}.ts).
   * Off: /p/<slug>/get/{vscode,github-action,selfhost}.zip answer 404 and the Get it panel has no such tabs.
   * RUNTIME_ENABLED, the Python functions, is CAP_FLAG.runtime, read through enabledCaps above.
   */
  get runtimeOutputs(): boolean {
    return flag("RUNTIME_OUTPUTS");
  },

  // ---------- Wave 3, unit 11: gpu (docs/CAPABILITIES.md) ----------

  /**
   * GPU_GLIMMER_SHARED: products whose brief picks muse-glimmer reach a hosted Muse Glimmer at {GATEWAY_URL}/glimmer/v1
   * during a demo window an admin opens (POST /api/admin/glimmer/windows). Off: those routes answer 404 and touch nothing,
   * and the brief, tokens and deploy env are today's. Decision 11: stays off until the owner confirms.
   */
  get gpuGlimmerShared(): boolean {
    return flag("GPU_GLIMMER_SHARED");
  },
  /**
   * GPU_GLIMMER_SHARED, for what a new build is told and given: also needs a builder snapshot made from a checkout with this
   * unit, which has askGlimmer in its template. template/caps/gpu ships no files, only its deps.json, so a snapshot lists `gpu`
   * in lib/sandbox/snapshots.json exactly when that's true. Local runs use the checkout's template.
   */
  get gpuGlimmerForBuilds(): boolean {
    if (!flag("GPU_GLIMMER_SHARED")) return false;
    const overlays = env.snapshotCaps;
    return overlays === null || overlays.includes("gpu");
  },
  /** GPU_GLIMMER_DAILY_USD: the most demo windows may reserve per UTC day, 15 by default. 0 pauses them. */
  get gpuGlimmerDailyUsd(): number {
    return dollars("GPU_GLIMMER_DAILY_USD", 15);
  },
  /**
   * GPU_GLIMMER_ALL_PRODUCTS: signed-in builders' products may use a window too. Off, only products an admin owns may,
   * which is the owner's open question 11 about serving Glimmer to other people's products.
   */
  get gpuGlimmerAllProducts(): boolean {
    return flag("GPU_GLIMMER_ALL_PRODUCTS");
  },
  /**
   * GPU_TRAIN_ON_DATA: a product's signed-in builder may train a model on their own owner rows, as an explicit action
   * (POST /api/products/{slug}/train, decision 12). Needs TUNE_COMPOSER too. Off: the route answers 404 and touches nothing.
   */
  get gpuTrainOnData(): boolean {
    return flag("GPU_TRAIN_ON_DATA");
  },

  // ---------- Hosting a tuned model on a provider the platform pays for (lib/train/host) ----------

  /** HOST_TUNED: the Run it section on a tuned model's page and its routes. Off: they answer 404, and the sweep only stops what still runs. */
  get hostTuned(): boolean {
    return flag("HOST_TUNED");
  },
  /** HOST_TUNED_OPEN: signed-in people may deploy too. Off, only admins. The shared guest account never may. */
  get hostTunedOpen(): boolean {
    return flag("HOST_TUNED_OPEN");
  },
  /** HOST_TUNED_DAILY_USD: the most hosted endpoints may cost per UTC day across every provider, 25 by default. 0 stops them all. */
  get hostTunedDailyUsd(): number {
    return dollars("HOST_TUNED_DAILY_USD", 25);
  },
  /** HOST_TUNED_MAX_LIVE: endpoints running at once, 2 by default. 0 stops them all. */
  get hostTunedMaxLive(): number {
    return wholeCount("HOST_TUNED_MAX_LIVE", 2);
  },
  /** HOST_TUNED_IDLE_MINUTES: an endpoint nobody has used for this long stops, 15 by default. */
  get hostTunedIdleMinutes(): number {
    return number("HOST_TUNED_IDLE_MINUTES", 15);
  },
  /** HOST_TUNED_MAX_MINUTES: the longest any endpoint runs, used or not, 240 by default. */
  get hostTunedMaxMinutes(): number {
    return number("HOST_TUNED_MAX_MINUTES", 240);
  },

  /** TRY_TUNED: anyone may chat with a tuned model on its public page, and wake it within the limits below. Also needs HOST_TUNED. */
  get tryTuned(): boolean {
    return flag("TRY_TUNED");
  },
  /** TRY_TUNED_DAILY_USD: the most visitors' wakes may promise per UTC day, 10 by default. Held to HOST_TUNED_DAILY_USD. 0 stops wakes. */
  get tryTunedDailyUsd(): number {
    return dollars("TRY_TUNED_DAILY_USD", 10);
  },
  /** TRY_TUNED_WAKES_PER_DAY: visitors' wakes per UTC day across every model, 4 by default. 0 stops wakes. */
  get tryTunedWakesPerDay(): number {
    return wholeCount("TRY_TUNED_WAKES_PER_DAY", 4);
  },
  /** TRY_TUNED_MINUTES: the longest a visitor's wake runs, 60 by default. Held to HOST_TUNED_MAX_MINUTES. */
  get tryTunedMinutes(): number {
    return number("TRY_TUNED_MINUTES", 60);
  },
  /** EXPORT_TUNED: one-click installers on a tuned model's public page, and their route. Off: the route answers 404. */
  get exportTuned(): boolean {
    return flag("EXPORT_TUNED");
  },

  // ---------- Wave 3, unit 12: drive export (docs/CAPABILITIES.md) ----------

  /**
   * DRIVE_EXPORT_ENABLED: the Flash drive card on /device, its links from the board's runs and lab models, and
   * /api/device/drive (docs/DRIVE_EXPORT.md). Off: the card isn't shown and the routes answer 404, touching nothing.
   */
  get driveExportEnabled(): boolean {
    return flag("DRIVE_EXPORT_ENABLED");
  },
  /**
   * DRIVE_EXPORT_PRODUCTS: the product gadget tools drive_status and export_to_drive (lib/device/drive-product.ts). They
   * also need HARDWARE_GADGET_OWNER_CHECK: see driveToolsUsable.
   */
  get driveExportProducts(): boolean {
    return flag("DRIVE_EXPORT_PRODUCTS");
  },
  /** Both DRIVE_EXPORT_PRODUCTS and HARDWARE_GADGET_OWNER_CHECK: products may be built with the drive tools. */
  get driveToolsUsable(): boolean {
    return flag("DRIVE_EXPORT_PRODUCTS") && flag("HARDWARE_GADGET_OWNER_CHECK");
  },

  // ---------- Wave 3, unit 13: hardware (docs/CAPABILITIES.md) ----------

  /** HARDWARE_BOARD_TOOLS: read_sensor and show_text, for products whose brief asks for them. HARDWARE_ENABLED is read through enabledCaps. */
  get hardwareBoardTools(): boolean {
    return flag("HARDWARE_BOARD_TOOLS");
  },
  /** Both HARDWARE_BOARD_TOOLS and HARDWARE_GADGET_OWNER_CHECK: products may be built with board tools. */
  get hardwareBoardToolsUsable(): boolean {
    return flag("HARDWARE_BOARD_TOOLS") && flag("HARDWARE_GADGET_OWNER_CHECK");
  },
  /** HARDWARE_BOARD_REGISTRY: /api/boards, linking a board to a product, and the board lists on /device and /gadgets. Admins only (decision 16). */
  get hardwareBoardRegistry(): boolean {
    return flag("HARDWARE_BOARD_REGISTRY") || flag("GADGET_CONNECT");
  },
  /** GADGET_CONNECT (lib/caps/hardware/flags.ts): pair your own board, inference on it, and a simulated robot. Off by default. */
  get gadgetConnect(): boolean {
    return flag("GADGET_CONNECT");
  },
  /**
   * HARDWARE_GADGET_OWNER_CHECK: a live token reaches only the board its product's owner linked, and a visitor only when
   * the link says so. Off: every live product with the gadget option reaches DEVICE_MCP_URL, as before. Turn this on
   * before DEVICE_MCP_URL reaches production.
   */
  get hardwareGadgetOwnerCheck(): boolean {
    return flag("HARDWARE_GADGET_OWNER_CHECK");
  },
  /** HARDWARE_BOARD_KEY: 32 bytes in base64, or a ring "v1:<key>,v2:<key>" (lib/secrets/box.ts). Platform only. */
  get hardwareBoardKey(): string | null {
    return optional("HARDWARE_BOARD_KEY");
  },
};
