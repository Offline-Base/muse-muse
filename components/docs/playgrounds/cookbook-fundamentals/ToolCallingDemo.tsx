"use client";

import { useId, useMemo, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, PresetPills, runOnModEnter, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { ToolCalls } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { Advanced, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { useToolLoop } from "@/components/docs/playgrounds/cookbook-fundamentals/useToolLoop";
import { chatTools, type NeutralRequest, type ToolDef } from "@/lib/docs/client/body";
import { DEFAULT_TEXT_MODEL, docsModelLabel, fitEffort, type Effort } from "@/lib/docs/client/models";
import { nextModelBody, requestedCalls, type LoopStep, type ModelStep } from "@/lib/docs/client/toolloop";
import type { ResolvedTool } from "@/lib/docs/client/tools";

/**
 * The tool-function-calling recipe, live on Chat Completions: the recipe's get_weather tool with its canned readings,
 * the loop that runs every call the model asks for and appends one tool message per tool_call_id after the assistant
 * message that holds them, until finish_reason is no longer tool_calls. Two switches send what the recipe warns
 * against, for the API's real 400s: the tool result without the assistant message, and a tool_choice other than auto.
 */

export interface ToolCallingDemoProps {
  slug: string;
  prompt: string;
  presets?: Array<{ label: string; prompt: string }>;
  /** The recipe's canned readings, city to temperature. */
  readings: Record<string, string>;
  maxCalls?: number;
}

const WEATHER: ToolDef = {
  name: "get_weather",
  description: "Get the current temperature for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name, such as Paris." } },
    required: ["city"],
  },
};

type Choice = "auto" | "required" | "none";

/** Drops every assistant message that carries tool_calls: the mistake the recipe shows, which the API rejects. */
function withoutAssistantToolCalls(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  return { ...body, messages: messages.filter((m) => !(m.role === "assistant" && Array.isArray(m.tool_calls))) };
}

function rolesOf(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; tool_calls?: unknown[] }>) : [];
  return messages.map((m) => (m.role === "assistant" && m.tool_calls ? `assistant (${m.tool_calls.length} tool_calls)` : (m.role ?? "?"))).join(" → ");
}

export function ToolCallingDemo({ prompt: initialPrompt, presets = [], readings, maxCalls = 5 }: ToolCallingDemoProps) {
  const id = useId();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [preset, setPreset] = useState<number | null>(null);
  const [choice, setChoice] = useState<Choice>("auto");
  const [skipAssistant, setSkipAssistant] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const tools: ResolvedTool[] = useMemo(
    () => [
      {
        def: WEATHER,
        builtIn: false,
        source: "fixed",
        // The recipe's get_weather: a canned lookup, "unknown" for any other city.
        run: async (args) => {
          const city = typeof args.city === "string" ? args.city.trim() : "";
          const hit = Object.keys(readings).find((k) => k.toLowerCase() === city.toLowerCase());
          return hit ? readings[hit] : "unknown";
        },
      },
    ],
    [readings],
  );

  const base: NeutralRequest = useMemo(
    () => ({ model, messages: [{ role: "user", content: prompt.trim() }], tools: [WEATHER], effort: fitEffort(model, effort) }),
    [model, prompt, effort],
  );

  const loop = useToolLoop({
    protocol: "chat",
    base,
    tools,
    maxCalls,
    extraBody: choice === "auto" ? undefined : { tool_choice: choice },
    transform: skipAssistant ? (body) => withoutAssistantToolCalls(body) : undefined,
  });

  const finished = loop.next === "done" || loop.next === "limit" || loop.next === "stopped";
  const lastModel = [...loop.steps].reverse().find((s): s is ModelStep => s.kind === "model");
  const answer = loop.next === "done" && lastModel?.collected && !lastModel.collected.error ? lastModel.collected.text : "";
  const nextBody = (steps: readonly LoopStep[]) => {
    let body = nextModelBody("chat", base, steps);
    if (choice !== "auto") body = { ...body, tool_choice: choice };
    return skipAssistant ? withoutAssistantToolCalls(body) : body;
  };
  const codeBody = !finished && !loop.busy ? nextBody(loop.steps) : (lastModel?.body ?? nextBody([]));
  const nextLabel = loop.next === "tools" ? "Run the tool" : loop.next === "model" ? (loop.steps.length ? "Send the result back" : "Call the model") : "Step";
  const changeSetup = (fn: () => void) => {
    fn();
    loop.reset();
  };

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={loop.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={loop.busy} />
        <span className="pg-inline-field pg-advanced">
          <span className="pg-label">tool_choice</span>
          <Segmented<Choice>
            size="sm"
            label="tool_choice"
            value={choice}
            onChange={(c) => changeSetup(() => setChoice(c))}
            disabled={loop.busy}
            options={[
              { value: "auto", label: "auto" },
              { value: "required", label: "required" },
              { value: "none", label: "none" },
            ]}
          />
        </span>
      </div>
      <Advanced>
        <Toggle
          id={`${id}-skip`}
          label="Send the tool result without the assistant message (the recipe's 400)"
          checked={skipAssistant}
          onChange={(v) => changeSetup(() => setSkipAssistant(v))}
          disabled={loop.busy}
        />
      </Advanced>

      <details className="pg-system">
        <summary>The tool: get_weather, with the recipe&apos;s canned readings</summary>
        <div className="pg-split">
          <JsonTree value={chatTools([WEATHER])[0]} openDepth={4} label="get_weather definition" />
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">city</th>
                  <th scope="col">returns</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(readings).map(([city, t]) => (
                  <tr key={city}>
                    <td>{city}</td>
                    <td>{t}</td>
                  </tr>
                ))}
                <tr>
                  <td className="pg-muted">anything else</td>
                  <td className="pg-muted">unknown</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {presets.length ? (
        <PresetPills
          presets={presets}
          active={preset}
          disabled={loop.busy}
          onPick={(i) =>
            changeSetup(() => {
              setPreset(i);
              setPrompt(presets[i].prompt);
            })
          }
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
          onKeyDown={runOnModEnter(() => void loop.runAll())}
          disabled={loop.busy || loop.steps.length > 0}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">{loop.steps.length ? "Reset to change the question." : `Up to ${maxCalls} model calls, like the recipe's loop.`}</span>
          {loop.steps.length ? (
            <button type="button" className="btn btn-sm" onClick={loop.reset} disabled={loop.busy}>
              Reset
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => void loop.stepOnce()} disabled={loop.busy || finished || !prompt.trim()}>
            {nextLabel}
          </button>
          <RunButton running={loop.busy} onRun={() => void loop.runAll()} onStop={loop.stop} label={loop.steps.length ? "Run to the end" : "Run the loop"} disabled={finished || !prompt.trim()} />
        </div>
      </div>

      {loop.steps.length ? (
        <ol className="pg-steps" aria-label="Steps" aria-live="polite">
          {loop.steps.map((s, i) =>
            s.kind === "model" ? (
              <li key={i} className="pg-step">
                <p className="pg-step-title">
                  <span className="pg-step-num">{i + 1}</span>
                  Model call {s.call}
                  {!s.collected?.done ? <StatusPill tone="busy">Running</StatusPill> : s.collected.error ? <StatusPill tone="bad">{s.status ? `HTTP ${s.status}` : "Failed"}</StatusPill> : <StatusPill tone="ok">finish_reason: {s.collected.finishReason ?? "?"}</StatusPill>}
                </p>
                <p className="pg-step-meta pg-advanced">
                  <span className="pg-muted">messages: {rolesOf(s.body)}</span>
                  {s.model ? <span className="pg-meta">{docsModelLabel(s.model)}</span> : null}
                  {s.elapsedMs ? <span className="pg-meta">{latencyLabel(s.elapsedMs)}</span> : null}
                  {s.collected?.usage ? <UsageLine model={s.model ?? model} usage={s.collected.usage} /> : null}
                </p>
                {s.collected && requestedCalls(s).length ? (
                  <>
                    {s.collected.text ? <p className={styles.thought}>{s.collected.text}</p> : null}
                    <div className="pg-advanced">
                      <ToolCalls calls={requestedCalls(s)} title={requestedCalls(s).length > 1 ? `${requestedCalls(s).length} tool calls in one turn` : "A tool call"} />
                    </div>
                  </>
                ) : s.collected?.done && !s.collected.error ? (
                  <p className={styles.textBlock}>{s.collected.text || "(no text)"}</p>
                ) : s.collected?.error ? (
                  <p className="pg-bad">{s.collected.error.message}</p>
                ) : null}
                <details className="pg-raw pg-advanced">
                  <summary>Request{s.collected?.final ? " and reply" : ""} JSON</summary>
                  <JsonTree value={s.body} openDepth={2} />
                  {s.collected?.final ? <JsonTree value={s.collected.final} openDepth={2} /> : null}
                </details>
              </li>
            ) : (
              <li key={i} className="pg-step">
                <p className="pg-step-title">
                  <span className="pg-step-num">{i + 1}</span>
                  Your code runs {s.results.length === 1 ? "the tool" : `${s.results.length} tools`}
                </p>
                <ul className="pg-toolcall-list">
                  {s.results.map((r, j) => (
                    <li key={r.call.callId || j} className="pg-toolcall">
                      <p className={styles.act}>
                        {r.call.name}({r.call.arguments}) → {r.run ? JSON.stringify(r.run.value) : "running"}
                      </p>
                      <p className="pg-muted pg-small">
                        Appended as {"{"}&quot;role&quot;: &quot;tool&quot;, &quot;tool_call_id&quot;: &quot;{r.call.callId}&quot;{"}"}
                      </p>
                    </li>
                  ))}
                </ul>
              </li>
            ),
          )}
        </ol>
      ) : null}

      {answer ? (
        <div className="pg-final" role="status">
          <p className="pg-section-label">Answer</p>
          <div className="pg-stream-text">{answer}</div>
        </div>
      ) : null}
      {loop.next === "limit" ? <p className="pg-hint">Stopped after {maxCalls} model calls, the loop&apos;s cap. Reset to start over.</p> : null}
      <ErrorBox error={loop.error} />
      {loop.error && skipAssistant ? (
        <p className={styles.note}>
          That&apos;s the recipe&apos;s point: a tool message must follow the assistant message that holds its tool_calls. Turn the switch off and
          run again to see the loop finish.
        </p>
      ) : null}
      {loop.error && choice !== "auto" ? (
        <p className={styles.note}>tool_choice only supports &quot;auto&quot;: design for a tool call and a plain answer both.</p>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={codeBody} caption={!finished && !loop.busy ? "The request the next step sends" : "The last request"} /> : null}
    </div>
  );
}
