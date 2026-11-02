import { useId } from "react";
import { Icon } from "@/components/icons";
import type { RequirementResult, RequirementState } from "@/lib/full/requirements";

const WORDS: Record<RequirementState, string> = { met: "Works", unmet: "Not met", cant: "Can't be done", unchecked: "Not checked yet" };

/** What a requirement seen working says while other checks failed, so nothing reads "Works" next to a failure. */
const MET_BUT_FAILED = "Looked right, but checks found problems";

/** One check result, oldest first: a verify summary, a judge verdict, or both from one round. */
export interface CheckOutcome {
  verify?: { passed: boolean } | null;
  judge?: { pass: boolean } | null;
}

/**
 * True when a failure must win over any "checked and working": the build or product failed, was refused or shipped as
 * partial (some check failed, the live check included), or its newest check found problems.
 */
export function checksFailed(status: string | null | undefined, checks: readonly CheckOutcome[]): boolean {
  if (status === "failed" || status === "refused" || status === "partial") return true;
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i]!;
    if (!c.verify && !c.judge) continue;
    return c.verify?.passed === false || c.judge?.pass === false;
  }
  return false;
}

/**
 * FULL_BUILDS: the person's list, one line for each requirement, in the build room and on the product page. Shows only
 * what was seen in a real run: nothing reads "Works" until its test passed and the judge saw it on screen, and nothing
 * reads "Works" or "checked and working" while `failed` (checksFailed) says a check failed.
 *
 * Drawn as the same card as Muse Code's todo list (components/build/session.tsx, owner, Nov 2): a box per line, ticked
 * once it's checked and working, with the count beside the title. "Works" (the ticked box) and "Not checked yet" (the
 * empty box) are said only to screen readers; every other state is also written beside the line.
 */
export function RequirementsChecklist({ items, title = "What you asked for", failed = false }: { items: RequirementResult[]; title?: string; failed?: boolean }) {
  const headingId = useId();
  if (!items.length) return null;
  const counted = items.filter((r) => r.state !== "cant");
  const met = counted.filter((r) => r.state === "met").length;
  return (
    <section className="todo-card requirements" aria-labelledby={headingId}>
      <div className="todo-head">
        <h3 id={headingId}>{title}</h3>
        {failed ? (
          <span className="muted">Checks found problems, so none of these count as working yet</span>
        ) : (
          <span className="muted">
            {met} of {counted.length} checked and working
          </span>
        )}
      </div>
      <ul className="todos">
        {items.map((r) => {
          const shownMet = r.state === "met" && !failed;
          const tone = shownMet ? "completed" : r.state === "unmet" ? "unmet" : r.state === "cant" ? "cancelled" : r.state === "met" ? "held" : "pending";
          const words = r.state === "met" && failed ? MET_BUT_FAILED : WORDS[r.state];
          return (
            <li key={r.id} className={`todo todo-${tone}`}>
              <span className="todo-box" aria-hidden>
                {shownMet ? <Icon name="check" size={12} /> : r.state === "unmet" ? <Icon name="close" size={12} /> : null}
              </span>
              <span className="todo-text">
                {r.id}: {r.text}
                {r.state === "unchecked" || shownMet ? <span className="sr-only"> ({words})</span> : <span className="todo-state"> {words}</span>}
                {r.detail ? <span className="todo-detail muted"> {r.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
