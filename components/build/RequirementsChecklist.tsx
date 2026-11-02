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
 */
export function RequirementsChecklist({ items, title = "What you asked for", failed = false }: { items: RequirementResult[]; title?: string; failed?: boolean }) {
  if (!items.length) return null;
  const counted = items.filter((r) => r.state !== "cant");
  const met = counted.filter((r) => r.state === "met").length;
  return (
    <div className="requirements">
      <p className="lead">
        <strong>{title}</strong>{" "}
        {failed ? (
          <span className="muted">Checks found problems, so none of these count as working yet</span>
        ) : (
          <span className="muted">
            {met} of {counted.length} checked and working
          </span>
        )}
      </p>
      <ul className="vsteps">
        {items.map((r) => {
          const shownMet = r.state === "met" && !failed;
          return (
            <li key={r.id} className={shownMet ? "ok" : r.state === "unmet" ? "bad" : undefined}>
              {shownMet || r.state === "unmet" ? <Icon name={shownMet ? "check" : "close"} size={16} title={WORDS[r.state]} /> : null}
              <span className="vstep-name">{r.id}: {r.text}</span>
              <span className="muted"> {r.state === "met" && failed ? MET_BUT_FAILED : WORDS[r.state]}</span>
              {r.detail ? <span className="vstep-detail muted"> {r.detail}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
