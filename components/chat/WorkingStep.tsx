import { Children, type ReactNode } from "react";
import type { StepState } from "@/components/chat/types";
import { WorkingIcon } from "@/components/chat/WorkingIcon";
import { Icon } from "@/components/icons";
import { AgentMuse } from "@/components/mascot/AgentMuse";
import type { AgentRole } from "@/lib/mascot";

/**
 * One step of the agent's work in the conversation (docs/UI_MUSE_APP.md, "The agent's working step"): the working icon
 * and a short present-tense title, then a hairline thread dropping from under the icon beside the description and any
 * sub-steps, which nest on the thread as smaller rows, so a step reads as a quiet tree. A finished step shows a check in
 * the icon's place and a failed one an alert. New steps fade in over 150 ms, except under reduced motion. A surface that
 * runs agents (the build room) can give a running step a little Muse at the right of its title: the orchestrator on its
 * own step, a sub-agent on each nested one.
 */
export function WorkingStep({
  title,
  description,
  state = "running",
  nested = false,
  muse,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  state?: StepState;
  /** A sub-step on its parent's thread: a 16 px icon and a smaller title. */
  nested?: boolean;
  /** While it runs, this agent as a little Muse at the right of the title (components/mascot/AgentMuse.tsx). */
  muse?: AgentRole;
  /** Sub-steps, as nested WorkingSteps. */
  children?: ReactNode;
}) {
  const body = Boolean(description) || Children.toArray(children).length > 0;
  const showMuse = Boolean(muse) && state === "running";
  return (
    <div className={`chat-step is-${state}${nested ? " is-nested" : ""}${showMuse ? " has-muse" : ""}`}>
      <span className="chat-step-icon">
        {state === "running" ? (
          <WorkingIcon state="working" variant={nested ? "subagent" : undefined} />
        ) : (
          <Icon name={state === "done" ? "check" : "alert"} size={nested ? 16 : 18} title={state === "done" ? "Done" : "Failed"} />
        )}
      </span>
      <p className="chat-step-title">{title}</p>
      {showMuse && muse ? <AgentMuse role={muse} height={nested ? 22 : 26} className="chat-step-muse" /> : null}
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
