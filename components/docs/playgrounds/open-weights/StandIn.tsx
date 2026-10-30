"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, TextArea, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { ReplyView } from "@/components/docs/kit/StreamView";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { DEFAULT_TEXT_MODEL, type Effort } from "@/lib/docs/client/models";
import { chatCollector, collectReply, type Collected } from "@/lib/docs/client/stream";
import { tokenUsage } from "@/lib/docs/client/cost";
import { budgetFor, standInBody, type ChatMessageJson } from "@/components/docs/playgrounds/open-weights/standin-body";
import { NumberField, StandInBanner } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The live part of an open-weight page: the same Chat Completions request a self-hosted server takes, sent to hosted
 * Muse Spark through Model API (the docs proxy), and labeled plainly as a stand-in, not the open-weight model. It shows
 * what the reader's own code reads back (content, tool_calls, finish_reason, usage), and where it differs from a
 * self-hosted server: hosted Chat Completions keeps the reasoning text and reports only its token count, where an
 * SGLang, vLLM or llama.cpp server returns it in reasoning_content or reasoning.
 */

export type { ChatMessageJson };

export interface StandInProps {
  /** The open-weight model this stands in for, for the banner. */
  standsFor: string;
  /** The conversation to send. When `prompt` is set, the last user message is replaced by the box's text. */
  messages: ChatMessageJson[];
  prompt?: string;
  /** Show an editable prompt box. Default true when `prompt` is set. */
  editPrompt?: boolean;
  effort?: Effort | null;
  maxTokens?: number;
  tools?: unknown[];
  parallelToolCalls?: boolean;
  /** Extra body fields the stand-in sends (temperature, top_p, response_format). Hosted-incompatible ones are dropped by the caller. */
  extra?: Record<string, unknown>;
  /** What the open-weight request carries that this one leaves out, and why. */
  dropped?: string[];
  /** A line under the run controls, such as which docs samples stand in for the page's example files. */
  note?: ReactNode;
  /** Hold Run, such as while those samples load. */
  disabled?: boolean;
  /** Where the open-weight server would put the reasoning text, for the note under the reply; null when the page doesn't say. */
  reasoningField?: string | null;
  runLabel?: string;
  /** Called with each finished reply. */
  onReply?(reply: Collected): void;
  /** Extra controls under the reply, such as "Add to the conversation". */
  children?: (reply: Collected | null) => ReactNode;
}

export function StandIn(props: StandInProps) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [maxTokens, setMaxTokens] = useState(String(props.maxTokens ?? budgetFor(props.effort === undefined ? "low" : props.effort)));
  const [prompt, setPrompt] = useState(props.prompt ?? "");
  const [stream, setStream] = useState(true);
  const [live, setLive] = useState<Collected | null>(null);
  const [reply, setReply] = useState<Collected | null>(null);
  const [showCode, setShowCode] = useState(false);
  const promptRef = useRef(props.prompt);
  const running = runner.state === "running";

  // A new prompt from the page (a preset) replaces the box's text.
  useEffect(() => {
    if (props.prompt !== promptRef.current) {
      promptRef.current = props.prompt;
      setPrompt(props.prompt ?? "");
    }
  }, [props.prompt]);
  useEffect(() => {
    if (props.effort === undefined) return;
    setEffort(props.effort);
    // Reasoning shares max_tokens with the answer, so a higher level gets a bigger budget unless the page fixed one.
    setMaxTokens(String(props.maxTokens ?? budgetFor(props.effort)));
  }, [props.effort, props.maxTokens]);

  const tokens = Math.max(16, Math.min(16384, Math.round(Number(maxTokens) || budgetFor(effort))));
  const editable = props.editPrompt ?? props.prompt !== undefined;
  const body = useMemo(
    () => standInBody({ ...props, prompt: props.prompt === undefined ? undefined : prompt }, model, effort, tokens, stream),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.messages, props.tools, props.parallelToolCalls, props.extra, props.prompt, prompt, model, effort, tokens, stream],
  );

  const run = async () => {
    if (running || props.disabled) return;
    if (editable && !prompt.trim()) return;
    const collector = chatCollector();
    setLive(null);
    setReply(null);
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      setLive(collector.snapshot());
    };
    const res = await runner.run("chat/completions", { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
    const done = stream ? collector.snapshot() : res.ok ? collectReply("chat", res.json) : null;
    setLive(null);
    if (res.ok && done && !isAborted(res)) {
      setReply(done);
      props.onReply?.(done);
    } else setReply(done);
  };

  const shown = running ? live : reply;
  const usage = tokenUsage(shown?.usage ?? null);
  const reasoningTokens = usage?.reasoning ?? 0;

  return (
    <div className={styles.stack}>
      <StandInBanner>
        Stand-in: this sends the same Chat Completions request to hosted Muse Spark through Model API, not to {props.standsFor}. Use it to see the request and reply shapes your
        code will handle; a self-hosted server answers in the same format.
      </StandInBanner>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} label="reasoning_effort" />
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
      </div>
      {editable ? (
        <div className="pg-composer">
          <label className="sr-only" htmlFor={`${id}-prompt`}>
            Message
          </label>
          <TextArea id={`${id}-prompt`} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={runOnModEnter(() => void run())} />
          <div className="pg-composer-bar">
            <div className="pg-advanced" style={{ maxWidth: 200, marginRight: "auto" }}>
              <NumberField id={`${id}-max`} label="max_tokens" value={maxTokens} min={16} max={16384} step={100} onChange={setMaxTokens} />
            </div>
            <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!prompt.trim() || props.disabled} label={props.runLabel ?? "Run on hosted Muse Spark"} />
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          <div className="pg-advanced" style={{ maxWidth: 200 }}>
            <NumberField id={`${id}-max`} label="max_tokens" value={maxTokens} min={16} max={16384} step={100} onChange={setMaxTokens} />
          </div>
          <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={props.disabled} label={props.runLabel ?? "Run on hosted Muse Spark"} />
        </div>
      )}
      {props.note ? <p className="pg-hint">{props.note}</p> : null}
      {props.dropped?.length ? <p className="pg-hint">Left out of the hosted request: {props.dropped.join("; ")}.</p> : null}

      {running || runner.result ? (
        <ResponseView result={running ? null : runner.result} running={running} elapsedMs={runner.elapsedMs} json={shown?.final ?? undefined} usage={shown?.usage ?? undefined} model={runner.result?.model ?? shown?.model ?? null}>
          <ReplyView reply={shown} running={running} placeholder={runner.error ? "No reply: the request failed." : undefined} />
          {!running && shown?.finishReason ? (
            <p className="pg-hint">
              finish_reason: <code>{shown.finishReason}</code>
              {shown.finishReason === "length" ? ". The budget ran out, often during reasoning: raise max_tokens." : ""}
            </p>
          ) : null}
          {!running && reasoningTokens > 0 ? (
            <p className="pg-hint">
              {reasoningTokens.toLocaleString("en-US")} reasoning tokens. Hosted Chat Completions keeps the reasoning text
              {props.reasoningField === null ? "." : (
                <>
                  ; your own server returns it in <code>{props.reasoningField ?? "reasoning_content"}</code>.
                </>
              )}
            </p>
          ) : null}
        </ResponseView>
      ) : null}
      {props.children ? props.children(running ? null : reply) : null}
      <ErrorBox error={runner.error} />
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body} caption="The hosted request this stand-in sends" /> : null}
    </div>
  );
}
