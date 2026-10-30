"use client";

import { useId, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ContributorNotice } from "@/components/docs/kit/ContributorNotice";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, TextArea, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { estimateCost } from "@/lib/docs/client/cost";
import { docsModelLabel, isContributor, modelsFor, type Effort } from "@/lib/docs/client/models";
import { collectorFor, type Collected } from "@/lib/docs/client/stream";
import { bodyDifferences, COMPARE_PRESETS, compareBody, compareLine, listWords } from "@/components/docs/playgrounds/start/compare";
import { WONDER_COST_NOTE, WONDER_MODEL } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

/** What both sides' menus offer: the whole text menu. */
const TEXT_MENU = modelsFor("text").map((m) => m.id);

/**
 * The same prompt on two models at once, on the Responses API, streamed side by side with each one's latency,
 * tokens and estimated cost, and a line comparing them. Presets are the models page's choices: Muse Spark or Muse
 * Wonder, Standard or Contributor mode, Muse Spark 1.3 or 1.2.
 */
export function CompareModels({ preset: initialPreset = 0 }: { slug: string; preset?: number }) {
  const id = useId();
  const start = COMPARE_PRESETS[initialPreset] ?? COMPARE_PRESETS[0];
  const [left, setLeft] = useState(start.left);
  const [right, setRight] = useState(start.right);
  const [prompt, setPrompt] = useState(start.prompt);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [preset, setPreset] = useState<number | null>(initialPreset);
  const [showCode, setShowCode] = useState(false);
  const a = useSide();
  const b = useSide();
  const running = a.running || b.running;
  const contributor = [left, right].find((m) => isContributor(m));

  const pick = (i: number) => {
    const p = COMPARE_PRESETS[i];
    setPreset(i);
    setLeft(p.left);
    setRight(p.right);
    setPrompt(p.prompt);
  };

  const run = () => {
    const text = prompt.trim();
    if (!text || running) return;
    void a.send(compareBody(left, text, effort));
    void b.send(compareBody(right, text, effort));
  };

  const stop = () => {
    a.abort();
    b.abort();
  };

  const line =
    a.done && b.done && a.model && b.model
      ? compareLine({ ...a.stats(), label: docsModelLabel(a.model) }, { ...b.stats(), label: docsModelLabel(b.model) })
      : null;

  return (
    <div className="pg">
      <PresetPills label="Compare" presets={COMPARE_PRESETS} active={preset} onPick={pick} disabled={running} />
      {preset !== null ? <p className="pg-hint">{COMPARE_PRESETS[preset].shows}</p> : null}
      <div className="pg-bar">
        <ModelSelect
          kind="text"
          label="Left"
          value={left}
          onChange={(m) => {
            setLeft(m);
            setPreset(null);
          }}
          notice={false}
          disabled={running}
        />
        <ModelSelect
          kind="text"
          label="Right"
          value={right}
          onChange={(m) => {
            setRight(m);
            setPreset(null);
          }}
          notice={false}
          disabled={running}
        />
        <EffortSelect id={`${id}-effort`} model={left === "muse-wonder-1.0" ? right : left} value={effort} onChange={setEffort} disabled={running} />
      </div>
      {contributor ? <ContributorNotice model={contributor} menu={TEXT_MENU} /> : null}
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Prompt for both models
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPreset(null);
          }}
          onKeyDown={runOnModEnter(run)}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">
            {[left, right].includes(WONDER_MODEL) ? WONDER_COST_NOTE : "Both run at once."}
          </span>
          <RunButton running={running} onRun={run} onStop={stop} label="Run both" disabled={!prompt.trim()} />
        </div>
      </div>
      <div className={styles.compare}>
        <Side title={docsModelLabel(a.model ?? left)} side={a} />
        <Side title={docsModelLabel(b.model ?? right)} side={b} />
      </div>
      {line ? (
        <p className={styles.total} role="status">
          {line}
        </p>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CompareCode left={left} right={right} prompt={prompt.trim() || start.prompt} effort={effort} /> : null}
    </div>
  );
}

/** The right side's request, with a caption that names everything the left side's request does differently. */
function CompareCode({ left, right, prompt, effort }: { left: string; right: string; prompt: string; effort: Effort | null }) {
  const body = compareBody(right, prompt, effort);
  const differs = bodyDifferences(compareBody(left, prompt, effort), body);
  const caption = differs.length
    ? `The ${docsModelLabel(right)} side's request. The ${docsModelLabel(left)} side's differs in ${listWords(differs)}.`
    : "Both sides send this request.";
  return <CodeView method="POST" path="responses" body={body} caption={caption} />;
}

interface SideRun {
  /** The model this side last ran, so its results keep their label when the menu changes. */
  model: string | null;
  running: boolean;
  done: boolean;
  reply: Collected | null;
  runner: ReturnType<typeof useDocsRun>;
  send(body: Record<string, unknown>): Promise<void>;
  abort(): void;
  stats(): { model: string; ms: number; usd: number | null; outputTokens: number };
}

/** One side's run: its own useDocsRun and stream collector. */
function useSide(): SideRun {
  const runner = useDocsRun();
  const [reply, setReply] = useState<Collected | null>(null);
  const [done, setDone] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const send = async (body: Record<string, unknown>) => {
    setModel(String(body.model));
    const collector = collectorFor("responses");
    setReply(null);
    setDone(false);
    await runner.run("responses", {
      method: "POST",
      body,
      stream: true,
      onEvent: (e: SseEvent) => {
        collector.push(e);
        setReply(collector.snapshot());
      },
    });
    setReply(collector.snapshot());
    setDone(true);
  };
  const stats = () => {
    const ran = runner.result?.model ?? model ?? "";
    const est = reply ? estimateCost(ran, reply.usage) : null;
    return { model: ran, ms: runner.result?.elapsedMs ?? 0, usd: est?.priced ? est.usd : null, outputTokens: est?.tokens?.output ?? 0 };
  };
  return { model, running: runner.state === "running", done: done && runner.state === "done", reply, runner, send, abort: runner.abort, stats };
}

function Side({ title, side }: { title: string; side: SideRun }) {
  const { runner, reply } = side;
  const result = runner.result;
  return (
    <section className={styles.side} aria-label={title} aria-busy={side.running || undefined}>
      <div className={styles.sideHead}>
        <strong>{title}</strong>
        {side.running ? (
          <span className="pg-status pg-status-busy">
            <span className="pg-dot pg-dot-busy" aria-hidden />
            {latencyLabel(runner.elapsedMs)}
          </span>
        ) : result ? (
          <span className={`pg-status ${result.ok && !runner.error ? "pg-status-ok" : "pg-status-bad"}`}>
            <span className={`pg-dot ${result.ok && !runner.error ? "pg-dot-ok" : "pg-dot-bad"}`} aria-hidden />
            {statusText(result)} · {latencyLabel(result.elapsedMs)}
          </span>
        ) : null}
      </div>
      <ErrorBox error={runner.error} />
      {reply || side.running ? (
        <div className={styles.answer}>
          <StreamView text={reply?.text ?? ""} running={side.running} placeholder="Waiting for the first words..." />
        </div>
      ) : (
        <p className="pg-empty">Run both to see this side.</p>
      )}
      {side.done && reply?.usage ? (
        <p className={styles.metric}>
          <UsageLine model={result?.model ?? null} usage={reply.usage} />
        </p>
      ) : null}
    </section>
  );
}
