import { FLOW_MARK_LABEL, FLOW_MARK_TONE, FLOW_STEPS } from "@/lib/story/flow";

/** Each step of the frontier claim, with what has really happened. Marks come from lib/story/flow.ts. */
export function FlowTable() {
  return (
    <ol className="st-flow">
      {FLOW_STEPS.map((step) => (
        <li key={step.step} className="st-flow-row">
          <div className="st-flow-head">
            <h3 className="how-title">{step.step}</h3>
            <span className={`pill pill-${FLOW_MARK_TONE[step.mark]}`}>
              <span className="pill-dot" aria-hidden />
              {FLOW_MARK_LABEL[step.mark]}
            </span>
          </div>
          <p className="muted">{step.evidence}</p>
        </li>
      ))}
    </ol>
  );
}
