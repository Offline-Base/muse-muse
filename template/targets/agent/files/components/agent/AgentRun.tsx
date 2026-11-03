"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { ModelChip } from "@/components/ModelChip";
import { Skeleton } from "@/components/Skeleton";
import { UsageStrip, type Usage } from "@/components/UsageStrip";
import { stopMessage, type AgentStep } from "@/lib/agent/events";
import type { UseAgent } from "@/lib/agent/client";
import { ConfirmCard } from "./ConfirmCard";
import { ConnectCard } from "./ConnectCard";
import { SourceList } from "./SourceList";

const STEP_ICON: Record<AgentStep["state"], IconName> = {
  running: "clock",
  done: "check",
  failed: "alert",
  waiting: "info",
};

const STATE_WORDS: Record<AgentStep["state"], string> = {
  running: "Working",
  done: "Done",
  failed: "Didn't work",
  waiting: "Waiting",
};

/**
 * One run on screen: the steps, then the answer with its sources, or what it's waiting for. Pass what useAgent returns.
 * The answer card has data-result, each step data-step-state, and the buttons are named Stop and Keep going, so tests
 * can find them. `children` draws a structured answer. Without it, the text answer is shown as markdown.
 */
export function AgentRun<T>({
  agent,
  title = "Your answer",
  numberedSources = false,
  usage,
  children,
}: {
  agent: UseAgent<T>;
  title?: string;
  /** Number the sources, when the answer points at them by number, as deep research's does. */
  numberedSources?: boolean;
  /**
   * The cost line under the answer. By default it shows the run's cost, and gives way to a UsageStrip the page places
   * itself, so cost never shows twice. Pass token counts to add them to this line, or false to leave it out.
   */
  usage?: false | Omit<Usage, "costUsd">;
  children?: (answer: T) => ReactNode;
}) {
  const { view, busy } = agent;
  const headingId = useId();
  const [connecting, setConnecting] = useState(false);
  if (view.status === "idle") return null;

  const running = view.status === "running";
  const finished = view.status === "completed";
  const canGoOn = !running && !!view.resume && (view.status === "stopped" || view.status === "failed");
  const answer = finished ? view.answer : null;
  const working = view.steps.findLast((s) => s.state === "running");
  // While it runs and when it stops short, the words so far are all there is. A structured answer draws itself.
  const text = !children || !finished ? view.text.trim() : "";
  const problem = view.status === "stopped" || view.status === "failed" ? (view.message ?? stopMessage(view.reason)) : view.status === "waiting" ? view.message : null;

  const connect = async (toolkit: string) => {
    setConnecting(true);
    try {
      await agent.connect(toolkit);
    } finally {
      setConnecting(false);
    }
  };

  const steps = view.steps.length ? (
    <details open>
      <summary>{view.steps.length === 1 ? "1 step" : `${view.steps.length} steps`}</summary>
      <ol className="list" aria-label="Steps">
        {view.steps.map((step) => (
          <li className="list-row" key={step.id} data-step-state={step.state}>
            <span className="icon-circle">
              <Icon name={STEP_ICON[step.state]} label={STATE_WORDS[step.state]} />
            </span>
            <span className="list-text">
              <span className="list-title">{step.title}</span>
              {step.description ? <span className="meta">{step.description}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </details>
  ) : null;

  return (
    <>
      {view.confirm ? <ConfirmCard confirm={view.confirm} busy={busy} onDecide={agent.decide} /> : null}
      {view.connect ? <ConnectCard connect={view.connect} busy={busy || connecting} onConnect={connect} /> : null}
      <section className={finished ? "card ai" : "card"} aria-labelledby={headingId} data-agent-run={view.status}>
        <div className="card-head">
          <h2 id={headingId}>{title}</h2>
          {finished ? <ModelChip model="muse-wonder-1.0" verb="Written" /> : null}
        </div>

        {running ? (
          <p className="working" role="status">
            {working ? `${working.title}…` : "Working on it…"}
          </p>
        ) : null}

        {!finished ? steps : null}

        {running && !text ? <Skeleton lines={3} /> : null}

        {problem ? (
          <p className="error" role="alert">
            <Icon name="alert" />
            {problem}
          </p>
        ) : null}

        {finished ? (
          <div data-result>
            {answer !== null && children ? children(answer) : <Markdown text={typeof answer === "string" ? answer : view.text} />}
          </div>
        ) : text ? (
          <Markdown text={text} />
        ) : null}

        <SourceList sources={view.sources} numbered={numberedSources} />

        {/* The answer comes first once there is one, with what it took under it. */}
        {finished ? steps : null}

        {finished && usage !== false ? <UsageStrip usage={{ ...usage, costUsd: view.costUsd }} what="in model and tool costs" fallback /> : null}

        {running || canGoOn ? (
          <div className="actions">
            {running ? (
              <button type="button" className="secondary" onClick={agent.stop}>
                <Icon name="stop" /> Stop
              </button>
            ) : (
              <button type="button" className="tinted ai" onClick={agent.keepGoing}>
                <Icon name="sparkle" /> Keep going
              </button>
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}
