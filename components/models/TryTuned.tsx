"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { TRY_MESSAGES_MAX, TRY_PROMPT_CHARS, type TryView } from "@/lib/train/host/try-view";

/**
 * Try it, on a tuned model's public page (TRY_TUNED): the tuned model and the model it started from answer side by side.
 * It talks only to Muse Muse's routes, so no provider address or key reaches this page. Waking a sleeping model is
 * a person's click, and the routes hold every limit.
 */
const POLL_MS = 15_000;

type Variant = "tuned" | "base";
interface Turn {
  role: "user" | "assistant";
  content: string;
}
type Column = { turns: Turn[]; note: string | null };

/** The words for each state. Exported for tests. */
export function tryLead(view: TryView): string {
  if (view.state === "live") return "It's awake. Ask something, and both models answer. An answer can take up to a few minutes if its GPU has to wake again.";
  if (view.state === "waking") return "Waking up. Its GPU is starting and loading the model, which can take several minutes and sometimes up to 45. This box opens by itself, so you can leave this page open.";
  if (view.state === "stopping") return "It's shutting down after sitting idle. Look again in a few minutes.";
  return view.cantWake ?? "This model is asleep, to save its GPU. Waking it takes several minutes, and sometimes up to 45. It goes back to sleep after 15 minutes with no questions.";
}

export function TryTuned({ modelId, initial, baseLabel }: { modelId: string; initial: TryView; baseLabel: string }) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [columns, setColumns] = useState<Record<Variant, Column>>({ tuned: { turns: [], note: null }, base: { turns: [], note: null } });
  const id = useId();
  const route = `/api/models/${modelId}/try`;

  useEffect(() => {
    if (view.state !== "waking" && view.state !== "stopping") return;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      const res = await fetch(route, { cache: "no-store" }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { view: TryView }) : null;
      if (body) setView(body.view);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [view.state, route]);

  async function wake() {
    if (waking) return;
    setWaking(true);
    setProblem(null);
    // The route waits for the provider, for minutes at most: the box says it is waking from the click.
    setView((v) => ({ ...v, state: "waking", provider: null }));
    try {
      const res = await fetch(`${route}/wake`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => null)) as { view?: TryView; error?: unknown } | null;
      if (body?.view) setView(body.view);
      else {
        setProblem(typeof body?.error === "string" ? body.error : "It couldn't be woken. Try again soon.");
        const again = await fetch(route, { cache: "no-store" }).catch(() => null);
        const now = again?.ok ? ((await again.json()) as { view: TryView }) : null;
        setView(now?.view ?? { ...initial, state: "asleep" });
      }
    } catch {
      setProblem("Couldn't reach Muse Muse. Check your connection and try again.");
    } finally {
      setWaking(false);
    }
  }

  async function askOne(variant: Variant, turns: Turn[]): Promise<Turn | null> {
    const res = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant, messages: turns.slice(-TRY_MESSAGES_MAX) }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { text?: unknown; code?: unknown; error?: unknown } | null | undefined;
    if (res?.ok && typeof body?.text === "string") return { role: "assistant", content: body.text };
    const code = body?.code;
    if (code === "asleep" || code === "endpoint_closed") setView((v) => ({ ...v, state: "asleep" }));
    if (code === "endpoint_starting" || code === "endpoint_waking") setView((v) => ({ ...v, state: "waking" }));
    const words = typeof body?.error === "string" ? body.error : "No answer came back. Try again.";
    setColumns((c) => ({ ...c, [variant]: { ...c[variant], note: words } }));
    return null;
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || view.state !== "live") return;
    setBusy(true);
    setDraft("");
    const you: Turn = { role: "user", content: text };
    const asked = { tuned: [...columns.tuned.turns, you], base: [...columns.base.turns, you] };
    setColumns({ tuned: { turns: asked.tuned, note: null }, base: { turns: asked.base, note: null } });
    // One after the other: a GPU can be one-at-a-time, and each answer shows as soon as it is in.
    for (const variant of ["tuned", "base"] as const) {
      const answer = await askOne(variant, asked[variant]);
      if (answer) setColumns((c) => ({ ...c, [variant]: { ...c[variant], turns: [...asked[variant], answer] } }));
    }
    setBusy(false);
  }

  const pill = view.state === "live" ? { tone: "live", label: "Awake" } : view.state === "asleep" ? { tone: "neutral", label: "Asleep" } : view.state === "waking" ? { tone: "building", label: "Waking up" } : { tone: "neutral", label: "Going to sleep" };
  return (
    <section className="card section-card lab-try" id="try-tuned" aria-labelledby={`${id}-title`}>
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Try it</h2>
        <span className={`pill pill-${pill.tone}`}>
          <span className="pill-dot" aria-hidden />
          {pill.label}
        </span>
      </div>
      <p className="lab-try-lead" aria-live="polite">
        {tryLead(view)}
      </p>
      {view.state === "asleep" && !view.cantWake ? (
        <div className="lab-try-foot">
          <button type="button" className="btn btn-primary" onClick={wake} disabled={waking}>
            {waking ? <span className="spinner" aria-hidden /> : null}
            <span>{waking ? "Waking" : "Wake it up"}</span>
          </button>
        </div>
      ) : null}

      <form className="lab-try-form" onSubmit={ask} noValidate>
        <label className="train-label" htmlFor={`${id}-q`}>
          Your question
        </label>
        <textarea id={`${id}-q`} className="train-input train-textarea lab-try-input" rows={3} maxLength={TRY_PROMPT_CHARS} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={view.state !== "live" || busy} />
        <div className="lab-try-foot">
          <button type="submit" className="btn btn-primary" disabled={view.state !== "live" || busy || !draft.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            <span>{busy ? "Answering" : "Ask both models"}</span>
          </button>
        </div>
      </form>
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}

      {columns.tuned.turns.length ? (
        <div className="lab-try-pair">
          <TryColumn title="This tuned model" column={columns.tuned} tuned />
          <TryColumn title={baseLabel} column={columns.base} />
        </div>
      ) : null}

      <TryNote view={view} />
    </section>
  );
}

function TryColumn({ title, column, tuned = false }: { title: string; column: Column; tuned?: boolean }) {
  return (
    <section className={`lab-try-answer${tuned ? " lab-try-tuned" : ""}`} aria-label={title}>
      <h3 className="train-role">{title}</h3>
      {column.turns.map((t, i) => (t.role === "user" ? <p className="muted small" key={i}>{t.content}</p> : <MarkdownText key={i} className="train-text" text={t.content.trim() || "(empty)"} links={false} />))}
      {column.note ? <p className="muted small" role="status">{column.note}</p> : null}
    </section>
  );
}

/** The honest note on the data and the limits. Exported for tests. */
export function TryNote({ view }: { view: TryView }) {
  return (
    <div className="muted small">
      <p>
        <strong>What happens to what you type.</strong> It goes to a GPU we rent{view.provider ? ` on ${view.provider}` : " from a hosting provider"} to get the answers. Muse Muse doesn&apos;t save your words, only how many questions were asked and how long the answers were, and it keeps your network address for a day or so to hold the limits. We can&apos;t promise what a provider&apos;s own logs keep, so leave out anything private.
      </p>
      <p>
        <strong>What this model is.</strong> It was tuned on a small set of examples and can be wrong or make things up. The other column is the model it started from, on the same GPU. Muse Muse pays for this, so the limit is 5 questions in 10 minutes and 20 a day.
      </p>
      <p>
        {view.duties.line ? <strong>{view.duties.line}. </strong> : null}
        {view.duties.license} {view.duties.points.join(" ")}
      </p>
    </div>
  );
}
