"use client";

import { useDeferredValue, useEffect, useId, useReducer, useState, type KeyboardEvent } from "react";
import { Field, PresetPills, Tabs, TextInput, Toggle } from "@/components/docs/kit";
import { COMMANDS, GROUPS, searchCommands, type Group } from "@/components/docs/playgrounds/muse-code/commands";
import { composerReducer, INITIAL_COMPOSER } from "@/components/docs/playgrounds/muse-code/composer";
import { occurrences, parseLoop } from "@/components/docs/playgrounds/muse-code/loop-schedule";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { C, Chip, Highlight, Notes, Panel, SelectField } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The interactive page's demo: a searchable explorer of every slash command and shortcut the Muse Code pages
 * document, a pretend session that shows what Enter, Alt+Enter, Esc and Ctrl+C do while a turn runs, and a /loop
 * checker that reads a cadence the way the page describes and lists when the job would fire before it expires.
 */

export interface CommandExplorerProps {
  slug: string;
  query?: string;
  loop?: string;
}

type View = "find" | "steer" | "loop";

const KIND_LABEL = { slash: "Slash command", key: "Key", cli: "Shell", setting: "Setting" } as const;

const LOOP_PRESETS = [
  { label: "Every 10 minutes", value: "/loop 10m /run-tests" },
  { label: "Weekdays at 9am", value: '/loop "0 9 * * 1-5" standup' },
  { label: "No cadence", value: "/loop check the deploy and report" },
  { label: "Every 2 days", value: "/loop 2d summarize new issues" },
];

function timeLabel(d: Date): string {
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function CommandExplorer({ query: startQuery, loop: startLoop }: CommandExplorerProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("find");

  const [query, setQuery] = useState(startQuery ?? "");
  const [group, setGroup] = useState<Group | "all">("all");
  const [inSide, setInSide] = useState(false);
  const deferred = useDeferredValue(query);
  const results = searchCommands(deferred, group);
  const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);

  const [sim, dispatch] = useReducer(composerReducer, INITIAL_COMPOSER);

  const [loop, setLoop] = useState(startLoop ?? LOOP_PRESETS[0].value);
  const [loopPreset, setLoopPreset] = useState<number | null>(() => {
    const i = LOOP_PRESETS.findIndex((p) => p.value === (startLoop ?? LOOP_PRESETS[0].value));
    return i >= 0 ? i : null;
  });
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const parsed = parseLoop(loop);
  const schedule = parsed.ok && now ? occurrences(parsed.cadence, now, 6) : null;

  const onComposerKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dispatch({ type: "key", key: e.altKey ? "Alt+Enter" : "Enter" });
    } else if (e.key === "Escape") {
      e.preventDefault();
      dispatch({ type: "key", key: "Esc" });
    } else if (e.key.toLowerCase() === "c" && e.ctrlKey && !e.metaKey) {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        dispatch({ type: "key", key: "Ctrl+C" });
      }
    }
  };

  const current = sim.turns[sim.turns.length - 1];

  return (
    <div className="pg">
      <Tabs<View>
        label="Working with the agent"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "find", label: "Find a command", count: COMMANDS.length },
          { id: "steer", label: "Steer a running turn" },
          { id: "loop", label: "Schedule a /loop" },
        ]}
      />

      <Panel idBase={idBase} id="find" active={view === "find"}>
        <div className="pg-col">
          <div className={styles.row}>
            <Field id={`${idBase}-q`} label="Search commands and shortcuts" className={styles.grow}>
              <TextInput id={`${idBase}-q`} type="search" value={query} placeholder="Try: branch, compact, cron, queue, voice" onChange={(e) => setQuery(e.target.value)} />
            </Field>
            <SelectField<Group | "all">
              id={`${idBase}-group`}
              label="Group"
              className={styles.narrow}
              value={group}
              onChange={setGroup}
              options={[{ value: "all", label: "All groups" }, ...GROUPS.map((g) => ({ value: g, label: g }))]}
            />
          </div>
          <Toggle id={`${idBase}-side`} label="I'm in a side conversation" checked={inSide} onChange={setInSide} />
          <p className="pg-hint" role="status" aria-live="polite">
            {results.length === COMMANDS.length ? `${results.length} commands and shortcuts.` : `${results.length} of ${COMMANDS.length} match.`}
            {inSide ? " Inside a side conversation, /side, /fork, /new, /clear and /resume are unavailable; return to the main chat with Ctrl+C first." : ""}
          </p>
          <ul className={`${styles.list} ${styles.scroll}`} aria-label="Commands">
            {results.map((c) => (
              <li key={c.name}>
                <div className={styles.itemHead}>
                  <span className={styles.itemName}>
                    <Highlight text={c.name} words={words} />
                  </span>
                  <Chip>{KIND_LABEL[c.kind]}</Chip>
                  <span className="pg-muted pg-small">{c.group}</span>
                  {inSide && c.sideChat === "unavailable" ? <Chip tone="bad">Unavailable here</Chip> : null}
                  {inSide && c.sideChat === "works" ? <Chip tone="ok">Works here</Chip> : null}
                </div>
                {c.forms?.length ? (
                  <p className={styles.itemText}>
                    {c.forms.map((f, i) => (
                      <span key={f}>
                        {i ? " " : ""}
                        <C>{f}</C>
                      </span>
                    ))}
                  </p>
                ) : null}
                <p className={styles.itemText}>
                  <Highlight text={c.summary} words={words} />
                </p>
                {c.details?.length ? (
                  <ul className={styles.notes}>
                    {c.details.map((d) => (
                      <li key={d}>
                        <Highlight text={d} words={words} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="pg-small">
                  <a href={c.href}>Read about it</a>
                </p>
              </li>
            ))}
          </ul>
          {!results.length ? <p className="pg-empty">No command matches. Try fewer words, or All groups.</p> : null}
          <p className="pg-hint">
            Every command is either safe to run mid-turn or held until the turn ends; the session tells you which while a run is active.
          </p>
        </div>
      </Panel>

      <Panel idBase={idBase} id="steer" active={view === "steer"}>
        <div className="pg-col">
          <p className="pg-hint">A pretend session. Type in the composer and press the keys (or the buttons) to see what each one does to a running turn.</p>
          <div className={`${styles.card} ${styles.cardMuted}`}>
            <div className={styles.cardHead}>
              <Chip tone={sim.running ? "accent" : "plain"}>{sim.running ? `Turn ${sim.turns.length} running` : "Idle"}</Chip>
              {sim.background ? <Chip tone="warn">Background command running</Chip> : null}
              {sim.goal !== "none" ? <Chip tone={sim.goal === "active" ? "ok" : "warn"}>Goal {sim.goal}</Chip> : null}
              {sim.escArmed ? <Chip tone="accent">Esc again to rewind</Chip> : null}
            </div>
            {current ? (
              <p className="pg-small">
                Last turn: <strong>{current.prompt}</strong> ({current.ended})
                {current.steered.length ? <> with {current.steered.length} steered: {current.steered.map((s) => `"${s}"`).join(", ")}</> : null}
              </p>
            ) : null}
            {sim.queue.length ? (
              <div>
                <p className="pg-section-label">Queued for the next turn</p>
                <ol className={styles.notes}>
                  {sim.queue.map((q, i) => (
                    <li key={`${i}-${q}`}>{q}</li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
          <Field id={`${idBase}-composer`} label="Composer">
            <TextInput
              id={`${idBase}-composer`}
              value={sim.composer}
              placeholder={sim.running ? "Type to steer (Enter) or queue (Alt+Enter)" : "Type a prompt and press Enter"}
              onChange={(e) => dispatch({ type: "text", value: e.target.value })}
              onKeyDown={onComposerKey}
            />
          </Field>
          <div className="pg-actions">
            {(["Enter", "Alt+Enter", "Esc", "Ctrl+C"] as const).map((k) => (
              <button key={k} type="button" className="btn btn-outline btn-sm" onClick={() => dispatch({ type: "key", key: k })}>
                <span className={styles.kbd}>{k}</span>
              </button>
            ))}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => dispatch({ type: "finish" })} disabled={!sim.running}>
              Let the turn finish
            </button>
          </div>
          <div className="pg-bar">
            <Toggle id={`${idBase}-bg`} label="A background command is running" checked={sim.background} onChange={(on) => dispatch({ type: "background", on })} />
            <Toggle id={`${idBase}-goal`} label="A goal is set" checked={sim.goal !== "none"} onChange={(on) => dispatch({ type: "goal", on })} />
            <button type="button" className="btn btn-outline btn-sm" onClick={() => dispatch({ type: "reset" })}>
              Start over
            </button>
          </div>
          <p className={styles.verdict} role="status" aria-live="polite">
            {sim.last}
          </p>
          {sim.log.length > 1 ? (
            <details className="pg-events">
              <summary>
                What happened <span className="pg-events-count">{sim.log.length}</span>
              </summary>
              <ol className="pg-events-list">
                {sim.log.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      </Panel>

      <Panel idBase={idBase} id="loop" active={view === "loop"}>
        <div className="pg-col">
          <Field id={`${idBase}-loop`} label="A /loop command">
            <TextInput
              id={`${idBase}-loop`}
              className="pg-code-input"
              value={loop}
              spellCheck={false}
              onChange={(e) => {
                setLoop(e.target.value);
                setLoopPreset(null);
              }}
            />
          </Field>
          <PresetPills
            presets={LOOP_PRESETS}
            active={loopPreset}
            onPick={(i) => {
              setLoop(LOOP_PRESETS[i].value);
              setLoopPreset(i);
            }}
          />
          {parsed.ok ? (
            <div className={`${styles.card} ${styles.cardMuted}`} role="status" aria-live="polite">
              <p className={styles.big}>{parsed.cadence.label}</p>
              <p className="pg-small">
                Runs <C>{parsed.prompt}</C> {parsed.prompt.startsWith("/") ? "(a /skill invocation)" : "(a plain instruction)"}, passed through verbatim.
              </p>
              {schedule ? (
                <>
                  <p className="pg-section-label">If you created it now</p>
                  <ol className={styles.notes}>
                    {schedule.runs.map((r) => (
                      <li key={r.getTime()}>{timeLabel(r)}</li>
                    ))}
                  </ol>
                  <p className="pg-small">
                    {schedule.total.toLocaleString("en-US")} {schedule.total === 1 ? "run" : "runs"} before it expires on {timeLabel(schedule.expires)} (recurring jobs auto-expire after 7 days).
                  </p>
                </>
              ) : null}
            </div>
          ) : (
            <p className="pg-hint pg-bad" role="alert">
              {parsed.error}
            </p>
          )}
          <Notes
            items={[
              "An occurrence that lands while a run is active is skipped, not queued or replayed, and the job stays scheduled for its next one (fire_when_active_run: false).",
              "There is no loop monitor panel: a loop is an ordinary scheduled job the agent manages with its cron tools.",
              "Pair it with /goal when you want the runtime to hold progress to a defined outcome.",
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}
