import { Icon } from "@/components/icons";
import type { RequirementResult, RequirementState } from "@/lib/full/requirements";

const WORDS: Record<RequirementState, string> = { met: "Works", unmet: "Not met", cant: "Can't be done", unchecked: "Not checked yet" };

/**
 * FULL_BUILDS: the person's list, one line for each requirement, in the build room and on the product page. Shows only
 * what was seen in a real run: nothing reads "Works" until its test passed and the judge saw it on screen.
 */
export function RequirementsChecklist({ items, title = "What you asked for" }: { items: RequirementResult[]; title?: string }) {
  if (!items.length) return null;
  const counted = items.filter((r) => r.state !== "cant");
  const met = counted.filter((r) => r.state === "met").length;
  return (
    <div className="requirements">
      <p className="lead">
        <strong>{title}</strong> <span className="muted">{met} of {counted.length} checked and working</span>
      </p>
      <ul className="vsteps">
        {items.map((r) => (
          <li key={r.id} className={r.state === "met" ? "ok" : r.state === "unmet" ? "bad" : undefined}>
            {r.state === "met" || r.state === "unmet" ? <Icon name={r.state === "met" ? "check" : "close"} size={16} title={WORDS[r.state]} /> : null}
            <span className="vstep-name">{r.id}: {r.text}</span>
            <span className="muted"> {WORDS[r.state]}</span>
            {r.detail ? <span className="vstep-detail muted"> {r.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
