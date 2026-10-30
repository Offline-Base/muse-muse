"use client";

import { useId, useMemo, useState } from "react";
import { PresetPills, TextArea, Toggle } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { clientBody, clientCode, defaultsOf, type OptionValue, type RuntimeDef, type Values } from "@/components/docs/playgrounds/open-weights/deploy";
import { SPARK_RUNTIMES } from "@/components/docs/playgrounds/open-weights/deploy-spark";
import { GLIMMER_RUNTIMES } from "@/components/docs/playgrounds/open-weights/deploy-glimmer";
import { MODEL_NAME, PAGE, type OpenModel } from "@/components/docs/playgrounds/open-weights/facts";
import { StandIn } from "@/components/docs/playgrounds/open-weights/StandIn";
import { hostedFromClient } from "@/components/docs/playgrounds/open-weights/standin-body";
import { CodeTabs, Issues, OptionControls, Rich, SegmentField, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The Run inference pages as a builder (muse-spark-open/deploy, muse-glimmer/deploy): pick a runtime, set the
 * variations the page describes (checkpoint, GPUs and parallelism, speculative decoding, caches, context and slots,
 * reasoning level), and get the page's install and serve commands with those values, the checks its troubleshooting
 * tables make, the client code for the started server, and a stand-in run of that client request on hosted Muse
 * Spark.
 */

export interface DeployBuilderProps {
  slug: string;
  model: OpenModel;
}

interface DeployPreset {
  label: string;
  runtime: string;
  values?: Values;
}

const PRESETS: Record<OpenModel, DeployPreset[]> = {
  spark: [
    { label: "SGLang, NVFP4 on 4 GPUs", runtime: "sglang" },
    { label: "SGLang, BF16 on 8 GPUs", runtime: "sglang", values: { checkpoint: "bf16" } },
    { label: "Prefill and decode split", runtime: "sglang", values: { mode: "pd", pdHardware: "b300" } },
    { label: "vLLM with DSpark", runtime: "vllm" },
    { label: "TensorRT-LLM on GB300", runtime: "trtllm" },
    { label: "llama.cpp, Q4_K_S", runtime: "llamacpp", values: { quant: "Q4_K_S" } },
    { label: "Unsloth, 2-bit", runtime: "unsloth" },
    { label: "MLX on four Macs", runtime: "mlx" },
    { label: "Hosted: Fireworks", runtime: "hosted", values: { provider: "fireworks" } },
  ],
  glimmer: [
    { label: "vLLM, bf16 on one GPU", runtime: "vllm" },
    { label: "vLLM, tight memory", runtime: "vllm", values: { memory: "tight" } },
    { label: "SGLang, NVFP4 on an RTX 5090", runtime: "sglang", values: { format: "nvfp4", hardware: "rtx5090" } },
    { label: "SGLang with DFlash", runtime: "sglang", values: { dflash: true } },
    { label: "SGLang on a Mac (MLX)", runtime: "sglang", values: { format: "mlx", hardware: "apple" } },
    { label: "llama.cpp with DFlash", runtime: "llamacpp", values: { dflash: true } },
    { label: "llama.cpp, 4 slots", runtime: "llamacpp", values: { np: 4, ctx: 524288 } },
    { label: "ExecuTorch, prebuilt", runtime: "executorch" },
    { label: "Ollama on Apple silicon", runtime: "ollama", values: { tag: "muse-glimmer:30b-mlx" } },
    { label: "Hosted: Together AI", runtime: "together" },
  ],
};

const PROMPT: Record<OpenModel, string> = {
  spark: "Briefly explain: what is SGLang?",
  glimmer: "Write a Python function to compute Fibonacci numbers.",
};

export function DeployBuilder({ model }: DeployBuilderProps) {
  const id = useId();
  const runtimes: RuntimeDef[] = model === "spark" ? SPARK_RUNTIMES : GLIMMER_RUNTIMES;
  const presets = PRESETS[model];
  const [runtimeId, setRuntimeId] = useState(runtimes[0].id);
  const [values, setValues] = useState<Record<string, Values>>(() => Object.fromEntries(runtimes.map((r) => [r.id, defaultsOf(r.options)])));
  const [preset, setPreset] = useState<number | null>(0);
  const [tab, setTab] = useState<"serve" | "client" | "live">("serve");
  // The prompt follows the picked runtime's own example until the reader types their own.
  const [typed, setTyped] = useState<string | null>(null);
  const [stream, setStream] = useState(false);

  const runtime = runtimes.find((r) => r.id === runtimeId) ?? runtimes[0];
  const v = values[runtime.id];
  const plan = useMemo(() => runtime.build(v), [runtime, v]);
  const client = plan.client;
  const prompt = typed ?? client?.examplePrompt ?? PROMPT[model];
  const code = useMemo(() => (client ? clientCode(client, prompt || PROMPT[model], stream) : null), [client, prompt, stream, model]);
  const hosted = useMemo(() => (client ? hostedFromClient(client) : null), [client]);
  const standInMessages = useMemo(() => [{ role: "user", content: prompt || PROMPT[model] }], [prompt, model]);

  const setOption = (key: string, value: OptionValue) => {
    setPreset(null);
    setValues((all) => ({ ...all, [runtime.id]: { ...all[runtime.id], [key]: value } }));
  };

  const pick = (i: number) => {
    const p = presets[i];
    const r = runtimes.find((x) => x.id === p.runtime) ?? runtimes[0];
    setPreset(i);
    setRuntimeId(r.id);
    setValues((all) => ({ ...all, [r.id]: { ...defaultsOf(r.options), ...(p.values ?? {}) } }));
    setTyped(null);
  };

  const selfHost = runtimes.filter((r) => r.group === "self-host");
  const hostedRuntimes = runtimes.filter((r) => r.group === "hosted");
  const tabs = [
    { id: "serve" as const, label: runtime.group === "hosted" ? "Set up" : "Serve" },
    ...(client ? [{ id: "client" as const, label: "Client code" }, { id: "live" as const, label: "Try the request" }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "serve";
  const tone = plan.errors.length ? "bad" : plan.warnings.length ? "warn" : "ok";

  return (
    <div className="pg">
      <PresetPills presets={presets} active={preset} onPick={pick} label="Try" />
      <SegmentField
        label="Runtime"
        value={runtime.id}
        options={[...selfHost, ...hostedRuntimes].map((r) => ({ value: r.id, label: r.label }))}
        onChange={(x) => {
          setPreset(null);
          setRuntimeId(x);
        }}
      />
      <p className="pg-hint">
        {runtime.bestFor}.{" "}
        <a href={`${PAGE[model].deploy}${runtime.anchor}`}>Read the {runtime.label} section</a>
      </p>
      <OptionControls options={runtime.options} values={v} onChange={setOption} idBase={`${id}-${runtime.id}`} />
      <Status tone={tone}>
        {plan.errors.length
          ? `${plan.errors.length === 1 ? "One combination" : `${plan.errors.length} combinations`} here fail at startup, per the page.`
          : plan.warnings.length
            ? `${runtime.label}: ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}, with ${plan.warnings.length} thing${plan.warnings.length === 1 ? "" : "s"} to check first.`
            : `${runtime.label}: ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}${client ? `, then a client on ${client.baseUrl}` : ""}.`}
      </Status>
      <Issues errors={plan.errors} warnings={plan.warnings} notes={plan.notes} />

      <Tabs label="Commands or client" tabs={tabs} value={activeTab} onChange={setTab} idBase={id} />
      <TabPanel idBase={id} id="serve" active={activeTab === "serve"}>
        <Steps steps={plan.steps} label={`${runtime.label} commands`} />
      </TabPanel>
      {client && code ? (
        <TabPanel idBase={id} id="client" active={activeTab === "client"}>
          <div className={styles.stack}>
            <div className="pg-field">
              <label className="pg-label" htmlFor={`${id}-prompt`}>
                Prompt
              </label>
              <TextArea id={`${id}-prompt`} rows={2} value={prompt} onChange={(e) => setTyped(e.target.value)} />
            </div>
            <Toggle id={`${id}-stream`} label="Stream the reply (recommended for long reasoning)" checked={stream} onChange={setStream} />
            <CodeTabs
              tabs={[
                { id: "python", label: "Python", lang: "python", code: code.python },
                { id: "typescript", label: "TypeScript", lang: "typescript", code: code.typescript },
                { id: "curl", label: "curl", lang: "bash", code: code.curl },
              ]}
            />
            <p className="pg-hint">
              <Rich
                text={[
                  client.reasoningFields.length ? `Reasoning comes back in ${client.reasoningFields.map((f) => `message.${f}`).join(" or ")}, the answer in message.content.` : "",
                  client.keyEnv ? `The key is the server's own, from ${client.keyEnv}; no Meta key is involved.` : "This server doesn't check a key.",
                  ...(client.notes ?? []),
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
            </p>
            <details className="pg-raw">
              <summary>The request body</summary>
              <pre className="pg-pre">{JSON.stringify(clientBody(client, prompt || PROMPT[model], stream), null, 2)}</pre>
            </details>
          </div>
        </TabPanel>
      ) : null}
      {client && hosted ? (
        <TabPanel idBase={id} id="live" active={activeTab === "live"}>
          <StandIn
            standsFor={MODEL_NAME[model]}
            messages={standInMessages}
            prompt={prompt || PROMPT[model]}
            effort={hosted.effort}
            extra={hosted.extra}
            dropped={hosted.dropped}
            reasoningField={client.reasoningFields.join(" or ") || "reasoning_content"}
          />
        </TabPanel>
      ) : null}
    </div>
  );
}
