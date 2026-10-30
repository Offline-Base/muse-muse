"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, PresetPills, TextArea, TextInput, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { useStrictJson } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import {
  describeCron,
  expiresAt,
  firesWithinLifetime,
  formatFireWindow,
  formatLocal,
  isFixedDate,
  JITTER_CAP_MINUTES,
  jobId,
  LIFETIME_DAYS,
  nextFire,
  nextRuns,
  parseCron,
  recovery,
  type Job,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/cron";
import { scheduleBody, type Translation } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { Chip, Section, ShowCode, Terminal, Verdict } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The loop-and-cron recipe as a schedule builder. A /loop request in plain words goes to the model, which returns the
 * stored job as strict JSON (a five-field cron in local time, recurring or one-time, the task); a local validator then
 * checks the expression and shows its next fire times in your timezone, the jitter window, the seven-day lifetime,
 * and the job in a session-scoped list you can run once, cancel, or recover after closing Muse Code.
 */

export interface ScheduleBuilderProps {
  slug: string;
  request?: string;
}

const REQUESTS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "Morning digest", text: "/loop every morning at 8am, triage new bugs from bugs/BUGS.md and post a digest to docs/BUG_DIGEST.md" },
  {
    label: "One-time review check",
    text: "Schedule a one-time job for tomorrow at 2pm local time to check whether D114486376 has review comments and summarize them. Do not inspect the diff now. Only create the scheduled job and report its ID and schedule.",
  },
  { label: "Every 15 minutes", text: "/loop every 15 minutes on weekdays between 9am and 5pm, check CI and summarize any new failures" },
  { label: "Weekly", text: "/loop every Monday at 10am, write the weekly changelog to docs/CHANGELOG.md" },
];

export function ScheduleBuilder(props: ScheduleBuilderProps) {
  const id = useId();
  const [request, setRequest] = useState(props.request ?? REQUESTS[0].text);
  const [cron, setCron] = useState("0 8 * * *");
  const [recurring, setRecurring] = useState(true);
  const [task, setTask] = useState("triage new bugs from bugs/BUGS.md and post a digest to docs/BUG_DIGEST.md");
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [now, setNow] = useState<number | null>(null);
  const [zone, setZone] = useState("your local timezone");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [session, setSession] = useState("session-1");
  const [sessions, setSessions] = useState(["session-1"]);
  const [closedHours, setClosedHours] = useState(30);
  const [recovered, setRecovered] = useState<Array<{ job: Job; missed: number; catchUpRuns: number; note: string }> | null>(null);
  const live = useStrictJson<Translation>();
  const translating = live.state === "running";

  // Times are the browser's own: computed after mount, so the server's clock and timezone never show.
  useEffect(() => {
    setNow(Date.now());
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone");
  }, []);

  const parsed = useMemo(() => parseCron(cron), [cron]);
  const runs = useMemo(() => (parsed.ok && now !== null ? nextRuns(parsed.cron, new Date(now), recurring ? 5 : 1) : []), [parsed, now, recurring]);
  const draft: Job | null = parsed.ok && now !== null ? { id: "draft", cron: parsed.cron.expression, recurring, task, createdAt: now, session, lastFiredAt: null, fireCount: 0 } : null;
  const mine = jobs.filter((j) => j.session === session);

  const body = scheduleBody(model, request.trim() || REQUESTS[0].text, new Date(now ?? 0), zone);
  const translate = async () => {
    if (!request.trim() || translating) return;
    const nowMs = Date.now();
    setNow(nowMs);
    const { value } = await live.run(scheduleBody(model, request.trim(), new Date(nowMs), zone));
    if (!value) return;
    setCron(value.cron);
    setRecurring(value.recurring);
    setTask(value.task);
  };

  const create = () => {
    if (!draft) return;
    setJobs((list) => [...list, { ...draft, id: jobId(), createdAt: Date.now() }]);
    setRecovered(null);
  };
  const fireOnce = (jid: string) => setJobs((list) => list.map((j) => (j.id === jid ? { ...j, lastFiredAt: Date.now(), fireCount: j.fireCount + 1 } : j)).filter((j) => j.recurring || j.fireCount === 0 || j.id !== jid));
  const cancelJob = (jid: string) => setJobs((list) => list.filter((j) => j.id !== jid));
  const newSession = () => {
    const next = `session-${sessions.length + 1}`;
    setSessions((s) => [...s, next]);
    setSession(next);
    setRecovered(null);
  };
  const closeFor = () => {
    const start = Date.now();
    const end = start + closedHours * 3600 * 1000;
    setRecovered(mine.map((job) => ({ job, ...recovery(job, start, end) })));
  };

  const one = parsed.ok && !recurring;
  return (
    <div className={`pg ${styles.stack}`}>
      <PresetPills presets={REQUESTS.map((r) => ({ label: r.label }))} active={REQUESTS.findIndex((r) => r.text === request)} onPick={(i) => setRequest(REQUESTS[i].text)} disabled={translating} />
      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-req`}>
          Scheduling request
        </label>
        <TextArea id={`${id}-req`} rows={3} value={request} onChange={(e) => setRequest(e.target.value)} onKeyDown={runOnModEnter(() => void translate())} disabled={translating} />
        <div className="pg-composer-bar">
          <span className="pg-muted pg-kbd-hint">The model returns the job as strict JSON; the expression is then checked here. Under a cent.</span>
          <RunButton running={translating} onRun={() => void translate()} onStop={live.abort} label="Translate to a job" disabled={!request.trim()} />
        </div>
      </div>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={translating} />
      </div>
      {translating || live.result ? (
        <ResponseView result={translating ? null : live.result} running={translating} elapsedMs={live.elapsedMs}>
          {live.value ? (
            <div className={styles.tight}>
              <p>
                <code>{live.value.cron}</code> {live.value.recurring ? <Chip tone="accent">recurring</Chip> : <Chip>one-time</Chip>} {live.value.also_run_now ? <Chip tone="warn">also runs it in this turn</Chip> : <Chip>only schedules it</Chip>}
              </p>
              <p>{live.value.task}</p>
              {live.value.notes ? <p className={styles.note}>{live.value.notes}</p> : null}
            </div>
          ) : (
            <p className="pg-empty">{translating ? "Translating the cadence..." : "No job in this reply."}</p>
          )}
        </ResponseView>
      ) : null}
      <ErrorBox error={live.error} />
      <ShowCode body={live.body ?? body} caption={live.body ? "The request that just ran" : "The request Run sends"} />

      <Section title="Check the stored job">
        <div className={styles.split}>
          <div className={styles.tight}>
            <Field id={`${id}-cron`} label="Cron expression (local time)" hint="minute hour day-of-month month day-of-week">
              <TextInput id={`${id}-cron`} className="pg-code-input" value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} aria-describedby={`${id}-cron-hint`} />
            </Field>
            <div className="pg-advanced">
              <Toggle id={`${id}-rec`} label="Recurring" checked={recurring} onChange={setRecurring} />
            </div>
            <Field id={`${id}-task`} label="Task" className="pg-advanced">
              <TextInput id={`${id}-task`} value={task} onChange={(e) => setTask(e.target.value)} />
            </Field>
          </div>
          <div className={styles.tight} aria-live="polite">
            {parsed.ok ? (
              <>
                <p>
                  <strong>{describeCron(parsed.cron)}</strong>
                  {one && !isFixedDate(parsed.cron) ? <span className="pg-bad"> A one-time job should pin one date (minute, hour, day of month, month).</span> : null}
                </p>
                {now === null ? (
                  <p className="pg-empty">Working out the next fire times in your timezone...</p>
                ) : (
                  <>
                    <p className={styles.note}>Next fire times in {zone}:</p>
                    <ol className="pg-list">
                      {runs.map((r) => (
                        <li key={r.getTime()}>
                          {formatLocal(r)}
                          {recurring ? <span className="pg-muted"> (eligible up to {JITTER_CAP_MINUTES} min later)</span> : null}
                        </li>
                      ))}
                    </ol>
                    {draft ? (
                      <p className={`${styles.note} pg-advanced`}>
                        {recurring
                          ? `Recurring jobs get deterministic forward jitter, capped at ${JITTER_CAP_MINUTES} minutes, and expire ${LIFETIME_DAYS} days after creation: created now, it expires ${formatLocal(new Date(expiresAt(draft)!))}, after ${firesWithinLifetime(draft)} fire(s).`
                          : "A one-time job deletes itself after its prompt is accepted for delivery."}
                      </p>
                    ) : null}
                  </>
                )}
              </>
            ) : (
              <Verdict tone="bad" title="Not a valid five-field expression">
                <ul className="pg-list">
                  {parsed.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Verdict>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={create} disabled={!draft || !task.trim()}>
              Create the job in {session}
            </button>
          </div>
        </div>
      </Section>

      <Section title="List, run, cancel">
        <div className={`${styles.row} pg-advanced`}>
          <span className="pg-inline-field">
            <label className="pg-label" htmlFor={`${id}-session`}>
              Session
            </label>
            <span className="select-wrap">
              <select id={`${id}-session`} className="select pg-select" value={session} onChange={(e) => { setSession(e.target.value); setRecovered(null); }}>
                {sessions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </span>
          </span>
          <button type="button" className="btn btn-sm btn-outline" onClick={newSession}>
            Start a new session
          </button>
        </div>
        {sessions.length > 1 ? (
          <p className={`${styles.note} pg-advanced`} role="status">
            {session === sessions[sessions.length - 1]
              ? `${session} has its own job list. Pick an earlier session to resume it and restore its scheduler.`
              : `Resumed ${session}: its scheduler and its jobs are back.`}
          </p>
        ) : null}
        <Terminal
          title="List my scheduled jobs."
          lines={[
            { text: "List my scheduled jobs. Show only each ID, cadence, and task.", tone: "prompt" },
            ...(mine.length ? mine.map((j) => ({ text: `${j.id}  ${j.cron.padEnd(14)}  ${j.recurring ? "recurring" : "one-time "}  ${j.task}` })) : [{ text: `No scheduled jobs in ${session}.${jobs.length ? " Jobs belong to the session that created them." : ""}`, tone: "muted" as const }]),
          ]}
          live
        />
        {mine.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Scheduled jobs in this session</caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Cadence</th>
                  <th scope="col">Next eligible fire</th>
                  <th scope="col">Last fire</th>
                  <th scope="col">Fires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mine.map((j) => {
                  const next = now === null ? null : nextFire(j, Date.now());
                  return (
                    <tr key={j.id}>
                      <td>
                        <code className={styles.nowrap}>{j.id}</code>
                      </td>
                      <td>
                        <code>{j.cron}</code>
                        <div className={styles.note}>{(() => { const p = parseCron(j.cron); return p.ok ? describeCron(p.cron) : ""; })()}</div>
                      </td>
                      <td>
                        {next ? formatFireWindow(next, j.recurring) : j.recurring ? "expired" : "delivered"}
                        {next && j.recurring ? <div className={styles.note}>the base match, then up to {JITTER_CAP_MINUTES} min of jitter</div> : null}
                      </td>
                      <td>{j.lastFiredAt ? formatLocal(new Date(j.lastFiredAt)) : "never"}</td>
                      <td>{j.fireCount}</td>
                      <td>
                        <div className={styles.row}>
                          <button type="button" className="btn btn-sm btn-outline" onClick={() => fireOnce(j.id)}>
                            Run once now
                          </button>
                          <button type="button" className="btn btn-sm btn-outline" onClick={() => cancelJob(j.id)} aria-label={`Cancel scheduled job ${j.id}`}>
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className={`${styles.note} pg-advanced`}>
          Muse Code offers create, list and delete. To change a cadence or a prompt, cancel the job and create a replacement. &quot;Run once now&quot; runs the stored task without creating another job; a one-time job then deletes itself.
        </p>
        <div className={`${styles.row} pg-advanced`}>
          <label className="pg-label" htmlFor={`${id}-closed`}>
            Close Muse Code for
          </label>
          <TextInput id={`${id}-closed`} className={styles.numberInput} type="number" min={1} max={240} value={closedHours} onChange={(e) => setClosedHours(Math.max(1, Math.min(240, Number(e.target.value) || 1)))} />
          <span className={styles.note}>hours</span>
          <button type="button" className="btn btn-sm btn-outline" onClick={closeFor} disabled={!mine.length}>
            Close, then resume
          </button>
        </div>
        {recovered ? (
          <Terminal
            title="After the session resumes"
            lines={recovered.map((r) => ({ text: `${r.job.id}: missed ${r.missed}, catch-up runs ${r.catchUpRuns}. ${r.note}`, tone: r.catchUpRuns ? ("warn" as const) : ("muted" as const) }))}
            live
          />
        ) : null}
        <p className={`${styles.note} pg-advanced`}>
          Jobs fire only while Muse Code runs, in the machine&apos;s local timezone. Use a system or hosted scheduler for work that must run with the terminal closed or for longer than {LIFETIME_DAYS} days.
        </p>
      </Section>
    </div>
  );
}
