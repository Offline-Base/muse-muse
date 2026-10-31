"use client";

import { useId, useMemo, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { PresetPills, TextArea, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { tokenUsage } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";
import { defaultsOf } from "@/components/docs/playgrounds/open-weights/deploy";
import { sparkRuntime } from "@/components/docs/playgrounds/open-weights/deploy-spark";
import { OPEN_EFFORTS, SPARK, SPARK_CHECKPOINTS, SPARK_PARSER_FLAGS, SPARK_REASONING, STOP_TOKENS, n, sparkStrength, type OpenEffort, type SparkCheckpoint } from "@/components/docs/playgrounds/open-weights/facts";
import { STRENGTH_TASKS, checkStops, contextFlag, kvGrowth, kvShareOfDense, type SettingsRuntime } from "@/components/docs/playgrounds/open-weights/settings";
import { CodeTabs, Facts, Issues, NumberField, SegmentField, SelectField, StandInBanner, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * Recommended settings for Muse Spark Open (muse-spark-open/settings): the per-request settings (sampling, reasoning
 * strength, streaming) and the serve-time ones (parallelism and context length) as one generator, the KV-cache growth
 * that 16 full-attention layers of 62 imply, a stop-token checker, and a live side-by-side of two reasoning levels on
 * hosted Muse Spark (a stand-in, not the open-weight model) to show the latency and token trade the page describes.
 */

export interface SettingsLabProps {
  slug: string;
}

const CONTEXTS = [32768, 49152, 131072, 262144, 524288, 1048576];
const RUNTIME_LABEL: Record<SettingsRuntime, string> = { sglang: "SGLang", vllm: "vLLM", trtllm: "TensorRT-LLM" };

export function SettingsLab(_props: SettingsLabProps) {
  const id = useId();
  const [tab, setTab] = useState<"config" | "live" | "stops">("config");
  const [checkpoint, setCheckpoint] = useState<SparkCheckpoint>("nvfp4");
  const [runtime, setRuntime] = useState<SettingsRuntime>("sglang");
  const [ctx, setCtx] = useState(131072);
  const [effort, setEffort] = useState<OpenEffort>("medium");
  const [temperature, setTemperature] = useState("1.0");
  const [topP, setTopP] = useState("1.0");
  const [stream, setStream] = useState(true);
  const c = SPARK_CHECKPOINTS[checkpoint];

  const serve = useMemo(() => {
    if (runtime === "sglang") {
      const r = sparkRuntime("sglang");
      return r.build({ ...defaultsOf(r.options), checkpoint, context: String(ctx) }).steps.find((s) => s.title.startsWith("Start the server"))?.code ?? "";
    }
    if (runtime === "vllm") {
      const r = sparkRuntime("vllm");
      return r.build({ ...defaultsOf(r.options), checkpoint, maxModelLen: String(ctx) }).steps.find((s) => s.title.startsWith("Start the server"))?.code ?? "";
    }
    const r = sparkRuntime("trtllm");
    return r.build({ ...defaultsOf(r.options), maxSeqLen: ctx }).steps.find((s) => s.title === "serve_config.yaml")?.code ?? "";
  }, [runtime, checkpoint, ctx]);

  const temp = Number(temperature);
  const top = Number(topP);
  const request = {
    model: c.repo,
    messages: [{ role: "user", content: "Find the race condition in this worker-pool design." }],
    temperature: Number.isFinite(temp) ? temp : 1,
    top_p: Number.isFinite(top) ? top : 1,
    reasoning_effort: effort,
    ...(stream ? { stream: true } : {}),
  };
  const warnings: string[] = [];
  if (temp !== 1 || top !== 1) warnings.push("The model card's evaluations ran at temperature 1.0 and top_p 1.0 (do_sample true) with xhigh reasoning; other values are untested there.");
  if (!stream && (effort === "high" || effort === "xhigh")) warnings.push("High strengths produce long reasoning traces: stream (stream: true) so a client or proxy timeout doesn't cut the generation off.");
  if (runtime === "trtllm" && checkpoint === "bf16") warnings.push("The validated TensorRT-LLM deployment serves NVFP4 at TP4/EP4 on one 4-GPU Blackwell node.");
  if (runtime === "trtllm" && ctx > 49152) warnings.push("max_seq_len 49,152 is TensorRT-LLM's validated window; longer windows need proportionally more KV-cache memory.");
  const row = SPARK_REASONING.find((r) => r.effort === effort)!;
  const json = JSON.stringify(request, null, 2).replace(/"temperature": 1(?=,)/, '"temperature": 1.0').replace(/"top_p": 1(?=,)/, '"top_p": 1.0');

  return (
    <div className="pg">
      <Tabs
        label="Settings"
        idBase={id}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "config", label: "Config generator" },
          { id: "live", label: "Compare strengths live" },
          { id: "stops", label: "Stop tokens" },
        ]}
      />
      <TabPanel idBase={id} id="config" active={tab === "config"}>
        <div className={styles.stack}>
          <div className={styles.options}>
            <SegmentField<SparkCheckpoint> label="Checkpoint" value={checkpoint} options={[{ value: "nvfp4", label: "NVFP4" }, { value: "bf16", label: "BF16" }]} onChange={setCheckpoint} />
            <SegmentField<SettingsRuntime> label="Runtime" value={runtime} options={(Object.keys(RUNTIME_LABEL) as SettingsRuntime[]).map((r) => ({ value: r, label: RUNTIME_LABEL[r] }))} onChange={setRuntime} />
            <SelectField id={`${id}-ctx`} label="Context length" value={String(ctx)} options={CONTEXTS.map((x) => ({ value: String(x), label: `${n(x)} tokens` }))} onChange={(x) => setCtx(Number(x))} />
          </div>
          <SegmentField<OpenEffort>
            advanced
            label="reasoning_effort for your requests"
            value={effort}
            options={OPEN_EFFORTS.map((e) => ({ value: e, label: `${e} · ${sparkStrength(e)}` }))}
            onChange={setEffort}
            hint={`${row.use}. The template writes it as Reasoning strength: ${row.strength}.`}
          />
          <div className={`${styles.options} pg-advanced`}>
            <NumberField id={`${id}-temp`} label="temperature" value={temperature} step={0.1} min={0} max={2} onChange={setTemperature} hint="Recommended: 1.0" />
            <NumberField id={`${id}-topp`} label="top_p" value={topP} step={0.05} min={0} max={1} onChange={setTopP} hint="Recommended: 1.0, with do_sample true" />
            <div className="pg-field">
              <Toggle id={`${id}-stream`} label="stream: true" checked={stream} onChange={setStream} />
              <p className="pg-hint">Per request, like sampling and the strength.</p>
            </div>
          </div>
          <Facts
            advanced
            label="What the serve command fixes"
            items={[
              { label: "Parallelism", value: `TP${c.tp} / EP${c.ep} on ${c.gpus} × B300 (${SPARK.routedExperts / c.ep} routed experts per GPU)` },
              { label: "Context flag", value: <code>{contextFlag(runtime, ctx)}</code> },
              { label: "Parser flags", value: <code>{SPARK_PARSER_FLAGS[runtime]}</code> },
              {
                label: "KV cache at this context",
                value: `${Math.round(kvShareOfDense(ctx) * 100)}% of what 62 full-attention layers would hold: 16 layers keep all ${n(ctx)} tokens, 46 keep 2,048`,
              },
            ]}
          />
          <div className={`${styles.tableWrap} pg-advanced`}>
            <table className={styles.table}>
              <caption className="sr-only">KV cache by context length, relative to 32,768 tokens</caption>
              <thead>
                <tr>
                  <th scope="col">Context</th>
                  <th scope="col" className={styles.num}>
                    KV cache vs 32,768
                  </th>
                  <th scope="col" className={styles.num}>
                    Share of a dense cache
                  </th>
                </tr>
              </thead>
              <tbody>
                {CONTEXTS.map((x) => (
                  <tr key={x} className={x === ctx ? styles.rowPicked : undefined}>
                    <td>{n(x)}</td>
                    <td className={styles.num}>{kvGrowth(32768, x).toFixed(1)}x</td>
                    <td className={styles.num}>{Math.round(kvShareOfDense(x) * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pg-hint">Bytes per token aren&apos;t on the page, so the table compares contexts. Set the context to what your workload needs rather than the full 1,048,576.</p>
          <Issues warnings={warnings} />
          <CodeTabs
            label="Config"
            tabs={[
              { id: "serve", label: runtime === "trtllm" ? "serve_config.yaml" : "Serve command", lang: runtime === "trtllm" ? "yaml" : "bash", code: serve },
              { id: "request", label: "Request", lang: "json", code: json },
              {
                id: "transformers",
                label: "Transformers generate",
                lang: "python",
                code: [
                  "inputs = processor.apply_chat_template(",
                  "    messages,",
                  `    reasoning_effort="${effort}",`,
                  "    add_generation_prompt=True,",
                  "    tokenize=True,",
                  "    return_dict=True,",
                  '    return_tensors="pt",',
                  ").to(model.device).to(model.dtype)",
                  `outputs = model.generate(**inputs, max_new_tokens=4096, do_sample=True, temperature=${Number.isFinite(temp) ? temp.toFixed(1) : "1.0"}, top_p=${Number.isFinite(top) ? (top === 1 ? "1.0" : top) : "1.0"})`,
                ].join("\n"),
              },
            ]}
          />
        </div>
      </TabPanel>
      <TabPanel idBase={id} id="live" active={tab === "live"}>
        <StrengthCompare />
      </TabPanel>
      <TabPanel idBase={id} id="stops" active={tab === "stops"}>
        <StopChecker />
      </TabPanel>
    </div>
  );
}

function StrengthCompare() {
  const id = useId();
  const a = useDocsRun();
  const b = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  // The multi-step task shows the trade best: on hosted Muse Spark, high spent about 1.6x the reasoning tokens of low.
  const [task, setTask] = useState(2);
  const [prompt, setPrompt] = useState<string>(STRENGTH_TASKS[2].prompt);
  const [levels, setLevels] = useState<[OpenEffort, OpenEffort]>(["low", "high"]);
  const [showCode, setShowCode] = useState(false);
  const running = a.state === "running" || b.state === "running";
  const body = (effort: OpenEffort) => ({ model, messages: [{ role: "user", content: prompt }], reasoning_effort: effort, max_tokens: 4000 });

  const run = () => {
    if (!prompt.trim() || running) return;
    void a.run("chat/completions", { method: "POST", body: body(levels[0]) });
    void b.run("chat/completions", { method: "POST", body: body(levels[1]) });
  };

  const column = (runner: ReturnType<typeof useDocsRun>, effort: OpenEffort, slot: 0 | 1) => {
    const reply = runner.result?.ok ? collectReply("chat", runner.result.json) : null;
    const usage = tokenUsage(reply?.usage ?? null);
    return (
      <div className={styles.card} aria-live="polite" aria-busy={runner.state === "running" || undefined}>
        <div className={styles.cardHead}>
          <SegmentField<OpenEffort>
            label={slot === 0 ? "Left" : "Right"}
            value={effort}
            options={OPEN_EFFORTS.map((e) => ({ value: e, label: e }))}
            onChange={(e) => setLevels((l) => (slot === 0 ? [e, l[1]] : [l[0], e]))}
            disabled={running}
          />
        </div>
        <p className="pg-hint">Open weights would write Reasoning strength: {sparkStrength(effort)}.</p>
        {runner.state === "running" ? <p className="pg-wait">Running at {effort}... {latencyLabel(runner.elapsedMs)}</p> : null}
        {reply ? (
          <>
            <p className={styles.tally}>
              <span>
                <strong>{(usage?.reasoning ?? 0).toLocaleString("en-US")}</strong> reasoning tokens
              </span>
              <span>
                <strong>{(usage?.output ?? 0).toLocaleString("en-US")}</strong> output in all
              </span>
              <span>
                <strong>{latencyLabel(runner.result?.elapsedMs ?? 0)}</strong>
              </span>
            </p>
            <div style={{ fontSize: 14 }}>
              <MarkdownText text={reply.text || "(no answer text: the budget ran out during reasoning)"} />
            </div>
            <p className="pg-small pg-muted">
              <UsageLine model={runner.result?.model ?? model} usage={reply.usage} />
            </p>
          </>
        ) : null}
        <ErrorBox error={runner.error} />
      </div>
    );
  };

  return (
    <div className={styles.stack}>
      <StandInBanner>
        Stand-in: both requests go to hosted Muse Spark through Model API, not to Muse Spark Open. Hosted levels go by name, where the open-weight template writes 8, 32, 256 or 512; the trade is
        the one the page describes: lower strength, fewer reasoning tokens, less latency.
      </StandInBanner>
      <PresetPills
        presets={STRENGTH_TASKS}
        active={task}
        onPick={(i) => {
          setTask(i);
          setPrompt(STRENGTH_TASKS[i].prompt);
        }}
        label="Task"
        disabled={running}
      />
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
      </div>
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          Prompt
        </label>
        <TextArea id={`${id}-prompt`} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">Two requests, max_tokens 4,000 each. Under a cent on Contributor.</span>
          <RunButton
            running={running}
            onRun={run}
            onStop={() => {
              a.abort();
              b.abort();
            }}
            disabled={!prompt.trim()}
            label="Run both"
          />
        </div>
      </div>
      <div className={styles.grid2}>
        {column(a, levels[0], 0)}
        {column(b, levels[1], 1)}
      </div>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body(levels[1])} caption={`The ${levels[1]} request (the other differs only in reasoning_effort)`} /> : null}
    </div>
  );
}

function StopChecker() {
  const id = useId();
  const [text, setText] = useState('{"eos_token_id": [200001, 200007, 200008]}');
  const result = useMemo(() => checkStops(text), [text]);
  const bad = result.checks.some((c) => c.level === "error");
  const warn = result.checks.some((c) => c.level === "warn");
  return (
    <div className={styles.stack}>
      <div className={`${styles.tableWrap} pg-advanced`}>
        <table className={styles.table}>
          <caption className="sr-only">Muse Spark Open's special tokens</caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col" className={styles.num}>
                ID
              </th>
              <th scope="col">Role</th>
              <th scope="col">Stop on it</th>
            </tr>
          </thead>
          <tbody>
            {STOP_TOKENS.map((t) => (
              <tr key={t.id} className={result.ids.includes(t.id) ? styles.rowPicked : undefined}>
                <td className={styles.mono}>{t.token}</td>
                <td className={styles.num}>{t.id}</td>
                <td>{t.role}</td>
                <td>{t.stop ? "Yes" : t.id === 200007 ? "Never" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pg-field">
        <label className="pg-label" htmlFor={`${id}-stops`}>
          Your stop list or generation_config.json
        </label>
        <TextArea id={`${id}-stops`} rows={3} className="pg-code-input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <p className="pg-hint">A JSON list, an eos_token_id object, or tokens and ids separated by commas.</p>
      </div>
      <Status tone={bad ? "bad" : warn ? "warn" : "ok"}>{bad ? "This list stops on <|eom|>: it would cut the model off mid-turn." : warn ? "Close: see what to add." : "Matches the page: eos_token_id is [200001, 200008]."}</Status>
      <Issues
        errors={result.checks.filter((c) => c.level === "error").map((c) => c.text)}
        warnings={result.checks.filter((c) => c.level === "warn").map((c) => c.text)}
        notes={[...result.checks.filter((c) => c.level === "ok").map((c) => c.text), "SGLang reads the same pair from config.json and generation_config.json, so it needs no explicit flag."]}
        noteTitle="Checks"
        notesAreResult
      />
    </div>
  );
}
