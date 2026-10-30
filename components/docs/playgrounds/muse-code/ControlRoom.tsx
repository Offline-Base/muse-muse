"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { initialRoom, openRoom, pressKey, progress, roomKey, type RoomKey, type RoomRun, type RoomState } from "@/components/docs/playgrounds/muse-code/control-room";
import { Chip, Notes, type Tone } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The workflow control room on a pretend session (control-room.ts): /workflows opens the run list, and the page's
 * keys select, open, cancel, pause, skip and restart. Focus the screen and press the keys, or click them.
 */

const TONE: Record<string, Tone> = { running: "accent", paused: "warn", completed: "ok", failed: "bad", cancelled: "plain", queued: "plain", skipped: "plain" };

const KEYS: ReadonlyArray<{ key: RoomKey; label: string }> = [
  { key: "up", label: "Up / K" },
  { key: "down", label: "Down / J" },
  { key: "enter", label: "Enter" },
  { key: "right", label: "Right" },
  { key: "left", label: "Left" },
  { key: "esc", label: "Esc" },
  { key: "space", label: "Space" },
  { key: "c", label: "C" },
  { key: "r", label: "R" },
  { key: "p", label: "P" },
  { key: "x", label: "X" },
];

function Phases({ run, selected }: { run: RoomRun; selected: number }) {
  const phases = [...new Set(run.children.map((c) => c.phase))];
  return (
    <div className="pg-col">
      {phases.map((phase) => (
        <div key={phase}>
          <p className="pg-section-label">{phase}</p>
          <ul className={styles.picker} aria-label={`${phase} children`}>
            {run.children.map((c, i) =>
              c.phase === phase ? (
                <li key={c.name} className={`${styles.pickerRow}${i === selected ? ` ${styles.pickerRowActive}` : ""}`} aria-current={i === selected || undefined}>
                  <span className={styles.pickerText}>{c.name}</span>
                  {c.restarts ? <span className="pg-muted pg-small">restarted {c.restarts}x</span> : null}
                  <Chip tone={TONE[c.status]}>{c.status}</Chip>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ControlRoom() {
  const [room, setRoom] = useState<RoomState>(initialRoom);
  const screen = useRef<HTMLDivElement>(null);
  const press = (key: RoomKey) => setRoom((r) => pressKey(r, key));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = roomKey(e.key);
    if (!key || !room.open) return;
    e.preventDefault();
    press(key);
  };
  const run = room.runs[room.run];

  return (
    <div className="pg-col">
      <p className="pg-hint">A pretend session with three workflows. Click the screen and use the page&apos;s keys, or the buttons under it.</p>
      <div ref={screen} className={`${styles.card} ${styles.cardMuted}`} tabIndex={0} role="group" aria-label="Workflow control room" onKeyDown={onKey}>
        {!room.open ? (
          <div className="pg-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setRoom((r) => openRoom(r));
                screen.current?.focus();
              }}
            >
              <span className={styles.mono}>/workflows</span>
            </button>
            <span className="pg-muted pg-small">opens the control room</span>
          </div>
        ) : room.level === "list" ? (
          <ul className={styles.picker} aria-label="Workflow runs">
            {room.runs.map((r, i) => (
              <li key={r.name} className={`${styles.pickerRow}${i === room.run ? ` ${styles.pickerRowActive}` : ""}`} aria-current={i === room.run || undefined}>
                <span className={`${styles.pickerText} ${styles.mono}`}>{r.name}</span>
                <span className="pg-muted pg-small">
                  {r.elapsed} · {r.tokens.toLocaleString("en-US")} tokens · {progress(r)}
                </span>
                <Chip tone={TONE[r.status]}>{r.status}</Chip>
              </li>
            ))}
          </ul>
        ) : room.level === "run" ? (
          <div className="pg-col">
            <div className={styles.cardHead}>
              <p className={`${styles.cardTitle} ${styles.mono}`}>{run.name}</p>
              <Chip tone={TONE[run.status]}>{run.status}</Chip>
            </div>
            <Phases run={run} selected={room.child} />
          </div>
        ) : (
          <div className="pg-col">
            <p className={`${styles.cardTitle} ${styles.mono}`}>{run.name}: result</p>
            <p className="pg-small">{run.result}</p>
          </div>
        )}
      </div>
      <div className="pg-actions" aria-label="Control room keys">
        {KEYS.map((k) => (
          <button
            key={k.key}
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!room.open}
            onClick={() => {
              press(k.key);
              screen.current?.focus();
            }}
          >
            <span className={styles.kbd}>{k.label}</span>
          </button>
        ))}
        <button type="button" className="btn btn-outline btn-sm pg-advanced" onClick={() => setRoom(initialRoom())}>
          Start over
        </button>
      </div>
      <p className={styles.verdict} role="status" aria-live="polite">
        {room.message}
      </p>
      <Notes
        className="pg-advanced"
        items={[
          "From the run list: Up and Down (or J and K) select, Enter or Right opens a run, C cancels it, R opens a completed run's result, Space or Esc closes.",
          "Inside a run: P pauses or resumes it, X skips the selected running child, R restarts it. R isn't a retry for completed or failed children. Esc or Left goes back; Space closes from any level.",
        ]}
      />
    </div>
  );
}
