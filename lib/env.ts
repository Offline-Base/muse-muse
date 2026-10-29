import { DRIVE_TERMS_DEFAULT_VERSION } from "@/lib/drive/terms";
import { publicHost } from "@/lib/sandbox/policy";

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

/** Muse Wonder, Meta's strongest model, is every platform role's default (docs/DESIGN.md, Model routing). */
export const DEFAULT_PLATFORM_MODEL = "muse-wonder-1.0";

const warnedContributor = new Set<string>();

/**
 * A model id from the environment, or the fallback. A contributor model (any id ending in "-contributor") is never
 * used: Meta may train on its prompts, which hold people's muses. It is ignored with one warning per variable.
 */
function model(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (/-contributor$/i.test(value)) {
    if (!warnedContributor.has(name)) {
      warnedContributor.add(name);
      console.warn(`${name} names a contributor model, which Meta may train on, so ${fallback} is used instead.`);
    }
    return fallback;
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
  get databaseUrl() {
    return required("DATABASE_URL");
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
   * with VERCEL_TOKEN set: the product would call this machine's gateway (GATEWAY_URL), which Vercel can't reach.
   */
  get publishOffReason(): string | null {
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
  /** Public origin of this platform, with no trailing slash. Products reach the gateway here. */
  get platformUrl() {
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
   * DRIVE_BENCH_TOKEN_HASH: the SHA-256 of the bench script's token (benchTokenHash in lib/drive/token.ts), or null. The
   * token itself lives only on the bench Mac, as DRIVE_BENCH_TOKEN; `npx tsx scripts/drive-bench.ts token` makes a pair
   * without any platform secret.
   */
  get driveBenchTokenHash(): string | null {
    const hash = process.env.DRIVE_BENCH_TOKEN_HASH?.trim().toLowerCase() ?? "";
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  },
};
