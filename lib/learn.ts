import resources from "@/catalog/meta-resources.json";
import type { RebuildCardView } from "@/components/view-types";
import type { LessonKind, LessonVerdict, RebuildTarget } from "@/lib/types";

/**
 * The Learn page's lessons (app/learn): every one of Meta's videos in catalog/meta-resources.json, in Meta's order,
 * with the Nov 2, 2026 audit's verdict and the improved plan. Pure, so the page and its tests share it.
 */
export const LESSONS = resources.videos as RebuildTarget[];

/**
 * Where a lesson stands on the page.
 *   partly     the audited product is live and does part of the lesson
 *   redo       the audited product skips the lesson, so the page doesn't show it as the answer
 *   new-build  a product other than the audited one has shipped since, and nobody has checked it against the lesson
 *   not-built  nothing for it has shipped
 */
export type LessonState = "partly" | "redo" | "new-build" | "not-built";

export const LESSON_STATES: LessonState[] = ["new-build", "partly", "redo", "not-built"];

export const LESSON_STATE_LABEL: Record<LessonState, string> = {
  "new-build": "New build, not checked yet",
  partly: "Partly there",
  redo: "Wrong, being redone",
  "not-built": "Not built",
};

/** Pill tones from app/globals.css. */
export const LESSON_STATE_TONE: Record<LessonState, string> = {
  "new-build": "building",
  partly: "partial",
  redo: "failed",
  "not-built": "neutral",
};

export const LESSON_SECTION_TITLE: Record<LessonState, string> = {
  "new-build": "Built, not checked against the lesson yet",
  partly: "Partly there",
  redo: "Being redone",
  "not-built": "Not built yet",
};

/** How a product page or build room names the audit's verdict on the product it judged. */
export const VERDICT_LABEL: Record<LessonVerdict, string> = {
  wrong: "Doesn't teach the lesson",
  "partly wrong": "Partly teaches the lesson",
  "not built": "Not built",
};

export const KIND_LABEL: Record<LessonKind, string> = {
  tutorial: "Tutorial",
  talk: "Talk",
  course: "Course",
  "case study": "Case study",
};

const SHIPPED = new Set(["live", "partial"]);

/**
 * `known` is false when the build and product rows couldn't be read. A partly-wrong lesson then keeps the audit's
 * "partly there" state instead of claiming nothing was built.
 */
export function lessonState(
  lesson: RebuildTarget,
  card: Pick<RebuildCardView, "product"> | null | undefined,
  known = true,
): LessonState {
  const product = card?.product && SHIPPED.has(card.product.status) ? card.product : null;
  if (product && product.slug !== lesson.current?.product) return "new-build";
  if (lesson.verdict === "wrong") return "redo";
  if (lesson.verdict === "partly wrong" && (product || (!known && lesson.current))) return "partly";
  return "not-built";
}

/** The lesson's card on the Learn page, for links from a product page or a build room. */
export function lessonHref(id: string): string {
  return `/learn#lesson-${id}`;
}

/** Whether the card may show the product and its demo as the lesson's version. Never for a product judged wrong. */
export function showsProduct(state: LessonState): boolean {
  return state === "partly" || state === "new-build";
}

export function lessonCounts(states: LessonState[]): Record<LessonState, number> {
  const counts: Record<LessonState, number> = { "new-build": 0, partly: 0, redo: 0, "not-built": 0 };
  for (const s of states) counts[s] += 1;
  return counts;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 4, 2025" from "2025-11-04". */
export function longDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
