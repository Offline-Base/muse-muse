"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { Tabs } from "@/components/docs/kit/Tabs";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import {
  callbackReport,
  guardStop,
  interleavedTrace,
  loopTools,
  loopTrace,
  migrationTools,
  oracleFiles,
  ProjectFs,
  resultSummary,
  shortCall,
  turnsOf,
} from "@/components/docs/playgrounds/cookbook-fundamentals/agent";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { unifiedDiff } from "@/components/docs/playgrounds/cookbook-fundamentals/diff";
import { PROJECTS, type AgentTask } from "@/components/docs/playgrounds/cookbook-fundamentals/projects";
import { allGreen, formatReport, runTestsInWorker, type TestReport } from "@/components/docs/playgrounds/cookbook-fundamentals/sandbox";
import { CodeLines, DiffView, Note, Stats, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { useToolLoop } from "@/components/docs/playgrounds/cookbook-fundamentals/useToolLoop";
import type { NeutralRequest } from "@/lib/docs/client/body";
import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { nextModelBody } from "@/lib/docs/client/toolloop";

/**
 * An agent loop on a real (small) project, in the page: the model reads files, edits them and runs the tests through
 * function tools on the Responses API, one turn at a time, until the tests pass or a guard stops it. Two recipes use
 * it. basic-agent-loop: one tool per turn, the THINK / ACT / RESULT / EVAL trace, and the guards (iteration cap, token
 * budget, a call repeated three times, Stop). interleaved-reasoning-tool-use: a callback-to-async migration where the
 * order of edits matters, with the reasoning each turn spends and the effort knob. The tests run in a locked-down
 * worker (sandbox.ts); nothing the model writes leaves the page.
 */

export interface AgentLoopDemoProps {
  slug: string;
  project: "agent-loop-target" | "callback-target";
  variant: "loop" | "interleaved";
  effort?: Effort | null;
  /** Ask for a reasoning summary each turn. */
  summary?: boolean;
  maxTurns?: number;
  tokenBudget?: number;
}

const LOOP_INSTRUCTIONS =
  "You are a coding agent working in a small JavaScript project. Each turn: think briefly, call exactly one tool, read the result, then decide whether the task is done. Use list_files and read_file to gather context, write_file to change a file (send the whole new file), and run_tests to check your work. Fix the code, not the tests. When the tests pass, stop and say what you changed in one or two sentences.";

const MIGRATE_INSTRUCTIONS =
  "You are a coding agent migrating a small Node.js project from error-first callbacks to async/await without changing its behavior. Reason about the order of changes before you edit: when a function becomes async, every caller has to change with it. Look with list_files, read_file and grep; change files with edit_file (old_string must match the file exactly once) or write_file. run_checks runs the tests and checks the files this task migrates for callback-style code. src/db/store.js stays callback-based: wrap it (util.promisify works). When run_checks passes, stop and summarize the migration in two sentences.";

interface RunRecord {
  n: number;
  effort: string;
  turns: number;
  reasoning: number;
  tokens: number;
  ms: number;
  outcome: string;
  usd: number;
}

type Panel = "trace" | "files" | "diff";

export function AgentLoopDemo({ project: projectId, variant, effort: initialEffort = "low", summary: initialSummary, maxTurns = 15, tokenBudget = 120_000 }: AgentLoopDemoProps) {
  const id = useId();
  const project = PROJECTS[projectId];
  const interleaved = variant === "interleaved";
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [summary, setSummary] = useState(initialSummary ?? interleaved);
  const [taskIndex, setTaskIndex] = useState(0);
  const task: AgentTask = project.tasks[taskIndex] ?? project.tasks[0];
  const [prompt, setPrompt] = useState(task.prompt);
  const [turnCap, setTurnCap] = useState(String(maxTurns));
  const [budget, setBudget] = useState(String(tokenBudget));
  const [panel, setPanel] = useState<Panel>("trace");
  const [file, setFile] = useState<string>(task.test ?? Object.keys(project.files)[0]);
  const [oracle, setOracle] = useState<{ report: TestReport; callbacks: string | null; changedTests: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [showCode, setShowCode] = useState(false);
  // "Run again" resets first and starts on the next render, once the tools close over the fresh project.
  const [again, setAgain] = useState(false);
  const fs = useRef(new ProjectFs(project.files));
  const startedAt = useRef<number | null>(null);
  const recorded = useRef(false);

  const runTests = (files: Record<string, string>, only?: string | null) => runTestsInWorker(files, { only: only ?? null });
  const tools = useMemo(
    () => (interleaved ? migrationTools(fs.current, runTests, () => task.migrate ?? []) : loopTools(fs.current, runTests)),
    // fs.current is replaced on reset, and the tools close over it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interleaved, task, fs.current],
  );

  const base: NeutralRequest = useMemo(
    () => ({
      model,
      system: interleaved ? MIGRATE_INSTRUCTIONS : LOOP_INSTRUCTIONS,
      messages: [{ role: "user", content: prompt.trim() }],
      tools: tools.map((t) => t.def),
      // The loop's contract is one tool per turn.
      parallelToolCalls: interleaved ? undefined : false,
      effort: fitEffort(model, effort),
      summary: summary ? "auto" : null,
    }),
    [model, interleaved, prompt, tools, effort, summary],
  );

  const guards = useMemo(() => ({ tokenBudget: Number(budget), repeats: 3 }), [budget]);
  const loop = useToolLoop({
    protocol: "responses",
    base,
    tools,
    maxCalls: Number(turnCap),
    guard: (steps) => guardStop(steps, guards),
  });

  const turns = turnsOf(loop.steps);
  const ended = !loop.busy && loop.steps.length > 0 && (loop.next === "done" || loop.next === "limit" || loop.next === "stopped" || !!loop.stopped);
  const changed = fs.current.changed();
  const reasoningTotal = turns.reduce((n, t) => n + t.reasoningTokens, 0);
  const tokensTotal = turns.reduce((n, t) => n + t.totalTokens, 0);
  const usd = turns.reduce((n, t) => n + (estimateCost(t.model.model ?? model, t.model.collected?.usage)?.usd ?? 0), 0);

  // When a run ends, run the oracle once: the project's original tests against the agent's code (a test the agent
  // rewrote doesn't get to vote), and for a migration the callback check.
  useEffect(() => {
    if (!ended || recorded.current) return;
    recorded.current = true;
    const ms = startedAt.current ? performance.now() - startedAt.current : 0;
    setChecking(true);
    const { files, changedTests } = oracleFiles(fs.current.original, fs.current.files, task.oracleTests);
    void runTestsInWorker(files, { only: interleaved ? null : (task.test ?? null) }).then((report) => {
      const callbacks = interleaved ? callbackReport(fs.current.files, task.migrate ?? []) : null;
      setOracle({ report, callbacks, changedTests });
      setChecking(false);
      const green = allGreen(report) && (!callbacks || callbacks.startsWith("No callback-style"));
      const outcome = loop.stopped ?? (loop.next === "limit" ? "iteration cap" : green ? "fixed" : "not fixed");
      setRuns((cur) => [
        ...cur,
        {
          n: cur.length + 1,
          effort: fitEffort(model, effort) ?? "default",
          turns: turns.length,
          reasoning: reasoningTotal,
          tokens: tokensTotal,
          ms,
          outcome: typeof outcome === "string" ? outcome : "stopped",
          usd,
        },
      ]);
    });
  }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetAll = (next?: AgentTask) => {
    loop.reset();
    fs.current = new ProjectFs(project.files);
    setOracle(null);
    recorded.current = false;
    startedAt.current = null;
    if (next) {
      setPrompt(next.prompt);
      setFile(next.test ?? (next.migrate?.[0] ?? Object.keys(project.files)[0]));
    }
  };

  useEffect(() => {
    if (!again || loop.steps.length) return;
    setAgain(false);
    startedAt.current = performance.now();
    recorded.current = false;
    void loop.runAll();
  }, [again, loop.steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (fn: () => Promise<void>) => {
    if (!loop.steps.length) {
      startedAt.current = performance.now();
      recorded.current = false;
      setOracle(null);
    }
    void fn();
  };

  const trace = interleaved ? interleavedTrace(loop.steps) : loopTrace(loop.steps, loop.stopped);
  const nextBody = nextModelBody("responses", base, loop.steps);
  const fileNames = Object.keys(fs.current.files).sort((a, b) => Number(changed.includes(b)) - Number(changed.includes(a)) || a.localeCompare(b));
  const shownFile = fs.current.files[file] !== undefined ? file : fileNames[0];
  const diffText = changed.map((p) => unifiedDiff(p, fs.current.original[p] ?? null, fs.current.files[p] ?? null)).filter(Boolean).join("\n\n");
  const oracleGreen = oracle ? allGreen(oracle.report) && (!oracle.callbacks || oracle.callbacks.startsWith("No callback-style")) : false;
  const nextLabel = loop.next === "tools" ? "Run the tool" : loop.next === "model" ? (loop.steps.length ? "Next turn" : "First turn") : "Step";

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={loop.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={loop.busy} label={interleaved ? "Reasoning effort" : "Reasoning"} />
        <Toggle id={`${id}-summary`} label="Reasoning summary" checked={summary} onChange={setSummary} disabled={loop.busy} />
      </div>
      <PresetPills
        label="Task"
        presets={project.tasks}
        active={taskIndex}
        disabled={loop.busy}
        onPick={(i) => {
          setTaskIndex(i);
          resetAll(project.tasks[i]);
        }}
      />
      <Field id={`${id}-prompt`} label="The task, as the recipe phrases it">
        <TextArea id={`${id}-prompt`} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={loop.busy || loop.steps.length > 0} />
      </Field>
      <div className={`${styles.row} pg-advanced`}>
        <span className={styles.inlineLabel}>Guards: most turns</span>
        <Segmented<string>
          size="sm"
          label="Most turns"
          value={turnCap}
          onChange={setTurnCap}
          disabled={loop.busy}
          options={["8", "15", "25"].map((v) => ({ value: v, label: v }))}
        />
        <span className={styles.inlineLabel}>token budget</span>
        <Segmented<string>
          size="sm"
          label="Token budget"
          value={budget}
          onChange={setBudget}
          disabled={loop.busy}
          options={["60000", "120000", "240000"].map((v) => ({ value: v, label: `${Number(v) / 1000}k` }))}
        />
        <span className="pg-muted pg-small">and a stop when one exact call repeats three times</span>
      </div>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">
          {interleaved ? "Each turn reasons, then acts." : "One tool per turn (parallel_tool_calls: false)."} A run is usually a few tenths of a cent.
        </span>
        <span className={styles.row}>
          {loop.steps.length ? (
            <button type="button" className="btn btn-sm" onClick={() => resetAll()} disabled={loop.busy}>
              Reset the project
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => start(loop.stepOnce)} disabled={loop.busy || ended || !prompt.trim()}>
            {nextLabel}
          </button>
          {ended ? (
            <RunButton
              running={false}
              onRun={() => {
                resetAll();
                setAgain(true);
              }}
              label="Run again on a fresh copy"
              disabled={!prompt.trim()}
            />
          ) : (
            <RunButton running={loop.busy} onRun={() => start(loop.runAll)} onStop={loop.stop} label={loop.steps.length ? "Run to the end" : "Run the loop"} disabled={!prompt.trim()} />
          )}
        </span>
      </div>
      <ErrorBox error={loop.error} />

      {turns.length ? (
        <>
          <Stats
            label="This run"
            items={[
              { label: "Turns", value: `${turns.length}`, note: `cap ${turnCap}` },
              { label: "Tokens", value: tokensTotal.toLocaleString("en-US"), note: `budget ${(Number(budget) / 1000).toFixed(0)}k` },
              { label: "Reasoning tokens", value: reasoningTotal.toLocaleString("en-US") },
              { label: "Cost", value: formatUsd(usd), note: "estimated" },
            ]}
          />
          <ol className={styles.turns} aria-label="Turns" aria-live="polite">
            {turns.map((t) => (
              <li key={t.turn} className={styles.turn}>
                <div className={styles.turnHead}>
                  <span className={styles.turnTitle}>Turn {t.turn}</span>
                  {!t.model.collected?.done ? (
                    <StatusPill tone="busy">thinking</StatusPill>
                  ) : t.model.collected.error ? (
                    <StatusPill tone="bad">{t.model.collected.error.code === "aborted" ? "stopped" : "failed"}</StatusPill>
                  ) : t.calls.length ? (
                    <StatusPill tone="idle">continue</StatusPill>
                  ) : (
                    <StatusPill tone="ok">done</StatusPill>
                  )}
                  <span className="pg-meta">{t.reasoningTokens.toLocaleString("en-US")} reasoning tokens</span>
                  {t.model.elapsedMs ? <span className="pg-meta pg-advanced">{latencyLabel(t.model.elapsedMs)}</span> : null}
                  {t.model.collected?.usage ? (
                    <span className="pg-advanced">
                      <UsageLine model={t.model.model ?? model} usage={t.model.collected.usage} />
                    </span>
                  ) : null}
                </div>
                {t.thought ? <p className={`${styles.thought} pg-advanced`}>{t.thought}</p> : null}
                {t.calls.map((c) => (
                  <div key={c.callId || c.name}>
                    <p className={styles.act}>→ {shortCall(c.name, c.args)}</p>
                    <p className={`${styles.result} pg-advanced`}>{resultSummary(c.name, c.output, c.ok)}</p>
                  </div>
                ))}
                {t.model.collected?.done && !t.calls.length && !t.model.collected.error ? <p className={styles.textBlock}>{t.model.collected.text || "(no text)"}</p> : null}
                {t.model.collected?.error && t.model.collected.error.code !== "aborted" ? <p className="pg-bad">{t.model.collected.error.message}</p> : null}
                <details className="pg-raw pg-advanced">
                  <summary>Request and reply JSON</summary>
                  <JsonTree value={t.model.body} openDepth={1} />
                  {t.model.collected?.final ? <JsonTree value={t.model.collected.final} openDepth={1} /> : null}
                </details>
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {loop.stopped ? <p className="pg-hint" role="status">{loop.stopped}</p> : null}
      {loop.next === "limit" && !loop.busy ? <p className="pg-hint">Hit the cap of {turnCap} turns: a guard, not a success.</p> : null}
      {checking ? <p className="pg-hint" role="status">Running the oracle...</p> : null}
      {oracle ? (
        <div className="pg-final" role="status">
          <p className="pg-section-label">The oracle {oracleGreen ? "says done" : "says not yet"}</p>
          <pre className="pg-pre">{[formatReport(oracle.report), oracle.callbacks].filter(Boolean).join("\n")}</pre>
          {oracle.changedTests.length ? (
            <p className="pg-hint">
              The agent changed {oracle.changedTests.join(", ")}. The oracle ran the project&apos;s original tests against its code instead.
            </p>
          ) : null}
          {task.oracleTests ? (
            <p className="pg-hint">
              This task changes an API, so the agent rewrites {Object.keys(task.oracleTests).join(", ")} itself; the oracle checks the new API with its own
              copy of those tests.
            </p>
          ) : null}
          <Note advanced>
            {interleaved
              ? "Done means the project's own behavior tests still pass and no callback-style code is left in the migrated files."
              : "The project's own tests are the oracle: the loop's claim of success counts only when they pass."}
          </Note>
        </div>
      ) : null}

      {loop.steps.length || changed.length ? (
        <div className={styles.stack}>
          <Tabs<Panel>
            label="Run details"
            idBase={`${id}-panel`}
            value={panel}
            onChange={setPanel}
            tabs={[
              { id: "trace", label: "Trace" },
              { id: "files", label: "Files", count: Object.keys(fs.current.files).length },
              { id: "diff", label: "Diff", count: changed.length },
            ]}
          />
          <div role="tabpanel" id={`${id}-panel-panel-${panel}`} aria-labelledby={`${id}-panel-tab-${panel}`} className={styles.stack}>
            {panel === "trace" ? (
              <>
                <div className={styles.spread}>
                  <span className="pg-muted pg-small pg-advanced">{interleaved ? "The recipe's interleaved trace: thought, then action." : "The recipe's trace format: one block per turn."}</span>
                  <CopyButton value={trace} label="Copy the trace" className="icon-btn icon-btn-plain icon-btn-sm" />
                </div>
                <pre className={styles.trace}>{trace || "No turns yet."}</pre>
              </>
            ) : panel === "files" ? (
              <>
                <div className={styles.row} role="group" aria-label="Files">
                  {fileNames.map((p) => (
                    <button key={p} type="button" className="pg-pill" aria-pressed={p === shownFile} onClick={() => setFile(p)}>
                      {p}
                      {changed.includes(p) ? " (changed)" : ""}
                    </button>
                  ))}
                </div>
                <CodeLines text={fs.current.files[shownFile] ?? ""} label={shownFile} />
              </>
            ) : (
              <DiffView diff={diffText} label="Changes the agent made" />
            )}
          </div>
        </div>
      ) : (
        <details className="pg-raw pg-advanced">
          <summary>The project ({Object.keys(project.files).length} files)</summary>
          <div className={styles.row} role="group" aria-label="Files">
            {Object.keys(project.files).map((p) => (
              <button key={p} type="button" className="pg-pill" aria-pressed={p === shownFile} onClick={() => setFile(p)}>
                {p}
              </button>
            ))}
          </div>
          <CodeLines text={project.files[shownFile] ?? ""} label={shownFile} />
        </details>
      )}

      {runs.length ? (
        <div className={`${styles.tableWrap} pg-advanced`}>
          <p className="pg-section-label">Runs so far</p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Effort</th>
                <th scope="col" className={styles.num}>Turns</th>
                <th scope="col" className={styles.num}>Reasoning</th>
                <th scope="col" className={styles.num}>Tokens</th>
                <th scope="col" className={styles.num}>Time</th>
                <th scope="col" className={styles.num}>Cost</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.n}>
                  <td>{r.n}</td>
                  <td>
                    <code>{r.effort}</code>
                  </td>
                  <td className={styles.num}>{r.turns}</td>
                  <td className={styles.num}>{r.reasoning.toLocaleString("en-US")}</td>
                  <td className={styles.num}>{r.tokens.toLocaleString("en-US")}</td>
                  <td className={styles.num}>{latencyLabel(r.ms)}</td>
                  <td className={styles.num}>{formatUsd(r.usd)}</td>
                  <td>{r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {interleaved && runs.length === 1 ? <Note>Reset, change the effort and run again: a thin budget can cost more turns end to end.</Note> : null}
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={nextBody} caption={loop.steps.length ? "The next turn's request" : "The first turn's request"} /> : null}
    </div>
  );
}
