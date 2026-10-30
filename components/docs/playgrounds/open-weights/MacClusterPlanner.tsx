"use client";

import { useId, useMemo, useState } from "react";
import { Field, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { MAC_DEFAULTS, defaultHosts, macPlan, macSummary } from "@/components/docs/playgrounds/open-weights/mac";
import { gb } from "@/components/docs/playgrounds/open-weights/facts";
import { StandIn } from "@/components/docs/playgrounds/open-weights/StandIn";
import { Issues, NumberField, SegmentField, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The Mac Studio recipe (cookbook/muse-spark-open-mac) as a cluster planner: two Macs with 512 GB or four with 256 GB,
 * your host names, the Thunderbolt 5 links every pair needs, each Mac's share of the NVFP4 weights, a checklist of the
 * prerequisites, and the SSH, install and mlx.launch commands with your settings. A second tab runs the generate
 * prompt on hosted Muse Spark as a stand-in.
 */

export interface MacClusterPlannerProps {
  slug: string;
}

export function MacClusterPlanner(_props: MacClusterPlannerProps) {
  const id = useId();
  const [tab, setTab] = useState<"plan" | "live">("plan");
  const [macs, setMacs] = useState<2 | 4>(4);
  const [hosts, setHosts] = useState<string[]>(defaultHosts(4));
  const [doubled, setDoubled] = useState(true);
  const [prompt, setPrompt] = useState(MAC_DEFAULTS.prompt);
  const [maxTokens, setMaxTokens] = useState("4096");
  const [temp, setTemp] = useState("1.0");
  const [topP, setTopP] = useState("1.0");
  const [done, setDone] = useState<Record<number, boolean>>({});

  const plan = useMemo(
    () =>
      macPlan({
        macs,
        hosts,
        doubleCables: doubled,
        prompt,
        maxTokens: Math.max(1, Math.round(Number(maxTokens) || 4096)),
        temp: Number.isFinite(Number(temp)) && temp.trim() ? Number(temp) : 1,
        topP: Number.isFinite(Number(topP)) && topP.trim() ? Number(topP) : 1,
        port: 8080,
      }),
    [macs, hosts, doubled, prompt, maxTokens, temp, topP],
  );
  const messages = useMemo(() => [{ role: "user", content: prompt }], [prompt]);
  const setMacCount = (n: 2 | 4) => {
    setMacs(n);
    setHosts((cur) => defaultHosts(n).map((d, i) => cur[i] ?? d));
  };

  return (
    <div className="pg">
      <Tabs
        label="Mac cluster"
        idBase={id}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "plan", label: "Plan the cluster" },
          { id: "live", label: "Try the prompt" },
        ]}
      />
      <TabPanel idBase={id} id="plan" active={tab === "plan"}>
        <div className={styles.stack}>
          <div className={styles.options}>
            <SegmentField<"2" | "4">
              label="Mac Studios (M5 Ultra)"
              value={String(macs) as "2" | "4"}
              options={[
                { value: "2", label: "Two with 512 GB" },
                { value: "4", label: "Four with 256 GB (fastest)" },
              ]}
              onChange={(x) => setMacCount(x === "2" ? 2 : 4)}
            />
            <div className="pg-field pg-advanced">
              <Toggle id={`${id}-double`} label="Two cables per pair (double the bandwidth)" checked={doubled} onChange={setDoubled} />
            </div>
          </div>
          <fieldset className={`${styles.fieldGrid} pg-advanced`}>
            <legend className="pg-label" style={{ marginBottom: 6 }}>
              Host names (the first is the primary)
            </legend>
            {hosts.slice(0, macs).map((h, i) => (
              <Field key={i} id={`${id}-h${i}`} label={i === 0 ? "Primary" : `Mac ${i + 1}`}>
                <TextInput id={`${id}-h${i}`} value={h} onChange={(e) => setHosts((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} spellCheck={false} />
              </Field>
            ))}
          </fieldset>
          <Status tone={plan.warnings.length ? "warn" : "ok"}>{macSummary(plan, macs)}</Status>
          <div className={`${styles.grid2} pg-advanced`}>
            <div className={styles.card}>
              <h4 className={styles.cardTitle}>Thunderbolt 5 links</h4>
              <ul className={styles.chipList} aria-label="Links between the Macs">
                {plan.pairs.map(([a, b]) => (
                  <li key={`${a}-${b}`} className={styles.chip} style={{ paddingRight: 10 }}>
                    {a.replace(/\.local$/, "")} to {b.replace(/\.local$/, "")}
                    {doubled ? " ×2" : ""}
                  </li>
                ))}
              </ul>
              <p className="pg-hint">
                {macs === 4 ? "With four Macs, every Mac connects to each of the other three." : "Two Macs need one direct link."} jaccl uses RDMA over these links; the CPU drives Thunderbolt and the GPU computes.
              </p>
            </div>
            <div className={styles.card}>
              <h4 className={styles.cardTitle}>Memory and disk per Mac</h4>
              <div className={styles.meter} role="img" aria-label={`${gb(plan.shareGb)} of ${plan.memoryGb} GB`}>
                <div className={styles.meterFill} style={{ width: `${plan.sharePercent}%` }} />
              </div>
              <p className="pg-small">
                About {gb(plan.shareGb)} GB of weights of {plan.memoryGb} GB unified memory ({plan.sharePercent}%), the rest for the KV cache and activations. Each Mac loads its share from a full copy on its own disk (about {plan.diskPerMacGb} GB).
              </p>
            </div>
          </div>
          <fieldset className={`${styles.card} pg-advanced`} style={{ margin: 0 }}>
            <legend className="pg-label" style={{ padding: "0 4px" }}>
              Before you start
            </legend>
            {plan.checklist.map((item, i) => (
              <label key={item} className={styles.row} style={{ gap: 8, alignItems: "flex-start", flexWrap: "nowrap", fontSize: 14 }}>
                <input type="checkbox" checked={!!done[i]} onChange={(e) => setDone((d) => ({ ...d, [i]: e.target.checked }))} style={{ marginTop: 3 }} />
                <span style={{ textDecoration: done[i] ? "line-through" : undefined, color: done[i] ? "var(--muted)" : undefined }}>{item}</span>
              </label>
            ))}
          </fieldset>
          <div className={`${styles.options} pg-advanced`}>
            <Field id={`${id}-prompt`} label="Prompt for mlx_lm.generate" className={styles.optionWide}>
              <TextArea id={`${id}-prompt`} rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </Field>
            <NumberField id={`${id}-max`} label="--max-tokens" value={maxTokens} min={64} step={256} onChange={setMaxTokens} hint="The template defaults to xhigh: leave room." />
            <NumberField id={`${id}-temp`} label="--temp" value={temp} min={0} max={2} step={0.1} onChange={setTemp} hint="Recommended: 1.0" />
            <NumberField id={`${id}-topp`} label="--top-p" value={topP} min={0} max={1} step={0.05} onChange={setTopP} hint="Recommended: 1.0" />
          </div>
          <Issues warnings={plan.warnings} notes={["--backend jaccl selects RDMA over Thunderbolt. --env MLX_METAL_FAST_SYNCH=1 turns on an experimental MLX feature for fast CPU-GPU synchronization, which cuts communication overhead.", "Everything after -- is the program mlx.launch starts on each Mac over SSH."]} />
          <Steps steps={plan.steps} label="Mac cluster commands" />
        </div>
      </TabPanel>
      <TabPanel idBase={id} id="live" active={tab === "live"}>
        <StandIn standsFor="Muse Spark Open on your Macs" messages={messages} prompt={prompt} effort="low" maxTokens={1200} extra={{ temperature: 1.0, top_p: 1.0 }} reasoningField={null} />
      </TabPanel>
    </div>
  );
}
