"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel, ResponseView, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { ReplyView } from "@/components/docs/kit/StreamView";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import {
  bodyBytes,
  bytesLabel,
  COMPARE_PROTOCOLS,
  compareBodies,
  eventSummary,
  nextTurnNote,
  replyShape,
  textPath,
  usageFields,
  WIRE,
  type CompareTurn,
} from "@/components/docs/playgrounds/protocols/compare";
import styles from "@/components/docs/playgrounds/protocols/protocols.module.css";
import type { DocsResult, SseEvent } from "@/lib/docs/client/api";
import { PROTOCOL_LABEL, PROTOCOL_PATH, type Protocol } from "@/lib/docs/client/body";
import { costExtrasOf } from "@/lib/docs/client/cost";
import { eventType, logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { DEFAULT_TEXT_MODEL, type Effort } from "@/lib/docs/client/models";
import { collectorFor, collectReply, type Collected } from "@/lib/docs/client/stream";
import { groupThousands } from "@/lib/format";

/**
 * "Choosing an API" made live: one question goes to Responses, Chat Completions and Messages at the same time, and a
 * table lines up what differs (where the instructions and the token limit go, where the text comes back, what the
 * usage fields are called, what it cost) and what doesn't (the model, the price per token). A follow-up shows how each
 * format carries the conversation: Responses sends only the new input with previous_response_id while the other two
 * resend everything, so their requests grow. A turn joins the conversation only when at least one format answered
 * and nobody pressed Stop; a format whose request failed leaves that turn out of its own history (compare.ts).
 */

/** Meta can answer a just-stored previous_response_id with this 400 for a moment (protocols/responses, "Persistence"). */
const STORAGE_LAG = /referenced response not found/i;
const STORAGE_LAG_RETRY_MS = 1500;

export interface ComparePreset {
  label: string;
  prompt: string;
  system?: string;
}

export interface ProtocolCompareProps {
  slug: string;
  prompt?: string;
  system?: string;
  presets?: ComparePreset[];
  /** Pills offered after the first turn, to ask a follow-up. */
  followUps?: string[];
  model?: string;
  models?: string[];
  /** Default "low". */
  effort?: Effort | null;
  /** Each format's output-token limit. Default 1500. */
  maxOutputTokens?: number;
  /** Default false: the whole reply shape shows at once. */
  stream?: boolean;
}

interface Lane {
  body: Record<string, unknown>;
  result: DocsResult | null;
  reply: Collected | null;
  events: EventLogEntry[];
  types: string[];
}

type Lanes = Partial<Record<Protocol, Lane>>;

/** A reply's text without Markdown emphasis and heading marks, for a table cell that shows its start. */
function plainReply(text: string): string {
  return text
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text that may wrap after dots, underscores, commas and a path's slashes rather than mid-word, for narrow table
 * cells: "POST /v1/chat/completions" breaks after "chat/", never inside "completions".
 */
function Breakable({ children }: { children: string }) {
  const parts = children.split(/(?<=[._,]|\w\/)/);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}

/** A code span that wraps at Breakable's points. */
function Code({ children }: { children: string }) {
  return (
    <code>
      <Breakable>{children}</Breakable>
    </code>
  );
}

export function ProtocolCompare(props: ProtocolCompareProps) {
  const id = useId();
  const tabsId = useId();
  const runners = { responses: useDocsRun(), chat: useDocsRun(), messages: useDocsRun() } satisfies Record<Protocol, ReturnType<typeof useDocsRun>>;
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [stream, setStream] = useState(props.stream ?? false);
  const [system, setSystem] = useState(props.system ?? "");
  const [systemOpen, setSystemOpen] = useState(!!props.system);
  const [prompt, setPrompt] = useState(props.prompt ?? "");
  const [preset, setPreset] = useState<number | null>(null);
  const [history, setHistory] = useState<CompareTurn[]>([]);
  const [lanes, setLanes] = useState<Lanes>({});
  const [question, setQuestion] = useState<string | null>(null);
  // The turn number the last Send went out as, and why it didn't join the conversation, when it didn't.
  const [sentTurn, setSentTurn] = useState(0);
  const [dropped, setDropped] = useState<"stopped" | "failed" | null>(null);
  const stoppedRef = useRef(false);
  const [tab, setTab] = useState<Protocol>("responses");
  const [showCode, setShowCode] = useState(false);
  const lanesRef = useRef<Lanes>({});
  const runHint = useModEnterHint("to send");
  const maxOutputTokens = props.maxOutputTokens ?? 1500;
  const running = COMPARE_PROTOCOLS.some((p) => runners[p].state === "running");

  const setLane = (p: Protocol, patch: Partial<Lane>) => {
    lanesRef.current = { ...lanesRef.current, [p]: { ...(lanesRef.current[p] as Lane), ...patch } };
    setLanes(lanesRef.current);
  };

  const nextBodies = useMemo(
    () => compareBodies({ model, system, question: prompt.trim() || props.prompt || "Hello", effort, maxOutputTokens, stream }, history),
    [model, system, prompt, props.prompt, effort, maxOutputTokens, stream, history],
  );

  /** One format's request. A chained Responses turn that hits the storage-lag 400 is sent once more after a pause. */
  const runLane = async (p: Protocol, body: Record<string, unknown>): Promise<{ reply: Collected | null; aborted: boolean }> => {
    const once = async () => {
      const collector = collectorFor(p);
      let events: EventLogEntry[] = [];
      const types: string[] = [];
      let last = 0;
      const onEvent = (e: SseEvent) => {
        collector.push(e);
        events = logEvent(events, e);
        types.push(eventType(e));
        const now = performance.now();
        if (now - last > 80) {
          last = now;
          setLane(p, { reply: collector.snapshot(), events, types: [...types] });
        }
      };
      const result = await runners[p].run(PROTOCOL_PATH[p], { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
      return { result, collector, events, types };
    };
    let sent = await once();
    if (p === "responses" && body.previous_response_id && sent.result.status === 400 && STORAGE_LAG.test(sent.result.error?.message ?? "")) {
      await new Promise((resolve) => setTimeout(resolve, STORAGE_LAG_RETRY_MS));
      if (!stoppedRef.current) sent = await once();
    }
    const { result, collector, events, types } = sent;
    const reply = stream ? collector.snapshot() : result.ok ? collectReply(p, result.json) : null;
    setLane(p, { result, reply, events, types });
    const aborted = isAborted(result) || stoppedRef.current;
    return { reply: result.ok && !aborted ? reply : null, aborted };
  };

  const send = async () => {
    const q = prompt.trim();
    if (!q || running) return;
    const bodies = compareBodies({ model, system, question: q, effort, maxOutputTokens, stream }, history);
    lanesRef.current = Object.fromEntries(COMPARE_PROTOCOLS.map((p) => [p, { body: bodies[p], result: null, reply: null, events: [], types: [] }]));
    setLanes(lanesRef.current);
    setQuestion(q);
    setSentTurn(history.length + 1);
    setDropped(null);
    setPrompt("");
    stoppedRef.current = false;
    const lanesDone = await Promise.all(COMPARE_PROTOCOLS.map((p) => runLane(p, bodies[p])));
    const [r, c, m] = lanesDone.map((l) => l.reply);
    // A stopped turn, or one no format answered, isn't part of the conversation: the question goes back in the box.
    const stopped = lanesDone.some((l) => l.aborted);
    if (stopped || ![r, c, m].some(Boolean)) {
      setDropped(stopped ? "stopped" : "failed");
      setPrompt(q);
      return;
    }
    const content = (m?.final as { content?: unknown } | null)?.content;
    setHistory((h) => [
      ...h,
      {
        question: q,
        responsesId: r?.id && r.text ? r.id : null,
        chatText: c?.text || null,
        messagesContent: Array.isArray(content) && m?.text ? content : null,
      },
    ]);
  };

  const stop = () => {
    stoppedRef.current = true;
    COMPARE_PROTOCOLS.forEach((p) => runners[p].abort());
  };

  const restart = () => {
    stop();
    COMPARE_PROTOCOLS.forEach((p) => runners[p].reset());
    setHistory([]);
    setLanes({});
    lanesRef.current = {};
    setQuestion(null);
    setSentTurn(0);
    setDropped(null);
  };

  const pick = (i: number) => {
    const p = props.presets?.[i];
    if (!p) return;
    setPreset(i);
    setPrompt(p.prompt);
    if (p.system !== undefined) {
      setSystem(p.system);
      if (p.system) setSystemOpen(true);
    }
  };

  const turn = history.length + 1;
  const ran = COMPARE_PROTOCOLS.some((p) => lanes[p]?.result);
  const sent = COMPARE_PROTOCOLS.some((p) => lanes[p]);

  const cell = (p: Protocol, render: (lane: Lane) => ReactNode) => {
    const lane = lanes[p];
    if (!lane) return <span className={styles.dim}>Not sent yet</span>;
    if (!lane.result) return <span className={styles.dim}>{runners[p].state === "running" ? "Running..." : "Not sent yet"}</span>;
    if (!lane.result.ok) return <span className="pg-bad">{statusText(lane.result)}</span>;
    return render(lane);
  };

  const finalOf = (lane: Lane) => (lane.reply?.final ?? lane.result?.json ?? null) as Record<string, unknown> | null;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
      </div>

      {props.presets?.length && !history.length ? <PresetPills presets={props.presets} active={preset} onPick={pick} disabled={running} /> : null}
      {history.length && props.followUps?.length ? (
        <PresetPills label="Follow up" presets={props.followUps.map((f) => ({ label: f }))} onPick={(i) => setPrompt(props.followUps![i])} disabled={running} />
      ) : null}

      <details className="pg-system" open={systemOpen} onToggle={(e) => setSystemOpen(e.currentTarget.open)}>
        <summary>Instructions{system ? "" : " (optional)"}</summary>
        <label className="sr-only" htmlFor={`${id}-system`}>
          Instructions
        </label>
        <TextArea
          id={`${id}-system`}
          rows={2}
          value={system}
          placeholder="Sent as instructions on Responses, a developer message on Chat Completions and system on Messages."
          onChange={(e) => setSystem(e.target.value)}
          disabled={running}
        />
      </details>

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Question for all three formats
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={2}
          value={prompt}
          placeholder={history.length ? "Ask a follow-up: Responses sends only this, the others resend the conversation" : "Ask something"}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (preset !== null && e.target.value !== props.presets?.[preset]?.prompt) setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void send())}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">
            {history.length && !running ? `Turn ${turn}. ` : ""}
            {runHint ?? ""}
          </span>
          {history.length ? (
            <button type="button" className="btn btn-sm" disabled={running} onClick={restart}>
              New conversation
            </button>
          ) : null}
          <RunButton running={running} onRun={() => void send()} onStop={stop} label="Send to all three" disabled={!prompt.trim()} />
        </div>
      </div>

      {question ? (
        <p className="pg-hint">
          Turn {sentTurn}: &ldquo;{question}&rdquo;
          {dropped && !running
            ? ` Not added to the conversation: ${dropped === "stopped" ? "it was stopped" : "no format answered"}. Send it again to go on.`
            : ""}
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {ran && !running
          ? COMPARE_PROTOCOLS.map((p) => `${PROTOCOL_LABEL[p]}: ${lanes[p]?.result ? statusText(lanes[p]!.result!) : "not sent"}`).join(". ")
          : ""}
      </p>

      <div className={styles.compareBox}>
      <p className={styles.compareScrollHint}>Scroll the table sideways for Chat Completions and Messages.</p>
      <div className={styles.compareTableWrap}>
        <table className={styles.compareTable}>
          <caption className="sr-only">The same request in the three formats</caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <th key={p} scope="col">
                  {PROTOCOL_LABEL[p]}
                  <span className={styles.compareEndpoint}>
                    <Breakable>{WIRE[p].endpoint}</Breakable>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sent ? (
              <>
            <tr>
              <th scope="row">Reply</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  {cell(p, (lane) => (
                    <span className={styles.compareText}>{plainReply(lane.reply?.text ?? "") || <span className={styles.dim}>No text came back</span>}</span>
                  ))}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Status, time</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>{cell(p, (lane) => `${statusText(lane.result!)}, ${latencyLabel(lane.result!.elapsedMs)}`)}</td>
              ))}
            </tr>
            <tr className="pg-advanced">
              <th scope="row">Reply shape</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>{cell(p, (lane) => <Code>{replyShape(p, finalOf(lane))}</Code>)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Usage fields</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  {cell(p, (lane) => {
                    const rows = usageFields(p, lane.reply?.usage ?? finalOf(lane)?.usage);
                    return rows.length ? (
                      <span>
                        {rows.map(([k, v]) => (
                          <span key={k} style={{ display: "block" }}>
                            <Code>{k}</Code> {groupThousands(v)}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className={styles.dim}>No usage reported</span>
                    );
                  })}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Cost</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  {cell(p, (lane) => (
                    <UsageLine model={lane.result?.model ?? model} usage={lane.reply?.usage ?? finalOf(lane)?.usage ?? null} {...costExtrasOf(finalOf(lane))} />
                  ))}
                </td>
              ))}
            </tr>
              </>
            ) : null}
            <tr>
              <th scope="row">Text is at</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  <Code>{(lanes[p]?.result?.ok ? textPath(p, finalOf(lanes[p]!)) : null) ?? WIRE[p].textAt}</Code>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Instructions go in</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  <Code>{WIRE[p].instructions}</Code>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Token limit</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  <Code>{WIRE[p].limit}</Code>
                </td>
              ))}
            </tr>
            <tr className="pg-advanced">
              <th scope="row">Reasoning control</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>
                  <Code>{WIRE[p].reasoning}</Code>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Next turn sends</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>{nextTurnNote(p, history)}</td>
              ))}
            </tr>
            <tr className="pg-advanced">
              <th scope="row">Reasoning across turns</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>{WIRE[p].carriesReasoning}</td>
              ))}
            </tr>
            <tr className="pg-advanced">
              <th scope="row">{ran ? "This request" : "Next request"}</th>
              {COMPARE_PROTOCOLS.map((p) => {
                const body = lanes[p]?.body ?? nextBodies[p];
                const n = Array.isArray(body.messages) ? body.messages.length : Array.isArray(body.input) ? body.input.length : 1;
                return (
                  <td key={p}>
                    {bytesLabel(bodyBytes(body))}
                    {p === "responses" ? (body.previous_response_id ? ", with previous_response_id" : "") : `, ${n} ${n === 1 ? "message" : "messages"}`}
                  </td>
                );
              })}
            </tr>
            {stream && ran ? (
              <tr className="pg-advanced">
                <th scope="row">Stream events</th>
                {COMPARE_PROTOCOLS.map((p) => (
                  <td key={p}>{lanes[p]?.types.length ? <Code>{eventSummary(lanes[p]!.types)}</Code> : <span className={styles.dim}>None yet</span>}</td>
                ))}
              </tr>
            ) : null}
            <tr className="pg-advanced">
              <th scope="row">Client</th>
              {COMPARE_PROTOCOLS.map((p) => (
                <td key={p}>{WIRE[p].sdk}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      </div>

      {COMPARE_PROTOCOLS.map((p) => (lanes[p]?.result && !lanes[p]!.result!.ok ? <ErrorBox key={p} error={runners[p].error} /> : null))}

      <div className="pg-col pg-advanced">
      <Tabs<Protocol>
        label="Format"
        idBase={tabsId}
        tabs={COMPARE_PROTOCOLS.map((p) => ({ id: p, label: PROTOCOL_LABEL[p] }))}
        value={tab}
        onChange={setTab}
      />
      {COMPARE_PROTOCOLS.map((p) => {
        const lane = lanes[p];
        const body = lane?.body ?? nextBodies[p];
        return (
          <TabPanel key={p} idBase={tabsId} id={p} active={tab === p}>
            <div className="pg-col">
              <p className="pg-section-label">{lane ? "Request body sent" : "Request body Send will use"}</p>
              <JsonTree value={body} openDepth={3} label={`${PROTOCOL_LABEL[p]} request`} />
              {lane?.result || runners[p].state === "running" ? (
                <ResponseView
                  result={lane?.result ?? null}
                  running={runners[p].state === "running"}
                  elapsedMs={runners[p].elapsedMs}
                  json={lane?.reply?.final ?? lane?.result?.json ?? undefined}
                  usage={lane?.reply?.usage ?? undefined}
                  events={lane?.events.length ? lane.events : undefined}
                >
                  <ReplyView reply={lane?.reply ?? null} running={runners[p].state === "running"} />
                </ResponseView>
              ) : null}
              <div className="pg-actions">
                <Toggle id={`${id}-code-${p}`} label="Show code" checked={showCode} onChange={setShowCode} />
              </div>
              {showCode ? <CodeView method="POST" path={PROTOCOL_PATH[p]} body={body} stream={stream} /> : null}
            </div>
          </TabPanel>
        );
      })}
      </div>
    </div>
  );
}
