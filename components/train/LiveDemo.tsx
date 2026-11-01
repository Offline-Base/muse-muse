"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { DecideTryCard } from "@/components/train/DecideTry";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import {
  DEMO_MINUTE_CHOICES,
  DEMO_REFRESH_MS,
  TRY_PLACEHOLDER,
  TRY_PROMPT_MAX,
  demoPlan,
  timeLeftText,
  type DecideTryModel,
} from "@/components/train/format";
import { toPublicLiveDemo, type PublicLiveDemo } from "@/components/train/results";
import { askLiveDemo, startLiveDemo } from "@/components/train/tryLive";
import { duration, groupThousands, plural, usd } from "@/lib/format";
import { SERVE_BOOT_MINUTES, SERVE_MINUTES_DEFAULT } from "@/lib/train/logic";
import type { LiveDemoView, TrainLimits, TryLiveAnswer } from "@/lib/train/types";

/**
 * The live demo of a trained Muse Glimmer adapter (docs/TRAINING.md "Live demo"): the Try it live box anyone sees on
 * the adapter's result page while a glimmer-serve job serves it, and the Start a live demo control admins get on the
 * adapter's job page when none is open. Both talk only to Muse Muse's own routes, never to the GPU.
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

export interface TryLiveCardProps {
  /** The trained glimmer-lora job whose adapter the demo serves: the page's own job. */
  adapterJobId: string;
  demo: PublicLiveDemo;
  serverNow: number;
  /** Admins only: the serve job, linked from the box. The public page never has it. */
  serveJobId?: string | null;
}

type Answered = TryLiveAnswer & { prompt: string };

/**
 * Try it live: a box for an app idea, and the base and the tuned Glimmer's answers side by side, from the same GPU, as
 * plain text. While the demo starts, the page checks again every 15 s and the box opens once it is live. It counts
 * down the time left, and closes when that runs out or the route says the demo ended.
 */
export function TryLiveCard({ adapterJobId, demo, serverNow, serveJobId = null }: TryLiveCardProps) {
  const router = useRouter();
  const id = useId();
  const now = useClock(serverNow, 5_000);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answered | null>(null);
  // Which demo the route said had ended. A new demo, or this one going live, opens the box again.
  const demoKey = `${demo.state}|${demo.endsAt ?? ""}`;
  const [endedKey, setEndedKey] = useState<string | null>(null);

  const end = Date.parse(demo.endsAt ?? "");
  const over = endedKey === demoKey || (demo.state === "live" && Number.isFinite(end) && now >= end);
  const live = demo.state === "live" && !over;
  const starting = demo.state === "starting" && !over;

  // Once it's over, look at the page again after a moment: guests lose the box, admins get Start a live demo back.
  useEffect(() => {
    if (!over) return;
    const t = setTimeout(() => router.refresh(), 5_000);
    return () => clearTimeout(t);
  }, [over, router]);

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!live || busy) return;
    const text = prompt.trim();
    if (!text) {
      setError("Type an app idea first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await askLiveDemo(adapterJobId, text);
    setBusy(false);
    if (result.ok) {
      setAnswer({ ...result.answer, prompt: text });
      return;
    }
    setError(result.message);
    if (result.ended) setEndedKey(demoKey);
  }

  const left = live ? timeLeftText(demo.endsAt, now) : null;
  const tone = live ? "live" : over ? "neutral" : "building";
  const label = live ? "Live" : over ? "Ended" : "Starting";
  const lead = live
    ? "Type an app idea. Muse Glimmer 30B answers it twice on the same GPU, once as the base model and once with this job's adapter, so you can compare them side by side."
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

      <form className="lab-try-form" onSubmit={ask} noValidate>
        <div className="train-field">
          <label className="train-label" htmlFor={`${id}-prompt`}>
            Your app idea
          </label>
          <textarea
            id={`${id}-prompt`}
            className="train-input train-textarea lab-try-input"
            value={prompt}
            rows={3}
            maxLength={TRY_PROMPT_MAX}
            placeholder={TRY_PLACEHOLDER}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy || over}
            aria-describedby={`${id}-help`}
          />
          <p className="train-help train-help-row" id={`${id}-help`}>
            <span>One idea at a time for everyone, and both answers can take a minute or two.</span>
            <span className="train-count">
              {groupThousands(prompt.length)} / {groupThousands(TRY_PROMPT_MAX)}
            </span>
          </p>
        </div>
        <div className="lab-try-foot">
          <button type="submit" className="btn btn-primary" disabled={!live || busy || !prompt.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
            <span>{busy ? "Answering" : "Ask both models"}</span>
          </button>
          <span className={busy ? "muted small" : "sr-only"} role="status">
            {busy
              ? "Base and tuned Glimmer are answering. This can take up to 2 minutes."
              : answer
                ? "Both answers are in, below."
                : ""}
          </span>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
      </form>

      {answer ? <LiveAnswers answer={answer} idBase={id} /> : null}

      {serveJobId ? (
        <p className="muted small">
          <Link href={`/fine-tuning/${serveJobId}`}>Open the demo&apos;s job</Link> for its GPU, log and Stop.
        </p>
      ) : null}
    </section>
  );
}

/** The idea and both answers. Model output reads as Markdown but never becomes HTML or a link. Exported for tests. */
export function LiveAnswers({ answer, idBase }: { answer: Answered; idBase: string }) {
  return (
    <div className="lab-try-result">
      <div className="train-msg">
        <h3 className="train-role">Your idea</h3>
        <p className="train-text">{answer.prompt}</p>
      </div>
      <div className="lab-try-pair">
        <LiveAnswer id={`${idBase}-base`} title="Base Glimmer" text={answer.base} />
        <LiveAnswer id={`${idBase}-tuned`} title="Tuned Glimmer" text={answer.tuned} tuned />
      </div>
      <p className="muted small">Both answered in {duration(answer.ms)} on the demo&apos;s GPU.</p>
    </div>
  );
}

function LiveAnswer({ id, title, text, tuned = false }: { id: string; title: string; text: string; tuned?: boolean }) {
  const t = text.trim();
  return (
    <section className={`lab-try-answer${tuned ? " lab-try-tuned" : ""}`} aria-labelledby={id}>
      <h3 className="train-role" id={id}>
        {title}
      </h3>
      {t ? <MarkdownText className="train-text" text={t} links={false} /> : <p className="train-text muted">(empty)</p>}
    </section>
  );
}

export interface StartLiveDemoProps {
  /** The trained glimmer-lora job to serve: the page's own job. */
  adapterJobId: string;
  adapterTitle: string;
  /** TRAIN_JOB_MAX_MINUTES and TRAIN_JOB_MAX_USD: the demo's limits come from its minutes, capped by these. */
  ceilings: TrainLimits;
  /** TRAIN_MAX_ACTIVE and TRAIN_DAILY_USD, for the error sentences. */
  maxActive: number;
  dailyUsd: number;
  /** Why POST /api/train/jobs would refuse right now (a local copy, the sweep not running), or null. */
  blocked?: string | null;
  /** False while this job has no public result page (it isn't judged), so only admins could try the demo. */
  publicPage?: boolean;
  /** True for a decision model's adapter: the demo picks a label for an input instead of answering an app idea. */
  decide?: boolean;
}

/**
 * Start a live demo: a minutes select and a button that starts a glimmer-serve job for this adapter (POST
 * /api/train/jobs), after a confirm with its limits. Minutes whose time plus the boot time pass the time ceiling can't
 * be picked; a warning says when the dollar ceiling could refuse it on the priciest GPU.
 */
export function StartLiveDemo({
  adapterJobId,
  adapterTitle,
  ceilings,
  maxActive,
  dailyUsd,
  blocked = null,
  publicPage = true,
  decide = false,
}: StartLiveDemoProps) {
  const router = useRouter();
  const id = useId();
  const plans = useMemo(() => DEMO_MINUTE_CHOICES.map((m) => demoPlan(m, ceilings)), [ceilings]);
  const first =
    plans.find((p) => p.minutes === SERVE_MINUTES_DEFAULT && p.fits) ?? [...plans].reverse().find((p) => p.fits) ?? plans[0];
  const [minutes, setMinutes] = useState(first.minutes);
  const plan = plans.find((p) => p.minutes === minutes) ?? first;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The new serve job's id once it started ("" when its link didn't come back). */
  const [started, setStarted] = useState<string | null>(null);

  async function start(e: FormEvent) {
    e.preventDefault();
    if (busy || blocked || !plan.fits) return;
    const ask =
      `Start a GPU on Lambda for a ${plan.minutes}-minute live demo? It stops at ${plan.limits.maxMinutes} minutes or ` +
      `${usd(plan.limits.maxUsd)}, whichever comes first` +
      (publicPage ? ", and anyone with this page's link can try it while it runs." : ".");
    if (!window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    const result = await startLiveDemo({ adapterJobId, adapterTitle, minutes: plan.minutes }, { maxActive, dailyUsd });
    setBusy(false);
    if (result.ok) {
      setStarted(result.jobId ?? "");
      router.refresh();
      return;
    }
    setError(result.message);
    if (result.running) router.refresh();
  }

  const fitsNone = !plans.some((p) => p.fits);
  return (
    <section className="card section-card lab-try" id="live-demo" aria-labelledby={`${id}-title`}>
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Live demo</h2>
      </div>
      <p className="lab-try-lead">
        Serve this adapter on one GPU for a set time.{" "}
        {publicPage
          ? decide
            ? "Anyone with this page's link can then type an input and see base Glimmer and this decision model each pick a label for it, with no sign-in."
            : "Anyone with this page's link can then type an app idea and see base and tuned Glimmer answer it side by side, with no sign-in."
          : decide
            ? "This job isn't scored yet, so its public result page doesn't exist and only admins can try the demo here."
            : "This job isn't judged yet, so its public result page doesn't exist and only admins can try the demo here."}
      </p>
      {blocked ? (
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <p>{blocked}</p>
        </div>
      ) : null}

      <form className="lab-try-start" onSubmit={start} noValidate>
        <div className="train-field">
          <label className="train-label" htmlFor={`${id}-minutes`}>
            Minutes live
          </label>
          <select
            id={`${id}-minutes`}
            className="train-select"
            value={String(plan.minutes)}
            onChange={(e) => setMinutes(Number(e.target.value))}
            disabled={busy || started !== null}
            aria-describedby={`${id}-plan`}
          >
            {plans.map((p) => (
              <option key={p.minutes} value={String(p.minutes)} disabled={!p.fits}>
                {p.fits
                  ? `${p.minutes} minutes`
                  : `${p.minutes} minutes (needs ${p.minutes + SERVE_BOOT_MINUTES}, over the ${ceilings.maxMinutes}-minute ceiling)`}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || Boolean(blocked) || !plan.fits || started !== null}
          aria-describedby={`${id}-plan`}
        >
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
          <span>{busy ? "Starting" : "Start a live demo"}</span>
        </button>
      </form>

      <p className="train-help" id={`${id}-plan`} aria-live="polite">
        {fitsNone
          ? `The ${ceilings.maxMinutes}-minute time ceiling leaves no room for a demo: even ${plans[0]?.minutes ?? 10} minutes live needs ${(plans[0]?.minutes ?? 10) + SERVE_BOOT_MINUTES}.`
          : `The job stops at ${plan.limits.maxMinutes} minutes or ${usd(plan.limits.maxUsd)}, whichever comes first: about ${SERVE_BOOT_MINUTES} to boot and load the model, then ${plan.minutes} live. Its GPU shuts down at the end like every other job's.`}
      </p>
      {plan.warn && !fitsNone ? (
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <p>{plan.warn}</p>
        </div>
      ) : null}
      {started !== null ? (
        <p className="muted small" role="status">
          Starting the live demo.{" "}
          {started ? <Link href={`/fine-tuning/${started}`}>Open its job page</Link> : "It's in the jobs list."}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
    </section>
  );
}

/** What the admin job page of a trained glimmer-lora job has for its live demo. */
export type JobLiveDemo =
  /** A serve job for it is starting or live. `decideTry` for a decision model: its box picks labels instead. */
  | { kind: "demo"; demo: LiveDemoView; decideTry?: DecideTryModel | null }
  /** None is open and its adapter can be served: offer to start one. */
  | ({ kind: "start" } & Omit<StartLiveDemoProps, "adapterJobId">);

/** The admin job page's live demo: the Try it live box with a link to the serve job, or Start a live demo. */
export function AdapterLiveDemo({ jobId, live, serverNow }: { jobId: string; live: JobLiveDemo; serverNow: number }) {
  if (live.kind === "demo") {
    const demo = toPublicLiveDemo(live.demo);
    if (!demo) return null;
    return live.decideTry ? (
      <DecideTryCard adapterJobId={jobId} demo={demo} model={live.decideTry} serverNow={serverNow} serveJobId={live.demo.serveJobId} />
    ) : (
      <TryLiveCard adapterJobId={jobId} demo={demo} serverNow={serverNow} serveJobId={live.demo.serveJobId} />
    );
  }
  return (
    <StartLiveDemo
      adapterJobId={jobId}
      adapterTitle={live.adapterTitle}
      ceilings={live.ceilings}
      maxActive={live.maxActive}
      dailyUsd={live.dailyUsd}
      blocked={live.blocked}
      publicPage={live.publicPage}
      decide={live.decide}
    />
  );
}
