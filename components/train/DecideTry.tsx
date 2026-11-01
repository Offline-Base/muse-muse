"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import {
  DECIDE_TRY_MAX,
  DEMO_REFRESH_MS,
  confidenceText,
  decideTryNote,
  percentText,
  timeLeftText,
  type DecideTryModel,
} from "@/components/train/format";
import type { PublicLiveDemo } from "@/components/train/results";
import { askDecideDemo } from "@/components/train/tryLive";
import { NONE_OPTION } from "@/lib/decide/format";
import type { DecideTryAnswer, DecideTryPick } from "@/lib/decide/types";
import { duration, groupThousands, plural } from "@/lib/format";
import { BUILT_WITH_SPARK_OPEN, USAGE_POINTS } from "@/lib/train/base";
import { SERVE_BOOT_MINUTES } from "@/lib/train/logic";

/**
 * A decision model's Try it live box (docs/DECISION_MODELS.md "On the lab's GPU"): on its result page, and on its admin
 * job page, while a glimmer-serve job serves it. One input, and base Glimmer's and the tuned model's picks side by side
 * from the same GPU, each with every label's probability. It talks only to POST /api/lab/{id}/decide, never to the GPU,
 * and replaces the chat box for a decision model, which answers one letter and never chats.
 */

/** The clock the box counts down with: the server's time first, so the first render matches, then the browser's. */
function useClock(initial: number, everyMs: number): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export interface DecideTryCardProps {
  /** The decide job whose adapter the demo serves: the page's own job. */
  adapterJobId: string;
  demo: PublicLiveDemo;
  model: DecideTryModel;
  serverNow: number;
  /** Admins only: the serve job, linked from the box. The public page never has it. */
  serveJobId?: string | null;
}

type Decided = DecideTryAnswer & { input: string };

export function DecideTryCard({ adapterJobId, demo, model, serverNow, serveJobId = null }: DecideTryCardProps) {
  const router = useRouter();
  const id = useId();
  const now = useClock(serverNow, 5_000);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Decided | null>(null);
  const demoKey = `${demo.state}|${demo.endsAt ?? ""}`;
  const [endedKey, setEndedKey] = useState<string | null>(null);

  const end = Date.parse(demo.endsAt ?? "");
  const over = endedKey === demoKey || (demo.state === "live" && Number.isFinite(end) && now >= end);
  const live = demo.state === "live" && !over;
  const starting = demo.state === "starting" && !over;

  useEffect(() => {
    if (!over) return;
    const t = setTimeout(() => router.refresh(), 5_000);
    return () => clearTimeout(t);
  }, [over, router]);

  async function decide(e: FormEvent) {
    e.preventDefault();
    if (!live || busy) return;
    const text = input.trim();
    if (!text) {
      setError("Type an input first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await askDecideDemo(adapterJobId, text);
    setBusy(false);
    if (result.ok) {
      setAnswer({ ...result.answer, input: text });
      return;
    }
    setError(result.message);
    if (result.ended) setEndedKey(demoKey);
  }

  const left = live ? timeLeftText(demo.endsAt, now) : null;
  const tone = live ? "live" : over ? "neutral" : "building";
  const label = live ? "Live" : over ? "Ended" : "Starting";
  const lead = live
    ? "Type one input, written the way the dataset's rows are. Muse Glimmer 30B with 2026 knowledge, on its own, and this decision model each pick one label for it on the same GPU, with how sure each one is."
    : over
      ? "This live demo has ended, and its GPU shuts down like every other job's."
      : `A live demo is starting. The GPU boots and loads the model, which takes up to about ${SERVE_BOOT_MINUTES} minutes, then this box opens for ${plural(demo.minutes, "minute")}.`;

  return (
    <section className="card section-card lab-try" id="try-live" aria-labelledby={`${id}-title`}>
      <RefreshWhileActive active={starting} everyMs={DEMO_REFRESH_MS} />
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Try it live</h2>
        <span className={`pill pill-${tone}`}>
          <span className="pill-dot" aria-hidden />
          {label}
        </span>
        {left ? <span className="muted small lab-try-left">{left}</span> : null}
      </div>
      <p className="lab-try-lead" aria-live="polite">
        {lead}
      </p>
      {/* The demo's GPU loads r30b (glimmer-serve's MODEL), a Derivative of Muse Spark Open (lib/train/base.ts). */}
      <p className="muted small lab-try-built">
        <strong>{BUILT_WITH_SPARK_OPEN}.</strong> {USAGE_POINTS.join(" ")}
      </p>
      <div className="lab-decide-ask">
        <p className="lab-decide-question">
          <span className="train-label">The question</span>
          <span>{model.question}</span>
        </p>
        <ul className="lab-decide-labels" aria-label="The labels it picks from">
          {model.labels.map((l) => (
            <li key={l.id} className="chip">
              {l.name}
            </li>
          ))}
          <li className="chip lab-decide-none">{NONE_OPTION}</li>
        </ul>
      </div>

      <form className="lab-try-form" onSubmit={decide} noValidate>
        <div className="train-field">
          <label className="train-label" htmlFor={`${id}-input`}>
            Your input
          </label>
          <textarea
            id={`${id}-input`}
            className="train-input train-textarea lab-try-input"
            value={input}
            rows={4}
            maxLength={DECIDE_TRY_MAX}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy || over}
            aria-describedby={`${id}-help`}
          />
          <p className="train-help train-help-row" id={`${id}-help`}>
            <span>One input at a time for everyone. A decision takes a few seconds.</span>
            <span className="train-count">
              {groupThousands(input.length)} / {groupThousands(DECIDE_TRY_MAX)}
            </span>
          </p>
        </div>
        <div className="lab-try-foot">
          <button type="submit" className="btn btn-primary" disabled={!live || busy || !input.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
            <span>{busy ? "Deciding" : "Decide"}</span>
          </button>
          <span className={busy ? "muted small" : "sr-only"} role="status">
            {busy ? "Base and tuned Glimmer are deciding." : answer ? "Both picks are in, below." : ""}
          </span>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
      </form>

      {answer ? <DecideAnswers answer={answer} idBase={id} /> : null}
      <p className="muted small">{decideTryNote(model)}</p>

      {serveJobId ? (
        <p className="muted small">
          <Link href={`/fine-tuning/${serveJobId}`}>Open the demo&apos;s job</Link> for its GPU, log and Stop.
        </p>
      ) : null}
    </section>
  );
}

/** The input and both picks. The input reads as plain text, never as HTML or a link. Exported for tests. */
export function DecideAnswers({ answer, idBase }: { answer: Decided; idBase: string }) {
  return (
    <div className="lab-try-result">
      <div className="train-msg">
        <h3 className="train-role">Your input</h3>
        <p className="train-text lab-decide-input">{answer.input}</p>
      </div>
      <div className="lab-try-pair">
        <DecidePick id={`${idBase}-base`} title="2026 Glimmer (r30b)" pick={answer.base} />
        <DecidePick id={`${idBase}-tuned`} title="Decision model" pick={answer.tuned} tuned />
      </div>
      <p className="muted small">Both decided in {duration(answer.ms)} on the demo&apos;s GPU.</p>
    </div>
  );
}

function DecidePick({ id, title, pick, tuned = false }: { id: string; title: string; pick: DecideTryPick; tuned?: boolean }) {
  const rows = [...pick.probabilities.map((p) => ({ key: p.id, name: p.option, p: p.p })), ...(pick.none > 0 ? [{ key: "none", name: NONE_OPTION, p: pick.none }] : [])];
  const picked = pick.id ?? "none";
  return (
    <section className={`lab-try-answer${tuned ? " lab-try-tuned" : ""}`} aria-labelledby={id}>
      <h3 className="train-role" id={id}>
        {title}
      </h3>
      <p className="lab-decide-pick">{pick.decision ?? NONE_OPTION}</p>
      <p className="muted small">Confidence: {confidenceText(pick.confidence, pick.calibrated)}.</p>
      <ul className={`lab-decide-bars${tuned ? " lab-decide-bars-tuned" : ""}`} aria-label={`${title}: every label's probability`}>
        {rows.map((r) => (
          <li key={r.key} className={r.key === picked ? "lab-decide-picked" : undefined}>
            <span className="lab-decide-name">{r.name}</span>
            <span className="lab-decide-track" aria-hidden>
              <span className="lab-decide-fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, r.p)) * 1000) / 10}%` }} />
            </span>
            <span className="lab-decide-p">{percentText(r.p)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
