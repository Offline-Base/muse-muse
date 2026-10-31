import { ChatLink } from "@/components/chat/ChatLink";
import type { StepItem, StepKind, StepMedia, StepsEnd } from "@/components/chat/types";
import { WorkingIcon } from "@/components/chat/WorkingIcon";
import { Icon, type IconName } from "@/components/icons";

const END: Record<StepsEnd, { label: string; icon: IconName }> = {
  done: { label: "Done", icon: "checkCircle" },
  stopped: { label: "Stopped", icon: "stopCircle" },
  unfinished: { label: "Didn't finish", icon: "alertCircle" },
};

/**
 * The steps panel's list (docs/UI_MUSE_APP.md, "The steps panel", "The list"): each step an 8 px dot on a hairline
 * thread, a semibold title, a description, and a 72 px thumbnail when it made an image or a video (videos get a play
 * badge). Sub-steps nest under their step as smaller rows. Subagents, workflows and the rows a workflow runs show the
 * working icon's subagent variant in place of the dot, and a step still running shows it turning. The thread ends in
 * "Done", "Stopped" or "Didn't finish" once the list is finished.
 */
export function StepList({ steps, end, label = "Steps" }: { steps: readonly StepItem[]; end?: StepsEnd; label?: string }) {
  return (
    <ol className="chat-steplist" aria-label={label}>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
      {end ? (
        <li className={`chat-steplist-end is-${end}`}>
          <span className="chat-steplist-marker">
            <Icon name={END[end].icon} size={17} />
          </span>
          <p className="chat-steplist-title">{END[end].label}</p>
        </li>
      ) : null}
    </ol>
  );
}

function StepRow({ step, parentKind }: { step: StepItem; parentKind?: StepKind }) {
  const avatar = step.kind === "subagent" || step.kind === "workflow" || parentKind === "workflow";
  return (
    <li className={`chat-steplist-row is-${step.state}${parentKind ? " is-nested" : ""}`}>
      <span className="chat-steplist-marker">
        {step.state === "running" || avatar ? (
          <WorkingIcon state={step.state === "running" ? "working" : "still"} variant="subagent" />
        ) : (
          <span className="chat-steplist-dot" />
        )}
      </span>
      <div className="chat-steplist-text">
        <p className="chat-steplist-title">
          {step.title}
          {step.state === "running" ? <span className="sr-only"> (working)</span> : null}
          {step.state === "failed" ? <span className="sr-only"> (failed)</span> : null}
        </p>
        {step.description ? <p className="chat-steplist-desc">{step.description}</p> : null}
        {step.media ? <StepThumb media={step.media} /> : null}
        {step.children?.length ? (
          <ol className="chat-steplist-children">
            {step.children.map((child) => (
              <StepRow key={child.id} step={child} parentKind={step.kind ?? "step"} />
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  );
}

function StepThumb({ media }: { media: StepMedia }) {
  return (
    <ChatLink href={media.href} className="chat-steplist-media">
      {/* A screenshot or a poster from storage. next/image would need every host configured. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.src} alt={media.alt} width={72} height={72} loading="lazy" />
      {media.kind === "video" ? (
        <span className="chat-steplist-play">
          <Icon name="play" size={14} title="Video" />
        </span>
      ) : null}
    </ChatLink>
  );
}
