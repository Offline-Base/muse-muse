import { Children, type ReactNode } from "react";
import type { StepState } from "@/components/chat/types";
import { WorkingIcon } from "@/components/chat/WorkingIcon";
import { Icon } from "@/components/icons";

/**
 * One step of the agent's work in the conversation (docs/UI_MUSE_APP.md, "The agent's working step"): the working icon
 * and a short present-tense title, then a hairline thread dropping from under the icon beside the description and any
 * sub-steps, which nest on the thread as smaller rows, so a step reads as a quiet tree. A finished step shows a check in
 * the icon's place and a failed one an alert. New steps fade in over 150 ms, except under reduced motion.
 */
export function WorkingStep({
  title,
  description,
  state = "running",
  nested = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  state?: StepState;
  /** A sub-step on its parent's thread: a 16 px icon and a smaller title. */
  nested?: boolean;
  /** Sub-steps, as nested WorkingSteps. */
  children?: ReactNode;
}) {
  const body = Boolean(description) || Children.toArray(children).length > 0;
  return (
    <div className={`chat-step is-${state}${nested ? " is-nested" : ""}`}>
      <span className="chat-step-icon">
        {state === "running" ? (
          <WorkingIcon state="working" variant={nested ? "subagent" : undefined} />
        ) : (
          <Icon name={state === "done" ? "check" : "alert"} size={nested ? 16 : 18} title={state === "done" ? "Done" : "Failed"} />
        )}
      </span>
      <p className="chat-step-title">{title}</p>
      {body ? (
        <>
          <span className="chat-step-thread" aria-hidden="true" />
          <div className="chat-step-body">
            {description ? <p className="chat-step-desc">{description}</p> : null}
            {children}
          </div>
        </>
      ) : null}
    </div>
  );
}
