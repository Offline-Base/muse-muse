"use client";

import { useId, useState, type ReactNode } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { PresetPills, runOnModEnter, TextArea, useModEnterHint } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { useAgentLoop, type AskRequest, type Harness } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { oneLine, toolLoopFirstBody, type ToolLoopRequest } from "@/components/docs/playgrounds/muse-code-cookbook/logic/live";
import { ShowCode, Terminal } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The live half of the harness recipes: the reader's prompt goes to the model with Muse Code's tools (bash,
 * edit_file), each tool call goes through the page's simulated harness (the sandbox, the stage checks, the guardrail
 * review), which can stop and ask the reader, and the result goes back to the model, until it reports. The model is
 * real; the harness around it is this page's simulator, so nothing runs on a machine.
 */

export interface AgentPreset {
  label: string;
  prompt: string;
}

export function AgentLoopPanel({
  presets,
  defaultPrompt,
  request,
  harness,
  maxCalls = 3,
  intro,
  runLabel = "Ask the agent",
  onStart,
}: {
  presets: readonly AgentPreset[];
  defaultPrompt: string;
  /** The tool loop request for a prompt and model (instructions, tools). */
  request: (prompt: string, model: string) => ToolLoopRequest;
  harness: Harness;
  maxCalls?: number;
  intro?: ReactNode;
  runLabel?: string;
  /** Called as a run starts, so the page can reset what its harness keeps between calls (the working tree). */
  onStart?: () => void;
}) {
  const id = useId();
  const loop = useAgentLoop(maxCalls);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [preset, setPreset] = useState<number | null>(presets.findIndex((p) => p.prompt === defaultPrompt));
  const hint = useModEnterHint("to run");

  const go = () => {
    if (!prompt.trim() || loop.running) return;
    onStart?.();
    void loop.start(request(prompt.trim(), model), harness);
  };

  return (
    <div className={styles.stack}>
      {intro ? <p className={`${styles.note} pg-advanced`}>{intro}</p> : null}
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={loop.running} />
      </div>
      {/* The simulator above holds the page's one input in the simple view; this prompt's default still runs. */}
      <div className="pg-advanced">
        <PresetPills
          presets={presets}
          active={preset}
          disabled={loop.running}
          onPick={(i) => {
            setPreset(i);
            setPrompt(presets[i].prompt);
          }}
        />
      </div>
      <div className={`pg-composer ${styles.agentComposer}`}>
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Prompt for the agent
        </label>
        <TextArea
          id={`${id}-prompt`}
          className="pg-advanced"
          rows={3}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPreset(null);
          }}
          onKeyDown={runOnModEnter(go)}
          disabled={loop.running}
        />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">{hint ?? ""}</span>
          <RunButton running={loop.running} onRun={go} onStop={loop.stop} label={runLabel} disabled={!prompt.trim()} />
        </div>
      </div>

      {loop.steps.length ? (
        <ol className={styles.loop} aria-label="What happened, step by step" aria-live="polite">
          {loop.steps.map((s, i) =>
            s.kind === "model" ? (
              <li key={i} className={styles.loopStep}>
                <span className={styles.loopStepHead}>
                  Model call {s.n}
                  {s.result ? (
                    <span className="pg-meta">
                      {latencyLabel(s.result.elapsedMs)} <UsageLine model={s.result.model} usage={s.reply?.usage ?? null} />
                    </span>
                  ) : (
                    <span className="pg-meta">running {latencyLabel(loop.elapsedMs)}</span>
                  )}
                </span>
                {s.reply?.text ? <MarkdownText className="pg-stream-text" text={s.reply.text} /> : null}
                {s.reply?.toolCalls.map((t) => (
                  <p key={t.callId} className={styles.note}>
                    Calls <code>{t.name}</code> <code>{oneLine(t.arguments, 240)}</code>
                  </p>
                ))}
                {s.notice ? (
                  <p className="pg-bad" role="status">
                    {s.notice}
                  </p>
                ) : null}
                {s.result && !s.result.ok ? <p className="pg-bad">The call failed; see below.</p> : null}
              </li>
            ) : (
              <li key={i} className={`${styles.loopStep} ${styles.loopStepTool}`}>
                <span className={styles.loopStepHead}>
                  Harness runs <code>{s.name}</code>
                  <span className="pg-meta">{s.status === "waiting" ? "waiting for your answer" : s.status === "running" ? "running" : "result sent back as function_call_output"}</span>
                </span>
                {s.result ? <Terminal title={s.result.title ?? s.name} lines={s.result.lines} /> : null}
              </li>
            ),
          )}
        </ol>
      ) : null}

      {loop.asking ? <AskPrompt request={loop.asking} onAnswer={loop.answer} /> : null}

      {loop.final !== null ? (
        <div className={styles.tight}>
          <p className="pg-section-label">The agent reports</p>
          <div aria-live="polite">
            <MarkdownText className={styles.answer} text={loop.final || "(no text)"} />
          </div>
        </div>
      ) : null}

      {loop.retrying ? (
        <p className={styles.note} role="status">
          Meta is still storing the last reply; sending the tool result again in a moment.
        </p>
      ) : null}
      <ErrorBox error={loop.error} />
      {loop.lastBody ? <ShowCode body={loop.lastBody} caption="The last request the loop sent" /> : <ShowCode body={toolLoopFirstBody(request(prompt.trim() || defaultPrompt, model))} caption="The first request Run sends" />}
    </div>
  );
}

/** The harness's approval prompt, as Muse Code shows it: what's under review and the choices it offers. */
export function AskPrompt({ request, onAnswer }: { request: AskRequest; onAnswer(value: string): void }) {
  const id = useId();
  return (
    // Focus moves to the prompt when it appears (not to a choice, so Enter can't approve by accident).
    <div className={styles.prompt} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} autoFocus>
      <p className={styles.promptHead} id={`${id}-title`}>
        {request.title}
      </p>
      {request.subject ? <pre className={styles.tree}>{request.subject}</pre> : null}
      {request.detail ? <p className={styles.note}>{request.detail}</p> : null}
      <div className={styles.choices}>
        {request.choices.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`btn btn-sm ${c.primary ? "btn-primary" : "btn-outline"} ${styles.choice}`}
            onClick={() => onAnswer(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {request.note ? <p className={`${styles.note} pg-advanced`}>{request.note}</p> : null}
    </div>
  );
}
