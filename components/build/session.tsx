"use client";

import { useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { UserBubble } from "@/components/chat";
import type { LogGroup, OpenQuestion, SessionModel } from "@/components/build/derive";
import type { MuseAnswer } from "@/lib/sandbox/bridge-protocol";

/**
 * What the build room shows of a Muse Code round on the session bridge (docs/MUSE_CODE_FULL.md, "The build room shows
 * all of it") beyond rows of the steps list (components/build/steps.tsx): the goal, the todo list and thinking in the
 * steps panel, owner notes and questions in the conversation. A `muse exec` round has none of these.
 */

type Tone = "building" | "live" | "failed" | "partial" | "neutral";

const STATUS_WORDS: Record<string, { label: string; tone: Tone }> = {
  inProgress: { label: "Running", tone: "building" },
  running: { label: "Running", tone: "building" },
  starting: { label: "Starting", tone: "building" },
  accepted: { label: "Starting", tone: "building" },
  pending: { label: "Waiting", tone: "neutral" },
  queued: { label: "Waiting", tone: "neutral" },
  paused: { label: "Paused", tone: "partial" },
  blocked: { label: "Blocked", tone: "partial" },
  completed: { label: "Done", tone: "live" },
  succeeded: { label: "Done", tone: "live" },
  resultReady: { label: "Done", tone: "live" },
  closed: { label: "Done", tone: "live" },
  failed: { label: "Failed", tone: "failed" },
  timedOut: { label: "Timed out", tone: "failed" },
  cancelled: { label: "Stopped", tone: "neutral" },
  rejected: { label: "Stopped", tone: "neutral" },
};

/** An agent's, child's or item's status in words, with the pill tone that goes with it. */
export function statusWords(status: string): { label: string; tone: Tone } {
  return STATUS_WORDS[status] ?? { label: status ? `${status[0]!.toUpperCase()}${status.slice(1)}` : "Unknown", tone: "neutral" };
}

// ---------- Goal and todo list ----------

const GOAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "In progress", tone: "building" },
  complete: { label: "Complete", tone: "live" },
  blocked: { label: "Blocked", tone: "partial" },
  paused: { label: "Paused", tone: "neutral" },
};

export function GoalCard({ goal }: { goal: NonNullable<SessionModel["goal"]> }) {
  const headingId = useId();
  const s = GOAL_STATUS[goal.status] ?? statusWords(goal.status);
  // Muse Code passes the percent through as it was reported, and it can run past 100.
  const pct = typeof goal.percentComplete === "number" ? Math.round(Math.min(100, Math.max(0, goal.percentComplete))) : null;
  return (
    <section className={`goal-card goal-${s.tone}`} aria-labelledby={headingId}>
      <div className="goal-head">
        <h3 className="goal-title" id={headingId}>
          <Icon name="sparkle" size={16} />
          Goal
        </h3>
        <span className={`pill pill-${s.tone}`}>
          <span className="pill-dot" aria-hidden />
          {s.label}
        </span>
      </div>
      {goal.objective ? <MarkdownText className="goal-objective" text={goal.objective} /> : null}
      {pct !== null ? (
        <div className="goal-progress">
          <span
            className="goal-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-labelledby={headingId}
          >
            <span className="goal-bar-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="goal-pct">{pct}%</span>
        </div>
      ) : null}
    </section>
  );
}

const TODO_STATUS: Record<string, string> = {
  pending: "Not started",
  inProgress: "In progress",
  completed: "Done",
  cancelled: "Dropped",
};

export function TodoList({ todos }: { todos: SessionModel["todos"] }) {
  const headingId = useId();
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <section className="todo-card" aria-labelledby={headingId}>
      <div className="todo-head">
        <h3 id={headingId}>Muse Code&apos;s todo list</h3>
        <span className="muted">
          {done} of {todos.length} done
        </span>
      </div>
      <ul className="todos">
        {todos.map((t, i) => (
          <li key={i} className={`todo todo-${t.status}`}>
            <span className="todo-box" aria-hidden>
              {t.status === "completed" ? <Icon name="check" size={12} /> : null}
            </span>
            <span className="todo-text">{t.text}</span>
            <span className="sr-only"> ({TODO_STATUS[t.status] ?? t.status})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- In the log ----------

/** Reasoning summaries, folded. */
export function Thinking({ text }: { text: string }) {
  return (
    <details className="thinking">
      <summary>Thinking</summary>
      <MarkdownText className="say" text={text.trim()} />
    </details>
  );
}

/** How an owner's note went, in words. */
export function steerMeta(g: Extract<LogGroup, { type: "steer" }>): string {
  if (g.status === "refused") return `Not delivered${g.error ? `: ${g.error}` : ""}`;
  if (g.status === "sent") return "Sent";
  if (g.delivery === "steer") return "Muse Code has read this";
  if (g.delivery === "queue") return "Muse Code gets this after its current step";
  return "Delivered";
}

/** A command from the build's owner, on the owner's side of the conversation. */
export function SteerNote({ group }: { group: Extract<LogGroup, { type: "steer" }> }) {
  return (
    <div className={`steer${group.status === "refused" ? " steer-refused" : ""}`}>
      <UserBubble
        text={
          <>
            <span className="sr-only">From the owner: </span>
            {group.text}
          </>
        }
      />
      <p className="steer-meta">{steerMeta(group)}</p>
    </div>
  );
}

// ---------- Questions ----------

type Question = OpenQuestion["questions"][number];

/** The answer to one question, or null while it has none that fits: free text wins over a choice. */
export function answerFor(q: Question, picked: string[], freeText: string): MuseAnswer | null {
  const text = freeText.trim();
  if (text) return { questionId: q.id, freeText: text.slice(0, 500) };
  if (q.multiple) {
    const min = q.min ?? 1;
    const max = q.max ?? (q.options?.length || 1);
    return picked.length >= min && picked.length <= max ? { questionId: q.id, selectedLabels: picked } : null;
  }
  return picked[0] ? { questionId: q.id, selectedLabel: picked[0] } : null;
}

/** How many options a multiple choice takes, in words. */
function pickHint(min = 1, max?: number): string {
  if (max && max === min) return `Pick ${max}.`;
  if (max) return min > 1 ? `Pick ${min} to ${max}.` : `Pick up to ${max}.`;
  return min > 1 ? `Pick at least ${min}.` : "Pick any that fit.";
}

/** The control route's error, which is a sentence or a short code. */
export function answerError(status: number, error: unknown): string {
  const text = typeof error === "string" ? error.trim() : "";
  if (/\s/.test(text)) return text;
  if (status === 401) return "Sign in to answer.";
  if (status === 403) return "Only the product's owner can answer.";
  if (status === 404) return "That build no longer exists.";
  return text ? `That didn't go through (${text}). Try again in a moment.` : "That didn't go through. Try again in a moment.";
}

/**
 * A question Muse Code asked, with its options and room for an answer in the owner's own words. The owner answers
 * while the round runs; everyone else sees what was asked.
 */
export function QuestionCard({
  question,
  buildId,
  canAnswer,
  live,
}: {
  question: OpenQuestion;
  buildId?: string;
  canAnswer: boolean;
  live: boolean;
}) {
  const id = useId();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" } | { kind: "error"; message: string }>({ kind: "idle" });
  const answers = question.questions.map((q) => answerFor(q, picked[q.id] ?? [], free[q.id] ?? ""));
  const ready = answers.every((a): a is MuseAnswer => a !== null);
  const open = live && canAnswer && Boolean(buildId);
  const locked = !open || state.kind === "sending" || state.kind === "sent";

  const pick = (q: Question, label: string, on: boolean) =>
    setPicked((prev) => {
      if (!q.multiple) return { ...prev, [q.id]: on ? [label] : [] };
      const chosen = new Set(prev[q.id] ?? []);
      if (on) chosen.add(label);
      else chosen.delete(label);
      // In the order Muse Code offered them.
      return { ...prev, [q.id]: (q.options ?? []).filter((o) => chosen.has(o)) };
    });

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!ready || locked) return;
    setState({ kind: "sending" });
    let res: Response;
    try {
      res = await fetch(`/api/builds/${buildId}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "answer", userInputId: question.userInputId, answers }),
      });
    } catch {
      setState({ kind: "error", message: "Couldn't reach Muse Muse. Check your connection and try again." });
      return;
    }
    if (res.ok) {
      setState({ kind: "sent" });
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    setState({ kind: "error", message: answerError(res.status, data.error) });
  }

  return (
    <form className="question-card" aria-labelledby={`${id}-head`} onSubmit={submit}>
      <h3 className="question-head" id={`${id}-head`}>
        <Icon name="info" size={16} />
        Muse Code asks
      </h3>
      {question.questions.map((q) => {
        const chosen = picked[q.id] ?? [];
        const full = Boolean(q.multiple && q.max && chosen.length >= q.max);
        return (
          <fieldset key={q.id} className="question" disabled={locked}>
            <legend>
              {q.header ? <span className="question-tag">{q.header}</span> : null}
              <span className="question-text">{q.text}</span>
            </legend>
            {q.multiple ? <p className="question-hint">{pickHint(q.min, q.max)}</p> : null}
            {q.options?.length ? (
              <div className="question-options">
                {q.options.map((label, i) => {
                  const checked = chosen.includes(label);
                  const note = q.descriptions?.[i];
                  return (
                    <label key={label} className="question-option">
                      <input
                        type={q.multiple ? "checkbox" : "radio"}
                        name={`${id}-${q.id}`}
                        value={label}
                        checked={checked}
                        disabled={!checked && full}
                        onChange={(ev) => pick(q, label, ev.currentTarget.checked)}
                      />
                      <span className="question-option-text">
                        <span>{label}</span>
                        {note ? <span className="muted small">{note}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
            {open ? (
              <label className="question-free">
                <span className="small">{q.options?.length ? "Or answer in your own words" : "Your answer"}</span>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={free[q.id] ?? ""}
                  onChange={(ev) => {
                    const value = ev.currentTarget.value;
                    setFree((prev) => ({ ...prev, [q.id]: value }));
                  }}
                />
              </label>
            ) : null}
          </fieldset>
        );
      })}
      {state.kind === "error" ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{state.message}</span>
        </p>
      ) : null}
      {open ? (
        <div className="question-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || locked}>
            {state.kind === "sending" ? "Sending" : "Send answer"}
          </button>
          <p className="muted small" role="status">
            {state.kind === "sent" ? "Sent. Muse Code reads it within a few seconds." : ""}
          </p>
          {state.kind === "sent" ? (
            // The card goes once Muse Code has the answer. If the log says it wasn't delivered, the owner can retry.
            <button type="button" className="link-btn" onClick={() => setState({ kind: "idle" })}>
              Send again
            </button>
          ) : null}
        </div>
      ) : (
        <p className="muted small">{live ? "Waiting for the owner to answer." : "The run ended before this was answered."}</p>
      )}
    </form>
  );
}
