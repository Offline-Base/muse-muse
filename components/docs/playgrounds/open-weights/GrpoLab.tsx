"use client";

import { useId, useMemo, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, PresetPills, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { RunButton } from "@/components/docs/kit/RunButton";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { tokenUsage, estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";
import type { DocsError } from "@/lib/docs/client/api";
import {
  ANALYST_LABELS,
  ANALYST_TIERS,
  MATH_PROBLEMS,
  SCHEME_LABEL,
  SCHEME_SOURCE,
  answerTagContent,
  grpoAdvantages,
  lastBoxed,
  promptFor,
  readGroup,
  rewardAnalyst,
  score,
  type AnalystOutcome,
  type RewardScheme,
  type Scored,
} from "@/components/docs/playgrounds/open-weights/rewards";
import { RL_DEFAULTS, rlPlan, type RlOptions } from "@/components/docs/playgrounds/open-weights/torchtitan";
import { Issues, NumberField, SegmentField, StandInBanner, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * GRPO's learning signal, hands on (cookbook/muse-spark-open-torchtitan-rl, and the RL sections of the post-training
 * pages): sample a group of answers to one prompt on hosted Muse Spark (a stand-in for the policy's rollouts, not the
 * open-weight model), score each with the recipe's reward, and see the group-relative advantages, including the
 * all-equal groups that teach nothing. A reward playground scores any reply by hand, and on the TorchTitan page a
 * recipe builder writes with_task, the bring-up and the longer run.
 */

export interface GrpoLabProps {
  slug: string;
  /** Which page: the TorchTitan recipe (boxed and exact rewards, the recipe builder) or Muse Glimmer's RL sections. */
  page: "torchtitan-rl" | "glimmer";
}

interface Sample {
  text: string;
  finish: string | null;
  scored: Scored;
  error: DocsError | null;
  outputTokens: number;
}

const BATCH = 4;

export function GrpoLab({ page }: GrpoLabProps) {
  const id = useId();
  const tabs =
    page === "torchtitan-rl"
      ? [
          { id: "group" as const, label: "Score a group live" },
          { id: "reward" as const, label: "Reward playground" },
          { id: "recipe" as const, label: "Recipe builder" },
        ]
      : [
          { id: "group" as const, label: "Score a group live" },
          { id: "reward" as const, label: "Reward playground" },
        ];
  const [tab, setTab] = useState<"group" | "reward" | "recipe">("group");
  return (
    <div className="pg">
      <Tabs label="GRPO" idBase={id} value={tab} onChange={setTab} tabs={tabs} />
      <TabPanel idBase={id} id="group" active={tab === "group"}>
        <GroupRun schemes={page === "torchtitan-rl" ? ["boxed", "exact"] : ["boxed", "answerMatch", "answerTag"]} />
      </TabPanel>
      <TabPanel idBase={id} id="reward" active={tab === "reward"}>
        <RewardPlayground schemes={page === "torchtitan-rl" ? ["boxed", "exact"] : ["graded", "answerTag", "answerMatch"]} />
      </TabPanel>
      {page === "torchtitan-rl" ? (
        <TabPanel idBase={id} id="recipe" active={tab === "recipe"}>
          <RlRecipe />
        </TabPanel>
      ) : null}
    </div>
  );
}

function GroupRun({ schemes }: { schemes: RewardScheme[] }) {
  const id = useId();
  const runners = [useDocsRun(), useDocsRun(), useDocsRun(), useDocsRun()];
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [scheme, setScheme] = useState<RewardScheme>(schemes[0]);
  const [problemIndex, setProblemIndex] = useState<number | null>(0);
  const [problem, setProblem] = useState<string>(MATH_PROBLEMS[0].problem);
  const [answer, setAnswer] = useState<string>(MATH_PROBLEMS[0].answer);
  const [k, setK] = useState("4");
  const [maxTokens, setMaxTokens] = useState(String(MATH_PROBLEMS[0].budget));
  const [samples, setSamples] = useState<Sample[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const count = Math.max(2, Math.min(8, Math.round(Number(k) || 4)));
  const budget = Math.max(64, Math.min(16384, Math.round(Number(maxTokens) || 1200)));
  const prompt = promptFor(scheme, problem);
  const body = { model, messages: [{ role: "user", content: prompt }], reasoning_effort: "low", max_tokens: budget, temperature: 1.0 };

  const run = async () => {
    if (busy || !problem.trim()) return;
    setBusy(true);
    setStopped(false);
    setSamples([]);
    const done: Sample[] = [];
    for (let start = 0; start < count; start += BATCH) {
      const slice = Array.from({ length: Math.min(BATCH, count - start) }, (_, j) => j);
      const results = await Promise.all(slice.map((j) => runners[j].run("chat/completions", { method: "POST", body, record: start + j === 0 ? undefined : false })));
      for (const res of results) {
        if (res.error?.code === "aborted") {
          setStopped(true);
          continue;
        }
        const reply = res.ok ? collectReply("chat", res.json) : null;
        const text = reply?.text ?? "";
        done.push({
          text,
          finish: reply?.finishReason ?? null,
          scored: res.ok ? score(scheme, text, answer) : { reward: 0, why: "The request failed." },
          error: res.ok ? null : res.error,
          outputTokens: tokenUsage(reply?.usage ?? null)?.output ?? 0,
        });
      }
      setSamples([...done]);
      if (results.some((r) => r.error?.code === "aborted")) break;
    }
    setBusy(false);
  };

  const stop = () => runners.forEach((r) => r.abort());
  const ok = samples.filter((s) => !s.error);
  const stats = grpoAdvantages(ok.map((s) => s.scored.reward));
  const reading = readGroup(ok.map((s) => ({ reward: s.scored.reward, finish: s.finish })));
  const status = groupStatus(stats, reading, ok[0]?.scored.reward ?? 0);
  const firstError = samples.find((s) => s.error)?.error ?? null;
  const cost = samples.reduce((sum, s) => sum + (estimateCost(model, { prompt_tokens: 60, completion_tokens: s.outputTokens })?.usd ?? 0), 0);

  return (
    <div className={styles.stack}>
      <StandInBanner>
        Stand-in: the group is sampled from hosted Muse Spark through Model API (temperature 1.0, low reasoning), not from the policy you&apos;d train. GRPO scores each sample and learns from the
        differences within the group.
      </StandInBanner>
      <PresetPills
        presets={MATH_PROBLEMS}
        active={problemIndex}
        onPick={(i) => {
          setProblemIndex(i);
          setProblem(MATH_PROBLEMS[i].problem);
          setAnswer(MATH_PROBLEMS[i].answer);
          setMaxTokens(String(MATH_PROBLEMS[i].budget));
        }}
        label="Problem"
        disabled={busy}
      />
      <div className={styles.options}>
        <Field id={`${id}-problem`} label="Prompt" className={styles.optionWide}>
          <TextArea
            id={`${id}-problem`}
            rows={2}
            value={problem}
            onChange={(e) => {
              setProblemIndex(null);
              setProblem(e.target.value);
            }}
          />
        </Field>
        <Field id={`${id}-answer`} label="Reference answer">
          <TextInput id={`${id}-answer`} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <NumberField id={`${id}-k`} label="Samples in the group" value={k} min={2} max={8} step={1} onChange={setK} hint="The recipe samples 8 per prompt." />
        <NumberField id={`${id}-max`} label="max_tokens per sample" value={maxTokens} min={64} max={16384} step={100} onChange={setMaxTokens} hint="The token budget: too small and rollouts truncate." />
      </div>
      <SegmentField<RewardScheme> label="Reward" value={scheme} options={schemes.map((s) => ({ value: s, label: SCHEME_LABEL[s] }))} onChange={setScheme} disabled={busy} hint={SCHEME_SOURCE[scheme]} />
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <RunButton running={busy} onRun={() => void run()} onStop={stop} label={`Sample ${count}`} disabled={!problem.trim()} />
        <span className="pg-hint">Each sample is one request (Chat Completions takes n=1). About {formatUsd(estimateCost(model, { prompt_tokens: 60 * count, completion_tokens: budget * count })?.usd ?? 0)} at most.</span>
      </div>
      {samples.length ? (
        <>
          <Status tone={status.tone}>{status.text}</Status>
          <div className={styles.tableWrap} aria-live="polite">
            <table className={styles.table}>
              <caption className="sr-only">The sampled group, scored</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Answer</th>
                  <th scope="col">finish_reason</th>
                  <th scope="col" className={styles.num}>
                    Reward
                  </th>
                  <th scope="col" className={styles.num}>
                    Advantage
                  </th>
                </tr>
              </thead>
              <tbody>
                {samples.map((s, i) => {
                  const okIndex = ok.indexOf(s);
                  const adv = okIndex >= 0 ? stats.advantages[okIndex] : null;
                  const shown = scheme === "boxed" ? lastBoxed(s.text) : scheme === "answerTag" || scheme === "answerMatch" ? answerTagContent(s.text) : s.text.trim().slice(0, 60);
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>
                        <details>
                          <summary className={styles.mono}>{s.error ? "Failed" : shown ?? "(none)"}</summary>
                          <p className="pg-small" style={{ whiteSpace: "pre-wrap" }}>
                            {s.error ? s.error.message : s.text || "(empty)"}
                          </p>
                          <p className="pg-small pg-muted">{s.scored.why}</p>
                        </details>
                      </td>
                      <td className={styles.mono}>{s.finish ?? "-"}</td>
                      <td className={styles.num}>{s.scored.reward}</td>
                      <td className={styles.num}>{adv === null ? "-" : adv.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="pg-hint">
            Advantage = (reward - group mean) / group standard deviation. Rollouts that hit the budget end with finish_reason length and usually score 0, which looks like the model failing.
            {cost > 0 ? ` This group cost about ${formatUsd(cost)}.` : ""}
          </p>
        </>
      ) : null}
      {stopped ? <p className="pg-muted">Stopped.</p> : null}
      <ErrorBox error={firstError} />
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body} caption="Each sample sends this request" /> : null}
    </div>
  );
}

/**
 * What the group teaches, in words: nothing when every reward is equal, a length penalty when every low score is a
 * rollout max_tokens cut off (the recipe budgets the trainer's whole context so that never happens), else the spread.
 */
function groupStatus(stats: ReturnType<typeof grpoAdvantages>, reading: ReturnType<typeof readGroup>, first: number): { tone: "ok" | "warn"; text: string } {
  if (stats.noSignal) {
    if (reading.allTruncated) {
      return {
        tone: "warn",
        text: `Every sample hit max_tokens (finish_reason length) and scored ${first}, so this group teaches nothing. Raise max_tokens: the recipe sets the budget to the trainer's whole context, so rollouts are never cut off.`,
      };
    }
    return { tone: "warn", text: `Every sample scored ${first}: no reward variance, so this group teaches nothing (Batcher drops it). GRPO needs prompts the model sometimes solves, or a graded reward.` };
  }
  if (reading.kind === "truncation") {
    const n = reading.truncatedLow;
    const them = n === 1 ? "the sample below the mean" : n === 2 ? "both samples below the mean" : `all ${n} samples below the mean`;
    return {
      tone: "warn",
      text: `This spread comes from truncation: ${them} hit max_tokens (finish_reason length) before answering, rather than answering wrong. GRPO would reinforce whichever answers happened to be short, a length penalty, not correctness. The recipe sets the budget to the trainer's whole context so rollouts are never cut off: raise max_tokens.`,
    };
  }
  const part = reading.truncatedLow ? ` ${reading.truncatedLow} of the ${reading.low} below the mean hit max_tokens, so part of this spread is a length penalty.` : "";
  return { tone: "ok", text: `Mean reward ${stats.mean.toFixed(2)}, standard deviation ${stats.std.toFixed(2)}: samples above the mean are reinforced, those below pushed down.${part}` };
}

function RewardPlayground({ schemes }: { schemes: RewardScheme[] }) {
  const id = useId();
  const [scheme, setScheme] = useState<RewardScheme>(schemes[0]);
  const [reply, setReply] = useState("The pairs split by residues mod 5... so |S| = 36 + 288.\n\nAnswer: \\boxed{324}");
  const [answer, setAnswer] = useState("324");
  const [outcome, setOutcome] = useState<AnalystOutcome>("wrongNumber");
  const [repeats, setRepeats] = useState("1");
  const group: AnalystOutcome[] = ["correct", "wrongNumber", "malformed", "ranCommand", "nothing"];
  const graded = scheme === "graded";
  const result = graded ? rewardAnalyst(outcome, Math.max(0, Math.round(Number(repeats) || 0))) : score(scheme, reply, answer);
  const groupStats = useMemo(() => grpoAdvantages(group.map((o) => rewardAnalyst(o, 0).reward)), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.stack}>
      <SegmentField<RewardScheme> label="Reward" value={scheme} options={schemes.map((s) => ({ value: s, label: SCHEME_LABEL[s] }))} onChange={setScheme} hint={SCHEME_SOURCE[scheme]} />
      {graded ? (
        <>
          <div className={styles.options}>
            <SegmentField<AnalystOutcome> label="What the rollout did" value={outcome} options={group.map((o) => ({ value: o, label: ANALYST_LABELS[o] }))} onChange={setOutcome} />
            <NumberField id={`${id}-rep`} label="Repeats of an already-failed command" value={repeats} min={0} max={20} step={1} onChange={setRepeats} hint="Each costs 0.05." />
          </div>
          <Status tone={result.reward >= 1 ? "ok" : result.reward > 0 ? "warn" : "bad"}>
            Reward {result.reward}: {result.why}
          </Status>
          <p className="pg-hint">
            The tiers rank a partly competent attempt above one that makes no progress, with a correct answer strictly on top. One rollout of each tier gives advantages{" "}
            {groupStats.advantages.map((a) => a.toFixed(2)).join(", ")}: every attempt is told apart, where a 0 or 1 reward would lump the four failures together.
          </p>
          <Issues
            notes={[
              `The page's tiers: ${group.map((o) => `${ANALYST_LABELS[o].toLowerCase()} ${ANALYST_TIERS[o]}`).join("; ")}; each repeat of a failed command -0.05.`,
              "Set file_exists_credit=0.0 and file_parses_credit=0.0 in rubric.py for a strict 0 or 1 reward, or raise repeated_failing_command_penalty.",
            ]}
          />
        </>
      ) : (
        <>
          <Field id={`${id}-reply`} label="A rollout's reply">
            <TextArea id={`${id}-reply`} rows={4} value={reply} onChange={(e) => setReply(e.target.value)} className="pg-code-input" />
          </Field>
          {scheme !== "answerTag" ? (
            <Field id={`${id}-ans`} label="Reference answer">
              <TextInput id={`${id}-ans`} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            </Field>
          ) : null}
          <Status tone={result.reward >= 1 ? "ok" : "bad"}>
            Reward {result.reward}: {result.why}
          </Status>
          {scheme === "boxed" ? <p className="pg-hint">A simplified check: Math-Verify, which the recipe uses, also accepts equivalent forms this playground may not.</p> : null}
          {scheme === "answerTag" ? <p className="pg-hint">The page's example rewards a parseable final answer, not a correct one: replace it with your task&apos;s verifiable reward.</p> : null}
        </>
      )}
    </div>
  );
}

function RlRecipe() {
  const id = useId();
  const [o, setO] = useState<RlOptions>(RL_DEFAULTS);
  const plan = useMemo(() => rlPlan(o), [o]);
  const set = <K extends keyof RlOptions>(k: K, v: RlOptions[K]) => setO((cur) => ({ ...cur, [k]: v }));
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() ? Math.round(Number(v)) : fallback);
  return (
    <div className={styles.stack}>
      <SegmentField<RlOptions["run"]>
        label="Run"
        value={o.run}
        options={[
          { value: "bringup", label: "DAPO-Math bring-up" },
          { value: "template", label: "The QA template" },
          { value: "custom", label: "Your own task" },
          { value: "longer", label: "A longer run" },
        ]}
        onChange={(x) => set("run", x)}
      />
      {o.run === "custom" ? (
        <div className={styles.options}>
          <Field id={`${id}-train`} label="train_path">
            <TextInput id={`${id}-train`} value={o.trainPath} onChange={(e) => set("trainPath", e.target.value)} spellCheck={false} />
          </Field>
          <Field id={`${id}-val`} label="validation_path">
            <TextInput id={`${id}-val`} value={o.valPath} onChange={(e) => set("valPath", e.target.value)} spellCheck={false} />
          </Field>
        </div>
      ) : null}
      {o.run === "longer" ? (
        <div className={styles.options}>
          <NumberField id={`${id}-steps`} label="num_training_steps" value={o.steps} min={1} step={10} onChange={(v) => set("steps", num(v, 150))} />
          <NumberField id={`${id}-off`} label="target_offpolicy_steps" value={o.offpolicy} min={0} step={1} onChange={(v) => set("offpolicy", num(v, 4))} hint="Overlaps generation and training." />
          <NumberField id={`${id}-valsteps`} label="ValidationConfig(steps=...)" value={o.validationSteps} min={1} step={5} onChange={(v) => set("validationSteps", num(v, 30))} />
          <NumberField id={`${id}-ckpt`} label="Checkpoint interval" value={o.ckptInterval} min={1} step={10} onChange={(v) => set("ckptInterval", num(v, 50))} />
          <NumberField id={`${id}-keep`} label="keep_latest_k" value={o.keepLatest} min={1} step={1} onChange={(v) => set("keepLatest", num(v, 3))} />
        </div>
      ) : null}
      <Issues warnings={plan.warnings} notes={plan.notes} />
      <Steps steps={plan.steps} label="RL recipe" />
    </div>
  );
}
