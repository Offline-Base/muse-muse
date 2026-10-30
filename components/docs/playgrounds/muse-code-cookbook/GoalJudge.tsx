"use client";

import { useId, useMemo, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { PresetPills, Segmented, TextArea, TextInput } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { useStrictJson } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { gateCompletion, GOAL_PRESETS, GOAL_REMINDER, goalIndicator, PROBE_EVERY, remindersAfter, type GoalCheck, type Judgement } from "@/components/docs/playgrounds/muse-code-cookbook/logic/goal";
import { judgeBody } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { Chip, Section, ShowCode, Terminal, Verdict } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The goal-tracking recipe as a gate. Declare the objective and its acceptance checks (/goal), watch the status line
 * and the step probe, then hand the agent's completion report to a judge model that grades each check with a quote
 * from the report, as strict JSON. update_goal(status: "complete") goes through only when every check passes with
 * evidence the report contains: the completion audit, enforced in the page, never just the judge's word.
 */

export interface GoalJudgeProps {
  slug: string;
}

const STATUS_TONE = { pass: "ok", fail: "bad", unproven: "warn" } as const;

export function GoalJudge(_props: GoalJudgeProps) {
  const id = useId();
  const [presetIndex, setPresetIndex] = useState(0);
  const preset = GOAL_PRESETS[presetIndex];
  const [objective, setObjective] = useState(preset.objective);
  const [checks, setChecks] = useState<GoalCheck[]>(preset.checks);
  const [report, setReport] = useState(preset.reports[0].text);
  const [calls, setCalls] = useState(0);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const judge = useStrictJson<Judgement>();
  const judging = judge.state === "running";
  const [judgedReport, setJudgedReport] = useState<string | null>(null);

  const pickPreset = (i: number) => {
    const p = GOAL_PRESETS[i];
    setPresetIndex(i);
    setObjective(p.objective);
    setChecks(p.checks);
    setReport(p.reports[0].text);
    setCalls(0);
    judge.clear();
  };

  const body = judgeBody(model, objective, checks, report);
  const run = async () => {
    setJudgedReport(report);
    await judge.run(body);
  };
  const gate = useMemo(() => (judge.value ? gateCompletion(checks, judge.value.checks, judgedReport ?? report) : null), [judge.value, checks, judgedReport, report]);
  const reminders = remindersAfter(calls);
  const passed = gate?.passed.length ?? 0;

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-advanced">
        <Segmented<string> label="Sample goal" size="sm" options={GOAL_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))} value={String(presetIndex)} onChange={(v) => pickPreset(Number(v))} />
      </div>
      <div className={`${styles.tight} pg-advanced`}>
        <label className="pg-label" htmlFor={`${id}-goal`}>
          /goal
        </label>
        <TextArea id={`${id}-goal`} rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} />
        <p className={styles.note}>Name the oracle in the objective (&quot;done ONLY when all six checks pass&quot;): a finish line that is a command or a test is much harder to close early.</p>
      </div>
      <Terminal
        title="Status line"
        lines={[
          { text: `/goal ${objective.replace(/\s+/g, " ").trim()}`, tone: "prompt" },
          { text: `${goalIndicator(objective)}${gate ? `  ${passed}/${checks.length} checks proven` : ""}`, tone: gate?.allowed ? "ok" : "plain" },
        ]}
      />

      <div className={`${styles.tight} pg-advanced`}>
        <p className="pg-section-label">Acceptance checks</p>
        <ul className={`${styles.tight} ${styles.plainList}`} aria-label="Acceptance checks">
          {checks.map((c, i) => (
            <li key={c.id} className={styles.row}>
              <code className={styles.mono}>{c.id}</code>
              <label className="sr-only" htmlFor={`${id}-check-${i}`}>
                Check {c.id}
              </label>
              <TextInput id={`${id}-check-${i}`} className={styles.grow} value={c.text} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <button type="button" className="icon-btn icon-btn-plain icon-btn-sm" aria-label={`Remove check ${c.id}`} onClick={() => setChecks(checks.filter((_, j) => j !== i))} disabled={checks.length <= 1}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          onClick={() => {
            // A new id each time, so removing and adding checks never reuses one.
            let n = checks.length + 1;
            while (checks.some((c) => c.id === `check-${n}`)) n++;
            setChecks([...checks, { id: `check-${n}`, text: "" }]);
          }}
          disabled={checks.length >= 8}
        >
          Add a check
        </button>
        {presetIndex === 0 ? <p className={styles.note}>The recipe&apos;s six real checks live in test_falcon_acceptance.py; these come from its description of the work.</p> : null}
      </div>

      <div className={`${styles.tight} pg-advanced`}>
        <p className="pg-section-label">The step probe</p>
        <div className={styles.row}>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setCalls((n) => n + 1)}>
            A model call with no progress
          </button>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setCalls((n) => n + 5)}>
            Five more
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setCalls(0)} disabled={!calls}>
            Progress made
          </button>
          <span className={styles.note} role="status" aria-live="polite">
            {calls} call{calls === 1 ? "" : "s"} without progress; the next reminder at {PROBE_EVERY * (reminders + 1)}.
          </span>
        </div>
        {reminders ? (
          <Terminal title="TUI" lines={Array.from({ length: reminders }, (_, i) => ({ text: `goal reminded  (after ${PROBE_EVERY * (i + 1)} calls): ${GOAL_REMINDER}`, tone: "muted" as const }))} copy={false} />
        ) : null}
      </div>

      <Section title="Try to close the goal">
        <PresetPills label="Agent's report" presets={preset.reports} active={preset.reports.findIndex((r) => r.text === report)} onPick={(i) => setReport(preset.reports[i].text)} disabled={judging} />
        <label className="sr-only" htmlFor={`${id}-report`}>
          The agent&apos;s completion report
        </label>
        <TextArea id={`${id}-report`} rows={6} className="pg-code-input" value={report} onChange={(e) => setReport(e.target.value)} disabled={judging} />
        <div className="pg-bar">
          <ModelSelect kind="text" value={model} onChange={setModel} disabled={judging} />
          <RunButton running={judging} onRun={() => void run()} onStop={judge.abort} label="Call update_goal" disabled={!report.trim() || !checks.length} />
        </div>
        <p className={`${styles.note} pg-advanced`}>The judge model grades each check with a quote from the report. The page then lets update_goal close the goal only if every check passed and every quote is really in the report. Under a cent.</p>
        {judging || judge.result ? (
          <ResponseView result={judging ? null : judge.result} running={judging} elapsedMs={judge.elapsedMs}>
            {judge.value && gate ? (
              <div className={styles.stack}>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <caption className="sr-only">Each acceptance check, graded</caption>
                    <thead>
                      <tr>
                        <th scope="col">Check</th>
                        <th scope="col">Judge</th>
                        <th scope="col">Evidence from the report</th>
                        <th scope="col">Audit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.map((c) => {
                        const j = judge.value!.checks.find((x) => x.id === c.id);
                        const audit = gate.passed.includes(c.id) ? "pass" : gate.failing.includes(c.id) ? "fail" : "unproven";
                        return (
                          <tr key={c.id}>
                            <td>
                              <code>{c.id}</code>
                              <div className={styles.note}>{c.text}</div>
                            </td>
                            <td>{j ? <Chip tone={STATUS_TONE[j.status]}>{j.status}</Chip> : <Chip tone="warn">skipped</Chip>}</td>
                            <td>{j?.evidence ? <code>{j.evidence}</code> : <span className="pg-muted">None</span>}</td>
                            <td>
                              <Chip tone={STATUS_TONE[audit]}>{audit}</Chip>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Terminal title="update_goal" lines={[{ text: `update_goal ${JSON.stringify(gate.call.arguments)}`, tone: "cmd" }, { text: gate.reply, tone: gate.allowed ? "ok" : "err" }]} live />
                <Verdict tone={gate.allowed ? "ok" : "bad"} title={gate.allowed ? "Goal closed: every deliverable is present" : "The goal stays open"}>
                  <p className={styles.note}>
                    {judge.value.verdict === "complete" && !gate.allowed ? "The judge said complete, but the audit found a check without evidence in the report, so it refused. " : ""}
                    Next step: {judge.value.next_step}
                  </p>
                </Verdict>
              </div>
            ) : (
              <p className="pg-empty">{judging ? "Auditing the report check by check..." : "No grades in this reply."}</p>
            )}
          </ResponseView>
        ) : null}
        <ErrorBox error={judge.error} />
        <ShowCode body={judge.body ?? body} caption={judge.body ? "The request that just ran" : "The request Run sends"} />
      </Section>
    </div>
  );
}
