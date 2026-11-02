"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PlanChecklist } from "@/components/build/PlanChecklist";
import { StepsFeed } from "@/components/build/StepsFeed";
import { tuneChecklist } from "@/lib/steps-feed/checklist";
import "@/components/make/make.css";
import "@/components/train/tune.css";
import { EvalResults } from "@/components/train/EvalResults";
import { evalState, judgeName, tunedModelName, writerName } from "@/components/train/format";
import { usd } from "@/lib/format";
import { connectWords, WHILE_TRAINING } from "@/lib/make/connect";
import type { LinkState } from "@/lib/make/pair";
import { tuneFeed } from "@/lib/steps-feed/tune";
import { isSparkOpenDerivative } from "@/lib/train/base";
import type { TuneRunView } from "@/lib/train/tune/types";

const POLL_MS = 5_000;
const LINK_POLL_MS = 30_000;

const Run = createContext<{ run: TuneRunView; link: LinkState | null } | null>(null);

/** Keeps the model's run fresh for the feed on the left and the panel on the right of a build room. */
export function PairedRun({ run: initial, canLink, buildId, children }: { run: TuneRunView; canLink: boolean; buildId: string; children: ReactNode }) {
  const [run, setRun] = useState(initial);
  const [link, setLink] = useState<LinkState | null>(null);
  const id = initial.id;
  const over = run.stage === "ready" || run.stage === "failed" || run.stage === "stopped";

  useEffect(() => {
    if (over) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void fetch(`/api/train/runs/${id}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { run?: TuneRunView } | null) => {
          if (d?.run?.id === id) setRun(d.run);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, over]);

  // An admin's run links to the product once the build has one (POST /api/make/pair). Never for anyone else.
  useEffect(() => {
    if (!canLink || link === "linked" || link === "no_glimmer" || link === "product_daily" || link === "off") return;
    const ask = () =>
      void fetch("/api/make/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buildId, runId: id }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { link?: LinkState } | null) => {
          if (d?.link) setLink(d.link);
        })
        .catch(() => {});
    ask();
    const timer = setInterval(ask, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [canLink, link, buildId, id]);

  return <Run.Provider value={{ run, link }}>{children}</Run.Provider>;
}

/** The model's story, under the app's on the left. */
export function PairedFeed() {
  const v = useContext(Run);
  if (!v) return null;
  return (
    <>
      <li className="make-story-head">The model</li>
      <li>
        <PlanChecklist list={tuneChecklist(v.run)} />
        <StepsFeed feed={tuneFeed(v.run)} label="What is happening to your model" />
      </li>
    </>
  );
}

const LINK_WORDS: Partial<Record<LinkState, string>> = {
  linked: "It is linked to this product.",
  no_glimmer: "This product's plan didn't pick Muse Glimmer, so it can't ask for this model.",
  product_daily: "This product already started a run today, so this one isn't linked to it.",
};

/** The model's scores and results, on the right, with the way to the full room. */
export function PairedPanel() {
  const v = useContext(Run);
  if (!v) return null;
  const { run, link } = v;
  const job = run.job;
  const scored = job && run.stage === "ready" ? evalState(job, run.evals, Date.now()) : null;
  const linked = link === "linked";
  return (
    <li className="room-answer make-row">
      <p>
        <strong>The model.</strong> {run.title}
      </p>
      {run.stage === "ready" ? <p className="tune-verdict">{run.verdict?.words ?? "Not scored."}</p> : null}
      {run.stage === "waiting" && run.hold ? <p>{run.hold.text}</p> : null}
      {run.stage === "failed" || run.stage === "stopped" ? <p>{run.problem ?? "This run didn't finish."}</p> : null}
      {job && scored ? <EvalResults state={scored} rows={run.evals} model={tunedModelName(job.recipe)} writer={writerName(run.dataset)} judge={judgeName(job)} sparkOpen={isSparkOpenDerivative({ params: job.params })} /> : null}
      <p className="room-meta">{usd(run.costSoFarUsd)} so far</p>
      <div className="row-actions">
        <Link className="btn btn-outline" href={`/fine-tuning/runs/${run.id}`}>
          Open its results
        </Link>
      </div>
      {run.stage === "ready" ? null : <p className="muted small">{WHILE_TRAINING}</p>}
      <p className="muted small">{connectWords(linked ? "window" : "none")}</p>
      {link && LINK_WORDS[link] ? <p className="muted small">{LINK_WORDS[link]}</p> : null}
    </li>
  );
}
