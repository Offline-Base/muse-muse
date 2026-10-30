"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, PresetPills, runOnModEnter, Segmented, TextArea, TextInput, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { DocsError, DocsResult } from "@/lib/docs/client/api";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, docsModelLabel, EFFORT_LABELS } from "@/lib/docs/client/models";
import { outcomeOfReply } from "@/lib/docs/client/record";
import {
  choicesFor,
  effortBody,
  effortResult,
  encryptedItems,
  EFFORT_CHOICES,
  presetSetup,
  previousFollowUp,
  replayFirstTurn,
  replayFollowUp,
  SUMMARY_PROFILES,
  type EffortChoice,
  type EffortProtocol,
  type EffortResult,
  type FollowUpMethod,
  type SummaryProfile,
} from "@/components/docs/playgrounds/text/efforts";
import { AnswerText } from "@/components/docs/playgrounds/text/AnswerText";
import { Badge, BarList, cx, DemoTabs, LazyDetails, n, PickPills } from "@/components/docs/playgrounds/text/parts";
import { withChainRetry } from "@/components/docs/playgrounds/text/chain";
import { failureOutcome, recordOf } from "@/components/docs/playgrounds/text/record";
import { RuleChecks } from "@/components/docs/playgrounds/text/RuleChecks";
import type { RuleCheck } from "@/components/docs/playgrounds/text/rules";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * Reasoning, compared (reasoning page): the same prompt at each effort level picked, three at a time, each with its
 * reasoning tokens, visible tokens, latency, estimated cost, the reasoning summary (Responses) and the answer; then
 * a follow-up from any run that carries its reasoning, by previous_response_id or by a stateless replay of the
 * encrypted reasoning. A worst-case cost shows before Run, since output limits cover reasoning too.
 */

export interface ReasoningPreset {
  label: string;
  prompt: string;
  followUp?: string;
  /** Switch to this model with the preset (the page's max example runs on Muse Wonder). */
  model?: string;
  efforts?: EffortChoice[];
  maxOutputTokens?: number;
}

export interface ReasoningLabProps {
  slug: string;
  presets: ReasoningPreset[];
  /** Default ["minimal", "low", "medium", "high"]. */
  efforts?: EffortChoice[];
  /** Default "auto". */
  summary?: SummaryProfile | null;
  /** Default 6000. */
  maxOutputTokens?: number;
  /** Default "responses". */
  protocol?: EffortProtocol;
  model?: string;
  models?: string[];
  checks?: RuleCheck[];
  checksIntro?: string;
}

interface RunSlot {
  state: "queued" | "running" | "done" | "error";
  body: Record<string, unknown>;
  protocol: EffortProtocol;
  model: string;
  result?: EffortResult;
  json?: unknown;
  status?: number;
  ranOn?: string | null;
  elapsedMs?: number;
  error?: DocsError | null;
}

const POOL = 3;
const DEFAULT_EFFORTS: EffortChoice[] = ["minimal", "low", "medium", "high"];
const DEFAULT_FOLLOW_UP = "Now explain the key step in one sentence.";

/** The live docs' output caps per model (docs/DOCS_MIRROR.md, "Clamps"), for the worst-case cost. */
const PROXY_CAP: Record<string, number> = {
  "muse-wonder-1.0": 4096,
  "muse-spark-1.2": 8192,
  "muse-spark-1.1": 8192,
  "muse-spark-1.3-contributor": 16_384,
  "muse-spark-1.2-contributor": 16_384,
};
const LABEL: Record<EffortChoice, string> = { default: "Default", ...EFFORT_LABELS };

function pathOf(protocol: EffortProtocol): string {
  return protocol === "chat" ? "chat/completions" : "responses";
}

export function ReasoningLab(props: ReasoningLabProps) {
  const id = useId();
  const r1 = useDocsRun();
  const r2 = useDocsRun();
  const r3 = useDocsRun();
  const followRunner = useDocsRun();
  const { recordRequest } = useDocsPage();
  const pool = [r1, r2, r3];
  const hint = useModEnterHint("to run");
  const first = props.presets[0];
  const [protocol, setProtocol] = useState<EffortProtocol>(props.protocol ?? "responses");
  const [model, setModel] = useState(first?.model ?? props.model ?? DEFAULT_TEXT_MODEL);
  const [efforts, setEfforts] = useState<EffortChoice[]>(first?.efforts ?? props.efforts ?? DEFAULT_EFFORTS);
  const [summary, setSummary] = useState<SummaryProfile | null>(props.summary === undefined ? "auto" : props.summary);
  const [maxTokens, setMaxTokens] = useState(String(first?.maxOutputTokens ?? props.maxOutputTokens ?? 6000));
  const [preset, setPreset] = useState<number | null>(first ? 0 : null);
  const [prompt, setPrompt] = useState(first?.prompt ?? "");
  const [followUp, setFollowUp] = useState(first?.followUp ?? DEFAULT_FOLLOW_UP);
  const [runs, setRuns] = useState<Partial<Record<EffortChoice, RunSlot>>>({});
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<FollowUpMethod>("previous");
  const [from, setFrom] = useState<EffortChoice | null>(null);
  const [follow, setFollow] = useState<{ steps: Array<{ label: string; body: Record<string, unknown>; res: DocsResult }>; result: EffortResult | null } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const stop = useRef(false);
  const followStop = useRef(false);

  const allowed = choicesFor(model);
  const chosen = EFFORT_CHOICES.filter((e) => efforts.includes(e) && allowed.includes(e));
  const typed = Math.round(Number(maxTokens));
  // Left empty, no limit is sent and the proxy applies its own cap for the model (docs/DOCS_MIRROR.md, "Clamps").
  const limit = typed > 0 ? Math.max(16, Math.min(PROXY_CAP[model] ?? 16_384, typed)) : null;
  const bodyFor = (effort: EffortChoice) =>
    effortBody(protocol, { model, prompt: prompt.trim(), effort, summary: protocol === "responses" ? summary : null, maxOutputTokens: limit });
  const worst = estimateCost(model, { input_tokens: 0, output_tokens: (limit ?? PROXY_CAP[model] ?? 16_384) * chosen.length })?.usd ?? 0;

  const runAll = async () => {
    if (busy || !prompt.trim() || !chosen.length) return;
    stop.current = false;
    setBusy(true);
    setFollow(null);
    const slots: Partial<Record<EffortChoice, RunSlot>> = {};
    for (const e of chosen) slots[e] = { state: "queued", body: bodyFor(e), protocol, model };
    setRuns(slots);
    setFrom(chosen[0] ?? null);
    let next = 0;
    const worker = async (runner: (typeof pool)[number]) => {
      while (next < chosen.length && !stop.current) {
        const effort = chosen[next++];
        const slot = slots[effort]!;
        setRuns((r) => ({ ...r, [effort]: { ...slot, state: "running" } }));
        const res = await runner.run(pathOf(protocol), { method: "POST", body: slot.body, record: false });
        const ok = res.ok;
        const spent = ok ? effortResult(protocol, res.json) : null;
        recordRequest(
          recordOf(
            pathOf(protocol),
            slot.body,
            res,
            spent ? `effort ${LABEL[effort].toLowerCase()}: ${n(spent.reasoning)} reasoning tokens of ${n(spent.output)} output; ${outcomeOfReply(res.json, res.status)}` : `effort ${LABEL[effort].toLowerCase()}: ${failureOutcome(res)}`,
          ),
        );
        setRuns((r) => ({
          ...r,
          [effort]: {
            ...slot,
            state: ok ? "done" : "error",
            result: spent ?? undefined,
            json: res.json,
            status: res.status,
            ranOn: res.model,
            elapsedMs: res.elapsedMs,
            error: res.error,
          },
        }));
      }
    };
    await Promise.all(pool.slice(0, Math.min(POOL, chosen.length)).map(worker));
    if (stop.current) setRuns((r) => Object.fromEntries(Object.entries(r).filter(([, s]) => s && s.state !== "queued")));
    setBusy(false);
  };

  const stopAll = () => {
    stop.current = true;
    pool.forEach((r) => r.abort());
  };

  // A preset is a whole setup (presetSetup): what it leaves out goes back to the demo's defaults.
  const pick = (i: number) => {
    const p = props.presets[i];
    if (!p) return;
    const next = presetSetup(p, {
      prompt: "",
      followUp: DEFAULT_FOLLOW_UP,
      model: props.model ?? DEFAULT_TEXT_MODEL,
      efforts: props.efforts ?? DEFAULT_EFFORTS,
      maxOutputTokens: props.maxOutputTokens ?? 6000,
    });
    setPreset(i);
    setPrompt(next.prompt);
    setFollowUp(next.followUp);
    setModel(next.model);
    setEfforts(next.efforts);
    setMaxTokens(String(next.maxOutputTokens));
  };

  const done = chosen.map((e) => [e, runs[e]] as const).filter((x): x is readonly [EffortChoice, RunSlot] => !!x[1]);
  const finished = done.filter(([, s]) => s.state === "done" && s.result);
  const source = from && runs[from]?.state === "done" ? runs[from] : finished[0]?.[1];
  const sourceEffort = from && runs[from]?.state === "done" ? from : finished[0]?.[0];

  const runFollowUp = async () => {
    if (!source?.result || followBusy || !followUp.trim() || source.protocol !== "responses") return;
    setFollowBusy(true);
    followStop.current = false;
    setFollow({ steps: [], result: null });
    const steps: Array<{ label: string; body: Record<string, unknown>; res: DocsResult }> = [];
    if (method === "previous" && source.result.id) {
      const body = previousFollowUp(source.body, source.result.id, followUp.trim());
      const res = await withChainRetry(() => followRunner.run("responses", { method: "POST", body }), body, { stopped: () => followStop.current });
      steps.push({ label: "The follow-up, continuing the stored response", body, res });
      setFollow({ steps, result: res.ok ? effortResult("responses", res.json) : null });
    } else {
      const turn1 = replayFirstTurn(source.body);
      const res1 = await followRunner.run("responses", { method: "POST", body: turn1 });
      steps.push({ label: "Turn 1 again, with include: [\"reasoning.encrypted_content\"] and store: false", body: turn1, res: res1 });
      setFollow({ steps: [...steps], result: null });
      if (res1.ok) {
        const turn2 = replayFollowUp(turn1, res1.json, followUp.trim());
        const res2 = await followRunner.run("responses", { method: "POST", body: turn2 });
        steps.push({ label: "Turn 2, replaying turn 1's output items (reasoning included) before the new question", body: turn2, res: res2 });
        setFollow({ steps: [...steps], result: res2.ok ? effortResult("responses", res2.json) : null });
      }
    }
    setFollowBusy(false);
  };

  const chart = finished.length > 1;
  const codeBody = bodyFor(sourceEffort ?? chosen[0] ?? "low");

  const demo = (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <Segmented<EffortProtocol>
          label="Protocol"
          options={[
            { value: "responses", label: "Responses" },
            { value: "chat", label: "Chat Completions" },
          ]}
          value={protocol}
          onChange={(p) => {
            setProtocol(p);
            setRuns({});
            setFollow(null);
          }}
          disabled={busy}
        />
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={busy} />
        {protocol === "responses" ? (
          <span className="pg-inline-field">
            <label className="pg-label" htmlFor={`${id}-summary`}>
              Summary
            </label>
            <span className="select-wrap">
              <select
                id={`${id}-summary`}
                className="select pg-select"
                value={summary ?? ""}
                disabled={busy}
                onChange={(e) => setSummary(e.target.value ? (e.target.value as SummaryProfile) : null)}
              >
                <option value="">None</option>
                {SUMMARY_PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </span>
          </span>
        ) : null}
        <span className="pg-inline-field">
          <label className="pg-label" htmlFor={`${id}-max`}>
            {protocol === "chat" ? "max_completion_tokens" : "max_output_tokens"}
          </label>
          <TextInput
            id={`${id}-max`}
            className={styles.number}
            inputMode="numeric"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={busy}
            aria-describedby={`${id}-max-hint`}
          />
        </span>
      </div>

      <PickPills<EffortChoice>
        label="Efforts"
        options={EFFORT_CHOICES.map((e) => ({ value: e, label: LABEL[e], disabled: !allowed.includes(e) }))}
        value={efforts}
        onChange={setEfforts}
        disabled={busy}
      />
      <p className={cx(styles.about, styles.small)} id={`${id}-max-hint`}>
        Reasoning tokens count toward the output limit and bill like visible output. &quot;Default&quot; leaves the effort out, so the model picks
        {model === "muse-wonder-1.0" || model === "muse-spark-1.3" ? "" : "; Max is offered on Muse Wonder"}. &quot;none&quot; returns HTTP 400 on these models.
      </p>

      {props.presets.length ? <PresetPills presets={props.presets} active={preset} onPick={pick} disabled={busy} /> : null}

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Prompt
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (preset !== null && e.target.value !== props.presets[preset]?.prompt) setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void runAll())}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">
            {chosen.length} run{chosen.length === 1 ? "" : "s"}, up to three at once. Worst case {formatUsd(worst)} if every run uses its whole output limit. {hint ?? ""}
          </span>
          <RunButton running={busy} onRun={() => void runAll()} onStop={stopAll} label={`Run ${chosen.length} effort${chosen.length === 1 ? "" : "s"}`} disabled={!prompt.trim() || !chosen.length} />
        </div>
      </div>

      {done.length ? (
        <section className={styles.stack} aria-label="Results by effort">
          {chart ? (
            <div className={styles.card}>
              <p className={styles.cardTitle}>Reasoning tokens by effort</p>
              <BarList
                label="Reasoning tokens by effort"
                items={finished.map(([e, s]) => ({ id: e, label: LABEL[e], value: s.result!.reasoning, display: `${n(s.result!.reasoning)} tokens` }))}
              />
              <p className={styles.cardTitle}>Time to the whole answer</p>
              <BarList
                label="Latency by effort"
                items={finished.map(([e, s]) => ({ id: e, label: LABEL[e], value: s.elapsedMs ?? 0, display: latencyLabel(s.elapsedMs ?? 0) }))}
              />
            </div>
          ) : null}
          <ol className={styles.runs} aria-live="polite">
            {done.map(([e, s]) => (
              <EffortRow key={e} effort={e} slot={s} onFollow={() => setFrom(e)} selected={sourceEffort === e} />
            ))}
          </ol>
        </section>
      ) : null}

      {done.some(([, s]) => s.state === "error") ? <ErrorBox error={done.find(([, s]) => s.state === "error")?.[1].error ?? null} /> : null}

      {finished.length && source ? (
        <section className={styles.card} aria-labelledby={`${id}-follow`}>
          <p className={styles.cardTitle} id={`${id}-follow`}>
            Carry the reasoning into a follow-up
          </p>
          {source.protocol === "chat" ? (
            <p className={styles.about}>
              Chat Completions can&apos;t carry reasoning across turns for API keys: <code>reasoning_content</code> is redacted before the reply reaches you (
              {source.result?.reasoningContent === "absent" ? "it was missing from this reply" : source.result?.reasoningContent === "empty" ? "it came back empty here" : "check the reply"}),
              so each turn reasons from scratch. Switch to Responses to try both ways the page gives.
            </p>
          ) : (
            <>
              <div className={styles.row}>
                <span className="pg-inline-field">
                  <label className="pg-label" htmlFor={`${id}-from`}>
                    From the run at
                  </label>
                  <span className="select-wrap">
                    <select id={`${id}-from`} className="select pg-select" value={sourceEffort ?? ""} disabled={followBusy} onChange={(ev) => setFrom(ev.target.value as EffortChoice)}>
                      {finished.map(([e]) => (
                        <option key={e} value={e}>
                          {LABEL[e]}
                        </option>
                      ))}
                    </select>
                  </span>
                </span>
                <Segmented<FollowUpMethod>
                  label="How to carry the reasoning"
                  size="sm"
                  options={[
                    { value: "previous", label: "previous_response_id" },
                    { value: "replay", label: "Stateless replay" },
                  ]}
                  value={method}
                  onChange={setMethod}
                  disabled={followBusy}
                />
              </div>
              <p className={cx(styles.about, styles.small)}>
                {method === "previous"
                  ? "The server keeps the reasoning of a stored response: send only the new question with previous_response_id."
                  : "Nothing stored: ask for the encrypted reasoning with include, then send it back as reasoning input items with the rest of the history. Two calls."}
              </p>
              <Field id={`${id}-fu`} label="Follow-up">
                <TextArea id={`${id}-fu`} rows={2} value={followUp} onChange={(ev) => setFollowUp(ev.target.value)} onKeyDown={runOnModEnter(() => void runFollowUp())} disabled={followBusy} />
              </Field>
              <div className="pg-composer-bar">
                <RunButton
                  running={followBusy}
                  onRun={() => void runFollowUp()}
                  onStop={() => {
                    followStop.current = true;
                    followRunner.abort();
                  }}
                  label="Send the follow-up"
                  disabled={!followUp.trim()}
                />
              </div>
              {follow ? <FollowView follow={follow} running={followBusy} /> : null}
              <ErrorBox error={followRunner.error} />
            </>
          )}
        </section>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView method="POST" path={pathOf(protocol)} body={codeBody} caption={`The request for the ${LABEL[sourceEffort ?? chosen[0] ?? "low"].toLowerCase()} run`} />
      ) : null}
    </div>
  );

  if (!props.checks?.length) return demo;
  return (
    <DemoTabs
      label="Reasoning demo"
      tabs={[
        { id: "demo", label: "Compare efforts", content: demo },
        { id: "rules", label: "Check the rules", count: props.checks.length, content: <RuleChecks slug={props.slug} checks={props.checks} intro={props.checksIntro} models={props.models} /> },
      ]}
    />
  );
}

function EffortRow({ effort, slot, onFollow, selected }: { effort: EffortChoice; slot: RunSlot; onFollow(): void; selected: boolean }) {
  const r = slot.result;
  return (
    <li className={styles.run} aria-busy={slot.state === "running" || undefined}>
      <div className={styles.runHead}>
        <span className={styles.runName}>{LABEL[effort]}</span>
        {slot.state === "queued" ? (
          <Badge>Waiting</Badge>
        ) : slot.state === "running" ? (
          <span className="pg-status pg-status-busy">
            <span className="pg-dot pg-dot-busy" aria-hidden />
            Running
          </span>
        ) : slot.state === "error" ? (
          <span className="pg-status pg-status-bad">
            <span className="pg-dot pg-dot-bad" aria-hidden />
            {statusText({ status: slot.status ?? 0, error: slot.error ?? null } as DocsResult)}
          </span>
        ) : r?.status === "incomplete" ? (
          <Badge tone="warn">Cut off: {r.incomplete ?? "incomplete"}</Badge>
        ) : (
          <Badge tone="ok">Done</Badge>
        )}
        {r ? (
          <>
            <span>
              <strong>{n(r.reasoning)}</strong> reasoning
            </span>
            <span>{n(r.visible)} visible</span>
            {slot.elapsedMs ? <span className="pg-muted">{latencyLabel(slot.elapsedMs)}</span> : null}
            <UsageLine model={slot.ranOn ?? slot.model} usage={(slot.json as { usage?: unknown } | null)?.usage ?? null} />
            {effort === "default" && r.ranAt ? <Badge tone="accent">ran at {r.ranAt}</Badge> : null}
          </>
        ) : null}
        {slot.state === "done" && slot.protocol === "responses" ? (
          <span className={styles.runAction}>
            {selected ? (
              <Badge tone="accent">Follow-up source</Badge>
            ) : (
              <button type="button" className="btn btn-sm btn-outline" onClick={onFollow}>
                Follow up from here
              </button>
            )}
          </span>
        ) : null}
      </div>
      {slot.state === "error" && slot.error ? <p className="pg-hint pg-bad">{slot.error.message}</p> : null}
      {r ? (
        <details className={styles.details}>
          <summary>
            {r.summary.length ? `Reasoning summary (${r.summary.length} part${r.summary.length === 1 ? "" : "s"}) and the answer` : "The answer"}
            {slot.ranOn ? ` from ${docsModelLabel(slot.ranOn)}` : ""}
          </summary>
          <div className={styles.tight}>
            {r.summary.length ? (
              <div className="pg-reasoning">
                <p className="pg-section-label">Reasoning summary</p>
                {r.summary.map((s, i) => (
                  <p key={i} className="pg-reasoning-text">
                    {s}
                  </p>
                ))}
              </div>
            ) : slot.protocol === "responses" && slot.body.reasoning && (slot.body.reasoning as { summary?: unknown }).summary ? (
              <p className="pg-hint">No summary this time: the page says summaries aren&apos;t guaranteed, and the summary array can be empty.</p>
            ) : null}
            {r.answer ? (
              <div className={styles.clamp}>
                <AnswerText text={r.answer} />
              </div>
            ) : (
              <p className="pg-hint">No visible answer: the output limit ran out during reasoning. Raise it and run again.</p>
            )}
          </div>
        </details>
      ) : null}
    </li>
  );
}

function FollowView({ follow, running }: { follow: { steps: Array<{ label: string; body: Record<string, unknown>; res: DocsResult }>; result: EffortResult | null }; running: boolean }) {
  return (
    <div className={styles.tight}>
      {follow.steps.map((s, i) => (
        <div key={i} className={styles.tight}>
          <p className="pg-small">
            <strong>{s.label}</strong>{" "}
            <span className="pg-muted">
              {statusText(s.res)}, {latencyLabel(s.res.elapsedMs)}
            </span>
          </p>
          {s.res.ok && i === 0 && follow.steps.length > 1 ? (
            <p className="pg-small pg-muted">{encryptedItems(s.res.json)} reasoning item(s) came back with encrypted_content to replay.</p>
          ) : null}
          <LazyDetails summary={`Request${s.res.json ? " and reply" : ""}`}>
            <JsonTree value={s.body} openDepth={2} />
            {s.res.json ? <JsonTree value={s.res.json} openDepth={1} /> : null}
          </LazyDetails>
        </div>
      ))}
      {running && !follow.result ? <p className="pg-wait">Running...</p> : null}
      {follow.result ? (
        <div className="pg-final" role="status">
          <p className="pg-section-label">
            Follow-up answer: {n(follow.result.reasoning)} reasoning tokens, {n(follow.result.input)} input tokens
          </p>
          <div className={styles.clamp}>{follow.result.answer ? <AnswerText text={follow.result.answer} /> : "(no visible answer)"}</div>
        </div>
      ) : null}
    </div>
  );
}
