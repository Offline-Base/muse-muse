"use client";

import { useId, useMemo, useState } from "react";
import { Field, TextInput, Toggle } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { DatasetCheck } from "@/components/docs/playgrounds/open-weights/DatasetCheck";
import { GrpoLab } from "@/components/docs/playgrounds/open-weights/GrpoLab";
import type { OpenModel } from "@/components/docs/playgrounds/open-weights/facts";
import { ANALYST_TIERS } from "@/components/docs/playgrounds/open-weights/rewards";
import {
  AXOLOTL_DEFAULTS,
  DPO_DEFAULTS,
  FIREWORKS_DEFAULTS,
  GLIMMER_TRL_DEFAULTS,
  GRPO_DEFAULTS,
  MILES_DEFAULTS,
  SPARK_TRL_DEFAULTS,
  TITANRL_DEFAULTS,
  axolotlPlan,
  dpoPlan,
  fireworksPlan,
  fullParamMemory,
  glimmerTrl,
  grpoPlan,
  milesPlan,
  sparkTrl,
  titanRlPlan,
  type AxolotlOptions,
  type DpoOptions,
  type FireworksOptions,
  type GlimmerTrlOptions,
  type GrpoOptions,
  type MilesOptions,
  type SparkTrlOptions,
  type TitanRlOptions,
  type TrainingPlan,
} from "@/components/docs/playgrounds/open-weights/training";
import { Issues, NumberField, SegmentField, SelectField, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The post-training pages as config builders (muse-spark-open/post-training, muse-glimmer/post-training): each
 * framework the page documents with its knobs (GPUs and sharding, LoRA rank and alpha, learning rate, batch, the RL
 * group size, save intervals), its code and launch commands with those values, and checks against the page's own
 * ranges; a memory calculator for full-parameter training; a row checker for the data formats; and, on Muse Glimmer,
 * a live GRPO group on hosted Muse Spark.
 */

export interface TrainingPlannerProps {
  slug: string;
  model: OpenModel;
}

function num(v: string, fallback: number): number {
  const x = Number(v);
  return v.trim() && Number.isFinite(x) ? x : fallback;
}

function PlanView({ plan, label }: { plan: TrainingPlan; label: string }) {
  return (
    <div className={styles.stack}>
      <Status tone={plan.errors.length ? "bad" : "neutral"}>{plan.summary}</Status>
      <Issues errors={plan.errors} warnings={plan.warnings} notes={plan.notes} />
      <Steps steps={plan.steps} label={label} />
    </div>
  );
}

export function TrainingPlanner({ model }: TrainingPlannerProps) {
  return model === "spark" ? <SparkTraining /> : <GlimmerTraining />;
}

// ---------------------------------------------------------------------------------------------------------------

type SparkTab = "trl" | "miles" | "fireworks" | "more" | "data";

function SparkTraining() {
  const id = useId();
  const [tab, setTab] = useState<SparkTab>("trl");
  return (
    <div className="pg">
      <Tabs
        label="Framework"
        idBase={id}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "trl", label: "TRL SFT" },
          { id: "miles", label: "Miles GRPO" },
          { id: "fireworks", label: "Fireworks" },
          { id: "more", label: "TorchTitan and more" },
          { id: "data", label: "Check rows" },
        ]}
      />
      <TabPanel idBase={id} id="trl" active={tab === "trl"}>
        <SparkTrlPanel />
      </TabPanel>
      <TabPanel idBase={id} id="miles" active={tab === "miles"}>
        <MilesPanel />
      </TabPanel>
      <TabPanel idBase={id} id="fireworks" active={tab === "fireworks"}>
        <FireworksPanel />
      </TabPanel>
      <TabPanel idBase={id} id="more" active={tab === "more"}>
        <MorePanel />
      </TabPanel>
      <TabPanel idBase={id} id="data" active={tab === "data"}>
        <DatasetCheck formats={["chat", "miles-math", "miles-vlm", "fireworks-rl", "torchtitan-sft"]} />
      </TabPanel>
    </div>
  );
}

function SparkTrlPanel() {
  const id = useId();
  const [s, setS] = useState<Record<keyof SparkTrlOptions, string>>(() => Object.fromEntries(Object.entries(SPARK_TRL_DEFAULTS).map(([k, v]) => [k, String(v)])) as Record<keyof SparkTrlOptions, string>);
  const o: SparkTrlOptions = {
    nodes: Math.max(1, Math.round(num(s.nodes, 8))),
    gpusPerNode: Math.max(1, Math.round(num(s.gpusPerNode, 8))),
    epSize: Math.max(1, Math.round(num(s.epSize, 8))),
    maxSteps: Math.max(1, Math.round(num(s.maxSteps, 500))),
    maxLength: Math.max(128, Math.round(num(s.maxLength, 2048))),
    rank: Math.max(1, Math.round(num(s.rank, 16))),
    alpha: Math.max(1, Math.round(num(s.alpha, 32))),
    saveSteps: Math.max(1, Math.round(num(s.saveSteps, 50))),
    dataset: s.dataset === "local" ? "local" : "tulu",
  };
  const plan = useMemo(() => sparkTrl(o), [JSON.stringify(o)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof SparkTrlOptions) => (v: string) => setS((cur) => ({ ...cur, [k]: v }));
  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        <NumberField id={`${id}-nodes`} label="Nodes" value={s.nodes} min={1} step={1} onChange={set("nodes")} hint="The recipe: 8 nodes of 8 H100." />
        <NumberField id={`${id}-gpn`} label="GPUs per node" value={s.gpusPerNode} min={1} step={1} onChange={set("gpusPerNode")} />
        <NumberField id={`${id}-ep`} label="ep_size (expert groups)" value={s.epSize} min={1} step={1} onChange={set("epSize")} />
        <NumberField id={`${id}-steps`} label="max_steps" value={s.maxSteps} min={1} step={50} onChange={set("maxSteps")} />
        <NumberField id={`${id}-len`} label="max_length" value={s.maxLength} min={128} step={256} onChange={set("maxLength")} />
        <NumberField id={`${id}-r`} label="LoRA r" value={s.rank} min={1} step={1} onChange={set("rank")} />
        <NumberField id={`${id}-a`} label="lora_alpha" value={s.alpha} min={1} step={1} onChange={set("alpha")} />
        <NumberField id={`${id}-save`} label="save_steps" value={s.saveSteps} min={1} step={10} onChange={set("saveSteps")} />
        <SegmentField<string> label="Data" value={s.dataset} options={[{ value: "tulu", label: "Tulu 3 SFT mixture" }, { value: "local", label: "My train.jsonl" }]} onChange={set("dataset")} />
      </div>
      <PlanView plan={plan} label="TRL commands" />
    </div>
  );
}

function MilesPanel() {
  const id = useId();
  const [o, setO] = useState<MilesOptions>(MILES_DEFAULTS);
  const [evalI, setEvalI] = useState("0");
  const [saveI, setSaveI] = useState("0");
  const opts: MilesOptions = { ...o, evalInterval: Math.max(0, Math.round(num(evalI, 0))), saveInterval: Math.max(0, Math.round(num(saveI, 0))) };
  const plan = useMemo(() => milesPlan(opts), [JSON.stringify(opts)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        <SegmentField<MilesOptions["mode"]>
          label="Mode"
          value={o.mode}
          options={[
            { value: "math", label: "Math reasoning (DAPO-Math-17k)" },
            { value: "vlm", label: "Image-grounded math (--vlm)" },
          ]}
          onChange={(mode) => {
            // Each mode starts at the page's own command: --vlm with the dynamic sampling filter, --reasoning-effort
            // medium and --eval-interval 5; math reasoning with none of them (xhigh, no eval).
            setO((c) => ({ ...c, mode, effort: mode === "vlm" ? "medium" : "xhigh", dynamicFilter: mode === "vlm" }));
            setEvalI(mode === "vlm" ? "5" : "0");
          }}
        />
        <SegmentField<MilesOptions["effort"]> label="--reasoning-effort" value={o.effort} options={(["low", "medium", "high", "xhigh"] as const).map((e) => ({ value: e, label: e }))} onChange={(effort) => setO((c) => ({ ...c, effort }))} />
        <NumberField id={`${id}-eval`} label="--eval-interval (0 for none)" value={evalI} min={0} step={1} onChange={setEvalI} />
        <NumberField id={`${id}-save`} label="--save-interval (0 for none)" value={saveI} min={0} step={5} onChange={setSaveI} />
        {opts.saveInterval > 0 ? (
          <Field id={`${id}-run`} label="--run-id">
            <TextInput id={`${id}-run`} value={o.runId} onChange={(e) => setO((c) => ({ ...c, runId: e.target.value }))} spellCheck={false} />
          </Field>
        ) : null}
        <div className="pg-field">
          <Toggle id={`${id}-dyn`} label="--use-dynamic-sampling-filter" checked={o.dynamicFilter || o.mode === "vlm"} onChange={(dynamicFilter) => setO((c) => ({ ...c, dynamicFilter }))} />
          <Toggle id={`${id}-muon`} label="--optimizer muon (state in CPU memory)" checked={o.optimizer === "muon"} onChange={(on) => setO((c) => ({ ...c, optimizer: on ? "muon" : "adam" }))} />
          <Toggle id={`${id}-data`} label="My own prompts (--prompt-data)" checked={o.customData} onChange={(customData) => setO((c) => ({ ...c, customData }))} />
        </div>
        {o.customData ? (
          <Field id={`${id}-path`} label="Prompt JSONL path">
            <TextInput id={`${id}-path`} value={o.dataPath} onChange={(e) => setO((c) => ({ ...c, dataPath: e.target.value }))} spellCheck={false} />
          </Field>
        ) : null}
      </div>
      <PlanView plan={plan} label="Miles commands" />
    </div>
  );
}

function FireworksPanel() {
  const id = useId();
  const [o, setO] = useState<FireworksOptions>(FIREWORKS_DEFAULTS);
  const [rank, setRank] = useState(String(FIREWORKS_DEFAULTS.rank));
  const opts = { ...o, rank: Math.round(num(rank, 0)) };
  const plan = useMemo(() => fireworksPlan(opts), [JSON.stringify(opts)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        <NumberField id={`${id}-rank`} label="LoRA rank (up to 64)" value={rank} min={1} max={64} step={1} onChange={setRank} />
        <Field id={`${id}-out`} label="output_model_id" hint="1 to 63 lowercase letters, digits and hyphens.">
          <TextInput id={`${id}-out`} value={o.outputModelId} onChange={(e) => setO((c) => ({ ...c, outputModelId: e.target.value }))} spellCheck={false} aria-describedby={`${id}-out-hint`} />
        </Field>
        <Field id={`${id}-name`} label="save_weights_for_sampler name" hint="17 characters or fewer.">
          <TextInput id={`${id}-name`} value={o.samplerName} onChange={(e) => setO((c) => ({ ...c, samplerName: e.target.value }))} spellCheck={false} aria-describedby={`${id}-name-hint`} />
        </Field>
      </div>
      <PlanView plan={plan} label="Fireworks steps" />
    </div>
  );
}

function MorePanel() {
  const rows = [
    {
      name: "TorchTitan: SFT with LoRA",
      what: "muse_spark_816b_a42b_ultradata_lora_sft_cp16_128k: a rank-8 LoRA adapter on agent conversations at a 131,072-token context, on 16 GB300 GPUs.",
      href: "/docs/cookbook/muse-spark-open-torchtitan-sft",
      link: "Full-parameter SFT recipe",
    },
    {
      name: "TorchTitan: RL with DAPO",
      what: "muse_spark_816b_a42b_dapo_math_gb300_config: math reasoning with vLLM rollouts on 256 trainer GPUs plus 16 generator GPUs, on separate hosts.",
      href: "/docs/cookbook/muse-spark-open-torchtitan-rl",
      link: "RL recipe",
    },
    { name: "NVIDIA NeMo AutoModel", what: "Full-parameter SFT and LoRA on PyTorch DTensor, loading Hugging Face checkpoints directly with no conversion.", href: "https://github.com/NVIDIA-NeMo/Automodel/blob/main/docs/model-coverage/vlm/meta-models/muse_spark_open.mdx", link: "Muse Spark Open guide" },
    { name: "NVIDIA Megatron Bridge", what: "Megatron-based training that converts checkpoints to and from Hugging Face format.", href: "https://github.com/NVIDIA-NeMo/Megatron-Bridge/tree/main/examples/models/muse_spark_open", link: "Muse Spark Open example" },
    { name: "Together AI (preview)", what: "SFT and GRPO quickstarts from Together's post-training cookbook, with meta-models/Muse-Spark-Open-816B-A42B as the base model and TOGETHER_API_KEY exported.", href: "https://docs.together.ai/docs/post-training/quickstart-rl", link: "GRPO quickstart" },
  ];
  return (
    <div className={styles.cards}>
      {rows.map((r) => (
        <article key={r.name} className={styles.card}>
          <h4 className={styles.cardTitle}>{r.name}</h4>
          <p className={styles.cardText}>{r.what}</p>
          <a className={styles.cardLink} href={r.href} {...(r.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {r.link}
          </a>
        </article>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

type GlimmerTab = "axolotl" | "trl" | "rl" | "memory" | "grpo" | "data";

function GlimmerTraining() {
  const id = useId();
  const [tab, setTab] = useState<GlimmerTab>("axolotl");
  return (
    <div className="pg">
      <Tabs
        label="Framework"
        idBase={id}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "axolotl", label: "Axolotl" },
          { id: "trl", label: "TRL SFT" },
          { id: "rl", label: "RL recipes" },
          { id: "memory", label: "GPU memory" },
          { id: "grpo", label: "GRPO, live" },
          { id: "data", label: "Check rows" },
        ]}
      />
      <TabPanel idBase={id} id="axolotl" active={tab === "axolotl"}>
        <AxolotlPanel />
      </TabPanel>
      <TabPanel idBase={id} id="trl" active={tab === "trl"}>
        <GlimmerTrlPanel />
      </TabPanel>
      <TabPanel idBase={id} id="rl" active={tab === "rl"}>
        <GlimmerRlPanel />
      </TabPanel>
      <TabPanel idBase={id} id="memory" active={tab === "memory"}>
        <MemoryPanel />
      </TabPanel>
      <TabPanel idBase={id} id="grpo" active={tab === "grpo"}>
        <GrpoLab slug="muse-glimmer/post-training" page="glimmer" />
      </TabPanel>
      <TabPanel idBase={id} id="data" active={tab === "data"}>
        <DatasetCheck formats={["axolotl", "chat", "dpo", "grpo"]} />
      </TabPanel>
    </div>
  );
}

function AxolotlPanel() {
  const id = useId();
  const [o, setO] = useState<AxolotlOptions>(AXOLOTL_DEFAULTS);
  const [gpus, setGpus] = useState("8");
  const opts = { ...o, gpus: Math.max(1, Math.round(num(gpus, 8))) };
  const plan = useMemo(() => axolotlPlan(opts), [JSON.stringify(opts)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        <SegmentField<AxolotlOptions["config"]>
          label="Config"
          value={o.config}
          options={[
            { value: "qlora", label: "QLoRA (start here)" },
            { value: "lora-fsdp2", label: "bf16 LoRA, FSDP2" },
            { value: "full-fsdp2", label: "Full bf16, FSDP2" },
          ]}
          onChange={(config) => setO((c) => ({ ...c, config }))}
        />
        <NumberField id={`${id}-gpus`} label="GPUs (H100)" value={gpus} min={1} max={8} step={1} onChange={setGpus} />
        <SelectField
          id={`${id}-data`}
          label="Prepared data"
          value={o.dataset}
          options={[
            { value: "cosyn-circuit", label: "CoSyn-400K circuit (images)" },
            { value: "tulu", label: "Tulu 3 SFT Personas (text)" },
            { value: "docmatix", label: "Docmatix (multi-image)" },
          ]}
          onChange={(x) => setO((c) => ({ ...c, dataset: x as AxolotlOptions["dataset"] }))}
        />
        <div className="pg-field">
          <Toggle id={`${id}-smoke`} label="Smoke run first (2 steps)" checked={o.smoke} onChange={(smoke) => setO((c) => ({ ...c, smoke }))} />
          <Toggle id={`${id}-sd`} label="Smoke-sized data (16 per split)" checked={o.smokeData} onChange={(smokeData) => setO((c) => ({ ...c, smokeData }))} />
        </div>
      </div>
      <PlanView plan={plan} label="Axolotl commands" />
    </div>
  );
}

function GlimmerTrlPanel() {
  const id = useId();
  const [method, setMethod] = useState<"lora" | "qlora">("lora");
  const [s, setS] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(GLIMMER_TRL_DEFAULTS.lora).map(([k, v]) => [k, String(v)])));
  const pickMethod = (m: "lora" | "qlora") => {
    setMethod(m);
    setS(Object.fromEntries(Object.entries(GLIMMER_TRL_DEFAULTS[m]).map(([k, v]) => [k, String(v)])));
  };
  const d = GLIMMER_TRL_DEFAULTS[method];
  const o: GlimmerTrlOptions = {
    method,
    rank: Math.max(1, Math.round(num(s.rank, d.rank))),
    alpha: Math.max(1, Math.round(num(s.alpha, d.alpha))),
    lr: num(s.lr, d.lr),
    epochs: Math.max(1, Math.round(num(s.epochs, d.epochs))),
    batch: Math.max(1, Math.round(num(s.batch, d.batch))),
    gradAcc: Math.max(1, Math.round(num(s.gradAcc, d.gradAcc))),
  };
  const plan = useMemo(() => glimmerTrl(o), [JSON.stringify(o)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (v: string) => setS((c) => ({ ...c, [k]: v }));
  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        <SegmentField<"lora" | "qlora"> label="Method" value={method} options={[{ value: "lora", label: "LoRA" }, { value: "qlora", label: "QLoRA (4-bit base)" }]} onChange={pickMethod} />
        <NumberField id={`${id}-r`} label="LoRA r" value={s.rank} min={1} step={1} onChange={set("rank")} hint="8 to 32" />
        <NumberField id={`${id}-a`} label="lora_alpha" value={s.alpha} min={1} step={1} onChange={set("alpha")} hint="2 × rank" />
        <NumberField id={`${id}-lr`} label="learning_rate" value={s.lr} step={0.00001} onChange={set("lr")} hint="1e-4 to 3e-4" />
        <NumberField id={`${id}-ep`} label="num_train_epochs" value={s.epochs} min={1} step={1} onChange={set("epochs")} hint="2 to 5" />
        <NumberField id={`${id}-b`} label="per_device_train_batch_size" value={s.batch} min={1} step={1} onChange={set("batch")} />
        <NumberField id={`${id}-ga`} label="gradient_accumulation_steps" value={s.gradAcc} min={1} step={1} onChange={set("gradAcc")} hint="Effective batch 4 to 16" />
      </div>
      <PlanView plan={plan} label="TRL code" />
    </div>
  );
}

function GlimmerRlPanel() {
  const id = useId();
  const [method, setMethod] = useState<"titanrl" | "dpo" | "grpo">("titanrl");
  const [titan, setTitan] = useState<TitanRlOptions>(TITANRL_DEFAULTS);
  const [tiers, setTiers] = useState<Record<string, string>>({ malformed: String(ANALYST_TIERS.malformed), wrongNumber: String(ANALYST_TIERS.wrongNumber), repeatPenalty: String(ANALYST_TIERS.repeatPenalty) });
  const [genTp, setGenTp] = useState("2");
  const [dpo, setDpo] = useState<Record<keyof DpoOptions, string>>(() => Object.fromEntries(Object.entries(DPO_DEFAULTS).map(([k, v]) => [k, String(v)])) as Record<keyof DpoOptions, string>);
  const [grpo, setGrpo] = useState<Record<keyof GrpoOptions, string>>(() => Object.fromEntries(Object.entries(GRPO_DEFAULTS).map(([k, v]) => [k, String(v)])) as Record<keyof GrpoOptions, string>);

  const plan = useMemo(() => {
    if (method === "titanrl") {
      return titanRlPlan({
        ...titan,
        generatorTp: Math.max(1, Math.round(num(genTp, 2))),
        tiers: { ...ANALYST_TIERS, malformed: num(tiers.malformed, ANALYST_TIERS.malformed), wrongNumber: num(tiers.wrongNumber, ANALYST_TIERS.wrongNumber), repeatPenalty: num(tiers.repeatPenalty, ANALYST_TIERS.repeatPenalty) },
      });
    }
    if (method === "dpo") return dpoPlan({ beta: num(dpo.beta, 0.1), lr: num(dpo.lr, 5e-7), batch: Math.round(num(dpo.batch, 2)), gradAcc: Math.round(num(dpo.gradAcc, 8)), epochs: Math.round(num(dpo.epochs, 1)) });
    return grpoPlan({ lr: num(grpo.lr, 1e-6), numGenerations: Math.round(num(grpo.numGenerations, 8)), maxCompletion: Math.round(num(grpo.maxCompletion, 4096)) });
  }, [method, titan, tiers, genTp, dpo, grpo]);

  return (
    <div className={styles.stack}>
      <SegmentField<"titanrl" | "dpo" | "grpo">
        label="Method"
        value={method}
        options={[
          { value: "titanrl", label: "TitanRL: GRPO, graded reward" },
          { value: "dpo", label: "TRL DPO: preference pairs" },
          { value: "grpo", label: "TRL GRPO: programmatic reward" },
        ]}
        onChange={setMethod}
      />
      {method === "titanrl" ? (
        <div className={styles.options}>
          <SegmentField<"smoke" | "full"> label="Config" value={titan.run} options={[{ value: "smoke", label: "Smoke (10 steps)" }, { value: "full", label: "Full" }]} onChange={(run) => setTitan((c) => ({ ...c, run }))} />
          <NumberField id={`${id}-tp`} label="Generator tensor parallel" value={genTp} min={1} max={8} step={1} onChange={setGenTp} hint="Two KV heads cap it at 2." />
          <NumberField id={`${id}-fe`} label="file_exists_credit (malformed file)" value={tiers.malformed} step={0.05} min={0} max={1} onChange={(v) => setTiers((c) => ({ ...c, malformed: v }))} />
          <NumberField id={`${id}-fp`} label="file_parses_credit (wrong number)" value={tiers.wrongNumber} step={0.05} min={0} max={1} onChange={(v) => setTiers((c) => ({ ...c, wrongNumber: v }))} />
          <NumberField id={`${id}-pen`} label="repeated_failing_command_penalty" value={tiers.repeatPenalty} step={0.01} min={0} max={1} onChange={(v) => setTiers((c) => ({ ...c, repeatPenalty: v }))} />
        </div>
      ) : null}
      {method === "dpo" ? (
        <div className={styles.options}>
          <NumberField id={`${id}-beta`} label="beta" value={dpo.beta} step={0.05} min={0} onChange={(v) => setDpo((c) => ({ ...c, beta: v }))} hint="0.1 to 0.5" />
          <NumberField id={`${id}-dlr`} label="learning_rate" value={dpo.lr} step={0.0000001} min={0} onChange={(v) => setDpo((c) => ({ ...c, lr: v }))} hint="1e-7 to 1e-6" />
          <NumberField id={`${id}-db`} label="per_device_train_batch_size" value={dpo.batch} step={1} min={1} onChange={(v) => setDpo((c) => ({ ...c, batch: v }))} />
          <NumberField id={`${id}-dga`} label="gradient_accumulation_steps" value={dpo.gradAcc} step={1} min={1} onChange={(v) => setDpo((c) => ({ ...c, gradAcc: v }))} />
          <NumberField id={`${id}-de`} label="num_train_epochs" value={dpo.epochs} step={1} min={1} onChange={(v) => setDpo((c) => ({ ...c, epochs: v }))} hint="1 to 2" />
        </div>
      ) : null}
      {method === "grpo" ? (
        <div className={styles.options}>
          <NumberField id={`${id}-glr`} label="learning_rate" value={grpo.lr} step={0.0000001} min={0} onChange={(v) => setGrpo((c) => ({ ...c, lr: v }))} hint="1e-6 to 3e-6" />
          <NumberField id={`${id}-ng`} label="num_generations (group size)" value={grpo.numGenerations} step={1} min={2} onChange={(v) => setGrpo((c) => ({ ...c, numGenerations: v }))} hint="4 to 16" />
          <NumberField id={`${id}-mcl`} label="max_completion_length" value={grpo.maxCompletion} step={512} min={256} onChange={(v) => setGrpo((c) => ({ ...c, maxCompletion: v }))} hint="Room for the reasoning trace" />
        </div>
      ) : null}
      <PlanView plan={plan} label="RL code" />
    </div>
  );
}

const GPU_MEM = [
  { value: "80", label: "H100 80 GB" },
  { value: "95", label: "H100 95 GB" },
  { value: "141", label: "H200 141 GB" },
  { value: "192", label: "B200 192 GB" },
  { value: "288", label: "B300 288 GB" },
];

function MemoryPanel() {
  const id = useId();
  const [shards, setShards] = useState("8");
  const [mem, setMem] = useState("80");
  const nShards = Math.max(1, Math.round(num(shards, 8)));
  const m = fullParamMemory(nShards);
  const memGb = Number(mem);
  const left = memGb - m.total;
  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        <NumberField id={`${id}-n`} label="GPUs the model is sharded over (N)" value={shards} min={1} max={512} step={1} onChange={setShards} />
        <SelectField id={`${id}-mem`} label="GPU" value={mem} options={GPU_MEM} onChange={setMem} />
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Parameter state per GPU for full-parameter bf16 training</caption>
          <thead>
            <tr>
              <th scope="col">Per GPU at 30B</th>
              <th scope="col" className={styles.num}>
                Formula
              </th>
              <th scope="col" className={styles.num}>
                At N = {nShards}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>bf16 weights</td>
              <td className={styles.num}>60 GB / N</td>
              <td className={styles.num}>{m.weights.toFixed(1)} GB</td>
            </tr>
            <tr>
              <td>bf16 gradients</td>
              <td className={styles.num}>60 GB / N</td>
              <td className={styles.num}>{m.grads.toFixed(1)} GB</td>
            </tr>
            <tr>
              <td>fp32 Adam state (m and v)</td>
              <td className={styles.num}>240 GB / N</td>
              <td className={styles.num}>{m.adam.toFixed(1)} GB</td>
            </tr>
            <tr>
              <td>
                <strong>Parameter state</strong>
              </td>
              <td className={styles.num}>360 GB / N</td>
              <td className={styles.num}>
                <strong>{m.total.toFixed(1)} GB</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Status tone={left < 0 ? "bad" : left < memGb * 0.35 ? "warn" : "ok"}>
        {left < 0
          ? `Parameter state alone is ${m.total.toFixed(1)} GB per GPU, more than ${memGb} GB: shard over more GPUs, or use LoRA or QLoRA.`
          : `${m.total.toFixed(1)} GB of parameter state per GPU leaves ${left.toFixed(1)} GB for activations, temporary buffers${" "}and, for RL, the generator.`}
      </Status>
      <Issues
        warnings={["Size memory for the step after the first optimizer.step(): Adam allocates its state on the first step, so a run that looks comfortable during step 1 can fail right after."]}
        notes={[
          "These figures leave out activations, temporary buffers, and the generator that RL keeps loaded.",
          "QLoRA keeps a 4-bit frozen base plus adapters, LoRA a bf16 base plus adapters: both far below full-parameter state. Axolotl's full FSDP2 run peaked at 97,340 MiB per H100 while consolidating its checkpoint.",
        ]}
      />
    </div>
  );
}
