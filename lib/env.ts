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

export const env = {
  /** The platform's Meta key. Server only. Never sent to products or sandboxes (the firewall injects it). */
  get modelApiKey() {
    return required("MODEL_API_KEY");
  },
  get briefModel() {
    return process.env.BRIEF_MODEL || "muse-spark-1.3";
  },
  get judgeModel() {
    return process.env.JUDGE_MODEL || "muse-spark-1.3";
  },
  get buildModel() {
    return process.env.BUILD_MODEL || "muse-spark-1.3";
  },
  get complexBuildModel() {
    return process.env.COMPLEX_BUILD_MODEL || "muse-wonder-1.0";
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
  /** Platform-wide daily spend cap across every build and product, in USD. The kill switch for runaway cost. */
  get dailySpendCapUsd() {
    return number("DAILY_SPEND_CAP_USD", 40);
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
};
