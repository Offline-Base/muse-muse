import { z } from "zod";

/**
 * FULL_BUILDS (docs/FULL_BUILDS.md): the numbered list of everything a person asked for, plus what a complete product
 * needs for that request. The list follows the build from the brief to the checklist the person sees: it sets the
 * milestones, the tests that must exist and what the judge checks. Only zod here, so lib/brief/schema.ts can import it.
 */

/** Schema limits with FULL_BUILDS. Set well above any real request, and only there to keep a runaway reply bounded. */
export const FULL_LIMITS = { primaryFlow: 40, screens: 30, requirements: 60 } as const;
/** How many requirements one milestone round takes on. */
export const REQUIREMENTS_PER_MILESTONE = 4;
/** REFINE_ROUND_STRIDE is 10, and milestones plus 3 fix rounds must stay under it. */
export const FULL_MILESTONES_MAX = 6;
/** CHAINED_BUILDS (docs/CHAINED_BUILDS.md): rounds run across sessions, so the stride's limit is the chain's own. */
export const CHAIN_MILESTONES_MAX = 40;
export const CHAIN_REQUIREMENTS_MAX = 200;

/** The most requirements a brief may have here. Read as lib/env.ts reads a flag, since only zod may be imported. */
export function requirementsMax(): number {
  const on = (name: string) => ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
  return on("CHAINED_BUILDS") && on("FULL_BUILDS") ? CHAIN_REQUIREMENTS_MAX : FULL_LIMITS.requirements;
}

export const RequirementSchema = z.object({
  id: z.string().regex(/^R[1-9][0-9]*$/),
  /** One thing the finished product does, in plain words someone could test. */
  text: z.string().min(1),
  /** "asked": the person asked for it. "needed": a complete product needs it for that request. */
  kind: z.enum(["asked", "needed"]),
  /** The person's own words this comes from. Empty for a "needed" one. */
  words: z.string(),
  /** It saves something that must still be there after a reload. */
  savesData: z.boolean(),
  /** False only for a part Muse Muse truly can't do, which is then named to the person. */
  canDo: z.boolean(),
  /** Why it can't be done, in one plain sentence to the person. Null when it can. */
  cantDoWhy: z.string().nullable(),
});

export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementsSchema = z.array(RequirementSchema).min(1).max(FULL_LIMITS.requirements);
/** What a stored brief or a chained build's writer may hold. */
export const ChainRequirementsSchema = z.array(RequirementSchema).min(1).max(CHAIN_REQUIREMENTS_MAX);

/** The independent check's record on the brief (lib/full/scope.ts). */
export const ScopeRecordSchema = z.object({
  /** False when the check couldn't run, so the person and the build log can say so. */
  ran: z.boolean(),
  /** How many times the brief was sent back. */
  sentBack: z.number().int().nonnegative(),
  asks: z.array(z.object({ ask: z.string(), covered: z.boolean() })),
  /** What the writer still left out after being sent back, which code added as requirements. */
  added: z.array(z.string()),
});

export type ScopeRecord = z.infer<typeof ScopeRecordSchema>;

export type RequirementState = "met" | "unmet" | "cant" | "unchecked";

/** One line of the person's checklist. */
export interface RequirementResult {
  id: string;
  text: string;
  state: RequirementState;
  /** What was seen, or why it failed. */
  detail?: string;
}

/** What verify's fixed check found for one requirement (verify.mjs, requirementResults). */
export interface RequirementTest {
  id: string;
  ok: boolean;
  detail?: string;
}

/** The judge's own read of one requirement, from the screenshots. */
export interface RequirementRead {
  id: string;
  met: boolean;
  evidence: string;
}

type WithRequirements = { requirements?: Requirement[] | null; chained?: boolean | null };

export function briefRequirements(brief: WithRequirements | null | undefined): Requirement[] {
  return Array.isArray(brief?.requirements) ? brief.requirements : [];
}

/** What gets built and checked: everything but the parts named as impossible. */
export function buildableRequirements(brief: WithRequirements | null | undefined): Requirement[] {
  return briefRequirements(brief).filter((r) => r.canDo);
}

/**
 * The writer's list, cleaned before zod: usable rows, numbered from R1 in the writer's order, with a why on every part it
 * can't do. Anything that isn't a list is left for zod to report.
 */
export function normalizeRequirements(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && typeof (r as { text?: unknown }).text === "string" && Boolean(((r as { text: string }).text).trim()))
    .slice(0, requirementsMax())
    .map((r, i) => {
      const canDo = r.canDo !== false;
      const why = typeof r.cantDoWhy === "string" && r.cantDoWhy.trim() ? r.cantDoWhy.trim() : null;
      return {
        ...r,
        id: `R${i + 1}`,
        kind: r.kind === "needed" ? "needed" : "asked",
        words: typeof r.words === "string" ? r.words : "",
        savesData: r.savesData === true,
        canDo,
        cantDoWhy: canDo ? null : (why ?? "Muse Muse can't do this part yet."),
      };
    });
}

/** A brief with parts it can't do says "partly" and lists each one as a limit, so none goes unnamed. */
export function nameWhatItCantDo<T extends { verdict: "yes" | "partly" | "no"; limits: string[] } & WithRequirements>(brief: T): T {
  const cant = briefRequirements(brief).filter((r) => !r.canDo);
  if (!cant.length || brief.verdict === "no") return brief;
  const lines = cant.map((r) => `Can't do: ${r.text}. ${r.cantDoWhy ?? ""}`.trim());
  return { ...brief, verdict: "partly", limits: [...brief.limits, ...lines.filter((l) => !brief.limits.includes(l))] };
}

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const NAV = /navigat|menu|tab|sidebar|move between|switch between|go between/i;
const EDIT = /edit|chang|updat|renam/i;
const DELETE = /delet|remov/i;
const EMPTY = /empty|nothing (yet|saved)|no .{1,30} yet|first (use|visit|time)/i;
const ERROR = /error|fail|goes wrong|can't load|retry|try again/i;
const SAVED = /reload|refresh|come back|return|stays? saved|still there|persist/i;

/**
 * Code's own check of the list, before any model reads it. Each problem is worth a repair call. `note` is what the person
 * typed. Pass null when their words may be elsewhere (a voice memo, a PDF, a rebuild's description), since then a quote
 * can't be checked against it.
 */
export function requirementProblems(brief: { screens: unknown[]; verdict: string } & WithRequirements, note: string | null): string[] {
  if (brief.verdict === "no") return [];
  const list = briefRequirements(brief);
  if (!list.length) return ["requirements must list every feature, screen and workflow the person asked for."];
  const problems: string[] = [];
  const text = list.map((r) => r.text).join("\n");
  const saves = list.some((r) => r.savesData);
  const needs: Array<[boolean, RegExp, string]> = [
    [brief.screens.length > 1, NAV, "how the person moves between the screens (navigation)"],
    [saves, SAVED, "that saved data is still there after a reload"],
    [saves, EDIT, "editing what was saved"],
    [saves, DELETE, "deleting what was saved"],
    [saves, EMPTY, "what the person sees before anything is saved (the empty state)"],
    [true, ERROR, "what the person sees when something fails (the error state)"],
  ];
  for (const [applies, pattern, what] of needs) if (applies && !pattern.test(text)) problems.push(`requirements has no "needed" entry for ${what}.`);
  if (note?.trim()) {
    const said = flat(note);
    const made = list.filter((r) => r.kind === "asked" && r.words.trim() && !said.includes(flat(r.words)));
    if (made.length) problems.push(`${made.map((r) => r.id).join(", ")}: words must be copied exactly from the person's note, and these aren't in it.`);
    const unsourced = list.filter((r) => r.kind === "asked" && !r.words.trim());
    if (unsourced.length) problems.push(`${unsourced.map((r) => r.id).join(", ")}: an "asked" requirement needs the person's words. If they didn't ask for it, its kind is "needed".`);
  }
  return problems;
}

const COMMON = new Set("about after again also because been before being build could every first from have into just like make made more most much only other over please should some that their them then there these they thing things this those through time using very want wants what when where which while will with would your really need needs able".split(" "));

/** The longer words of a note that appear nowhere in the plan, matched on their first five letters. */
export function wordsLeftOut(note: string | null, planText: string): string[] {
  if (!note?.trim()) return [];
  const words = (s: string) => flat(s).split(" ").filter((w) => w.length >= 5 && !COMMON.has(w));
  const plan = new Set(words(planText).map((w) => w.slice(0, 5)));
  return [...new Set(words(note))].filter((w) => !plan.has(w.slice(0, 5)));
}

/**
 * The milestones of a full build, from the requirements in the order the writer put them: at most FULL_MILESTONES_MAX,
 * each ending with its requirements working. Made by code, so no requirement can fall between two of them.
 */
export function fullMilestones(brief: WithRequirements): Array<{ title: string; doneMeans: string; requirementIds: string[] }> {
  const list = buildableRequirements(brief);
  if (!list.length) return [];
  const count = Math.min(brief.chained === true ? CHAIN_MILESTONES_MAX : FULL_MILESTONES_MAX, Math.ceil(list.length / REQUIREMENTS_PER_MILESTONE));
  const size = Math.ceil(list.length / count);
  const out: Array<{ title: string; doneMeans: string; requirementIds: string[] }> = [];
  for (let i = 0; i < count; i++) {
    const part = list.slice(i * size, (i + 1) * size);
    if (!part.length) break;
    const span = part.length === 1 ? part[0].id : `${part[0].id} to ${part[part.length - 1].id}`;
    out.push({
      title: span,
      doneMeans: `These work end to end, each with its own passing test: ${part.map((r) => `${r.id} (${r.text})`).join("; ")}`,
      requirementIds: part.map((r) => r.id),
    });
  }
  return out;
}

/** The product's musemuse.requirements.json: what verify's fixed check holds it to, up to this milestone. */
export function requirementsFile(brief: WithRequirements, upTo?: number): string {
  const list = buildableRequirements(brief);
  const ids = upTo === undefined ? null : new Set(fullMilestones(brief).slice(0, upTo).flatMap((m) => m.requirementIds));
  const requirements = list.filter((r) => !ids || ids.has(r.id)).map((r) => ({ id: r.id, savesData: r.savesData }));
  return `${JSON.stringify({ requirements }, null, 2)}\n`;
}

/**
 * The verdict on every requirement, decided by code. Met needs both proofs: its test passed in verify, and the judge saw
 * it on screen. A part named as impossible stays "cant". Anything with no result is unmet, never assumed.
 */
export function requirementResults(
  list: Requirement[],
  tests: RequirementTest[] | null | undefined,
  reads: RequirementRead[] | null | undefined,
): RequirementResult[] {
  const test = new Map((tests ?? []).map((t) => [t.id, t]));
  const read = new Map((reads ?? []).map((r) => [r.id, r]));
  return list.map((r): RequirementResult => {
    if (!r.canDo) return { id: r.id, text: r.text, state: "cant", detail: r.cantDoWhy ?? undefined };
    const t = test.get(r.id);
    const j = read.get(r.id);
    if (!t) return { id: r.id, text: r.text, state: "unmet", detail: "No test ran for it." };
    if (!t.ok) return { id: r.id, text: r.text, state: "unmet", detail: t.detail || "Its test failed." };
    if (reads === null || reads === undefined) return { id: r.id, text: r.text, state: "unchecked", detail: "Its test passed. The judge hasn't looked yet." };
    if (!j) return { id: r.id, text: r.text, state: "unmet", detail: "The judge didn't report on it." };
    return { id: r.id, text: r.text, state: j.met ? "met" : "unmet", ...(j.evidence ? { detail: j.evidence } : {}) };
  });
}

/** The unmet ones as fix notes and for the final message. */
export function unmetLines(results: RequirementResult[]): string[] {
  return results.filter((r) => r.state === "unmet").map((r) => `${r.id} is not met: ${r.text}.${r.detail ? ` ${r.detail}` : ""}`);
}

/** The latest checklist in a build's check results, newest last. Before any check every requirement is unchecked. */
export function latestChecklist(
  brief: WithRequirements | null | undefined,
  checks: ReadonlyArray<{ judge?: { requirements?: RequirementResult[] } | null; tests?: RequirementTest[] | null }>,
): RequirementResult[] {
  const list = briefRequirements(brief);
  if (!list.length) return [];
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i]!;
    if (c.judge?.requirements?.length) return c.judge.requirements;
    if (c.tests) return requirementResults(list, c.tests, null);
  }
  return list.map((r) => (r.canDo ? { id: r.id, text: r.text, state: "unchecked" as const } : { id: r.id, text: r.text, state: "cant" as const, ...(r.cantDoWhy ? { detail: r.cantDoWhy } : {}) }));
}
