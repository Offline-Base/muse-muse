/**
 * Known issues: what a shipped build still gets wrong, said where people see it ship (the build room's last turn and the
 * product page). A build that ships after the screenshot judge failed it, or whose live link failed its check, is never
 * shown as a clean Live: these lines say what is wrong, in the judge's or the live check's own words. Pure, so the
 * client build room, the server product page and the tests share it.
 */
import { scrubMachineText } from "@/lib/pipeline/visitor-text";

/** The events this reads, as the build room and the product page hold them. Anything else is skipped. */
type IssueEvent =
  | { type: "judge"; verdict?: { pass?: boolean; mismatches?: unknown; reasons?: unknown } }
  | { type: "live_check"; ok?: boolean; reason?: string; action?: string }
  | { type: "deploy" }
  | { type: string };

/** The most lines shown. The build room has the rest. */
export const MAX_KNOWN_ISSUES = 6;

const plain = (text: string) => scrubMachineText(text.replace(/\s*\u2014\s*/g, ", ").replace(/\s+/g, " ")).trim();

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

/** A line ends as a sentence. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The known issues of a build that shipped (live or partial), newest facts only:
 * - the last screenshot judge's mismatches when it failed the build, or its first reason when it named none;
 * - every live link check after the last deploy that failed.
 * Empty for a build that didn't ship, or shipped clean.
 */
export function knownIssues(events: ReadonlyArray<IssueEvent>, status: string): string[] {
  if (status !== "live" && status !== "partial") return [];
  let judge: { pass?: boolean; mismatches?: unknown; reasons?: unknown } | null = null;
  let live: string[] = [];
  for (const e of events) {
    if (e.type === "judge") judge = (e as Extract<IssueEvent, { type: "judge" }>).verdict ?? null;
    else if (e.type === "deploy") live = [];
    else if (e.type === "live_check") {
      const c = e as Extract<IssueEvent, { type: "live_check" }>;
      if (c.ok === false) live.push(`On its live link: ${plain(c.reason?.trim() || "it did not answer")}`);
    }
  }
  const out: string[] = [];
  if (judge && judge.pass === false) {
    const said = strings(judge.mismatches);
    const lines = said.length ? said : strings(judge.reasons).slice(0, 1);
    for (const l of lines) out.push(plain(l));
  }
  out.push(...live);
  return [...new Set(out.filter(Boolean).map(sentence))].slice(0, MAX_KNOWN_ISSUES);
}
