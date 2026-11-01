import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import { connectJudgeNote } from "@/lib/caps/connect/judge";
import { codeJudgeNote } from "@/lib/caps/code/judge";
import { dataJudgeNote } from "@/lib/caps/data/judge";
import { extensionJudgeNote } from "@/lib/caps/extension/judge";
import { filesJudgeNote } from "@/lib/caps/files/judge";
import { gamesJudgeNote } from "@/lib/caps/games/judge";
import type { CapId } from "@/lib/caps/ids";
import { mediaJudgeNote } from "@/lib/caps/media/judge";
import type { CapProof, VerifySummary } from "@/lib/types";

/**
 * The judge's part in caps (docs/CAPABILITIES.md, 2.8). It never decides a fixed check: those run in verify's caps step.
 * It gets each cap's note (what to look for on the screenshots) and the checks' results as text. One line per cap, in
 * plan order; the text lives in lib/caps/<id>/judge.ts.
 */
export const CAP_JUDGE: Partial<Record<CapId, (brief: Brief) => string>> = {
  data: dataJudgeNote,
  files: filesJudgeNote,
  connect: connectJudgeNote,
  media: mediaJudgeNote,
  code: codeJudgeNote,
  extension: extensionJudgeNote,
  games: gamesJudgeNote,
};

/**
 * The notes judgeInstructions (lib/prompts/judge.ts) appends after the glasses note. Empty for a brief with no cap blocks,
 * so the instructions are today's. A brief with a cap block is a whole stored brief.
 */
export function capsJudgeNotes(brief: Partial<Brief>): string {
  const notes = briefCaps(brief).flatMap((id) => {
    const note = CAP_JUDGE[id]?.(brief as Brief).trim();
    return note ? [note] : [];
  });
  if (!notes.length) return "";
  return `\n\nPlatform services in this product. Fixed checks the platform ran decide whether each one works, not you. Check only what the screenshots show:\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

/** A check's id as a plain slug, or "check". Ids can come from what a product's test recorded. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const slug = (id: unknown) => (typeof id === "string" && SLUG.test(id) ? id : "check");

/**
 * The verify summary's cap checks, as the one text part the judge gets before the screenshots. Null when there are none.
 * Only the cap, the check's id and whether it passed: a check's detail can carry text the product wrote, which must
 * never reach the judge as an instruction.
 */
export function capsProofText(verify: Pick<VerifySummary, "caps"> | null | undefined): string | null {
  const caps: CapProof[] = verify?.caps ?? [];
  if (!caps.length) return null;
  const lines = caps.flatMap((c) =>
    c.checks.length ? c.checks.map((k) => `- ${slug(c.cap)}, ${slug(k.id)}: ${k.ok ? "passed" : "failed"}`) : [`- ${slug(c.cap)}: no checks were recorded`],
  );
  return `Fixed checks the platform ran for this product's platform services. They are already decided, so don't judge them again. They tell you what the screenshots should show:\n${lines.join("\n")}`;
}
