"use client";

import { useId, useMemo, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, PresetPills, Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { useStrictJson } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import {
  BASTION_PLAN,
  cancel,
  concurrencyLimit,
  ISOLATION_REJECTION,
  mergeOrderProblems,
  overlaps,
  spawnAll,
  spawnCall,
  statusOf,
  steer,
  tick,
  type Board,
  type Child,
  type FanoutPlan,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/fanout";
import { fanoutPlanBody } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { Chip, Section, ShowCode, Terminal, Verdict } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The subagent-fanout recipe as a planner and a board. "Plan the fan-out" asks the model for subtasks, the files each
 * touches, how each proves it's done and a merge order, as strict JSON; the board then spawns one write-capable
 * child per task in its own worktree, up to the host's concurrency limit, and lets the reader steer (queue or
 * interrupt), cancel and advance time, so the recipe's timing failures can be reproduced. It opens on the recipe's
 * own six tasks, so the board works before anything runs.
 */

export interface FanoutPlannerProps {
  slug: string;
  job?: string;
}

const JOBS: ReadonlyArray<{ label: string; job: string }> = [
  {
    label: "Bastion Breaker (the recipe's)",
    job: "This repo (Bastion Breaker) is a brick-out x space-invaders game. World rule: the player breaks bricks, but ENEMY lasers must NOT destroy bricks. There is a bug where enemy lasers do destroy bricks (game/engine.py _resolve_laser). Fan this work out to parallel subagents: (1) fix the enemy-laser-destroys-bricks bug, (2) add high-score persistence, (3) make bricks multi-colored by row from assets/bricks/*.png, (4) add a brick-shatter particle effect, (5) add a combo multiplier, (6) add a power-up drop from a broken brick.",
  },
  {
    label: "Docs refresh",
    job: "Our docs site (Markdown under docs/, built with a script in tools/build_docs.py) needs: a new getting-started page, every code sample re-checked against the v2 API, broken links fixed, and a dark-mode stylesheet. Split it into parallel subtasks.",
  },
  {
    label: "API migration",
    job: "Migrate our Flask service from the v1 payments client to v2: update the client wrapper in app/payments.py, the three routes in app/routes/ that call it, the webhook handler, and the tests in tests/test_payments.py. Plan it as parallel subtasks where it is safe to.",
  },
];

const STATE_TONE: Record<Child["state"], "ok" | "bad" | "warn" | "accent" | undefined> = {
  queued: undefined,
  running: "accent",
  result_ready: "ok",
  closing: "warn",
  cancelled: "bad",
  rejected: "bad",
};

export function FanoutPlanner(props: FanoutPlannerProps) {
  const id = useId();
  const [job, setJob] = useState(props.job ?? JOBS[0].job);
  const [cores, setCores] = useState(8);
  const [isolation, setIsolation] = useState(true);
  const [plan, setPlan] = useState<FanoutPlan>(BASTION_PLAN);
  const [planSource, setPlanSource] = useState<"recipe" | "model">("recipe");
  const [board, setBoard] = useState<Board>(() => spawnAll(BASTION_PLAN, { cores: 8, isolation: true }));
  const [target, setTarget] = useState("subagent-1");
  const [message, setMessage] = useState("After your loop, name the file ENGINE_NOTES.md and add a 'World Rules' section.");
  const [mode, setMode] = useState<"queue" | "interrupt">("queue");
  const [reason, setReason] = useState("descoping render notes");
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const live = useStrictJson<FanoutPlan>();
  const planning = live.state === "running";

  const respawn = (p = plan, c = cores, iso = isolation) => setBoard(spawnAll(p, { cores: c, isolation: iso }));
  const body = useMemo(() => fanoutPlanBody(model, job.trim() || JOBS[0].job), [model, job]);
  const runPlan = async () => {
    const { value } = await live.run(body);
    if (!value || !Array.isArray(value.tasks) || !value.tasks.length) return;
    const fixed: FanoutPlan = { ...value, tasks: value.tasks.slice(0, 8) };
    setPlan(fixed);
    setPlanSource("model");
    respawn(fixed);
    setTarget("subagent-1");
  };

  const limit = concurrencyLimit(cores);
  const problems = mergeOrderProblems(plan);
  const shared = overlaps(plan.tasks);
  const running = board.children.filter((c) => c.state === "running" || c.state === "closing").length;
  const done = board.children.every((c) => ["result_ready", "cancelled", "rejected"].includes(c.state));
  const child = board.children.find((c) => c.id === target);

  const worktreeLines = [
    { text: "git worktree list", tone: "cmd" as const },
    { text: `/home/.../repo                                          ${board.baseCommit} [master]` },
    ...board.children.filter((c) => c.worktree && c.state !== "queued").map((c) => ({ text: `/home/.../repo/${c.worktree}  ${board.baseCommit} (detached HEAD)` })),
  ];

  return (
    <div className={`pg ${styles.stack}`}>
      <PresetPills label="Job" presets={JOBS} active={JOBS.findIndex((j) => j.job === job)} onPick={(i) => setJob(JOBS[i].job)} disabled={planning} />
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-job`}>
          The job to fan out
        </label>
        <TextArea id={`${id}-job`} rows={4} value={job} onChange={(e) => setJob(e.target.value)} disabled={planning} />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">Strict JSON: tasks, files, a verify command each, and a merge order. Under a cent.</span>
          <RunButton running={planning} onRun={() => void runPlan()} onStop={live.abort} label="Plan the fan-out" disabled={!job.trim()} />
        </div>
      </div>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={planning} />
      </div>
      {planning || live.result ? (
        <ResponseView result={planning ? null : live.result} running={planning} elapsedMs={live.elapsedMs}>
          {live.value ? (
            <p>
              Planned {live.value.tasks.length} subagents. {live.value.notes}
            </p>
          ) : (
            <p className="pg-empty">{planning ? "Planning the subtasks..." : "No plan in this reply."}</p>
          )}
        </ResponseView>
      ) : null}
      <ErrorBox error={live.error} />
      <ShowCode body={live.body ?? body} caption={live.body ? "The request that just ran" : "The request Run sends"} />

      <Section title={planSource === "model" ? "The board: your plan" : "The board: the recipe's six tasks"}>
        <div className={`${styles.row} pg-advanced`}>
          <Toggle id={`${id}-iso`} label={<code>--subagent-worktree-isolation</code>} checked={isolation} onChange={(v) => { setIsolation(v); respawn(plan, cores, v); }} />
          <span className="pg-inline-field">
            <label className="pg-label" htmlFor={`${id}-cores`}>
              Host cores
            </label>
            <TextInput id={`${id}-cores`} className={styles.numberInput} type="number" min={1} max={64} value={cores} onChange={(e) => { const c = Math.max(1, Math.min(64, Number(e.target.value) || 1)); setCores(c); respawn(plan, c, isolation); }} />
          </span>
          <span className={styles.note}>
            Concurrency limit {limit} (about cores - 2, clamped to 4 to 8). {running} running.
          </span>
        </div>
        <div className="pg-advanced">
          <Terminal title="Launch" lines={[{ text: `muse${isolation ? " --subagent-worktree-isolation" : ""}`, tone: "cmd" }]} copy={false} />
        </div>
        {!isolation ? (
          <Verdict tone="bad" title="Spawn rejected · isolation is off for this profile">
            <p className={styles.note}>Retry without worktree_isolation, or enable native_subagent_worktree_isolation.</p>
            <pre className={styles.tree}>{JSON.stringify(ISOLATION_REJECTION)}</pre>
            <p className={styles.note}>Relaunch with <code>muse --subagent-worktree-isolation</code>, or fall back to <code>git worktree add -b taskN-branch ...</code> yourself, and then the worktree cleanup is yours.</p>
          </Verdict>
        ) : null}
        <div className={styles.row}>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setBoard((b) => tick(b))} disabled={done}>
            Advance one turn
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => setBoard((b) => {
              let x = b;
              for (let i = 0; i < 20 && !x.children.every((c) => ["result_ready", "cancelled", "rejected"].includes(c.state)); i++) x = tick(x);
              return x;
            })}
            disabled={done}
          >
            Run to the end
          </button>
          <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => respawn()}>
            Respawn
          </button>
          <span className={styles.note} role="status" aria-live="polite">
            Turn {board.tick}. {done ? "Every child has finished, was cancelled, or was rejected." : ""}
          </span>
        </div>
        <ul className={styles.cards} aria-label="Subagents">
          {board.children.map((c) => (
            <li key={c.id} className={`${styles.card} ${c.id === target ? styles.cardPicked : ""}`}>
              <div className={styles.spread}>
                <strong>{c.id}</strong>
                <Chip tone={STATE_TONE[c.state]}>{c.state}</Chip>
              </div>
              <p className={styles.cardText}>{c.task.objective}</p>
              <p className={styles.cardMeta}>
                <span>{c.task.role}</span>
                <span>
                  turn {c.turns} of {c.turnsNeeded}
                </span>
              </p>
              <div className={styles.progress} aria-hidden>
                <div className={styles.progressBar} style={{ width: `${Math.round((c.turns / c.turnsNeeded) * 100)}%` }} />
              </div>
              <p className={`${styles.note} pg-advanced`}>
                <span className="sr-only">Worktree: </span>
                {c.worktree ? <code>{c.worktree}</code> : "no worktree"}
                <br />
                Files: {c.task.files.join(", ") || "none listed"}
              </p>
              <p className={`${styles.note} pg-advanced`} title={c.task.verify}>
                Check: <code>{c.task.verify.length > 48 ? `${c.task.verify.slice(0, 45)}...` : c.task.verify}</code>
              </p>
              {c.note ? <p className={styles.why}>{c.note}</p> : null}
              <details className="pg-advanced">
                <summary className={styles.note}>subagent_spawn and the event log ({c.events.length})</summary>
                <pre className={styles.tree}>{[`subagent_spawn ${JSON.stringify(spawnCall(c.task))}`, ...c.events].join("\n")}</pre>
              </details>
              <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => setTarget(c.id)} aria-pressed={c.id === target}>
                Control {c.id}
              </button>
            </li>
          ))}
        </ul>

        {child ? (
          <div className={`${styles.split} pg-advanced`}>
            <div className={styles.tight}>
              <p className="pg-section-label">Steer {child.id} (subagent_send_message)</p>
              <Field id={`${id}-msg`} label="Message">
                <TextInput id={`${id}-msg`} value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
              <Segmented<"queue" | "interrupt">
                label="Delivery"
                size="sm"
                options={[
                  { value: "queue", label: "Queue (next turn)" },
                  { value: "interrupt", label: "Interrupt (preempt)" },
                ]}
                value={mode}
                onChange={setMode}
              />
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setBoard((b) => steer(b, child.id, message, mode))} disabled={!message.trim()}>
                Send
              </button>
              <p className={styles.note}>A queued message lands on the child&apos;s next turn, so it can arrive too late for a child about to finish. Use an interrupt for a hard redirect.</p>
            </div>
            <div className={styles.tight}>
              <p className="pg-section-label">Stop {child.id} (subagent_cancel)</p>
              <Field id={`${id}-reason`} label="Reason">
                <TextInput id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setBoard((b) => cancel(b, child.id, reason))}>
                Cancel
              </button>
              <p className={styles.note}>Cancel is cooperative: treat it as &quot;stop taking new work&quot;, not &quot;undo what is done&quot;. A finished child only records the reason (already_terminal).</p>
            </div>
          </div>
        ) : null}

        <div className={styles.split}>
          <div className={`${styles.tight} pg-advanced`}>
            <p className="pg-section-label">subagent_status</p>
            <JsonTree value={statusOf(board)} openDepth={2} />
          </div>
          <div className={styles.tight}>
            <div className="pg-advanced">
              <Terminal title="The worktrees on disk" lines={worktreeLines} />
            </div>
            <p className="pg-section-label pg-advanced">Merge order</p>
            <ol className="pg-list pg-advanced">
              {plan.merge_order.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))}
            </ol>
            {problems.length ? (
              <div className="pg-warn" role="note">
                <p className="pg-warn-title">The plan&apos;s merge order needs a look:</p>
                <ul>
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {shared.length ? (
              <p className={`${styles.note} pg-advanced`}>
                Isolated while they run, but these meet at merge time: {shared.map((o) => `${o.a} and ${o.b} (${o.files.join(", ")})`).join("; ")}.
              </p>
            ) : null}
          </div>
        </div>
        {planSource === "recipe" ? <p className={`${styles.note} pg-advanced`}>{BASTION_PLAN.notes}</p> : null}
      </Section>
    </div>
  );
}
