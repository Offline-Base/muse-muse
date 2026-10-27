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
  /** Platform-wide daily spend cap across every build and product, in USD. The kill switch for runaway cost. */
  get dailySpendCapUsd() {
    return number("DAILY_SPEND_CAP_USD", 40);
  },
};
