"use client";

import { useState } from "react";
import { ChatLink } from "@/components/chat/ChatLink";
import type { StepItem, StepKind, StepMedia, StepsEnd } from "@/components/chat/types";
import { WorkingIcon } from "@/components/chat/WorkingIcon";
import { Icon, type IconName } from "@/components/icons";
import { AgentMuse } from "@/components/mascot/AgentMuse";
import { subRole } from "@/lib/mascot";

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
 * "Done", "Stopped" or "Didn't finish" once the list is finished. A surface with more to show can give a row a body, and
 * fold a long run of children under the row's title; those render only while the fold is open. Each row carries its id as data-step, so a surface can scroll to it.
 * With `muse` (the build room), each agent row still running gets a little sub-agent Muse at its right.
 */
export function StepList({ steps, end, label = "Steps", muse = false }: { steps: readonly StepItem[]; end?: StepsEnd; label?: string; muse?: boolean }) {
  return (
    <ol className="chat-steplist" aria-label={label}>
      {steps.map((step, i) => (
        <StepRow key={step.id} step={step} muse={muse} index={i} />
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

function StepRow({ step, parentKind, muse = false, index = 0 }: { step: StepItem; parentKind?: StepKind; muse?: boolean; index?: number }) {
  const [foldOpen, setFoldOpen] = useState(false);
  const avatar = step.kind === "subagent" || step.kind === "workflow" || parentKind === "workflow";
  const showMuse = muse && avatar && step.state === "running";
  const media = ([] as readonly StepMedia[]).concat(step.media ?? []);
  const children = step.children?.length ? (
    <ol className="chat-steplist-children">
      {step.children.map((child, i) => (
        <StepRow key={child.id} step={child} parentKind={step.kind ?? "step"} muse={muse} index={i} />
      ))}
    </ol>
  ) : null;
  const title = (
    <>
      {step.title}
      {step.state === "running" ? <span className="sr-only"> (working)</span> : null}
      {step.state === "failed" ? <span className="sr-only"> (failed)</span> : null}
    </>
  );
  return (
    <li data-step={step.id} className={`chat-steplist-row is-${step.state}${parentKind ? " is-nested" : ""}${showMuse ? " has-muse" : ""}`}>
      {showMuse ? <AgentMuse role={subRole(index)} height={20} className="chat-steplist-muse" /> : null}
      <span className="chat-steplist-marker">
        {step.state === "running" || avatar ? (
          <WorkingIcon state={step.state === "running" ? "working" : "still"} variant="subagent" />
        ) : (
          <span className="chat-steplist-dot" />
        )}
      </span>
      <div className="chat-steplist-text">
        {step.folded ? (
          <details className="chat-steplist-fold" onToggle={(e) => setFoldOpen(e.currentTarget.open)}>
            <summary className="chat-steplist-title">{title}</summary>
            {foldOpen ? children : null}
          </details>
        ) : (
          <>
            {step.title ? <p className="chat-steplist-title">{title}</p> : null}
            {step.description ? <p className="chat-steplist-desc">{step.description}</p> : null}
            {media.length ? (
              <div className="chat-steplist-gallery">
                {media.map((m) => (
                  <StepThumb key={m.src} media={m} />
                ))}
              </div>
            ) : null}
            {step.body ? <div className="chat-steplist-body">{step.body}</div> : null}
            {children}
          </>
        )}
      </div>
    </li>
  );
}

function StepThumb({ media }: { media: StepMedia }) {
  return (
    <ChatLink href={media.href} className="chat-steplist-media">
      {/* A screenshot or a poster from storage. next/image would need every host configured. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.src} alt={media.alt} title={media.alt} width={72} height={72} loading="lazy" />
      {media.kind === "video" ? (
        <span className="chat-steplist-play">
          <Icon name="play" size={14} title="Video" />
        </span>
      ) : null}
    </ChatLink>
  );
}
