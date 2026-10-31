// Works out what the app should open when it starts, from the build's settings, launch arguments and any deep link.
//
// Production shells open products by slug only, because *.vercel.app and *.vercel.run names can be claimed by anyone,
// so only the platform can vouch for a URL. Only the lab variant takes raw URLs.

export type AppVariant = "production" | "lab";

export interface LaunchEnv {
  variant: AppVariant;
  /** The glasses build. Sets whether glasses options are honored at all. */
  glasses: boolean;
  /** Set only in per-product APKs: the one URL this app ever opens. */
  productUrl?: string | null;
}

/** What a deep link or launch arguments asked for, before the variant's rules are applied. */
export interface LaunchRequest {
  slug?: string;
  url?: string;
  selftest?: boolean;
  /** A signed token from the platform, for posting the health report. */
  token?: string;
  /** Another platform to report to, for Preview deployments. Lab only. */
  platform?: string;
  mock?: boolean;
  autopilot?: boolean;
}

export interface LabOptions {
  selftest: { token: string | null; platformUrl: string | null } | null;
  glasses: { mock: boolean; autopilot: boolean } | null;
}

export type LaunchTarget =
  | { kind: "slug"; slug: string }
  | ({ kind: "url"; url: string } & LabOptions)
  | { kind: "list"; notice?: string };

export const SLUG_MAX = 40;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEEP_LINK_SCHEMES = new Set(["musemuse:", "musemuse-lab:", "exp:", "exps:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2", "[::1]"]);

/** Matches the platform's normalizeSlug rule: lowercase letters, digits and single dashes. */
export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);
}

/** https anywhere, or http on the machine itself for a local run. */
export function isOpenableUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

function truthy(value: string | null): boolean {
  return value === "1" || value === "true";
}

/**
 * Reads musemuse://open?slug=, musemuse://check?url=, and Expo Go's exp://u.expo.dev/<id>/--/open?slug= and
 * /--/p/<slug>. Returns null for anything else, including the callback links Meta AI sends the glasses module.
 */
export function parseDeepLink(raw: string | null | undefined): LaunchRequest | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!DEEP_LINK_SCHEMES.has(url.protocol)) return null;
  if (url.searchParams.has("metaWearablesAction")) return null;

  const isExpoGo = url.protocol === "exp:" || url.protocol === "exps:";
  // musemuse://open puts "open" in the host. Expo Go puts the app's path after "/--/".
  const path = isExpoGo
    ? url.pathname.split("/--/")[1] ?? ""
    : [url.hostname, url.pathname.replace(/^\/+/, "")].filter(Boolean).join("/");
  const [action, value] = path.split("/");

  if (action !== "open" && action !== "check" && action !== "p") return null;
  const q = url.searchParams;
  const request: LaunchRequest = {};
  const slug = action === "p" ? value : q.get("slug");
  if (slug) request.slug = slug;
  if (q.get("url")) request.url = q.get("url") as string;
  if (truthy(q.get("selftest"))) request.selftest = true;
  if (q.get("token")) request.token = q.get("token") as string;
  if (q.get("platform")) request.platform = q.get("platform") as string;
  if (truthy(q.get("mock"))) request.mock = true;
  if (q.get("run") === "autopilot") request.autopilot = true;
  return request;
}

/** iOS launch arguments, read through React Native's Settings: -museUrl, -museSlug, -museSelftest, -museToken. */
export function launchArgsToRequest(args: Record<string, unknown>): LaunchRequest | null {
  const request: LaunchRequest = {};
  if (typeof args.museSlug === "string" && args.museSlug) request.slug = args.museSlug;
  if (typeof args.museUrl === "string" && args.museUrl) request.url = args.museUrl;
  if (args.museSelftest === "1" || args.museSelftest === 1 || args.museSelftest === true) request.selftest = true;
  if (typeof args.museToken === "string" && args.museToken) request.token = args.museToken;
  if (typeof args.musePlatform === "string" && args.musePlatform) request.platform = args.musePlatform;
  if (args.museMock === "1" || args.museMock === 1 || args.museMock === true) request.mock = true;
  if (args.museRun === "autopilot") request.autopilot = true;
  return Object.keys(request).length > 0 ? request : null;
}

function targetFromRequest(env: LaunchEnv, request: LaunchRequest): LaunchTarget {
  if (env.variant === "lab" && request.url !== undefined) {
    if (!isOpenableUrl(request.url)) return { kind: "list", notice: "That link can't be opened here." };
    return {
      kind: "url",
      url: request.url,
      selftest: request.selftest
        ? {
            token: request.token ?? null,
            platformUrl: isOpenableUrl(request.platform) ? request.platform : null,
          }
        : null,
      glasses: env.glasses ? { mock: Boolean(request.mock), autopilot: Boolean(request.autopilot) } : null,
    };
  }
  if (request.slug !== undefined) {
    if (isValidSlug(request.slug)) return { kind: "slug", slug: request.slug };
    return { kind: "list", notice: "That product link isn't right." };
  }
  if (request.url !== undefined) return { kind: "list", notice: "This app only opens Muse Muse products." };
  return { kind: "list" };
}

/** A per-product APK ignores everything else, so no link can point it at another site. */
export function chooseLaunchTarget(
  env: LaunchEnv,
  sources: { launchArgs?: LaunchRequest | null; deepLink?: LaunchRequest | null },
): LaunchTarget {
  if (env.productUrl) {
    if (!isOpenableUrl(env.productUrl)) return { kind: "list", notice: "This app was packaged with a bad link." };
    return { kind: "url", url: env.productUrl, selftest: null, glasses: null };
  }
  const request = sources.launchArgs ?? sources.deepLink;
  return request ? targetFromRequest(env, request) : { kind: "list" };
}

/** Links the app receives while it's already open. A per-product app stays where it is. */
export function targetForRunningApp(env: LaunchEnv, raw: string | null | undefined): LaunchTarget | null {
  if (env.productUrl) return null;
  const request = parseDeepLink(raw);
  return request ? targetFromRequest(env, request) : null;
}
