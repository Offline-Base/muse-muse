"use client";

import { useId, useState } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, EffortSelect, ErrorBox, ModelSelect, PresetPills, RunButton, TextArea, Toggle, latencyLabel, useDocsRun } from "@/components/docs/kit";
import { estimateCost, formatUsd, tokenUsage } from "@/lib/docs/client/cost";
import { fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { Chip } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * `--reasoning-effort` trades latency for depth (configuration page). This runs one prompt at two effort levels side
 * by side on the Responses API, through the docs proxy, and shows each one's time, reasoning tokens and cost. Muse
 * Code's own levels add none (which the Meta provider rejects) and ultra (a client-side setting); the API takes
 * minimal through max, and max only on the models that offer it.
 */

const PRESETS = [
  { label: "Slow recursion", prompt: "A recursive fib(n) is called with n up to 40 and it's slow. Name the fix and its time complexity in two sentences." },
  { label: "Off-by-one", prompt: "for (let i = 0; i <= items.length; i++) total += items[i].price; throws sometimes. Why, and what's the one-character fix?" },
  { label: "Race", prompt: "Two requests read a counter, add one, and write it back. Explain the bug in two sentences and give a fix." },
];

export function EffortCompare({ prompt: startPrompt }: { prompt?: string }) {
  const id = useId();
  const a = useDocsRun();
  const b = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [prompt, setPrompt] = useState(startPrompt ?? PRESETS[0].prompt);
  const [preset, setPreset] = useState<number | null>(startPrompt ? null : 0);
  const [effortA, setEffortA] = useState<Effort | null>("minimal");
  const [effortB, setEffortB] = useState<Effort | null>("high");
  const [showCode, setShowCode] = useState(false);
  const running = a.state === "running" || b.state === "running";
  // Muse Wonder costs about 50x more per output token: its cap stays low, which can cut a high-effort answer short.
  const cap = model === "muse-wonder-1.0" ? 800 : 2500;
  const bodyFor = (effort: Effort | null) => {
    const e = fitEffort(model, effort);
    return { model, input: prompt.trim() || PRESETS[0].prompt, ...(e ? { reasoning: { effort: e } } : {}), max_output_tokens: cap };
  };

  const runBoth = () => {
    void a.run("responses", { body: bodyFor(effortA) });
    void b.run("responses", { body: bodyFor(effortB) });
  };

  const side = (label: string, runner: typeof a, effort: Effort | null) => {
    const json = runner.result?.json as { usage?: unknown; status?: string } | null;
    const usage = tokenUsage(json?.usage);
    const cost = estimateCost(runner.result?.model ?? model, json?.usage);
    const text = runner.result?.ok ? collectReply("responses", json).text : "";
    return (
      <section className={styles.card} aria-label={label} aria-live="polite">
        <div className={styles.cardHead}>
          <p className={styles.cardTitle}>
            <code className={styles.code}>--reasoning-effort {fitEffort(model, effort) ?? "(model default)"}</code>
          </p>
          {runner.state === "running" ? <Chip tone="accent">Running {latencyLabel(runner.elapsedMs)}</Chip> : null}
          {json?.status === "incomplete" ? <Chip tone="warn">Cut off at the token cap</Chip> : null}
        </div>
        {usage ? (
          <p className="pg-small">
            <strong>{latencyLabel(runner.result?.elapsedMs ?? 0)}</strong> · {usage.reasoning.toLocaleString("en-US")} reasoning tokens · {usage.output.toLocaleString("en-US")} output in all
            {cost ? ` · ${formatUsd(cost.usd)}` : ""}
          </p>
        ) : null}
        <div className={styles.msgAssistant}>{text || (runner.state === "running" ? "Thinking..." : runner.state === "idle" ? "Press Run to compare." : "")}</div>
        <ErrorBox error={runner.error} />
      </section>
    );
  };

  return (
    <div className="pg-col">
      <p className="pg-hint">
        <code className={styles.code}>--reasoning-effort</code> (or <code className={styles.code}>/effort</code>) trades latency for depth. Run one prompt at two levels on the API
        and compare the time and reasoning tokens. Muse Code&apos;s levels also include none, which the Meta provider doesn&apos;t accept, and ultra, a client-side
        setting.
      </p>
      <PresetPills
        presets={PRESETS}
        active={preset}
        onPick={(i) => {
          setPrompt(PRESETS[i].prompt);
          setPreset(i);
        }}
      />
      <label className="sr-only" htmlFor={`${id}-prompt`}>
        Prompt
      </label>
      <TextArea
        id={`${id}-prompt`}
        rows={2}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setPreset(null);
        }}
      />
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-a`} label="Left" model={model} value={effortA} onChange={setEffortA} disabled={running} />
        <EffortSelect id={`${id}-b`} label="Right" model={model} value={effortB} onChange={setEffortB} disabled={running} />
        <RunButton running={running} onRun={runBoth} onStop={() => { a.abort(); b.abort(); }} label="Run both" disabled={!prompt.trim()} />
      </div>
      <div className={styles.grid2}>
        {side("Left run", a, effortA)}
        {side("Right run", b, effortB)}
      </div>
      <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      {showCode ? <CodeView method="POST" path="responses" body={bodyFor(effortB)} caption="The right-hand request (the left differs only in reasoning.effort)" /> : null}
    </div>
  );
}
