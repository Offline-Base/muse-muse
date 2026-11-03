/**
 * The pure half of scripts/backfill-live-urls.ts: which stored live links are the long team-scoped vercel.app address, what
 * their short alias is, and whether two pages came from the same deployment. No network and no database here.
 */
import { projectNameFor } from "@/lib/publish/vercel";

/** The short address Vercel gives a product's project: https://musemuse-<slug>.vercel.app. */
export function shortAliasFor(slug: string): string {
  return `https://${projectNameFor(slug)}.vercel.app`;
}

/**
 * The short alias to try for a product, or null when its link is already short or isn't one of ours. Long means the
 * team-scoped production address, musemuse-<slug>-<team>.vercel.app, which an early link could get (lib/publish/vercel.ts,
 * pollDeploy). Anything else (a custom domain, a deployment's own hash address, another project) is left alone.
 */
export function longLinkAlias(liveUrl: string | null | undefined, slug: string): string | null {
  if (!liveUrl) return null;
  let url: URL;
  try {
    url = new URL(liveUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  const short = new URL(shortAliasFor(slug)).host;
  const host = url.host.toLowerCase();
  if (host === short) return null;
  const name = short.slice(0, -".vercel.app".length);
  // The team suffix is one or more dash-separated words, as Vercel writes it ("ethan-6436s-projects").
  return host.startsWith(`${name}-`) && host.endsWith(".vercel.app") && /^[a-z0-9-]+$/.test(host.slice(name.length + 1, -".vercel.app".length))
    ? `https://${short}`
    : null;
}

/**
 * The deployment a Next.js page on Vercel came from. Its asset links carry `?dpl=dpl_...` (skew protection), so one id
 * across the page is the deployment. None, or more than one, is null: then this can't tell, and the link stays as it is.
 */
export function deploymentIdOf(html: string): string | null {
  const ids = new Set(html.match(/\bdpl_[A-Za-z0-9]{8,}\b/g) ?? []);
  return ids.size === 1 ? [...ids][0] : null;
}

/** What the script saw at one address. */
export interface PageCheck {
  status: number;
  deploymentId: string | null;
}

export type BackfillDecision = { update: true; to: string } | { update: false; why: string };

/**
 * Whether to point a product at its short alias: only when both addresses answer 200 and name the same deployment, so a
 * product never moves to an alias serving something else.
 */
export function decideBackfill(input: { alias: string; long: PageCheck; short: PageCheck }): BackfillDecision {
  if (input.short.status !== 200) return { update: false, why: `the short link answered ${input.short.status || "nothing"}` };
  if (input.long.status !== 200) return { update: false, why: `the stored link answered ${input.long.status || "nothing"}` };
  if (!input.short.deploymentId || !input.long.deploymentId) return { update: false, why: "a page didn't say which deployment it came from" };
  if (input.short.deploymentId !== input.long.deploymentId) {
    return { update: false, why: `they serve different deployments (${input.long.deploymentId} and ${input.short.deploymentId})` };
  }
  return { update: true, to: input.alias };
}
