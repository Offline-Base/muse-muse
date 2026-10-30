"use client";

import { Fragment, useId, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { DEFAULT_TEXT_MODEL, EFFORT_LABELS, effortsFor, fitEffort, type Effort } from "@/lib/docs/client/models";
import { CodeBlock } from "@/components/docs/playgrounds/start/CodeBlock";
import { API_BASE_URL } from "@/components/docs/playgrounds/start/facts";
import {
  configCheckRequest,
  OPENCODE_DEFAULTS,
  openCodeConfig,
  providerPrompt,
  readResponse,
  type OpenCodeAdapter,
} from "@/components/docs/playgrounds/start/quickstart";
import { WONDER_MODEL, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

/**
 * The quickstart's "Use with your coding agent", as a builder: pick the model, the adapter and the reasoning
 * options, and get the provider prompt for a self-configuring agent, the opencode.json block for a manual setup, and
 * the three values any OpenAI-compatible tool asks for. "Check these settings" sends one request with exactly those
 * settings, so a rejected option shows up here rather than in the middle of an agent session.
 */
export function AgentSetup({ model: initialModel }: { slug: string; model?: string }) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(initialModel ?? DEFAULT_TEXT_MODEL);
  const [adapter, setAdapter] = useState<OpenCodeAdapter>(OPENCODE_DEFAULTS.adapter);
  const [effort, setEffort] = useState<Effort>(OPENCODE_DEFAULTS.effort);
  const [summary, setSummary] = useState(OPENCODE_DEFAULTS.summary);
  const [encrypted, setEncrypted] = useState(OPENCODE_DEFAULTS.encryptedReasoning);
  const [showCode, setShowCode] = useState(false);
  const responses = adapter === "@ai-sdk/openai";
  const options = { model, adapter, effort: fitEffort(model, effort) ?? "high", summary: responses && summary, encryptedReasoning: responses && encrypted };
  const config = JSON.stringify(openCodeConfig(options), null, 2);
  const prompt = providerPrompt(options);
  const check = configCheckRequest(options);
  const running = runner.state === "running";
  const reading = readResponse(runner.result?.json);
  const reasoning = reading?.items.find((i) => i.kind === "reasoning");

  const values: Array<{ name: string; value: string }> = [
    { name: "Base URL", value: API_BASE_URL },
    { name: "API key variable", value: "MODEL_API_KEY" },
    { name: "Model ID", value: model },
  ];

  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        Any harness with an OpenAI-compatible or custom provider plugs in through the Responses API or Chat Completions. Pick the
        settings, then paste the prompt into a self-configuring agent (OpenCode, Goose, Roo) or put the block in{" "}
        <code>opencode.json</code> (global at <code>~/.config/opencode/opencode.json</code>, or per project).
      </p>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} />
        <span className="pg-inline-field pg-advanced">
          <label className="pg-label" htmlFor={`${id}-effort`}>
            reasoningEffort
          </label>
          <span className="select-wrap">
            <select id={`${id}-effort`} className="select pg-select" value={options.effort} onChange={(e) => setEffort(e.target.value as Effort)} disabled={!responses}>
              {effortsFor(model).map((e) => (
                <option key={e} value={e}>
                  {EFFORT_LABELS[e]}
                </option>
              ))}
            </select>
          </span>
        </span>
      </div>
      <div className="pg-bar pg-advanced">
        <Segmented<OpenCodeAdapter>
          label="Adapter"
          options={[
            { value: "@ai-sdk/openai", label: "@ai-sdk/openai (Responses, recommended)" },
            { value: "@ai-sdk/openai-compatible", label: "@ai-sdk/openai-compatible (Chat Completions)" },
          ]}
          value={adapter}
          onChange={setAdapter}
          size="sm"
        />
        <Toggle id={`${id}-summary`} label='reasoningSummary "auto"' checked={summary && responses} onChange={setSummary} disabled={!responses} />
        <Toggle id={`${id}-enc`} label="Encrypted reasoning" checked={encrypted && responses} onChange={setEncrypted} disabled={!responses} />
      </div>
      <p className="pg-hint">
        {responses
          ? encrypted
            ? 'include: ["reasoning.encrypted_content"] carries the model\'s reasoning across turns, so it keeps the thread in multi-step tool loops.'
            : "Without encrypted reasoning, the model reasons from scratch each turn and can lose the thread in multi-step loops."
          : "The fallback adapter is simpler, but it doesn't replay reasoning across turns or attach PDFs. Images still work, forwarded as image_url parts."}
      </p>

      <CodeBlock label="text" code={prompt} syntax="text" caption="Option A: paste this into your coding agent" copyLabel="Copy the provider prompt" />
      <div className="pg-advanced">
        <CodeBlock label="opencode.json" code={config} syntax="json" caption="Option B: add this block to opencode.json" copyLabel="Copy the opencode.json block" />
      </div>
      <p className="pg-hint">
        Then run <code>/connect</code>, select the <code>meta</code> provider and enter your API key when asked (keep it out of the
        config file), restart OpenCode and select the model.
        {model.endsWith("-contributor")
          ? " This config uses Contributor mode: Meta may use what you send to train future models. Drop -contributor for Standard mode."
          : ""}
      </p>

      <div className="pg-advanced">
        <p className="pg-section-label">Any OpenAI-compatible tool</p>
        <p className="pg-hint">
          LangChain, LlamaIndex, the Vercel AI SDK, Continue and most frameworks ask for three values. Put the key itself in the
          environment variable, never in the tool&apos;s config.
        </p>
        <dl className={styles.kv}>
          {values.map((v) => (
            <Fragment key={v.name}>
              <dt>{v.name}</dt>
              <dd>
                <code>{v.value}</code>{" "}
                <CopyButton value={v.value} label={`Copy the ${v.name.toLowerCase()}`} className="icon-btn icon-btn-plain icon-btn-sm" />
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>

      <div className="pg-actions">
        <RunButton running={running} onRun={() => void runner.run(check.path, { method: "POST", body: check.body })} onStop={runner.abort} label="Check these settings" />
        <span className="pg-hint">
          Sends one {responses ? "Responses" : "Chat Completions"} request with these settings.{" "}
          {model === WONDER_MODEL
            ? `On Muse Wonder the live docs cap the output at ${WONDER_OUTPUT_CAP} tokens, so it costs about a cent.`
            : "Fractions of a cent on Contributor."}
        </span>
      </div>
      <ErrorBox error={runner.error} />
      <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs}>
        {reading ? (
          <div className={styles.stack}>
            {reading.status === "incomplete" ? (
              <p>
                The API accepted these settings, but the response stopped early (<code>incomplete_details.reason</code>:{" "}
                <code>{reading.incompleteReason ?? "not given"}</code>) before it answered: reasoning used the output limit. Lower the
                effort and check again.
              </p>
            ) : (
              <p>
                The model answered <strong>{reading.outputText || "(no text)"}</strong>: these settings work.
              </p>
            )}
            {reasoning ? <p className="pg-hint">Reasoning item: {reasoning.detail}</p> : null}
          </div>
        ) : undefined}
      </ResponseView>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={check.path} body={check.body} caption="The check request" /> : null}
    </div>
  );
}
