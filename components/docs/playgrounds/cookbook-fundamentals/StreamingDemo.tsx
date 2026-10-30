"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import {
  analyzeStream,
  chunkLabel,
  visibleTokensPerSecond,
  type ChunkInfo,
  type StreamAnalysis,
  type TimedEvent,
} from "@/components/docs/playgrounds/cookbook-fundamentals/stream-timing";
import { ms, Stats } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import type { SseEvent } from "@/lib/docs/client/api";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { chatCollector } from "@/lib/docs/client/stream";

/**
 * The streaming-responses recipe, live: a streamed chat completion drawn as it arrives, with when the first chunk and
 * the first visible token came (reasoning happens before the first delta), each chunk on a timeline, the final chunk
 * that carries finish_reason and the usage that stream_options.include_usage asks for, and what the recipe's naive
 * `text += delta.content` loop would have done with these exact chunks.
 */

export interface StreamingDemoProps {
  slug: string;
  prompt?: string;
  presets?: Array<{ label: string; prompt: string }>;
  effort?: Effort | null;
}

const SHOWN_HEAD = 60;
const SHOWN_TAIL = 4;

function Timeline({ a }: { a: StreamAnalysis }) {
  const end = Math.max(1, a.endMs ?? 1);
  const x = (t: number) => (t / end) * 1000;
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / end) * 100)).toFixed(2)}%`;
  const first = a.firstTokenMs;
  return (
    <div className={styles.timelineWrap}>
      <svg
        className={styles.timeline}
        viewBox="0 0 1000 32"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Timeline: first chunk at ${ms(a.firstChunkMs)}, first token at ${ms(first)}, the stream ended at ${ms(a.endMs)}, ${a.chunks.length} chunks`}
      >
        {first !== null && first > 0 ? <rect className={styles.timelineGap} x={0} y={6} width={x(first)} height={16} rx={2} /> : null}
        <line className={styles.timelineAxis} x1={0} x2={1000} y1={30} y2={30} />
        {a.chunks.map((c) => (
          <line
            key={c.index}
            className={styles.timelineTick}
            data-kind={c.kind === "content" ? undefined : c.kind === "finish" || c.kind === "usage" ? c.kind : "empty"}
            x1={x(c.at)}
            x2={x(c.at)}
            y1={6}
            y2={22}
          >
            <title>{`#${c.index + 1} at ${ms(c.at)}: ${chunkLabel(c)}`}</title>
          </line>
        ))}
      </svg>
      <div className={styles.timelineLabels} aria-hidden>
        <span style={{ left: 0 }}>0</span>
        {first !== null && first / end > 0.15 && first / end < 0.6 ? (
          <span style={{ left: pct(first), transform: "translateX(-50%)" }}>first token {ms(first)}</span>
        ) : null}
        <span style={{ right: 0 }}>{ms(a.endMs)}</span>
      </div>
      {first !== null && first / end > 0.25 ? <p className={styles.note}>The shaded stretch is the wait before the first visible token: the model reasons first.</p> : null}
    </div>
  );
}

function ChunkStrip({ chunks, crashIndex }: { chunks: ChunkInfo[]; crashIndex: number | null }) {
  const head = chunks.length > SHOWN_HEAD + SHOWN_TAIL ? chunks.slice(0, SHOWN_HEAD) : chunks;
  const tail = chunks.length > SHOWN_HEAD + SHOWN_TAIL ? chunks.slice(-SHOWN_TAIL) : [];
  const pill = (c: ChunkInfo) => (
    <span
      key={c.index}
      className={styles.chunk}
      data-kind={c.kind === "content" ? undefined : c.index === crashIndex || c.kind === "finish" || c.kind === "usage" ? "end" : "meta"}
      title={`#${c.index + 1} at ${ms(c.at)}`}
    >
      {c.kind === "content" ? (c.content ?? "").replace(/\n/g, "↵ ") : chunkLabel(c)}
    </span>
  );
  return (
    <div className={styles.chunks} role="group" aria-label="Chunks as they arrived">
      {head.map(pill)}
      {tail.length ? <span className={styles.chunk} data-kind="meta">... {chunks.length - SHOWN_HEAD - SHOWN_TAIL} more</span> : null}
      {tail.map(pill)}
    </div>
  );
}

export function StreamingDemo({
  prompt: initialPrompt = "List three uses for a hash map, one line each.",
  presets = [],
  effort: initialEffort = "minimal",
}: StreamingDemoProps) {
  const id = useId();
  const runner = useDocsRun();
  const hint = useModEnterHint("to run");
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [includeUsage, setIncludeUsage] = useState(true);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [preset, setPreset] = useState<number | null>(null);
  const [timed, setTimed] = useState<TimedEvent[]>([]);
  const [log, setLog] = useState<EventLogEntry[]>([]);
  const [showCode, setShowCode] = useState(false);
  const timedRef = useRef<TimedEvent[]>([]);
  const logRef = useRef<EventLogEntry[]>([]);
  const collectorRef = useRef(chatCollector());
  const running = runner.state === "running";

  const body = useMemo(() => {
    const e = fitEffort(model, effort);
    return {
      model,
      messages: [{ role: "user", content: prompt.trim() || "..." }],
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(e ? { reasoning_effort: e } : {}),
    };
  }, [model, effort, includeUsage, prompt]);

  const a = useMemo(() => analyzeStream(timed), [timed]);
  const tps = visibleTokensPerSecond(a);

  const run = async () => {
    if (!prompt.trim() || running) return;
    const collector = chatCollector();
    collectorRef.current = collector;
    timedRef.current = [];
    logRef.current = [];
    setTimed([]);
    setLog([]);
    const t0 = performance.now();
    await runner.run("chat/completions", {
      method: "POST",
      body,
      stream: true,
      onEvent: (event: SseEvent) => {
        collector.push(event);
        timedRef.current = [...timedRef.current, { at: performance.now() - t0, event }];
        logRef.current = logEvent(logRef.current, event);
        setTimed(timedRef.current);
        setLog(logRef.current);
      },
    });
  };

  const reply = collectorRef.current.snapshot();
  const stopped = isAborted(runner.result);
  const finishChunk = a.finishIndex !== null ? a.chunks[a.finishIndex] : null;
  const usageChunk = a.usageIndex !== null ? a.chunks[a.usageIndex] : null;
  const hasRun = running || runner.result;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <Toggle id={`${id}-usage`} label={<code>stream_options.include_usage</code>} checked={includeUsage} onChange={setIncludeUsage} disabled={running} />
      </div>
      {presets.length ? (
        <PresetPills
          presets={presets}
          active={preset}
          disabled={running}
          onPick={(i) => {
            setPreset(i);
            setPrompt(presets[i].prompt);
          }}
        />
      ) : null}
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Message
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void run())}
          disabled={running}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">Raise the reasoning effort to watch the wait before the first token grow. {hint ?? ""}</span>
          <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!prompt.trim()} label="Stream it" />
        </div>
      </div>
      <ErrorBox error={runner.error} />
      {hasRun ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={reply.final ?? undefined}
          usage={a.usage ?? undefined}
          model={runner.result?.model ?? reply.model}
          events={log.length ? log : undefined}
        >
          <div className={styles.stack}>
            <Stats
              label="Stream timing"
              items={[
                { label: "First chunk", value: ms(a.firstChunkMs) },
                { label: "First token", value: ms(a.firstTokenMs), note: a.firstTokenMs !== null && a.firstTokenMs > 1500 ? "the model reasoned first" : undefined },
                { label: "Last token", value: ms(a.lastTokenMs) },
                { label: "Chunks", value: a.chunks.length.toLocaleString("en-US"), note: `${a.contentChunks} with text` },
                { label: "Visible tokens a second", value: tps ? Math.round(tps).toLocaleString("en-US") : "n/a", note: "after the first token" },
              ]}
            />
            {a.chunks.length ? <Timeline a={a} /> : null}
            <p className="pg-section-label">Text as it arrives</p>
            <StreamView text={a.text} running={running} placeholder="No text yet." />
            {stopped ? (
              <p className={styles.note}>
                Stopped mid-stream: the {a.text.length.toLocaleString("en-US")} characters that arrived are kept, as the
                recipe&apos;s stream_completion keeps its partial text. Retrying starts the stream over.
              </p>
            ) : null}
            {a.chunks.length ? (
              <>
                <p className="pg-section-label">Chunks</p>
                <ChunkStrip chunks={a.chunks} crashIndex={a.naive.crashIndex} />
              </>
            ) : null}
            {!running && a.chunks.length ? (
              <div className={styles.compare}>
                <div className={styles.compareCol}>
                  <p className={styles.compareTitle}>Guarded loop</p>
                  <p className={styles.note}>
                    Skips chunks with no choices or no delta.content, as the recipe does: {a.text.length.toLocaleString("en-US")} characters, all of them.
                  </p>
                </div>
                <div className={styles.compareCol}>
                  <p className={styles.compareTitle}>Naive text += delta.content</p>
                  <p className={styles.note}>
                    {a.naive.crashIndex !== null
                      ? `Crashes on chunk ${a.naive.crashIndex + 1} (${chunkLabel(a.chunks[a.naive.crashIndex])}) with ${a.naive.error}, after ${a.naive.collected.length.toLocaleString("en-US")} characters.`
                      : "Gets through these chunks, but only by luck: guard every chunk anyway."}
                  </p>
                </div>
              </div>
            ) : null}
            {!running && (finishChunk || usageChunk) ? (
              <div className={styles.compare}>
                {finishChunk ? (
                  <div className={styles.compareCol}>
                    <p className={styles.compareTitle}>The chunk with finish_reason</p>
                    <p className={styles.note}>
                      Chunk {finishChunk.index + 1} at {ms(finishChunk.at)}: finish_reason <code>{finishChunk.finishReason}</code>, delta.content{" "}
                      {finishChunk.content === undefined ? "missing (None in Python)" : finishChunk.content === null ? "null" : "present"}.
                    </p>
                  </div>
                ) : null}
                {usageChunk ? (
                  <div className={styles.compareCol}>
                    <p className={styles.compareTitle}>The usage {usageChunk.choices ? "on the last chunk" : "chunk"}</p>
                    <JsonTree value={usageChunk.usage} openDepth={1} />
                  </div>
                ) : (
                  <div className={styles.compareCol}>
                    <p className={styles.compareTitle}>No usage chunk</p>
                    <p className={styles.note}>A stream omits usage unless you ask with stream_options.include_usage.</p>
                  </div>
                )}
              </div>
            ) : null}
            {!includeUsage && !running && runner.result?.note ? (
              <p className={styles.note}>
                You turned include_usage off, so your own calls would get no usage chunk. The live docs turn it back on to
                meter the run (the note above says so), which is why one arrived here.
              </p>
            ) : null}
          </div>
        </ResponseView>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body} stream caption="The request Run sends" /> : null}
    </div>
  );
}
