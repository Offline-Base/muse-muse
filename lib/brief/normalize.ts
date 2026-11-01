import { ASKED_LOOK_MAX, MAX_AGENT_STEPS, MAX_AGENT_TOOLS, type Brief } from "@/lib/brief/schema";
import type { RebuildTarget, Reference } from "@/lib/types";

/**
 * Deterministic cleanup of the brief writer's JSON, before and after zod. Fixes what a retry would waste a model call
 * on (slug format, lengths, em dashes) and states facts the model may get wrong (reference kinds, rebuild fit).
 */

/** User-facing copy never contains em dashes (Ethan's rule). */
export function noEmDashes(s: string): string {
  return s
    .replace(/\s*—\s*$/g, "")
    .replace(/^\s*—\s*/g, "")
    .replace(/\s*—\s*/g, ", ");
}

/** Trims every string and removes em dashes, deeply. */
export function cleanStrings<T>(value: T): T {
  if (typeof value === "string") return noEmDashes(value).trim() as T;
  if (Array.isArray(value)) return value.map(cleanStrings) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanStrings(v)])) as T;
  }
  return value;
}

export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > max / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, "");
}

/** Cuts at a word boundary and drops trailing punctuation. */
export function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/g, "");
}

function snakeCase(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(out) ? out : `do_${out || "action"}`;
}

type Loose = Record<string, unknown>;

function asArray(v: unknown): Loose[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Loose[]) : [];
}

/** Runs on the raw JSON before zod. Leaves anything it doesn't recognize for zod to report. */
export function normalizeRawBrief(raw: unknown, references: Reference[]): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const b = cleanStrings(raw) as Loose;

  if (typeof b.name === "string") b.name = clamp(b.name, 60);
  if (typeof b.tagline === "string") b.tagline = clamp(b.tagline, 120);
  const slugSource = typeof b.slug === "string" && b.slug ? b.slug : typeof b.name === "string" ? b.name : "";
  b.slug = slugify(slugSource) || "product";

  if (b.verdict !== "no") b.refusal = null;
  // askedLook (MUSE_APP_LOOK): an empty ask is no ask, and a long one is cut to the schema's limit.
  if (typeof b.askedLook === "string") b.askedLook = b.askedLook.trim() ? clamp(b.askedLook.trim(), ASKED_LOOK_MAX) : null;
  if (Array.isArray(b.primaryFlow)) b.primaryFlow = b.primaryFlow.filter((s) => typeof s !== "string" || s).slice(0, 8);
  if (Array.isArray(b.screens)) b.screens = b.screens.slice(0, 5);
  for (const a of asArray(b.actions)) if (typeof a.name === "string") a.name = snakeCase(a.name);
  if (typeof b.estimatedCostPerRunUsd === "number") {
    b.estimatedCostPerRunUsd = Math.max(0, Math.round(b.estimatedCostPerRunUsd * 10_000) / 10_000);
  }

  const insp = b.inspiration as Loose | undefined;
  if (insp && Array.isArray(insp.references)) {
    let refs = asArray(insp.references);
    const indexes = refs.map((r) => r.index).filter((i): i is number => typeof i === "number");
    // The model sometimes numbers references from 1, like their labels. Only an index equal to the reference count
    // proves it (0-based indexes stop one short), so a partial 0-based list is left alone.
    const oneBased =
      !indexes.includes(0) && indexes.includes(references.length) && indexes.every((i) => i >= 1 && i <= references.length);
    if (oneBased) {
      refs = refs.map((r) => ({ ...r, index: (r.index as number) - 1 }));
      // The fixtures' reference numbers come from the same reply, so they shift too.
      for (const f of asArray(b.fixtures)) if (typeof f.referenceIndex === "number") f.referenceIndex -= 1;
    }
    const byIndex = new Map<number, Loose>();
    for (const r of refs) {
      const i = r.index;
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= references.length || byIndex.has(i)) continue;
      byIndex.set(i, { ...r, kind: references[i].kind });
    }
    insp.references = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, r]) => r);
  }

  // Duplicates only: which targets and tools stay is applyTargets' call, once zod has passed.
  if (Array.isArray(b.targets)) {
    const seen = new Set<unknown>();
    b.targets = asArray(b.targets).filter((t) => !seen.has(t.id) && Boolean(seen.add(t.id)));
    for (const t of b.targets as Loose[]) if (typeof t.why === "string") t.why = clamp(t.why, 200);
  }
  const agent = b.agent as Loose | null | undefined;
  if (agent && Array.isArray(agent.tools)) {
    const seen = new Set<unknown>();
    const tools = asArray(agent.tools).filter((t) => !seen.has(t.id) && Boolean(seen.add(t.id))).slice(0, MAX_AGENT_TOOLS);
    agent.tools = tools;
    if (typeof agent.task === "string") agent.task = clamp(agent.task, 400);
    if (typeof agent.stepsPerRun === "number") agent.stepsPerRun = Math.min(Math.max(1, Math.round(agent.stepsPerRun)), MAX_AGENT_STEPS);
    // No tools isn't an agent. Null gets the one repair call from targetProblems, then applyTargets' web search.
    if (!tools.length) b.agent = null;
  }

  // A sample can only come from the user when they gave a reference of that kind.
  const kinds = new Set(references.map((r) => r.kind as string));
  for (const f of asArray(b.fixtures)) {
    if (f.fromUserSample === true && !kinds.has(String(f.kind))) f.fromUserSample = false;
    const i = f.referenceIndex;
    const valid = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < references.length && references[i].kind === f.kind;
    if (f.fromUserSample !== true || !valid) f.referenceIndex = null;
  }
  return b;
}

/** Problems worth one repair call. */
export function briefProblems(brief: Brief, references: Reference[]): string[] {
  const problems: string[] = [];
  const covered = new Set(brief.inspiration.references.map((r) => r.index));
  const missing = references.map((_, i) => i).filter((i) => !covered.has(i));
  if (missing.length) {
    problems.push(
      `inspiration.references needs one entry per reference. Missing: ${missing.map((i) => `index ${i} (Reference ${i + 1}, ${references[i].fileName})`).join(", ")}.`,
    );
  }
  if (brief.verdict === "no" && !brief.refusal) problems.push('refusal must explain why when verdict is "no".');
  return problems;
}

/** Patches what the repair call didn't fix, so a brief is always complete. */
export function patchBrief(brief: Brief, references: Reference[]): Brief {
  const covered = new Set(brief.inspiration.references.map((r) => r.index));
  const added = references
    .map((r, index) => ({ index, kind: r.kind, describes: `${r.fileName} (${r.kind}). The brief writer did not describe it.` }))
    .filter((r) => !covered.has(r.index));
  return {
    ...brief,
    refusal: brief.verdict === "no" && !brief.refusal ? "Muse Muse can't make this with the models it has." : brief.refusal,
    inspiration: {
      ...brief.inspiration,
      references: [...brief.inspiration.references, ...added].sort((a, b) => a.index - b.index),
    },
  };
}

/** States a rebuild's fit honestly, whatever the model wrote. */
export function applyRebuildFit(brief: Brief, target: RebuildTarget): Brief {
  if (brief.verdict === "no") return brief;
  const fit = target.rebuild.fit;
  const verdict = fit === "partial" && brief.verdict === "yes" ? "partly" : brief.verdict;
  const hasFitLimit = brief.limits.some((l) => /rebuild fit/i.test(l));
  const limits = hasFitLimit
    ? brief.limits
    : [`Rebuild fit: ${fit}. ${noEmDashes(target.rebuild.plan)}`, ...brief.limits];
  return { ...brief, verdict, limits };
}
