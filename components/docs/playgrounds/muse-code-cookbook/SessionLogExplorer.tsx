"use client";

import { useEffect, useId, useMemo, useState, type ChangeEvent } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { useStrictJson } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { reviewBody as makeReviewBody, type Review } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { sha256Hex } from "@/components/docs/playgrounds/muse-code-cookbook/logic/replay";
import { LOG_SAMPLES, logSample, type SampleId } from "@/components/docs/playgrounds/muse-code-cookbook/logic/samples";
import {
  approvalChains,
  authorizationSummary,
  buildLedger,
  diagnostics,
  explainDecision,
  exportDocument,
  jqDuplicateKeys,
  jqSpine,
  jqWindow,
  ledgerPlain,
  ledgerSummary,
  liveOnlyRecords,
  offsetSeconds,
  parseSessionLog,
  redactValue,
  resumeReport,
  sessionIdOf,
  type LogRecord,
  type ResumeReport,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/session-log";
import { BreakAfter, Chip, Section, ShowCode, Terminal, Verdict, linesOf, type TermLine } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The audit recipe's walk through a session log, in the browser: a real Muse Code log (or an excerpt rebuilt from the
 * recipe, or the reader's own session.jsonl, read locally and never uploaded) as a timeline in lanes, the ledger of
 * who authorized each action, the approval chain, what `muse resume` would find if the process died at any record,
 * and what `muse export` would say about it. "Hand it to a reviewer" sends the ledger (not the log) to the model.
 */

export interface SessionLogExplorerProps {
  slug: string;
  sample?: SampleId;
}

type Source = SampleId | "own";
type View = "timeline" | "ledger" | "approvals" | "resume" | "export";

/** Records the timeline folds away unless asked: lifecycle bookkeeping and stream notices. */
const BOOKKEEPING = new Set(["accepted", "scheduled", "started", "task_stream_linked", "session_run_linked", "command_accepted", "status"]);

const OWN_LIMIT = 3 * 1024 * 1024;

function laneClass(r: LogRecord): string {
  return `${styles.chip} ${styles.lane} ${styles[`lane_${r.lane}`] ?? ""}`;
}

function offsetLabel(records: readonly LogRecord[], r: LogRecord): string {
  const s = offsetSeconds(records, r);
  return s === null ? "" : `+${s.toFixed(1)}s`;
}

/**
 * What to say under the rebuilt export header: which keys are this page's counts, why the log reads as it ends, and
 * what its diagnostics mean for this log (a muse exec stream keeps its live-only records inline; an excerpt skips
 * sequences on purpose).
 */
function exportNotes(sampleId: SampleId | null, excerpt: boolean, report: ResumeReport, diag: ReturnType<typeof diagnostics>, liveOnly: number): string[] {
  const runEnded = report.ending.startsWith("run ") ? `run.terminal.${report.ending.slice(4)}` : null;
  const ending = report.orderlyEnd
    ? "session_terminated_abnormally is false because the log ends with a session.end fact."
    : report.ending === "crash_inferred"
      ? "The log ends with session.end crash_inferred: the process was killed, so it reads session_terminated_abnormally: true."
      : sampleId === "exec"
        ? runEnded
          ? `This muse exec --json stream ends with ${runEnded} and records no session.end fact, so the rebuild reads session_terminated_abnormally: true. An interactive session you quit with /quit ends with session.end instead.`
          : "Cut before the run's end: nothing marks an end yet, so it reads session_terminated_abnormally: true."
        : runEnded
          ? `The last run ended (${runEnded}), but no session.end fact is recorded (the session was still open, or was killed), so it reads session_terminated_abnormally: true. Quit with /quit before exporting a finished session.`
          : "No orderly end is recorded (exported mid-session, or the process was killed), so it reads session_terminated_abnormally: true. Quit with /quit before exporting a finished session.";
  const diagLine = excerpt
    ? "This excerpt leaves sequences out on purpose, so gaps counts those, not live-only omissions, and turn_count and step_count count only the records it keeps."
    : diag.omitted_live_only === 0 && liveOnly > 0
      ? `It keeps its ${liveOnly} live-only record(s) (streaming deltas and status) inline, so nothing was omitted: gaps ${diag.gaps}, omitted_live_only 0.`
      : diag.gaps === 0 && diag.omitted_live_only === 0
        ? "No gaps: every sequence number is there, and no live-only record was left out."
        : diag.gaps === diag.omitted_live_only
          ? "gaps equals omitted_live_only: every gap is a deliberate live-only omission."
          : "gaps doesn't equal omitted_live_only: some gaps aren't explained by live-only markers.";
  return [
    ending,
    diagLine,
    "Rebuilt here with the recipe's header keys. turn_count counts run.lifecycle.started records, step_count the session stream's records, and unknown_payload_kinds the envelopes this page's parser doesn't read; Muse Code's exporter also stamps exporter_version and session_build.",
  ];
}

/** True when the log's timestamps span at least a second; the real exec sample's are microseconds apart. */
function hasTiming(records: readonly LogRecord[]): boolean {
  const times = records.map((r) => r.at).filter((t): t is number => t !== null);
  return times.length > 1 && Math.max(...times) - Math.min(...times) >= 1e6;
}

export function SessionLogExplorer(props: SessionLogExplorerProps) {
  const id = useId();
  const [source, setSource] = useState<Source>(props.sample ?? "exec");
  const [ownText, setOwnText] = useState("");
  const [ownName, setOwnName] = useState<string | null>(null);
  const [ownProblem, setOwnProblem] = useState<string | null>(null);
  const [view, setView] = useState<View>("timeline");
  const [hideBookkeeping, setHideBookkeeping] = useState(true);
  const [withModel, setWithModel] = useState(false);
  const [redacted, setRedacted] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [hashes, setHashes] = useState<{ a: string; b: string; flags: "same" | "other" } | null>(null);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const reviewer = useStrictJson<Review>();
  const reviewing = reviewer.state === "running";

  const sample = source === "own" ? null : logSample(source);
  const parsed = useMemo(() => parseSessionLog(sample ? sample.lines : ownText), [sample, ownText]);
  const total = parsed.records.length;
  const [keep, setKeep] = useState(total);
  // A new log starts whole: nothing killed yet.
  useEffect(() => {
    setKeep(total);
    setSelected(null);
    setHashes(null);
  }, [total, source, ownText]);

  const kept = useMemo(() => parsed.records.slice(0, keep), [parsed, keep]);
  const killed = keep < total;
  const sessionId = sessionIdOf(parsed.records);
  const report = useMemo(() => resumeReport(parsed.records, keep), [parsed, keep]);
  const rows = useMemo(() => buildLedger(kept), [kept]);
  const termination = report.orderlyEnd ? "clean" : report.ending === "none" ? "no orderly end" : report.ending;
  const ledgerText = useMemo(() => ledgerPlain(sessionId, kept, rows, termination, withModel), [sessionId, kept, rows, termination, withModel]);
  const chains = useMemo(() => approvalChains(kept), [kept]);
  const auth = useMemo(() => authorizationSummary(kept), [kept]);
  const visible = kept.filter((r) => !hideBookkeeping || !BOOKKEEPING.has(r.kind));
  const timed = useMemo(() => hasTiming(parsed.records), [parsed]);
  const inspected = selected === null ? null : kept.find((r) => r.line === selected) ?? null;

  const lines = sample ? sample.lines : ownText;
  const exportDoc = useMemo(() => exportDocument(lines, keep, redacted), [lines, keep, redacted]);
  const redactionHits = useMemo(() => (redacted ? redactValue(kept.map((r) => r.raw)).hits.length : 0), [kept, redacted]);

  const loadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > OWN_LIMIT) {
      setOwnProblem("That file is over 3 MB. Export a shorter session, or paste the part you want to read.");
      return;
    }
    setOwnProblem(null);
    setOwnName(file.name);
    setOwnText(await file.text());
    setSource("own");
  };

  const reviewBody = makeReviewBody(model, ledgerSummary(parsed.records, keep));

  const exportCommand = `muse export --session ${sessionId ? sessionId.slice(0, 8) : "<session-id>"}${redacted ? " --redacted --out share.json" : " --out trajectory.json"}`;
  // Two rebuilds of the export: with the same flags they match (the property cmp checks), and with --redacted
  // flipped they don't, the recipe's "two exports do not match" case.
  const compareExports = async (flags: "same" | "other") => {
    const a = JSON.stringify(exportDocument(lines, keep, redacted), null, 2);
    const b = JSON.stringify(exportDocument(lines, keep, flags === "same" ? redacted : !redacted), null, 2);
    setHashes({ a: await sha256Hex(a), b: await sha256Hex(b), flags });
  };
  const notes = exportNotes(sample?.id ?? null, sample?.excerpt ?? false, report, diagnostics({ ...parsed, records: kept }), liveOnlyRecords({ ...parsed, records: kept }));

  const resumeLines: TermLine[] = [
    { text: "muse resume --last", tone: "cmd" },
    { text: `Re-opened session ${sessionId ? sessionId.slice(0, 8) : "(unknown)"}; replaying ${kept.length} records as history.`, tone: "muted" },
    ...report.committed.map((s) => ({ text: `done      ${s.intent.sequence}  ${s.intent.operation}  (terminal at ${s.terminal!.sequence}): not run again`, tone: "ok" as const })),
    ...report.inFlight.map((s) => ({
      text: `unknown   ${s.intent.sequence}  ${s.intent.operation}  (no terminal record): reported as unknown, checked before any retry`,
      tone: "warn" as const,
    })),
    ...(report.inFlight.length || report.committed.length ? [] : [{ text: "No side effects were announced yet.", tone: "muted" as const }]),
  ];

  const tabs: Array<{ id: View; label: string; count?: number }> = [
    { id: "timeline", label: "Timeline", count: kept.length },
    { id: "ledger", label: "Ledger", count: rows.filter((r) => r.lane !== "model").length },
    { id: "approvals", label: "Approvals", count: chains.length },
    { id: "resume", label: "Resume", count: report.inFlight.length || undefined },
    { id: "export", label: "Export" },
  ];

  return (
    <div className={`pg ${styles.stack}`}>
      <div className={styles.spread}>
        <Segmented<Source>
          label="Session log"
          options={[...LOG_SAMPLES.map((s) => ({ value: s.id as Source, label: s.label })), { value: "own", label: "Your log" }]}
          value={source}
          onChange={setSource}
        />
        <span className={`btn btn-sm btn-outline ${styles.fileButton}`}>
          Open a session.jsonl
          <input type="file" accept=".jsonl,.json,.txt,application/json,text/plain" aria-label="Open a session.jsonl from your computer" onChange={(e) => void loadFile(e)} />
        </span>
      </div>
      {sample ? (
        <p className={`${styles.note} pg-advanced`}>
          {sample.description}
          {sample.excerpt ? " Rebuilt from the records the recipe quotes; fields it doesn't show are filled in, and sequences it doesn't show are left out." : ""}
        </p>
      ) : (
        <div className={styles.tight}>
          <p className={styles.note}>
            Paste a Muse Code session.jsonl (from ~/.local/share/muse/sessions/YYYY/MM/DD/&lt;session-id&gt;/) or open one. It&apos;s read in your browser and never uploaded.
            {ownName ? ` Opened ${ownName}.` : ""}
          </p>
          <label className="sr-only" htmlFor={`${id}-own`}>
            Session log lines
          </label>
          <TextArea id={`${id}-own`} rows={4} className="pg-code-input" value={ownText} placeholder='{"schema_version":1,"sequence":1,...}' onChange={(e) => setOwnText(e.target.value)} spellCheck={false} />
          {ownProblem ? <div className="pg-hint pg-bad">{ownProblem}</div> : null}
          {parsed.unparseable.length ? <div className="pg-hint pg-bad">Skipped {parsed.unparseable.length} line(s) that aren&apos;t envelopes: {parsed.unparseable.slice(0, 6).join(", ")}{parsed.unparseable.length > 6 ? "..." : ""}.</div> : null}
        </div>
      )}

      {total ? (
        <div className={`${styles.tight} pg-advanced`}>
          <label className="pg-label" htmlFor={`${id}-kill`}>
            Kill the process after record {keep} of {total}
            {kept.length ? ` (sequence ${kept[kept.length - 1].sequence}, ${kept[kept.length - 1].jqKind ?? kept[kept.length - 1].kind})` : ""}
          </label>
          <div className={styles.row}>
            <input
              id={`${id}-kill`}
              className={styles.range}
              type="range"
              min={1}
              max={total}
              value={keep}
              onChange={(e) => setKeep(Number(e.target.value))}
              aria-describedby={`${id}-kill-hint`}
            />
            {killed ? (
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setKeep(total)}>
                Let it finish
              </button>
            ) : null}
          </div>
          <p className="pg-hint" id={`${id}-kill-hint`}>
            Like <code>pkill -9 -x muse</code>: the log keeps what was written before that point. The Resume tab shows what <code>muse resume</code> would find.
          </p>
        </div>
      ) : (
        <p className="pg-empty">No envelopes yet. Paste or open a session log, or pick a sample.</p>
      )}

      {total ? (
        <>
          <Tabs<View> label="Views of the log" idBase={id} tabs={tabs} value={view} onChange={setView} />
          <TabPanel idBase={id} id="timeline" active={view === "timeline"}>
            <div className={styles.stack}>
              <div className={`${styles.row} pg-advanced`}>
                <Toggle id={`${id}-bk`} label="Hide bookkeeping (accepted, scheduled, started, stream notices)" checked={hideBookkeeping} onChange={setHideBookkeeping} />
              </div>
              <ol className={styles.timeline} aria-label="Records in order">
                {visible.map((r) => (
                  <li key={r.line}>
                    <button type="button" className={`${styles.timelineRow} ${timed ? "" : styles.timelineUntimed}`} aria-pressed={selected === r.line} onClick={() => setSelected(selected === r.line ? null : r.line)}>
                      <span className={styles.timelineSeq}>{r.sequence}</span>
                      {timed ? <span className={styles.timelineAt}>{offsetLabel(parsed.records, r)}</span> : null}
                      <span className={laneClass(r)}>{r.lane}</span>
                      <span className={styles.timelineText}>
                        <span className={styles.timelineKind}>{r.jqKind ?? r.kind}</span>
                        {r.summary}
                      </span>
                    </button>
                  </li>
                ))}
                {killed ? (
                  <li className={styles.cutLine} role="note">
                    kill -9 here: the {total - keep} record(s) after sequence {report.lastSequence} were never written
                  </li>
                ) : null}
              </ol>
              {inspected ? (
                <div className={styles.tight} aria-live="polite">
                  <p className="pg-section-label">
                    Record {inspected.sequence} (line {inspected.line}){redacted ? ", redacted" : ""}
                  </p>
                  <JsonTree value={redacted ? redactValue(inspected.raw).value : inspected.raw} openDepth={4} />
                </div>
              ) : (
                <p className={`${styles.note} pg-advanced`}>Pick a record to see its whole envelope.</p>
              )}
            </div>
          </TabPanel>

          <TabPanel idBase={id} id="ledger" active={view === "ledger"}>
            <div className={styles.stack}>
              <div className="pg-advanced">
                <Toggle id={`${id}-model`} label="Include model calls (auth=not_applicable)" checked={withModel} onChange={setWithModel} />
              </div>
              <Terminal title="build_ledger.py --plain" lines={[{ text: "python3 artifacts/build_ledger.py trajectory.json --plain", tone: "cmd" }, ...linesOf(ledgerText)]} wrap={false} />
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="sr-only">Who authorized each action</caption>
                  <thead>
                    <tr>
                      <th scope="col">policy_decision</th>
                      <th scope="col">Intents</th>
                      <th scope="col">What it means</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auth.map((a) => (
                      <tr key={a.decision}>
                        <td>
                          <code className={styles.argv}>
                            <BreakAfter text={a.decision} />
                          </code>
                        </td>
                        <td>{a.count}</td>
                        <td>{a.meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={`${styles.note} pg-advanced`}>Every side_effect_intent carries its policy_decision, and it lands before the effect runs, so the session reduces to this ledger.</p>
            </div>
          </TabPanel>

          <TabPanel idBase={id} id="approvals" active={view === "approvals"}>
            {chains.length ? (
              <div className={styles.stack}>
                {chains.map((c) => {
                  const jq = jqWindow(kept, c.steps[0].sequence, Math.max(...kept.filter((r) => r.taskId === c.steps[0].taskId).map((r) => r.sequence), c.steps[c.steps.length - 1].sequence));
                  return (
                    <div key={c.pendingActionId} className={styles.stack}>
                      <Verdict tone={c.decision === "approved" ? "ok" : c.decision ? "bad" : "warn"} title={`${c.command ?? "An action"}: ${c.decision ?? "waiting for a decision"}`} live={false}>
                        <p className={`${styles.note} pg-advanced`}>
                          Threaded by pending_action_id <code>{c.pendingActionId}</code>.{" "}
                          {c.intent ? (
                            <>
                              The intent at sequence {c.intent.sequence} carries <code>{c.intent.policyDecision}</code>: {explainDecision(c.intent.policyDecision)}.
                            </>
                          ) : (
                            "No intent landed: the effect was never authorized, so it never ran."
                          )}
                        </p>
                      </Verdict>
                      <Terminal title="The approval window" lines={[{ text: jq.command, tone: "cmd" }, ...jq.output.map((o) => ({ text: o }))]} />
                      {c.authorizer ? (
                        <div className={styles.tight}>
                          <p className="pg-section-label">decision_source: who allowed it</p>
                          <JsonTree value={c.authorizer} />
                          <p className={`${styles.note} pg-advanced`}>A static policy allow reads allow:policy. A reviewer decision reads allow:llm_judge and carries the reviewer&apos;s prompt_version and a context_digest that pins exactly what it saw.</p>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <Verdict tone="info" title="No approval records in this log" live={false}>
                <p className={styles.note}>
                  Ordinary tool calls clear static policy (allow:policy), so nothing went to review. A command the policy calls dangerous, such as <code>rm -rf</code> on a file, escalates. With <code>--yolo</code> there is no approval.review stream at all. Pick the Approval window sample to walk one.
                </p>
              </Verdict>
            )}
          </TabPanel>

          <TabPanel idBase={id} id="resume" active={view === "resume"}>
            <div className={styles.stack}>
              {report.inFlight.length ? (
                <Verdict tone="warn" title={`${report.inFlight.length} effect(s) announced but never confirmed`}>
                  <p className={styles.note}>Each has an intent and no terminal record. The resumed turn reports it as unknown instead of retrying, and checks actual state first, so nothing runs twice.</p>
                </Verdict>
              ) : (
                <Verdict tone="ok" title={`Nothing to reconcile: ${report.committed.length} effect(s), each with its terminal record`}>
                  <p className={`${styles.note} pg-advanced`}>{killed ? "The kill landed between effects." : "Move the slider to kill the process mid-task and see what a resume would find."}</p>
                </Verdict>
              )}
              <Terminal title="muse resume (simulated from the log)" lines={resumeLines} live />
              <div className={styles.row}>
                <Chip tone={report.orderlyEnd ? "ok" : "warn"}>Ending: {termination}</Chip>
                {report.resumedFrom !== null ? <Chip tone="accent">session.resumed: resumed_from_sequence {report.resumedFrom}</Chip> : null}
                <Chip tone={report.duplicateKeys.length ? "bad" : "ok"}>{report.duplicateKeys.length ? `${report.duplicateKeys.length} idempotency key(s) fired twice` : "No idempotency key fired twice"}</Chip>
              </div>
              {report.resumedFrom !== null ? (
                <p className={`${styles.note} pg-advanced`}>Everything at or below resumed_from_sequence is replayed history; everything above it is new, so rebuilding earlier work re-runs none of it.</p>
              ) : null}
              <div className={`${styles.stack} pg-advanced`}>
                <Terminal title="The crash and resume spine" lines={[{ text: jqSpine(kept).command, tone: "cmd" }, ...jqSpine(kept).output.map((o) => ({ text: o }))]} />
                <Terminal
                  title="No key fired twice"
                  lines={[{ text: jqDuplicateKeys(kept).command, tone: "cmd" }, ...(jqDuplicateKeys(kept).output.length ? jqDuplicateKeys(kept).output.map((o) => ({ text: o, tone: "err" as const })) : [{ text: "(no output)", tone: "muted" as const }])]}
                />
              </div>
            </div>
          </TabPanel>

          <TabPanel idBase={id} id="export" active={view === "export"}>
            <div className={styles.stack}>
              <div className={`${styles.row} pg-advanced`}>
                <Toggle id={`${id}-redact`} label={<>Share-safe export (<code>--redacted</code>)</>} checked={redacted} onChange={setRedacted} />
                {redacted ? <span className={styles.note}>{redactionHits ? `${redactionHits} string(s) redacted.` : "Nothing in this log matched the redaction rules."}</span> : null}
              </div>
              <Terminal title="Export" lines={[{ text: exportCommand, tone: "cmd" }, { text: `${redacted ? "share" : "trajectory"}.json: ${kept.length} events, one per log line, in order`, tone: "muted" }]} />
              <JsonTree value={{ ...exportDoc, events: `[${kept.length} records]` }} openDepth={3} />
              {notes.map((n) => (
                <p key={n} className={`${styles.note} pg-advanced`}>
                  {n}
                </p>
              ))}
              <p className={`${styles.note} pg-advanced`}>Redaction only removes; it can&apos;t un-redact what the log already stored.</p>
              <div className={`${styles.row} pg-advanced`}>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void compareExports("same")}>
                  Rebuild twice and compare
                </button>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void compareExports("other")}>
                  Compare with a {redacted ? "raw" : "--redacted"} export
                </button>
              </div>
              {hashes ? (
                <div className={styles.tight} role="status">
                  <span className={styles.mono}>
                    a.json {hashes.a.slice(0, 12)}... b.json {hashes.b.slice(0, 12)}... {hashes.a === hashes.b ? "byte-identical" : "differ"}
                  </span>
                  <p className={styles.note}>
                    {hashes.flags === "same"
                      ? "Same log bytes, same flags, same document: what cmp a.json b.json shows for Muse Code's own export. Both are rebuilt by this page, so this illustrates the property rather than testing Muse Code."
                      : "A raw export and a --redacted one of the same log never match: the recipe's \"two exports do not match\" case. Compare raw to raw, or redacted to redacted."}
                  </p>
                </div>
              ) : null}
            </div>
          </TabPanel>
        </>
      ) : null}

      <Section title="Hand it to a reviewer">
        <p className={`${styles.note} pg-advanced`}>
          Sends the ledger and the resume summary (not the raw log, and run through the redaction rules first) to the model, which answers what the agent did and who allowed each action. Under a cent.
        </p>
        <div className="pg-bar">
          <ModelSelect kind="text" value={model} onChange={setModel} disabled={reviewing} />
          <RunButton running={reviewing} onRun={() => void reviewer.run(reviewBody)} onStop={reviewer.abort} label="Review this session" disabled={!kept.length} />
        </div>
        {reviewing || reviewer.result ? (
          <ResponseView result={reviewing ? null : reviewer.result} running={reviewing} elapsedMs={reviewer.elapsedMs}>
            {reviewer.value ? (
              <div className={styles.stack}>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <caption className="sr-only">The reviewer&apos;s reading of each action</caption>
                    <thead>
                      <tr>
                        <th scope="col">Seq</th>
                        <th scope="col">Action</th>
                        <th scope="col">Authorized by</th>
                        <th scope="col">Concern</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reviewer.value.actions.map((a, i) => (
                        <tr key={`${a.sequence}-${i}`}>
                          <td>{a.sequence}</td>
                          <td>{a.action}</td>
                          <td>{a.authorized_by}</td>
                          <td>{a.concern || <span className="pg-muted">None</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {reviewer.value.follow_ups.length ? (
                  <ul className="pg-list">
                    {reviewer.value.follow_ups.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : null}
                <MarkdownText text={reviewer.value.summary} />
              </div>
            ) : (
              <p className="pg-empty">{reviewing ? "The reviewer is reading the ledger..." : "No review in this reply."}</p>
            )}
          </ResponseView>
        ) : null}
        <ErrorBox error={reviewer.error} />
        <ShowCode body={reviewer.body ?? reviewBody} caption={reviewer.body ? "The request that just ran" : "The request Run sends"} />
      </Section>
    </div>
  );
}
