"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { EffortSelect, TextArea, Toggle } from "@/components/docs/kit/Field";
import { Tabs, TabPanel } from "@/components/docs/kit/Tabs";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { AgentBadge, RunBar, Timeline, agentColor } from "@/components/docs/playgrounds/cookbook-use-cases/Timeline";
import { useAgentRun, type ToolExecutor } from "@/components/docs/playgrounds/cookbook-use-cases/useAgentRun";
import { agentBase, type AgentDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { ONE_LINE_BRIEF, PROFILES, TOOLSETS, TOOLS_FOR, instructionsFor, type Board, type Profile, type Task, type TaskStatus } from "@/components/docs/playgrounds/cookbook-use-cases/lib/kanban";
import { PM_KICKOFF, boardTool, orchestrate, type BoardHost } from "@/components/docs/playgrounds/cookbook-use-cases/lib/kanban-run";

/**
 * cookbook/multi-agent-orchestration: a PM and three specialists (the recipe's Hermes profiles, SOULs and toolsets)
 * coordinating through a live Kanban board. The PM interviews you with clarify, writes brief.md and runbook.md,
 * and creates linked tasks; the dispatcher releases each task when its parents are done; a specialist that needs a
 * decision blocks with needs_input and the PM answers on the task. Every call, block and comment is in the timeline.
 */

export interface MultiAgentBoardProps {
  slug: string;
  brief?: string;
}

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "ready", label: "Ready" },
  { status: "running", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export function MultiAgentBoard({ brief: initialBrief = ONE_LINE_BRIEF }: MultiAgentBoardProps) {
  const id = useId();
  const run = useAgentRun();
  const [brief, setBrief] = useState(initialBrief);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [board, setBoard] = useState<Board>({ tasks: [], files: {} });
  const boardRef = useRef<Board>({ tasks: [], files: {} });
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [file, setFile] = useState("brief.md");
  const [showCode, setShowCode] = useState(false);

  const commit = (b: Board) => {
    boardRef.current = b;
    setBoard(b);
  };

  const def = (p: Profile): AgentDef => ({
    name: p,
    model,
    instructions: instructionsFor(p),
    tools: TOOLS_FOR[p],
    effort,
    maxOutputTokens: 3000,
    maxCalls: p === "pm" ? 12 : 10,
    parallelToolCalls: false,
    state: "replay",
  });

  const host: BoardHost = useMemo(
    () => ({ board: () => boardRef.current, commit: (b: Board) => commit(b), current: {} }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const exec: ToolExecutor = (agent, call, rt) => boardTool(host, agent, call, rt);

  const start = () => {
    commit({ tasks: [], files: {} });
    host.current = {};
    setOpenTask(null);
    void run.start((rt) => orchestrate(rt, host, { brief, def }), exec);
  };

  const files = Object.keys(board.files);
  const shownFile = files.includes(file) ? file : files[0];
  const fileIdBase = `${id}-files`;
  const opened = board.tasks.find((t) => t.id === openTask) ?? null;

  return (
    <div className="pg">
      <div className={`${styles.grid2} pg-advanced`}>
        {PROFILES.map((p) => (
          <div key={p} className={styles.card} style={{ padding: "10px 12px" }}>
            <p className={styles.row}>
              <AgentBadge name={p} order={PROFILES} />
              <span className="pg-hint">{TOOLSETS[p].join(", ")}</span>
            </p>
            <details>
              <summary className="pg-small">SOUL.md</summary>
              <pre className="pg-pre" style={{ maxHeight: 200 }}>
                {instructionsFor(p).split("\n\nYour profile")[0]}
              </pre>
            </details>
          </div>
        ))}
      </div>

      <label className="pg-label" htmlFor={`${id}-brief`}>
        The one-line brief for the PM
      </label>
      <TextArea id={`${id}-brief`} rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} disabled={run.busy} />
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={run.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={run.busy} />
        <Toggle id={`${id}-step`} label="Pause after each step" checked={run.stepMode} onChange={run.setStepMode} />
      </div>
      <div className="pg-actions">
        <RunButton running={run.busy} onRun={start} onStop={run.stop} label="Brief the PM" disabled={!brief.trim()} />
        <span className="pg-hint pg-advanced">Answer the PM&apos;s clarify questions when they appear. A full run is 30 to 80 short calls, spaced to stay under the live demos&apos; per-minute limit and up to a fifth of the 400 runs each network gets a day: a few minutes and about a cent on Spark Contributor. On Muse Wonder (40 times the input price, 100 times the output) the same run costs dollars, more than the $2 a day each network gets.</span>
      </div>
      <RunBar busy={run.busy} modelCalls={run.modelCalls} totalUsd={run.totalUsd} waitingStep={run.waitingStep} onAdvance={run.advance} />
      <ErrorBox error={run.error} />

      {board.tasks.length ? (
        <div className={styles.stack}>
          <p className="pg-section-label">Kanban board</p>
          <div className={styles.board} role="list" aria-label="Kanban board">
            {COLUMNS.map((c) => (
              <div key={c.status} className={styles.column} role="listitem" aria-label={c.label}>
                <span className={styles.columnTitle}>
                  {c.label} ({board.tasks.filter((t) => t.status === c.status).length})
                </span>
                {board.tasks
                  .filter((t) => t.status === c.status)
                  .map((t) => (
                    <TaskCard key={t.id} t={t} onOpen={() => setOpenTask(openTask === t.id ? null : t.id)} open={openTask === t.id} />
                  ))}
              </div>
            ))}
          </div>
          {opened ? (
            <div className={styles.card} aria-live="polite">
              <p className={styles.cardTitle}>
                {opened.id}: {opened.title}
              </p>
              <p className="pg-small">
                Assignee <AgentBadge name={opened.assignee} order={PROFILES} /> · {opened.status}
                {opened.parents.length ? ` · after ${opened.parents.join(", ")}` : ""}
              </p>
              <p className={styles.answer}>{opened.description}</p>
              {opened.comments.length ? (
                <ol className="pg-list">
                  {opened.comments.map((cm, i) => (
                    <li key={i} className="pg-small">
                      <strong>
                        {cm.author}
                        {cm.kind && cm.kind !== "comment" ? ` (${cm.kind})` : ""}:
                      </strong>{" "}
                      {cm.body}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="pg-hint">No comments yet.</p>
              )}
              <p className="pg-hint">Events: {opened.events.join(" > ")}</p>
            </div>
          ) : (
            <p className="pg-hint">Click a card to open its drawer: description, comment thread and events.</p>
          )}
        </div>
      ) : null}

      <Timeline entries={run.entries} onAnswer={run.answer} order={PROFILES} label="Hermes run" />

      {files.length ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>Project workspace</p>
          <Tabs label="Workspace files" idBase={fileIdBase} tabs={files.map((f) => ({ id: f, label: f }))} value={shownFile} onChange={setFile} />
          {files.map((f) => (
            <TabPanel key={f} idBase={fileIdBase} id={f} active={shownFile === f}>
              <pre className="pg-pre">{board.files[f]}</pre>
            </TabPanel>
          ))}
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={{ ...agentBase(def("pm")), input: `${brief.trim()}\n\n${PM_KICKOFF}` }} caption="The PM's first call: its SOUL, its tools (clarify, files, kanban) and the brief" /> : null}
    </div>
  );
}

function TaskCard({ t, onOpen, open }: { t: Task; onOpen(): void; open: boolean }) {
  const last = t.comments[t.comments.length - 1];
  return (
    <button type="button" className={styles.task} style={{ ["--badge" as string]: agentColor(t.assignee, PROFILES), cursor: "pointer" }} onClick={onOpen} aria-expanded={open}>
      <span className={styles.taskTitle}>
        {t.id} {t.title}
      </span>
      <span className="pg-hint">
        {t.assignee}
        {t.parents.length ? ` · after ${t.parents.join(", ")}` : ""}
      </span>
      {last ? <span className="pg-hint">{`${last.author}: ${last.body.slice(0, 70)}${last.body.length > 70 ? "..." : ""}`}</span> : null}
    </button>
  );
}
