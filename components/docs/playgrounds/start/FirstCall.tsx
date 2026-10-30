"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, runOnModEnter, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { Citations, ReplyView, Searches } from "@/components/docs/kit/StreamView";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { SseEvent } from "@/lib/docs/client/api";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectorFor, collectReply, type Collected } from "@/lib/docs/client/stream";
import {
  FIRST_CALL_PRESETS,
  firstCallBody,
  presetMatching,
  readResponse,
  type FirstCallPreset,
  type ResponseReading,
} from "@/components/docs/playgrounds/start/quickstart";
import { SplitPills } from "@/components/docs/playgrounds/start/SplitPills";
import { WONDER_COST_NOTE, WONDER_MODEL, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

export interface FirstCallProps {
  slug: string;
  prompt?: string;
  model?: string;
  /** "What to try next". Defaults to the quickstart's. */
  presets?: FirstCallPreset[];
}

/**
 * The quickstart's first call on the Responses API, with its "Read the response" section live: the answer
 * (response.output_text), each output item (the reasoning item, then the message), and the usage, where reasoning
 * tokens count toward output_tokens. Presets are the next steps the page points to, each a working variation. The
 * highlighted preset is worked out from the form, so it lets go as soon as the reader changes what it set.
 */
export function FirstCall({ prompt: initialPrompt, model: initialModel, presets = [...FIRST_CALL_PRESETS] }: FirstCallProps) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(initialModel ?? presets[0]?.model ?? DEFAULT_TEXT_MODEL);
  const [prompt, setPrompt] = useState(initialPrompt ?? presets[0]?.prompt ?? "What is the capital of France?");
  const [effort, setEffort] = useState<Effort | null>(presets[0]?.effort ?? null);
  const [summary, setSummary] = useState(!!presets[0]?.summary);
  const [webSearch, setWebSearch] = useState(!!presets[0]?.webSearch);
  const [stream, setStream] = useState(!!presets[0]?.stream);
  const [sent, setSent] = useState<Record<string, unknown> | null>(null);
  const [live, setLive] = useState<Collected | null>(null);
  const [final, setFinal] = useState<unknown>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [showCode, setShowCode] = useState(false);
  const eventsRef = useRef<EventLogEntry[]>([]);
  const runHint = useModEnterHint("to run");
  const running = runner.state === "running";

  const options = { model, prompt: prompt.trim(), stream, effort: fitEffort(model, effort), summary, webSearch };
  const next = firstCallBody({ ...options, prompt: options.prompt || "What is the capital of France?" });

  const preset = presetMatching(presets, { model, prompt, effort, summary, webSearch, stream });

  const pick = (i: number) => {
    const p = presets[i];
    if (!p) return;
    setPrompt(p.prompt);
    setModel(p.model ?? DEFAULT_TEXT_MODEL);
    setEffort(p.effort ?? null);
    setSummary(!!p.summary);
    setWebSearch(!!p.webSearch);
    setStream(!!p.stream);
  };

  const run = async () => {
    if (!options.prompt || running) return;
    const body = firstCallBody(options);
    const collector = stream ? collectorFor("responses") : null;
    eventsRef.current = [];
    setEvents([]);
    setSent(body);
    setLive(null);
    setFinal(null);
    const onEvent = (e: SseEvent) => {
      collector!.push(e);
      eventsRef.current = logEvent(eventsRef.current, e);
      setEvents(eventsRef.current);
      setLive(collector!.snapshot());
    };
    const res = await runner.run("responses", { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
    setFinal(collector ? collector.snapshot().final : res.json);
  };

  // Whether the run on screen streamed: the request sent says, not the switch, which may have moved since.
  const streamed = sent?.stream === true;
  const reading = useMemo(() => readResponse(final), [final]);
  const reply = useMemo(() => (final ? collectReply("responses", final) : null), [final]);
  const result = runner.result;
  const shownPreset = preset !== null ? presets[preset] : null;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
        <Toggle id={`${id}-summary`} label="Reasoning summary" checked={summary} onChange={setSummary} disabled={running} />
        <Toggle id={`${id}-search`} label="Web search" checked={webSearch} onChange={setWebSearch} disabled={running} />
      </div>

      <SplitPills label="Try next" presets={presets} active={preset} onPick={pick} disabled={running} />
      {shownPreset ? <p className="pg-hint">{shownPreset.shows}</p> : model === WONDER_MODEL ? <p className="pg-hint">{WONDER_COST_NOTE}</p> : null}

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Input
        </label>
        <TextArea
          id={`${id}-prompt`}
          className={styles.autoGrow}
          rows={Math.min(5, Math.max(2, Math.ceil(prompt.length / 56)))}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={runOnModEnter(() => void run())}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">
            POST /v1/responses{runHint ? `. ${runHint}` : ""}
          </span>
          <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!prompt.trim()} />
        </div>
      </div>

      <ErrorBox error={runner.error} />

      {running || result ? (
        <ResponseView
          result={result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={streamed ? ((running ? live?.final : final) ?? undefined) : undefined}
          usage={streamed ? ((running ? live?.usage : reply?.usage) ?? undefined) : undefined}
          events={events.length ? events : undefined}
        >
          {running && streamed ? (
            <ReplyView reply={live} running />
          ) : reading ? (
            <ReadResponse reading={reading} reply={reply} />
          ) : isAborted(result) ? (
            <p className="pg-muted">Stopped before the reply finished.</p>
          ) : result && !result.ok ? (
            <p className="pg-muted">No response object: the request failed. The error is above, and the JSON tab has the body.</p>
          ) : undefined}
        </ResponseView>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView
          method="POST"
          path="responses"
          body={prompt.trim() || !sent ? next : sent}
          caption={prompt.trim() || !sent ? "The request Run sends next" : "The request that just ran"}
        />
      ) : null}
    </div>
  );
}

/** "Read the response": the answer, the output items in order, and where the tokens went. */
function ReadResponse({ reading, reply }: { reading: ResponseReading; reply: Collected | null }) {
  const u = reading.usage;
  const textTokens = u ? Math.max(0, u.output - u.reasoning) : 0;
  return (
    <div className={styles.stack}>
      <div>
        <p className="pg-section-label">The answer: response.output_text</p>
        <MarkdownText className="pg-stream-text" text={reading.outputText || "(no output_text in this response)"} />
        {reading.items.filter((i) => i.kind === "message").length > 1 ? (
          <p className="pg-hint">
            output_text joins the text of every message item, including the model&apos;s notes between tool calls. The last message holds
            the final answer.
          </p>
        ) : null}
      </div>
      {reply?.searches.length ? <Searches searches={reply.searches} /> : null}
      {reply?.citations.length ? <Citations citations={reply.citations} /> : null}
      <div>
        <p className="pg-section-label">Output items, in order</p>
        <ol className={styles.items}>
          {reading.items.map((item, i) => (
            <li key={`${item.id}-${i}`} className={`${styles.item} ${item.kind === "message" ? styles.itemMessage : ""}`}>
              <span className={styles.itemHead}>
                <span className={styles.itemType}>{item.type}</span>
                {item.id ? <span className={styles.itemId}>{item.id}</span> : null}
              </span>
              {item.detail ? <span>{item.detail}</span> : null}
            </li>
          ))}
        </ol>
      </div>
      {u ? (
        <div className={styles.stack}>
          <p className="pg-section-label">Usage</p>
          {u.output ? (
            <div className={styles.meter} role="img" aria-label={`${u.reasoning} reasoning tokens and ${textTokens} answer tokens of ${u.output} output tokens`}>
              <span className={styles.meterReasoning} style={{ width: `${(u.reasoning / u.output) * 100}%` }} />
              <span className={styles.meterText} style={{ width: `${(textTokens / u.output) * 100}%` }} />
            </div>
          ) : null}
          <p className={styles.legend}>
            <span>
              <span className={`${styles.swatch} ${styles.meterReasoning}`} aria-hidden />
              {u.reasoning.toLocaleString("en-US")} reasoning tokens
            </span>
            <span>
              <span className={`${styles.swatch} ${styles.meterText}`} aria-hidden />
              {textTokens.toLocaleString("en-US")} answer tokens
            </span>
            <span>
              {u.input.toLocaleString("en-US")} input ({u.cached.toLocaleString("en-US")} cached) · {u.output.toLocaleString("en-US")} output ·{" "}
              {u.total.toLocaleString("en-US")} total
            </span>
          </p>
          <p className="pg-hint">
            Reasoning tokens count toward <code>output_tokens</code> and are billed as output.{" "}
            {reading.effort ? (
              <>
                This response ran at <code>reasoning.effort: &quot;{reading.effort}&quot;</code>
                {reading.effort === "high" ? ", the default when a request sets none" : ""}.
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {reading.status === "incomplete" ? (
        <div className="pg-hint" role="status">
          The response stopped early: <code>incomplete_details.reason</code> is <code>{reading.incompleteReason ?? "not given"}</code>.
          {reading.incompleteReason === "max_output_tokens"
            ? ` Reasoning used the output limit before the answer was done${reading.model === WONDER_MODEL ? ` (the live docs cap Muse Wonder at ${WONDER_OUTPUT_CAP} tokens)` : ""}: lower the effort, or raise max_output_tokens in your own code.`
            : ""}
        </div>
      ) : null}
      <p className="pg-hint">
        <code>status: {reading.status || "unknown"}</code> · <code>id: {reading.id}</code>
      </p>
    </div>
  );
}
