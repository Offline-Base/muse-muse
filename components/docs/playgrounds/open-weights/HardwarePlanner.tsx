"use client";

import { useId, useMemo, useState } from "react";
import { Toggle } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { SPARK, SPARK_CHECKPOINTS, gb, n, type OpenModel, type SparkCheckpoint } from "@/components/docs/playgrounds/open-weights/facts";
import { CTX_FLAG, PAGE_CTX, sparkLayout, sparkNvidiaCommand, type NvidiaRuntime } from "@/components/docs/playgrounds/open-weights/spark-hardware";
import { kvGrowth } from "@/components/docs/playgrounds/open-weights/settings";
import {
  AMD_VARIANTS,
  B300_GB,
  B300_SWEEP,
  GLIMMER_PLATFORMS,
  GLIMMER_TROUBLESHOOTING,
  INTEL_COMMAND,
  MLX_COMMAND,
  aiperfCommand,
  amdCommand,
  describeSweepRow,
  glimmerFits,
  glimmerPlatformCommand,
  macShare,
  type AmdVariant,
  type GlimmerPlatformId,
} from "@/components/docs/playgrounds/open-weights/hardware";
import { Badge, CodeCard, Facts, Issues, NumberField, SegmentField, SelectField, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The Hardware platforms pages as calculators (muse-spark-open/hardware-platforms, muse-glimmer/hardware-platforms):
 * for Muse Spark Open, the platform, accelerator, count and checkpoint, with each GPU's share of the weights, the
 * experts per GPU, the KV-cache rule for GB300 and the platform's sample command; for Muse Glimmer, each verified
 * platform's specs and command, what fits in its memory, NVIDIA's single-B300 throughput sweep and the
 * troubleshooting table.
 */

export interface HardwarePlannerProps {
  slug: string;
  model: OpenModel;
}

export function HardwarePlanner({ model }: HardwarePlannerProps) {
  return model === "spark" ? <SparkHardware /> : <GlimmerHardware />;
}

type Vendor = "nvidia" | "amd" | "intel" | "apple";

const CTX_SIZES = [49152, 131072, 262144, 524288, 1048576];

function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = Math.min(100, (used / total) * 100);
  const over = used > total * 0.9;
  return (
    <div className="pg-field">
      <span className="pg-label">{label}</span>
      <div className={styles.meter} role="img" aria-label={`${gb(used, 0)} of ${gb(total, 0)} GB`}>
        <div className={`${styles.meterFill} ${over ? styles.meterOver : used > total * 0.75 ? styles.meterTight : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="pg-small pg-muted">
        {gb(used, 0)} GB of {gb(total, 0)} GB
      </span>
    </div>
  );
}

function SparkHardware() {
  const id = useId();
  const [vendor, setVendor] = useState<Vendor>("nvidia");
  const [gpu, setGpu] = useState<"gb300" | "b300">("gb300");
  const [count, setCount] = useState<"4" | "8">("4");
  const [checkpoint, setCheckpoint] = useState<SparkCheckpoint>("nvfp4");
  const [runtime, setRuntime] = useState<NvidiaRuntime>("trtllm");
  const [amdGpu, setAmdGpu] = useState<"mi355x" | "mi350x">("mi355x");
  const [variant, setVariant] = useState<AmdVariant>("bf16");
  const [macs, setMacs] = useState<"2" | "4">("4");
  const [ctxChoice, setCtxChoice] = useState("page");

  const gpus = Number(count);
  // The numbers describe the layout the command uses (spark-hardware.ts): the page's TP/EP, on part of the GPUs when
  // there are more than the recipe needs.
  const { layout, used, spare, fit, expertsPerGpu } = sparkLayout(checkpoint, gpus, runtime);
  const ctx = ctxChoice === "page" ? PAGE_CTX[runtime] : Number(ctxChoice);
  const nvidiaCommand = useMemo(() => sparkNvidiaCommand(runtime, checkpoint, gpu, ctx), [runtime, gpu, checkpoint, ctx]);

  const nvidiaIssues: string[] = [];
  const nvidiaWarnings: string[] = [];
  const nvidiaNotes: string[] = [];
  if (vendor === "nvidia") {
    if (!fit.fits) nvidiaIssues.push(`${layout.label} doesn't fit on ${gpus} GPUs: the page's recipe serves it at TP${layout.tp}/EP${layout.ep} on ${layout.gpus}, the command below.`);
    if (runtime === "trtllm" && checkpoint === "bf16") nvidiaWarnings.push("The validated TensorRT-LLM configuration serves NVFP4 at TP4/EP4, so the command and the numbers here are NVFP4's. For BF16, use SGLang or vLLM.");
    if (spare > 0) {
      nvidiaNotes.push(
        `The page's ${layout.label} recipe is TP${layout.tp}/EP${layout.ep} on ${layout.gpus} GPUs, so the command uses ${layout.gpus} of your ${gpus}; the pages don't validate TP${gpus}/EP${gpus} for it. The other ${spare} can serve a second copy, or SGLang's prefill and decode split (Run inference) runs one TP4/EP4 server on each half.`,
      );
    }
    if (runtime === "trtllm" && gpus === 8) nvidiaNotes.push("TP4/EP4 fits on a single 4-GPU node, so trtllm-serve launches directly, with no multi-node launcher.");
    if (gpu === "gb300" && runtime === "trtllm") nvidiaNotes.push("On GB300 (SM103), the FP8 KV cache is required when chunked prefill or KV-cache block reuse is on, and the recommended configuration turns both on.");
    if (ctx === null) nvidiaNotes.push("SGLang's command on the page sets no --context-length, so the server picks its own. KV memory grows with the context on the 16 full-attention layers: set it to what your workload needs (Recommended settings).");
    else if (ctx !== 49152) {
      nvidiaNotes.push(
        `At ${n(ctx)} tokens the KV cache is ${kvGrowth(49152, ctx).toFixed(1)}x what it is at 49,152 (TensorRT-LLM's validated window): only the 16 full-attention layers of 62 grow with the context; the 46 sliding-window layers keep 2,048 tokens. It must fit in what's left per GPU, with activations.`,
      );
    }
    nvidiaNotes.push("Validated serving configurations live in the runtimes' recipe databases (TensorRT-LLM's examples/configs/database, the Dynamo recipe): start there rather than hand-tuning.");
  }
  const amd = AMD_VARIANTS.find((x) => x.id === variant)!;
  const share = macShare(macs === "2" ? 2 : 4);

  return (
    <div className="pg">
      <SegmentField<Vendor>
        label="Vendor"
        value={vendor}
        options={[
          { value: "nvidia", label: "NVIDIA Blackwell" },
          { value: "amd", label: "AMD Instinct" },
          { value: "intel", label: "Intel Xeon 6" },
          { value: "apple", label: "Apple (Mac Studio)" },
        ]}
        onChange={setVendor}
      />
      {vendor === "nvidia" ? (
        <div className={styles.stack}>
          <div className={styles.options}>
            <SegmentField<"gb300" | "b300"> label="Accelerator" value={gpu} options={[{ value: "gb300", label: "GB300 NVL (SM103)" }, { value: "b300", label: "B300 (SM100)" }]} onChange={setGpu} />
            <SegmentField<"4" | "8"> label="GPUs" value={count} options={[{ value: "4", label: "4" }, { value: "8", label: "8" }]} onChange={setCount} />
            <SegmentField<SparkCheckpoint> label="Checkpoint" value={checkpoint} options={[{ value: "nvfp4", label: "NVFP4" }, { value: "bf16", label: "BF16" }]} onChange={setCheckpoint} />
            <SegmentField<NvidiaRuntime> label="Runtime" value={runtime} options={[{ value: "trtllm", label: "TensorRT-LLM" }, { value: "sglang", label: "SGLang" }, { value: "vllm", label: "vLLM" }]} onChange={setRuntime} />
            <SelectField
              id={`${id}-ctx`}
              label={`Context length (${CTX_FLAG[runtime]})`}
              value={ctxChoice}
              options={[
                { value: "page", label: runtime === "trtllm" ? "The page's: 49,152 tokens (validated)" : runtime === "sglang" ? "The page's: the server default" : "The page's: 1,048,576 tokens" },
                ...CTX_SIZES.map((x) => ({ value: String(x), label: `${n(x)} tokens${x === 49152 ? " (TensorRT-LLM's validated window)" : x === 1048576 ? " (the full window)" : ""}` })),
              ]}
              onChange={setCtxChoice}
            />
          </div>
          <Status tone={fit.fits ? "ok" : "bad"}>{spare > 0 ? `${fit.summary.replace(/ on \d+ GPUs:/, ` on ${used} of your ${gpus} GPUs:`)}` : fit.summary}</Status>
          <div className={styles.grid2}>
            <Meter used={Math.min(fit.perGpuGb, B300_GB * 1.5)} total={B300_GB} label={`Weights per GPU (an even split, estimate) of ${B300_GB} GB HBM3e`} />
            <Facts
              label="Layout"
              items={[
                { label: "Parallelism", value: `TP${layout.tp}/EP${layout.ep}, the page's recipe${spare > 0 ? `, on ${used} of your ${gpus} GPUs` : used < layout.gpus ? `, which needs ${layout.gpus} GPUs` : ""}` },
                { label: "Routed experts per GPU", value: `${expertsPerGpu} of ${SPARK.routedExperts}` },
                { label: "KV cache", value: gpu === "gb300" && runtime === "trtllm" ? "FP8 (required on SM103 here)" : "Per the runtime's recipe" },
              ]}
            />
          </div>
          <Issues errors={nvidiaIssues} warnings={nvidiaWarnings} notes={nvidiaNotes} />
          <CodeCard code={nvidiaCommand} lang={runtime === "trtllm" ? "yaml" : "bash"} label={runtime === "trtllm" ? "serve_config.yaml and trtllm-serve" : `${runtime === "sglang" ? "SGLang" : "vLLM"} serve command`} />
          <p className="pg-small">
            <a href="/docs/muse-spark-open/deploy">Run inference</a> builds every runtime&apos;s full command.
          </p>
        </div>
      ) : null}
      {vendor === "amd" ? (
        <div className={styles.stack}>
          <div className={styles.options}>
            <SegmentField<"mi355x" | "mi350x"> label="Accelerator (8 GPUs)" value={amdGpu} options={[{ value: "mi355x", label: "MI355X" }, { value: "mi350x", label: "MI350X" }]} onChange={setAmdGpu} />
            <SelectField id={`${id}-variant`} label="Checkpoint and mode" value={variant} options={AMD_VARIANTS.map((x) => ({ value: x.id, label: x.label }))} onChange={(x) => setVariant(x as AmdVariant)} />
          </div>
          <Facts
            label="AMD configuration"
            items={[
              { label: "Checkpoint", value: <code>{amd.checkpoint}</code> },
              { label: "Parallelism", value: amd.parallelism },
              { label: "KV cache", value: "GPU" },
              { label: "Runtime", value: "vLLM (vllm/vllm-openai-rocm:muse-spark-open)" },
            ]}
          />
          {variant.startsWith("bf16") ? (
            <Status tone="ok">
              BF16 over 8 GPUs is about {gb(SPARK_CHECKPOINTS.bf16.footprintGb / 8, 0)} GB of weights per GPU (an even split, estimate). Both MI355X and MI350X carry 288 GB of HBM3E (AMD&apos;s spec, not this page&apos;s).
            </Status>
          ) : (
            <Status tone="ok">AMD&apos;s Quark {variant.startsWith("fp8") ? "PTPC-FP8" : "MXFP4"} checkpoint serves at TP8+EP8; this page doesn&apos;t list its size.</Status>
          )}
          <CodeCard code={amdCommand(variant)} lang="bash" label={`${amd.label} on ${amdGpu === "mi355x" ? "MI355X" : "MI350X"}`} />
        </div>
      ) : null}
      {vendor === "intel" ? (
        <div className={styles.stack}>
          <Facts
            label="Intel configuration"
            items={[
              { label: "Checkpoint", value: <code>intel-ai/Muse-Spark-Open-816B-A42B-INT4</code> },
              { label: "Hardware", value: "Intel Xeon 6 with P-cores, such as the 6980P" },
              { label: "Runtime", value: "SGLang, --quantization gptq, --tp-size 2" },
            ]}
          />
          <CodeCard code={INTEL_COMMAND} lang="bash" label="SGLang on Xeon 6" />
          <p className="pg-small">
            The Intel and SGLang launch posts and SGLang&apos;s cookbook page cover the CPU setup. The page doesn&apos;t give the INT4 checkpoint&apos;s size.
          </p>
        </div>
      ) : null}
      {vendor === "apple" ? (
        <div className={styles.stack}>
          <SegmentField<"2" | "4"> label="Mac Studios with M5 Ultra" value={macs} options={[{ value: "2", label: "Two with 512 GB" }, { value: "4", label: "Four with 256 GB" }]} onChange={setMacs} />
          <Status tone="ok">
            Each Mac holds about {gb(share.perMacGb)} GB of the {SPARK_CHECKPOINTS.nvfp4.footprintGb} GB NVFP4 weights ({share.percent}% of its {share.memGb} GB), and its own full copy on disk.
          </Status>
          <Meter used={share.perMacGb} total={share.memGb} label="Each Mac's share of the NVFP4 weights" />
          <Issues notes={["MLX splits the model across the Macs over RDMA on Thunderbolt 5, which needs macOS 26.2 or later and a direct link between every pair of Macs.", "Four Macs serve fastest."]} />
          <CodeCard code={MLX_COMMAND} lang="bash" label="mlx.launch on the primary" />
          <p className="pg-small">
            <a href="/docs/cookbook/muse-spark-open-mac">The Mac Studio recipe</a> plans the cables, SSH and commands.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function GlimmerHardware() {
  const id = useId();
  const [tab, setTab] = useState<"platform" | "sweep" | "trouble">("platform");
  const [platform, setPlatform] = useState<GlimmerPlatformId | "custom">("b300");
  const [custom, setCustom] = useState("24");
  const [vision, setVision] = useState(true);
  const [conc, setConc] = useState(8);
  const [picked, setPicked] = useState<number[]>(B300_SWEEP.map((r) => r.concurrency));
  const [symptom, setSymptom] = useState(0);

  const p = platform === "custom" ? null : GLIMMER_PLATFORMS.find((x) => x.id === platform)!;
  const memory = p ? p.memoryGb : Math.max(0, Number(custom) || 0);
  const fits = glimmerFits(memory, vision, p);
  const row = B300_SWEEP.find((r) => r.concurrency === conc) ?? B300_SWEEP[0];
  const maxTotal = Math.max(...B300_SWEEP.map((r) => r.total));
  const t = GLIMMER_TROUBLESHOOTING[symptom];

  return (
    <div className="pg">
      <Tabs
        label="Hardware"
        idBase={id}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "platform", label: "Platforms and fit" },
          { id: "sweep", label: "B300 throughput" },
          { id: "trouble", label: "Troubleshoot" },
        ]}
      />
      <TabPanel idBase={id} id="platform" active={tab === "platform"}>
        <div className={styles.stack}>
          <div className={styles.options}>
            <SelectField
              id={`${id}-platform`}
              label="Platform"
              value={platform}
              options={[...GLIMMER_PLATFORMS.map((x) => ({ value: x.id, label: x.label })), { value: "custom", label: "My own machine" }]}
              onChange={(x) => setPlatform(x as GlimmerPlatformId | "custom")}
            />
            {platform === "custom" ? <NumberField id={`${id}-mem`} label="GPU or unified memory (GB)" value={custom} min={1} step={1} onChange={setCustom} hint="Cards' GB are GiB." /> : null}
            <div className="pg-field">
              <Toggle id={`${id}-vision`} label="Image input (vision projector)" checked={vision} onChange={setVision} />
            </div>
          </div>
          {p ? (
            <Facts
              label={p.label}
              items={[
                { label: "Memory", value: p.memory },
                { label: "Verified", value: p.verifiedBy },
                { label: "Precisions verified", value: p.precisions },
                { label: "Runtime", value: p.runtime },
              ]}
            />
          ) : null}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">What fits in {memory} GB</caption>
              <thead>
                <tr>
                  <th scope="col">Build</th>
                  <th scope="col" className={styles.num}>
                    Needs
                  </th>
                  <th scope="col">In {gb(memory)} GB</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {fits.map((f) => (
                  <tr key={f.format}>
                    <td>
                      {f.label}
                      {!f.images ? <span className="pg-muted pg-small"> · text only</span> : null}
                    </td>
                    <td className={styles.num}>{f.needGb === null ? "?" : `${gb(f.needGb)} ${f.format === "kquant17" || f.format === "dynamic" ? "GiB" : "GB"}`}</td>
                    <td>{f.fits === null ? <Badge tone="neutral">Unknown</Badge> : f.fits ? <Badge tone="ok">Fits</Badge> : <Badge tone="bad">No</Badge>}</td>
                    <td className="pg-small pg-muted">{f.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p ? <CodeCard code={glimmerPlatformCommand(p.id)} lang="bash" label={`${p.label}: ${p.runtime}`} /> : null}
          <p className="pg-small">
            Partners verified these on their own machines at the versions listed; Meta doesn&apos;t re-run them. <a href="/docs/muse-glimmer/quantization">Quantization</a> budgets the GGUFs in detail.
          </p>
        </div>
      </TabPanel>
      <TabPanel idBase={id} id="sweep" active={tab === "sweep"}>
        <div className={styles.stack}>
          <SegmentField<string> label="Concurrent requests" value={String(conc)} options={B300_SWEEP.map((r) => ({ value: String(r.concurrency), label: String(r.concurrency) }))} onChange={(x) => setConc(Number(x))} />
          <Status tone="ok">{describeSweepRow(row)}</Status>
          <ul className={styles.bars} aria-label="Total output tokens per second by concurrency">
            {B300_SWEEP.map((r) => (
              <li key={r.concurrency} className={`${styles.bar} ${r.concurrency === conc ? styles.barPicked : ""}`}>
                <span>{r.concurrency}</span>
                <span className={styles.barTrack}>
                  <span className={styles.barFill} style={{ width: `${(r.total / maxTotal) * 100}%`, display: "block" }} />
                </span>
                <span>{n(r.total)} tok/s</span>
              </li>
            ))}
          </ul>
          <p className="pg-hint">
            One B300, no tensor parallelism: 2,048 input and 256 output tokens with a 32,768-token prefix cache (vLLM 0.1.dev19055, torch 2.13.0+cu130, CUDA 13.0). Throughput keeps rising past 64 requests while each request slows to under 20 tokens a second.
          </p>
          <fieldset className={styles.row} style={{ margin: 0, padding: 0, border: 0 }}>
            <legend className="pg-label" style={{ marginBottom: 6 }}>
              Concurrencies to profile
            </legend>
            {B300_SWEEP.map((r) => (
              <Toggle
                key={r.concurrency}
                id={`${id}-c${r.concurrency}`}
                label={String(r.concurrency)}
                checked={picked.includes(r.concurrency)}
                onChange={(on) => setPicked((cur) => (on ? [...cur, r.concurrency].sort((a, b) => a - b) : cur.filter((x) => x !== r.concurrency)))}
              />
            ))}
          </fieldset>
          <CodeCard code={aiperfCommand(picked)} lang="bash" label="Reproduce the sweep with aiperf" />
        </div>
      </TabPanel>
      <TabPanel idBase={id} id="trouble" active={tab === "trouble"}>
        <div className={styles.stack}>
          <SegmentField<string> label="What do you see?" value={String(symptom)} options={GLIMMER_TROUBLESHOOTING.map((x, i) => ({ value: String(i), label: x.symptom }))} onChange={(x) => setSymptom(Number(x))} />
          <div className={styles.card} aria-live="polite">
            <p className={styles.cardText}>
              <strong>Cause:</strong> {t.cause}
            </p>
            <p className={styles.cardText}>
              <strong>Fix:</strong> {t.fix}
            </p>
          </div>
          <p className="pg-hint">These fixes apply on every platform above.</p>
        </div>
      </TabPanel>
    </div>
  );
}
