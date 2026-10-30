"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, runOnModEnter, Segmented, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { PresetRow } from "@/components/docs/playgrounds/common/PresetRow";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { ReplyView } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { DocsResult, SseEvent } from "@/lib/docs/client/api";
import { buildBody, mergeBody, PROTOCOL_LABEL, PROTOCOL_PATH, type ChatTurn, type Protocol } from "@/lib/docs/client/body";
import { costExtrasOf } from "@/lib/docs/client/cost";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectorFor, collectReply, type Collected } from "@/lib/docs/client/stream";

/**
 * A chat playground for the text protocols, configured by plain JSON props so a page group can drop it in:
 * Responses, Chat Completions or Messages (with a switcher when a page offers more than one), the model, the
 * instructions, reasoning effort and summary, streaming, and multi-turn. Responses turns continue with
 * previous_response_id; the other two resend the history, as their pages describe. `extraBody` is merged into every
 * request, so a page can add web_search, a text.format schema or anything else it teaches. Each turn shows its text,
 * reasoning summary, sources and usage, and "Show code" gives the exact request.
 */

export interface ChatPreset {
  label: string;
  prompt: string;
  system?: string;
  /** Merged over the page's extraBody for this preset only. */
  extraBody?: Record<string, unknown>;
}

export interface ChatPlaygroundProps {
  slug: string;
  /** Default "responses". */
  protocol?: Protocol;
  /** Offer a switcher between these protocols. */
  protocols?: Protocol[];
  /** Default muse-spark-1.3-contributor. */
  model?: string;
  /** Limit the model menu to these ids. */
  models?: string[];
  system?: string;
  prompt?: string;
  placeholder?: string;
  /** Default "low": quick and cheap. null leaves reasoning to the model. */
  effort?: Effort | null;
  /** Ask for a reasoning summary (Responses only). Default false. */
  summary?: boolean;
  /** Default true. */
  stream?: boolean;
  /** Keep the conversation going across runs. Default true. */
  multiTurn?: boolean;
  maxOutputTokens?: number;
  presets?: ChatPreset[];
  /** Merged into every request (lib/docs/client/body mergeBody: tools and include add up). */
  extraBody?: Record<string, unknown>;
  /** Merged after extraBody for one protocol, for pages that compare protocols. */
  extraBodyFor?: Partial<Record<Protocol, Record<string, unknown>>>;
  /** Show the instructions field. Default true. */
  showSystem?: boolean;
  /** Show the effort, summary and stream controls. Default true. */
  showOptions?: boolean;
}

interface Turn {
  user: string;
  reply: Collected | null;
  result: DocsResult | null;
  body: Record<string, unknown>;
  protocol: Protocol;
  events: EventLogEntry[];
}

export function ChatPlayground(props: ChatPlaygroundProps) {
  const id = useId();
  const protocols = props.protocols?.length ? props.protocols : [props.protocol ?? "responses"];
  const runner = useDocsRun();
  const [protocol, setProtocol] = useState<Protocol>(props.protocol && protocols.includes(props.protocol) ? props.protocol : protocols[0]);
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [system, setSystem] = useState(props.system ?? "");
  const [prompt, setPrompt] = useState(props.prompt ?? "");
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [summary, setSummary] = useState(props.summary ?? false);
  const [stream, setStream] = useState(props.stream ?? true);
  const [preset, setPreset] = useState<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<{ user: string; body: Record<string, unknown> } | null>(null);
  const [live, setLive] = useState<Collected | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [showCode, setShowCode] = useState(false);
  const [systemOpen, setSystemOpen] = useState(!!props.system);
  const eventsRef = useRef<EventLogEntry[]>([]);
  const running = runner.state === "running";
  const runHint = useModEnterHint("to run");
  const multiTurn = props.multiTurn ?? true;
  const showOptions = props.showOptions ?? true;

  const extra = useMemo(() => {
    const p = preset !== null ? props.presets?.[preset]?.extraBody : undefined;
    return mergeBody(mergeBody(props.extraBody ?? {}, props.extraBodyFor?.[protocol]), p);
  }, [preset, props.presets, props.extraBody, props.extraBodyFor, protocol]);

  /** The request the next run sends: history or previous_response_id, then the page's extras on top. */
  const bodyFor = (question: string): Record<string, unknown> => {
    const done = multiTurn ? turns.filter((t) => t.protocol === protocol && t.reply && !t.result?.error && t.reply.text) : [];
    const last = done[done.length - 1];
    // Chaining needs a stored response with no tool calls left unanswered; otherwise the history is resent.
    const chain = protocol === "responses" && extra.store !== false && last?.reply?.id && !last.reply.toolCalls.length ? last.reply.id : null;
    const history: ChatTurn[] = chain
      ? []
      : done.flatMap((t) => [
          { role: "user" as const, content: t.user },
          { role: "assistant" as const, content: t.reply!.text },
        ]);
    const body = buildBody(protocol, {
      model,
      system,
      messages: [...history, { role: "user", content: question }],
      effort: fitEffort(model, effort),
      summary: protocol === "responses" && summary ? "auto" : null,
      maxOutputTokens: props.maxOutputTokens,
      stream,
      previousResponseId: chain,
    });
    return mergeBody(body, extra);
  };

  const send = async () => {
    const question = prompt.trim();
    if (!question || running) return;
    const body = bodyFor(question);
    const collector = collectorFor(protocol);
    eventsRef.current = [];
    setEvents([]);
    setLive(null);
    setPending({ user: question, body });
    setPrompt("");
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      eventsRef.current = logEvent(eventsRef.current, e);
      setLive(collector.snapshot());
      setEvents(eventsRef.current);
    };
    const res = await runner.run(PROTOCOL_PATH[protocol], { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
    const reply = stream ? collector.snapshot() : res.ok ? collectReply(protocol, res.json) : null;
    const keep = reply && (reply.text || reply.toolCalls.length || reply.images.length || reply.reasoning);
    setTurns((t) => [...(multiTurn ? t : []), { user: question, reply: keep ? reply : null, result: res, body, protocol, events: eventsRef.current }]);
    setPending(null);
    setLive(null);
    // A failed question goes back in the box, ready to run again.
    if (!res.ok && !isAborted(res)) setPrompt(question);
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

  const switchProtocol = (p: Protocol) => {
    setProtocol(p);
    setTurns([]);
    runner.reset();
  };

  const latest = pending ? null : turns[turns.length - 1];
  const earlier = pending ? turns : turns.slice(0, -1);
  const lastBody = pending?.body ?? latest?.body;
  const codeBody = prompt.trim() || !lastBody ? bodyFor(prompt.trim() || props.prompt || "Hello") : lastBody;
  const codeCaption = prompt.trim() || !lastBody ? "The request Run sends next" : "The request that just ran";

  return (
    <div className="pg pg-chat">
      <div className="pg-bar">
        {protocols.length > 1 ? (
          <Segmented<Protocol>
            label="Protocol"
            options={protocols.map((p) => ({ value: p, label: PROTOCOL_LABEL[p] }))}
            value={protocol}
            onChange={switchProtocol}
            disabled={running}
          />
        ) : null}
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={running} />
        {showOptions ? <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} /> : null}
        {showOptions && protocol === "responses" ? <Toggle id={`${id}-summary`} label="Reasoning summary" checked={summary} onChange={setSummary} disabled={running} /> : null}
        {showOptions ? <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} /> : null}
      </div>

      {props.presets?.length ? <PresetRow presets={props.presets} active={preset} onPick={pick} disabled={running} /> : null}

      {props.showSystem ?? true ? (
        <details className="pg-system" open={systemOpen} onToggle={(e) => setSystemOpen(e.currentTarget.open)}>
          <summary>Instructions{system ? "" : " (optional)"}</summary>
          <label className="sr-only" htmlFor={`${id}-system`}>
            Instructions
          </label>
          <TextArea
            id={`${id}-system`}
            rows={2}
            value={system}
            placeholder="Tone, persona, output rules. Sent as instructions on Responses, a developer message on Chat Completions, and system on Messages."
            onChange={(e) => setSystem(e.target.value)}
            disabled={running}
          />
        </details>
      ) : null}

      {earlier.length ? (
        <ol className="pg-transcript" aria-label="Earlier turns">
          {earlier.map((t, i) => (
            <li key={i} className="pg-turn">
              <p className="pg-bubble-user">{t.user}</p>
              <div className="pg-bubble-assistant">
                <ReplyView reply={t.reply} placeholder={t.result?.error ? "No reply: the request failed." : "No text in this reply."} />
                <p className="pg-turn-meta">
                  <UsageLine model={t.result?.model ?? t.reply?.model ?? null} usage={t.reply?.usage ?? null} {...costExtrasOf(t.reply?.final)} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {pending || latest ? (
        <div className="pg-turn pg-turn-current">
          <p className="pg-bubble-user">{pending?.user ?? latest?.user}</p>
          <ResponseView
            result={pending ? null : (latest?.result ?? null)}
            running={!!pending && running}
            elapsedMs={runner.elapsedMs}
            json={(pending ? live?.final : (latest?.reply?.final ?? latest?.result?.json)) ?? undefined}
            usage={(pending ? live?.usage : latest?.reply?.usage) ?? undefined}
            model={(pending ? null : latest?.result?.model) ?? (pending ? live?.model : latest?.reply?.model) ?? null}
            events={(pending ? events : latest?.events)?.length ? (pending ? events : latest?.events) : undefined}
          >
            <ReplyView
              reply={pending ? live : (latest?.reply ?? null)}
              running={!!pending && running}
              placeholder={latest?.result?.error ? "No reply: the request failed." : undefined}
            />
            {!pending && latest && isAborted(latest.result) ? <p className="pg-muted">Stopped before the reply finished.</p> : null}
            {!pending && latest?.reply?.toolCalls.length ? (
              <p className="pg-hint">The model asked for a tool. This demo doesn&apos;t run tools; the tool calling page&apos;s demo runs the whole loop.</p>
            ) : null}
          </ResponseView>
        </div>
      ) : null}

      <ErrorBox error={runner.error} />

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Message
        </label>
        <TextArea
          id={`${id}-prompt`}
          rows={3}
          value={prompt}
          placeholder={props.placeholder ?? (turns.length && multiTurn ? "Ask a follow-up" : "Ask something")}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (preset !== null && e.target.value !== props.presets?.[preset]?.prompt) setPreset(null);
          }}
          onKeyDown={runOnModEnter(() => void send())}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">
            {protocol === "responses" && turns.length && multiTurn ? "Follow-ups continue with previous_response_id. " : ""}
            {runHint ?? ""}
          </span>
          {turns.length && multiTurn ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={running}
              onClick={() => {
                setTurns([]);
                runner.reset();
              }}
            >
              New conversation
            </button>
          ) : null}
          <RunButton running={running} onRun={() => void send()} onStop={runner.abort} disabled={!prompt.trim()} />
        </div>
      </div>

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={PROTOCOL_PATH[protocol]} body={codeBody} caption={codeCaption} /> : null}
    </div>
  );
}
