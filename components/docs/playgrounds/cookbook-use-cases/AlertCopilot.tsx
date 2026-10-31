"use client";

import { useId, useMemo, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, Toggle } from "@/components/docs/kit/Field";
import { Tabs, TabPanel } from "@/components/docs/kit/Tabs";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { formatUsd } from "@/lib/docs/client/cost";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { replyUsd, responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { asObject, parseStrictJson } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";
import { withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { useRetryGuard } from "@/components/docs/playgrounds/cookbook-use-cases/useRetryGuard";
import {
  CHAT_TASK,
  assessRequest,
  chatRequest,
  digestOf,
  digestText,
  numberCheck,
  probeRequest,
  probeStateFiles,
  syntheticAlerts,
  validateAssessment,
  validateProbe,
  type CheckLine,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/alerts";

/**
 * cookbook/alert-fatigue-copilot over a synthetic BrewBean feed: the recipe's three tasks on the direct API (its
 * demo.py path). Task 1 probes the feed and must return strict JSON (patterns, refined purpose, signals), checked by
 * the validator's rules and written to state files; task 2 answers from those state files, with every number checked
 * against the digest; task 3 self-assesses with proposals from the allowed kinds. Guards: three turns, one re-prompt
 * when the JSON doesn't parse ("no markdown fences, raw JSON only").
 */

export interface AlertCopilotProps {
  slug: string;
  /** Hand the model the computed digest (the loop's READ step). Default true. */
  sendDigest?: boolean;
  /** Enforce the shape with a strict json_schema instead of the prompt alone. Default false. */
  enforceSchema?: boolean;
}

type Json = Record<string, unknown>;

interface TaskRun {
  body: Json;
  text: string;
  value: unknown;
  recovered: string | null;
  checks: CheckLine[];
  retried: boolean;
  usage: unknown;
  model: string | null;
  usd: number;
}

const FILES = ["purpose.json", "signals.json", "memory.jsonl", "assessment.json", "proposals.json"] as const;

export function AlertCopilot({ sendDigest: initialDigest = true, enforceSchema: initialSchema = false }: AlertCopilotProps) {
  const id = useId();
  const runner = useDocsRun();
  const alerts = useMemo(() => syntheticAlerts(), []);
  const digest = useMemo(() => digestOf(alerts), [alerts]);
  const [sendDigest, setSendDigest] = useState(initialDigest);
  const [schema, setSchema] = useState(initialSchema);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [probe, setProbe] = useState<TaskRun | null>(null);
  const [chat, setChat] = useState<TaskRun | null>(null);
  const [assess, setAssess] = useState<TaskRun | null>(null);
  const [state, setState] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<string | null>(null);
  const [file, setFile] = useState<string>("purpose.json");
  const [showCode, setShowCode] = useState(false);
  const guard = useRetryGuard(runner.abort);
  const running = runner.state === "running" || guard.waiting;

  const probeBody = (): Json => probeRequest({ model, effort, schema, sendDigest, alerts, digest });

  /** One strict-JSON task, re-prompted once if its reply doesn't parse. */
  const strictTask = async (body: Json, validate: (v: unknown) => CheckLine[]): Promise<TaskRun | null> => {
    let res = await withRetries(() => runner.run("responses", { method: "POST", body }), guard.options);
    if (!res.ok) return null;
    let text = responseText(res.json);
    let parsed = parseStrictJson(text);
    let retried = false;
    let usd = replyUsd(res.model ?? model, res.json);
    if (!parsed.ok) {
      retried = true;
      const prev = (res.json as Json | null)?.id;
      res = await runner.run("responses", {
        method: "POST",
        body: { model, ...(typeof prev === "string" ? { previous_response_id: prev } : {}), instructions: body.instructions, input: "No markdown fences, raw JSON only. Return the JSON object again.", max_output_tokens: body.max_output_tokens },
      });
      if (!res.ok) return null;
      usd += replyUsd(res.model ?? model, res.json);
      text = responseText(res.json);
      parsed = parseStrictJson(text);
    }
    const value = parsed.ok ? parsed.value : null;
    const checks = parsed.ok ? validate(value) : [{ ok: false, text: `[ERR] ${parsed.error}` }];
    return { body, text, value, recovered: parsed.ok ? parsed.recovered : null, checks, retried, usage: (res.json as Json | null)?.usage, model: res.model, usd };
  };

  const runProbe = async (): Promise<Record<string, string> | null> => {
    setPhase("Task 1: probing the feed");
    setChat(null);
    setAssess(null);
    const t = await strictTask(probeBody(), validateProbe);
    setPhase(null);
    if (!t) return null;
    setProbe(t);
    if (!asObject(t.value) || !t.checks.every((c) => c.ok)) return null;
    const files = probeStateFiles(t.value, digest);
    setState(files);
    setFile("purpose.json");
    return files;
  };

  const runChat = async (files: Record<string, string>): Promise<Record<string, string> | null> => {
    setPhase("Task 2: answering from memory");
    const body = chatRequest({ model, effort, files, digest });
    const res = await withRetries(() => runner.run("responses", { method: "POST", body }), guard.options);
    setPhase(null);
    if (!res.ok) return null;
    const text = responseText(res.json);
    const nums = numberCheck(text, digest);
    const ungrounded = nums.filter((n) => !n.grounded);
    setChat({
      body,
      text,
      value: null,
      recovered: null,
      checks: [
        ungrounded.length
          ? { ok: false, text: `numbers not in the digest: ${ungrounded.map((n) => n.text).join(", ")}` }
          : { ok: true, text: `every number traces back to the digest (${nums.map((n) => n.text).join(", ") || "none stated"})` },
      ],
      retried: false,
      usage: (res.json as Json | null)?.usage,
      model: res.model,
      usd: replyUsd(res.model ?? model, res.json),
    });
    const next = { ...files, "memory.jsonl": `${files["memory.jsonl"]}\n${JSON.stringify({ turn: 2, kind: "chat", question: CHAT_TASK, answer: text })}` };
    setState(next);
    return next;
  };

  const runAssess = async (files: Record<string, string>) => {
    setPhase("Task 3: self-assessing");
    const body = assessRequest({ model, effort, schema, files });
    const t = await strictTask(body, validateAssessment);
    setPhase(null);
    if (!t) return;
    setAssess(t);
    const o = asObject(t.value);
    if (o) {
      setState((s) => ({
        ...s,
        "assessment.json": JSON.stringify(o, null, 2),
        "proposals.json": JSON.stringify(Array.isArray(o.proposals) ? o.proposals : [], null, 2),
      }));
      setFile("assessment.json");
    }
  };

  const runAll = async () => {
    guard.begin();
    const f1 = await runProbe();
    if (!f1) return;
    const f2 = await runChat(f1);
    if (!f2) return;
    await runAssess(f2);
  };

  const allChecks: Array<{ label: string; ok: boolean | null }> = [
    { label: "probe JSON has a patterns array with text and salience", ok: probe ? probe.checks[0]?.ok ?? false : null },
    { label: "refined_purpose.statement non-empty", ok: probe ? probe.checks[1]?.ok ?? false : null },
    { label: "signals have the required direction, role and proxy_strength fields", ok: probe ? probe.checks[2]?.ok ?? false : null },
    { label: "self-assess narrative non-empty", ok: assess ? assess.checks[0]?.ok ?? false : null },
    { label: "proposals each have a kind in the allowlist and low/high risk", ok: assess ? assess.checks[1]?.ok ?? false : null },
  ];
  const spent = (probe?.usd ?? 0) + (chat?.usd ?? 0) + (assess?.usd ?? 0);
  const fileIdBase = `${id}-files`;
  const present = FILES.filter((f) => state[f]);

  return (
    <div className="pg">
      <div className={`${styles.card} pg-advanced`}>
        <p className={styles.cardTitle}>The feed: data/synthetic_alerts.json</p>
        <p className="pg-hint">
          {alerts.length} synthetic alerts for the fictional BrewBean POS team, September 2026, .example hosts only. The digest below is what a Python Counter
          prints; it is the only source of numbers the model may state.
        </p>
        <pre className="pg-pre">{digestText(digest)}</pre>
        <details>
          <summary className="pg-small">Show all {alerts.length} alerts</summary>
          <div className={styles.tableWrap} style={{ maxHeight: 320, overflow: "auto", marginTop: 8 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>id</th>
                  <th>time</th>
                  <th>component</th>
                  <th>title</th>
                  <th>owner</th>
                  <th>recurring</th>
                  <th>silenced</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className={styles.mono}>{a.id}</td>
                    <td className={styles.mono}>{a.ts.slice(5, 16).replace("T", " ")}</td>
                    <td>{a.component}</td>
                    <td>{a.title}</td>
                    <td>{a.owner}</td>
                    <td>{a.recurring ? "yes" : ""}</td>
                    <td>{a.silenced ? "yes" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
      </div>
      <div className="pg-bar pg-advanced">
        <Toggle id={`${id}-digest`} label="Hand the model the digest (READ step)" checked={sendDigest} onChange={setSendDigest} disabled={running} />
        <Toggle id={`${id}-schema`} label="Enforce the shape with json_schema strict" checked={schema} onChange={setSchema} disabled={running} />
      </div>
      <p className="pg-hint">
        Off, the model counts the raw feed itself, which is where the recipe sees hallucinated counts. The prompt alone asks for strict JSON; the schema switch is
        the recipe&apos;s fix when the shape keeps breaking.
      </p>

      <div className="pg-actions">
        <RunButton running={running} onRun={() => void runAll()} onStop={guard.stop} label="Run the three tasks" />
        <button type="button" className="btn btn-sm pg-advanced" onClick={() => void runProbe()} disabled={running}>
          Task 1 only
        </button>
        <button type="button" className="btn btn-sm pg-advanced" onClick={() => state["purpose.json"] && void runChat(state)} disabled={running || !state["purpose.json"]}>
          Task 2
        </button>
        <button type="button" className="btn btn-sm pg-advanced" onClick={() => state["purpose.json"] && void runAssess(state)} disabled={running || !state["purpose.json"]}>
          Task 3
        </button>
        {phase ? (
          <span className="pg-hint" role="status">
            {phase}...
          </span>
        ) : spent ? (
          <span className="pg-hint">{formatUsd(spent)} est. so far</span>
        ) : null}
      </div>
      {guard.waitNote ? (
        <div className="pg-hint" role="status">
          {guard.waitNote}
        </div>
      ) : null}
      <ErrorBox error={guard.waiting ? null : runner.error} />

      {probe ? <TaskCard title="Task 1: probe the feed" run={probe} fallbackModel={model} /> : null}
      {chat ? <TaskCard title="Task 2: answer from memory" run={chat} fallbackModel={model} plain /> : null}
      {assess ? <TaskCard title="Task 3: self-assess and propose improvements" run={assess} fallbackModel={model} /> : null}

      {present.length ? (
        <div className={`${styles.card} pg-advanced`}>
          <p className={styles.cardTitle}>State files written</p>
          <Tabs label="State files" idBase={fileIdBase} tabs={present.map((f) => ({ id: f, label: f }))} value={present.includes(file as (typeof FILES)[number]) ? file : present[0]} onChange={setFile} />
          {present.map((f) => (
            <TabPanel key={f} idBase={fileIdBase} id={f} active={(present.includes(file as (typeof FILES)[number]) ? file : present[0]) === f}>
              <pre className="pg-pre">state/{f}{"\n"}{state[f]}</pre>
            </TabPanel>
          ))}
        </div>
      ) : null}

      {probe || assess ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>Validate every run</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>check</th>
                  <th>result</th>
                </tr>
              </thead>
              <tbody>
                {allChecks.map((c) => (
                  <tr key={c.label}>
                    <td>{c.label}</td>
                    <td>{c.ok === null ? <span className="pg-muted">not run</span> : c.ok ? <span className="pg-good">pass</span> : <span className="pg-bad">fail</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pg-hint">The schema guarantees shape, not facts: check the counts in the answers against the digest above.</p>
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={probe?.body ?? probeBody()} caption="Task 1, the probe request" /> : null}
    </div>
  );
}

function TaskCard({ title, run, fallbackModel, plain }: { title: string; run: TaskRun; fallbackModel: string; plain?: boolean }) {
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>{title}</p>
      {run.retried ? <p className="pg-hint">The first reply didn&apos;t parse, so the harness re-prompted once: &quot;No markdown fences, raw JSON only.&quot;</p> : null}
      {run.recovered ? <p className="pg-hint">Recovered the JSON from {run.recovered === "fences" ? "markdown fences" : "text around it"}, as the validator does.</p> : null}
      {plain ? <MarkdownText className={styles.answer} text={run.text} /> : <pre className={run.value ? "pg-pre pg-advanced" : "pg-pre"}>{run.value ? JSON.stringify(run.value, null, 2) : run.text}</pre>}
      <ul className="pg-checks">
        {run.checks.map((c, i) => (
          <li key={i} className={c.ok ? "pg-check-ok" : ""}>
            <span className="pg-check-mark">{c.ok ? "✓" : "✗"}</span> <span className={styles.mono}>{c.ok ? "[OK]" : "[ERR]"}</span> {c.text.replace(/^\[ERR\] /, "")}
          </li>
        ))}
      </ul>
      <UsageLine model={run.model ?? fallbackModel} usage={run.usage} />
    </div>
  );
}
