"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, ErrorBox, ModelSelect, ResponseView, RunButton, Tabs, TextArea, Toggle, UsageLine, isAborted, useDocsRun } from "@/components/docs/kit";
import { collectReply } from "@/lib/docs/client/stream";
import { callWithRetries, pausable, retryMessage } from "@/components/docs/playgrounds/muse-code/agent-loop";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import {
  addTurn,
  AVAILABILITY_LABEL,
  contextOf,
  newTree,
  NOT_REWIND_POINTS,
  pathOf,
  PICKER_SAMPLE,
  pickerMove,
  previousIdFor,
  rewindTo,
  scrollbackOf,
  setDraft,
  type Availability,
  type Tree,
} from "@/components/docs/playgrounds/muse-code/rewind";
import { Chip, Notes, Panel, SelectField, type Tone } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The rewind page's demo, live: a real conversation on the Responses API where every turn is a stored response
 * chained with previous_response_id. Rewind (the /rewind button, or Esc twice from an idle, empty composer) opens the
 * picker; choosing an earlier input makes a new branch that continues from the response before it, with the input back
 * in the composer as an unsent draft, while the original conversation keeps every turn. A second tab walks the
 * picker's labels (Exact, Review required, Blocked) on a sample session.
 */

export interface RewindTimelineProps {
  slug: string;
  /** Inputs for "Play A, B, C". */
  script?: string[];
  instructions?: string;
}

type View = "live" | "picker";

const SCRIPT = [
  "I'm adding rate limiting to an Express API. Suggest one approach in two sentences.",
  "Show the middleware in under 12 lines of TypeScript.",
  "Now write one test for it in under 12 lines.",
];

const INSTRUCTIONS = "You are a coding assistant in a terminal. Keep answers short.";

const LABEL_TONE: Record<Availability, Tone> = { exact: "ok", review: "warn", blocked: "bad" };

interface PickerProps {
  rows: ReadonlyArray<{ text: string; label: Availability; detail: string }>;
  /** Called when the reader confirms Rewind conversation on a row. */
  onRewind(index: number): void;
  onClose(): void;
  /** Warnings the action screen shows for every row. */
  warnings: string[];
  label: string;
}

/** The rewind picker: a list of earlier inputs (Up, Down, Ctrl+P, Ctrl+N, Home, End, Enter, Esc) and its action screen. */
function Picker({ rows, onRewind, onClose, warnings, label }: PickerProps) {
  const id = useId();
  const [index, setIndex] = useState(rows.length - 1);
  const [action, setAction] = useState<number | null>(null);
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (action === null) listRef.current?.focus();
    else confirmRef.current?.focus();
  }, [action]);

  const open = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.label === "blocked") {
      setBlockedNote(`Blocked: ${row.detail} Enter doesn't continue from a blocked row.`);
      return;
    }
    setBlockedNote(null);
    setAction(i);
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const next = pickerMove(e.key, e.ctrlKey, index, rows.length);
    if (next !== null) {
      e.preventDefault();
      setIndex(next);
      setBlockedNote(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      open(index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (action !== null) {
    const row = rows[action];
    return (
      <div
        className={`${styles.card} ${styles.cardMuted}`}
        role="group"
        aria-label="Rewind action"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setAction(null);
          }
        }}
      >
        <p className={styles.cardTitle}>Rewind to message {action + 1}?</p>
        <p className="pg-small">
          <Chip tone={LABEL_TONE[row.label]}>{AVAILABILITY_LABEL[row.label]}</Chip> {row.detail}
        </p>
        <Notes items={warnings} />
        <div className="pg-actions">
          <button ref={confirmRef} type="button" className="btn btn-primary btn-sm" onClick={() => onRewind(action)}>
            Rewind conversation
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAction(null)}>
            Never mind
          </button>
        </div>
        <p className="pg-hint">Enter confirms. Esc goes back to the picker.</p>
      </div>
    );
  }

  return (
    <div className="pg-col">
      <p className="pg-section-label" id={`${id}-label`}>
        {label}
      </p>
      <ul
        ref={listRef}
        className={styles.picker}
        role="listbox"
        tabIndex={0}
        aria-labelledby={`${id}-label`}
        aria-activedescendant={`${id}-row-${index}`}
        onKeyDown={onListKey}
      >
        {rows.map((r, i) => (
          <li
            key={i}
            id={`${id}-row-${i}`}
            role="option"
            aria-selected={i === index}
            className={`${styles.pickerRow}${i === index ? ` ${styles.pickerRowActive}` : ""}`}
            onClick={() => {
              setIndex(i);
              open(i);
            }}
          >
            <span className="pg-muted pg-small">{i + 1}</span>
            <span className={styles.pickerText}>{r.text}</span>
            <Chip tone={LABEL_TONE[r.label]}>{AVAILABILITY_LABEL[r.label]}</Chip>
          </li>
        ))}
      </ul>
      <div className={blockedNote ? "pg-hint" : "pg-hint pg-advanced"} role="status" aria-live="polite">
        {blockedNote ?? "Up and Down (or Ctrl+P and Ctrl+N), Home and End to choose; Enter opens the action screen; Esc leaves the picker."}
      </div>
      <div className="pg-actions pg-advanced">
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
          Close the picker
        </button>
      </div>
    </div>
  );
}

export function RewindTimeline({ script: scriptProp, instructions: instructionsProp }: RewindTimelineProps) {
  const idBase = useId();
  const script = scriptProp?.length ? scriptProp : SCRIPT;
  const instructions = instructionsProp ?? INSTRUCTIONS;
  const [view, setView] = useState<View>("live");
  const [tree, setTree] = useState<Tree>(newTree);
  const [current, setCurrent] = useState("b0");
  const [composer, setComposer] = useState(script[0]);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [escArmed, setEscArmed] = useState(false);
  const [noLog, setNoLog] = useState(false);
  // A send, with its retries, or the whole A, B, C script: Stop stays available for all of it.
  const [busy, setBusy] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [stoppedNote, setStoppedNote] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [samplePicker, setSamplePicker] = useState(true);
  const [sampleResult, setSampleResult] = useState<string | null>(null);
  const runner = useDocsRun();
  const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by Stop and Esc: nothing new is sent after it, not a retry and not the script's next turn.
  const stopped = useRef(false);
  const cancelWait = useRef<(() => void) | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const running = runner.state === "running" || busy;

  useEffect(
    () => () => {
      if (escTimer.current) clearTimeout(escTimer.current);
      // Leaving the page mid-backoff must not fire the retry later.
      stopped.current = true;
      cancelWait.current?.();
    },
    [],
  );

  const stop = () => {
    stopped.current = true;
    cancelWait.current?.();
    runner.abort();
  };

  /** After a send or the script ends: a stop leaves no stale error behind, just the note. */
  const settle = () => {
    setBusy(false);
    setRetryNote(null);
    if (stopped.current) {
      runner.reset();
      setStoppedNote(true);
    }
  };

  const bodyFor = (t: Tree, branch: string, input: string) => {
    const prev = previousIdFor(t, branch);
    return {
      model,
      instructions,
      input,
      ...(prev ? { previous_response_id: prev } : {}),
      reasoning: { effort: "low" },
      max_output_tokens: model === "muse-wonder-1.0" ? 800 : 1200,
    };
  };

  /**
   * One turn on the branch. Returns false when it failed or was stopped. A chained turn retries Meta's transient
   * stored-response errors with backoff, as the agent loop does (agent-loop.ts callWithRetries). A stopped turn is
   * never re-sent, and Stop during a backoff wait cancels the retry.
   */
  const sendTurn = async (branch: string, input: string): Promise<boolean> => {
    const body = bodyFor(treeRef.current, branch, input);
    const res = await callWithRetries(() => runner.run("responses", { body }), "previous_response_id" in body, {
      stopped: () => stopped.current,
      sleep: async (ms) => {
        const wait = pausable(ms);
        cancelWait.current = wait.cancel;
        await wait.done;
        cancelWait.current = null;
        setRetryNote(null);
      },
      onRetry: (attempt, ms, failed) => setRetryNote(retryMessage(attempt, ms, failed)),
    });
    if (stopped.current || isAborted(res) || !res.ok) return false;
    const reply = collectReply("responses", res.json);
    if (!reply.id) return false;
    const next = addTurn(treeRef.current, branch, { input, reply: reply.text || "(no text in the reply)", responseId: reply.id });
    treeRef.current = next;
    setTree(next);
    return true;
  };

  const send = async () => {
    const input = composer.trim();
    if (!input || running) return;
    stopped.current = false;
    setStoppedNote(false);
    setBusy(true);
    setComposer("");
    const ok = await sendTurn(current, input);
    if (!ok) setComposer(input);
    else {
      const len = contextOf(treeRef.current, current).length;
      if (current === "b0" && len < script.length) setComposer(script[len]);
    }
    settle();
  };

  const playScript = async () => {
    if (running) return;
    stopped.current = false;
    setStoppedNote(false);
    setBusy(true);
    const start = contextOf(treeRef.current, current).length;
    for (let i = start; i < script.length; i++) {
      if (stopped.current) {
        setComposer(script[i]);
        break;
      }
      setComposer("");
      const ok = await sendTurn(current, script[i]);
      if (!ok) {
        setComposer(script[i]);
        break;
      }
    }
    settle();
  };

  const ctx = contextOf(tree, current);
  const branch = tree.branches.find((b) => b.id === current)!;
  const scrollback = scrollbackOf(tree, current);
  const canRewind = !running && !noLog && ctx.length > 0;

  const openPicker = () => {
    if (!canRewind) return;
    setPickerOpen(true);
    setEscArmed(false);
  };

  const doRewind = (index: number) => {
    const out = rewindTo(tree, current, index);
    treeRef.current = out.tree;
    setTree(out.tree);
    setCurrent(out.branch);
    setComposer(contextOf(out.tree, current)[index].input);
    setPickerOpen(false);
    setStoppedNote(false);
    runner.reset();
  };

  const switchBranch = (id: string) => {
    // Keep the branch's unsent draft with it, as a retained session would.
    const updated = setDraft(treeRef.current, current, composer.trim() ? composer : null);
    treeRef.current = updated;
    setTree(updated);
    setCurrent(id);
    setComposer(updated.branches.find((b) => b.id === id)?.draft ?? "");
    setPickerOpen(false);
    setStoppedNote(false);
    runner.reset();
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (running) {
      // Esc interrupts a running turn, as Stop does; it never starts the rewind gesture.
      stop();
      setEscArmed(false);
      return;
    }
    if (composer.trim()) {
      setEscArmed(false);
      return;
    }
    if (escArmed) {
      if (escTimer.current) clearTimeout(escTimer.current);
      openPicker();
      return;
    }
    setEscArmed(true);
    if (escTimer.current) clearTimeout(escTimer.current);
    escTimer.current = setTimeout(() => setEscArmed(false), 1500);
  };

  const pendingBody = composer.trim() ? bodyFor(tree, current, composer.trim()) : null;

  return (
    <div className="pg">
      <Tabs<View>
        label="Rewind"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "live", label: "Rewind a live conversation" },
          { id: "picker", label: "Read the picker's labels" },
        ]}
      />

      <Panel idBase={idBase} id="live" active={view === "live"}>
        <div className="pg-col">
          <div className="pg-bar">
            <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
            <SelectField
              id={`${idBase}-branch`}
              className={tree.branches.length > 1 ? undefined : "pg-advanced"}
              label="Session (like /resume)"
              value={current}
              onChange={switchBranch}
              disabled={running}
              options={tree.branches.map((b) => ({ value: b.id, label: `${b.label}: ${pathOf(tree, b.id)}` }))}
            />
          </div>

          {scrollback.length ? (
            <ol className={styles.timeline} aria-label="Earlier scrollback">
              {scrollback.map((t, i) => (
                <li key={`s${i}`} className={`${styles.msg}${t.inContext ? "" : ` ${styles.faded}`}`}>
                  <p className={styles.msgUser}>{t.input}</p>
                  <div className={styles.msgAssistant}>{t.reply}</div>
                  <p className={styles.msgMeta}>{t.inContext ? "In this branch's context" : "Scrollback only: not in this branch's context"}</p>
                </li>
              ))}
            </ol>
          ) : null}
          {branch.parent ? (
            <p className={styles.divider} role="note">
              • You&apos;re continuing from this point in a new conversation
            </p>
          ) : null}

          {branch.turns.length ? (
            <ol className={styles.timeline} aria-label="This branch">
              {branch.turns.map((t, i) => (
                <li key={t.responseId} className={styles.msg}>
                  <p className={styles.msgUser}>{t.input}</p>
                  <div className={styles.msgAssistant}>{t.reply}</div>
                  <p className={styles.msgMeta}>
                    Message {(branch.parent?.keep ?? 0) + i + 1} · {t.responseId}
                  </p>
                </li>
              ))}
            </ol>
          ) : !branch.parent ? (
            <p className="pg-empty">Start the conversation: send the first message, or play the page&apos;s A, B, C.</p>
          ) : null}

          {retryNote ? (
            <div className="pg-hint" role="status">
              {retryNote}
            </div>
          ) : runner.state === "running" || runner.error ? (
            <ResponseView result={runner.result} running={runner.state === "running"} elapsedMs={runner.elapsedMs}>
              {runner.result && !runner.result.ok ? <p className="pg-muted">The turn failed; your message is back in the composer.</p> : <p className="pg-muted">Waiting for the reply.</p>}
            </ResponseView>
          ) : null}
          <ErrorBox error={retryNote ? null : runner.error} />
          {runner.result?.ok ? (
            <p className="pg-small">
              <UsageLine model={runner.result.model} usage={(runner.result.json as { usage?: unknown } | null)?.usage ?? null} />
            </p>
          ) : null}

          {pickerOpen ? (
            <Picker
              label="Rewind to an earlier message"
              rows={ctx.map((t) => ({ text: t.input, label: "exact" as const, detail: "A stored response on the API: the branch continues from the one before it, without known loss." }))}
              warnings={[
                "Rewind changes conversation history only. Workspace files aren't restored, reverted or deleted: review the working copy and restore code with your source-control tools.",
                "Background work that belongs to the source session keeps running there; the new branch gets no live task handles.",
              ]}
              onRewind={doRewind}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}

          <div className="pg-composer">
            <label className="sr-only" htmlFor={`${idBase}-composer`}>
              Message
            </label>
            <TextArea
              id={`${idBase}-composer`}
              rows={2}
              value={composer}
              placeholder={branch.parent && !branch.turns.length ? "Edit the restored message, then send it" : "Type a message"}
              onChange={(e) => {
                setComposer(e.target.value);
                setEscArmed(false);
              }}
              onKeyDown={onComposerKey}
            />
            <div className="pg-composer-bar">
              <span className="pg-muted pg-kbd-hint" aria-live="polite">
                {escArmed ? "Esc again to rewind" : branch.parent && !branch.turns.length && composer ? "The selected message is back as an unsent draft. Edit it, then send." : "Esc twice from an idle, empty composer opens the picker."}
              </span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void playScript()} disabled={running || current !== "b0" || ctx.length >= script.length}>
                Play A, B, C
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={openPicker} disabled={!canRewind} title={noLog ? "Unavailable with --no-session-log" : undefined}>
                /rewind
              </button>
              <RunButton running={running} onRun={() => void send()} onStop={stop} label="Send" disabled={!composer.trim()} />
            </div>
          </div>
          <div className="pg-bar pg-advanced">
            <Toggle id={`${idBase}-nolog`} label="Started with --no-session-log" checked={noLog} onChange={setNoLog} />
            <Toggle id={`${idBase}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
          </div>
          {noLog ? (
            <div className="pg-hint pg-bad" role="status">
              Rewind is available only in interactive sessions with session logging on. It&apos;s unavailable after muse --no-session-log.
            </div>
          ) : null}
          {showCode ? (
            <CodeView
              method="POST"
              path="responses"
              body={pendingBody ?? bodyFor(tree, current, "<your message>")}
              caption={previousIdFor(tree, current) ? "The next turn continues from this branch's last stored response" : "The first turn of a conversation has no previous_response_id"}
            />
          ) : null}
          {stoppedNote ? (
            <div className="pg-muted" role="status">
              Stopped: nothing more was sent. The message is back in the composer.
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel idBase={idBase} id="picker" active={view === "picker"}>
        <div className="pg-col">
          <p className="pg-hint">A sample retained session with one row for each label and reason the page lists. Choose a row and press Enter.</p>
          {samplePicker ? (
            <Picker
              label="Rewind picker (sample session)"
              rows={PICKER_SAMPLE}
              warnings={["The action screen warns you when Muse Code detects active background work in the source session."]}
              onRewind={(i) => {
                setSampleResult(
                  PICKER_SAMPLE[i].label === "review"
                    ? `A new branch opens with message ${i + 1} as the draft and a missing-content marker where [Image #1] was. Replace or remove it before you submit.`
                    : `A new branch opens with message ${i + 1} as the draft; messages 1 to ${i} are its context. The original session stays available through /resume.`,
                );
                setSamplePicker(false);
              }}
              onClose={() => {
                setSampleResult("You left the picker. Nothing changed.");
                setSamplePicker(false);
              }}
            />
          ) : (
            <div className="pg-col">
              <p className={styles.verdict} role="status">
                {sampleResult}
              </p>
              <div className="pg-actions">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setSamplePicker(true)}>
                  Open the picker again
                </button>
              </div>
            </div>
          )}
          <div className="pg-advanced">
            <p className="pg-section-label">Never in the picker</p>
            <Notes items={NOT_REWIND_POINTS} />
          </div>
          <p className="pg-hint">Older sessions can hold messages from before rewind support; the picker marks them or says the conversation has no supported rewind points.</p>
        </div>
      </Panel>
    </div>
  );
}
