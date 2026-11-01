import { z } from "zod";
import { dataBlock } from "@/lib/caps/data/brief";
import { COLLECTION_NAME } from "@/lib/caps/data/types";
import { jobsWebhooksOn } from "@/lib/caps/jobs/flags";
import { JOB_NAME } from "@/lib/caps/jobs/limits";
import { parseEvery } from "@/lib/caps/jobs/schedule";

/**
 * The jobs cap's brief block (docs/CAPABILITIES.md, section 12): the schedules a product runs, the webhooks that start
 * its jobs, and `results`, the data block's collections its jobs may save to. Jobs read and notify. A job's writes go only
 * to `results`, and its sends wait for the owner.
 */
export const MAX_SCHEDULES = 3;
export const MAX_WEBHOOKS = 2;
export const MAX_RESULTS = 3;

const name = z.string().min(1).max(40);
const says = z.string().min(1).max(200);

export const JobsBriefBlock = z.object({
  schedules: z.array(z.object({ name, every: z.string().min(1).max(60), does: says })).max(MAX_SCHEDULES),
  webhooks: z.array(z.object({ name, from: says, does: says })).max(MAX_WEBHOOKS),
  results: z.array(z.string().min(1).max(32)).max(MAX_RESULTS),
});

export type JobsBrief = z.infer<typeof JobsBriefBlock>;

/** The writer's block: no webhooks while JOBS_WEBHOOKS is off. */
export const jobsWriterBlock = (webhooks: boolean = jobsWebhooksOn()) =>
  z.object({
    schedules: JobsBriefBlock.shape.schedules,
    webhooks: z.array(z.object({ name, from: says, does: says })).max(webhooks ? MAX_WEBHOOKS : 0),
    results: JobsBriefBlock.shape.results,
  });

/** Collections a job may save to: listed in the data block, shared or owner, and never a person's own. */
function usableResults(brief: object | null | undefined, results: readonly string[]): string[] {
  const list = dataBlock(brief)?.collections ?? [];
  return results.filter((r) => list.some((c) => c.name === r && (c.scope === "shared" || c.scope === "owner")));
}

/**
 * The brief's jobs block as this platform can serve it, or null. Webhooks go while JOBS_WEBHOOKS is off, and results go
 * with a dropped data cap. Every step reads this, so the prompt, the judge and the checks agree. A block left with no
 * schedule and no webhook is null, and capsForBuild's drop says so.
 */
export function jobsBlock(brief: object | null | undefined, webhooks: boolean = jobsWebhooksOn()): JobsBrief | null {
  const parsed = JobsBriefBlock.safeParse((brief as { jobs?: unknown } | null | undefined)?.jobs);
  if (!parsed.success) return null;
  const block: JobsBrief = { schedules: parsed.data.schedules, webhooks: webhooks ? parsed.data.webhooks : [], results: usableResults(brief, parsed.data.results) };
  return block.schedules.length || block.webhooks.length ? block : null;
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

function slug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const out = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40);
  return JOB_NAME.test(out) ? out : null;
}

/**
 * The writer's raw jobs block, cleaned before zod (normalizeRawBrief): names as route segments, each once; schedules the
 * platform can read, with below 15 minutes raised to 15; text clipped; results only from the data block. A block that
 * asks for nothing becomes null.
 */
export function normalizeJobsBlock(raw: unknown, data: unknown, webhooks: boolean = jobsWebhooksOn()): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? clip(v.trim(), 200) : fallback);
  const seen = new Set<string>();
  const fresh = (n: string | null): n is string => n !== null && !seen.has(n) && Boolean(seen.add(n));
  b.schedules = list(b.schedules)
    .flatMap((s) => {
      const r = (s ?? {}) as Record<string, unknown>;
      const n = slug(r.name);
      if (!fresh(n) || !parseEvery(r.every)) return [];
      return [{ name: n, every: clip(String(r.every).trim(), 60), does: text(r.does, n) }];
    })
    .slice(0, MAX_SCHEDULES);
  b.webhooks = webhooks
    ? list(b.webhooks)
        .flatMap((s) => {
          const r = (s ?? {}) as Record<string, unknown>;
          const n = slug(r.name);
          return fresh(n) ? [{ name: n, from: text(r.from, "another service"), does: text(r.does, n) }] : [];
        })
        .slice(0, MAX_WEBHOOKS)
    : [];
  const collections = list((data as { collections?: unknown } | null | undefined)?.collections) as Array<{ name?: unknown; scope?: unknown }>;
  b.results = [...new Set(list(b.results).filter((r): r is string => typeof r === "string" && COLLECTION_NAME.test(r)))]
    .filter((r) => collections.some((c) => c?.name === r && (c?.scope === "shared" || c?.scope === "owner")))
    .slice(0, MAX_RESULTS);
  if (!(b.schedules as unknown[]).length && !(b.webhooks as unknown[]).length) return null;
  return b;
}

/** The writer's rules (lib/caps/brief-fields.ts, CAP_WRITER_RULES), following JOBS_WEBHOOKS. */
export function jobsWriterRules(webhooks: boolean = jobsWebhooksOn()): readonly string[] {
  return [
    "jobs: fill it only when the muse needs work that happens with nobody on the page: a daily digest, a check every hour, a long task that runs in steps" + (webhooks ? ", or something another service starts" : "") + ". Otherwise null. Jobs read and tell the owner. Nothing a job does goes out to anyone until the owner confirms it, so never promise automatic emails, posts or payments: say in limits that the owner approves them.",
    `jobs.schedules: up to ${MAX_SCHEDULES}, each {name, every, does}. name is lowercase letters, digits and dashes. every is one of "15 minutes" (the shortest), "2 hours", "1 day at 07:30", "1 week at 09:00 America/New_York": a time zone only when the muse names a place, otherwise UTC. does is one plain sentence. Empty when nothing runs on a clock.`,
    webhooks
      ? `jobs.webhooks: up to ${MAX_WEBHOOKS}, each {name, from, does}: another service posts to a private address and that starts the job named name. from says which service. Empty when none.`
      : "jobs.webhooks: []. Other services can't start a product's jobs yet.",
    `jobs.results: up to ${MAX_RESULTS} collections from the data block, shared or owner scope, that jobs save to. Fill in the data block for them, since the result has to show on a screen, like "Last digest". A job can't save anywhere else or to anyone's private items.`,
    "Add to limits: schedules stop after 14 days with no visit from the owner, until the owner visits again.",
  ];
}
