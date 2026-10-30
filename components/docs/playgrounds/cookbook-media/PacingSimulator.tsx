"use client";

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "@/components/icons";
import { Segmented } from "@/components/docs/kit/Field";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { CUTOFF, clock, simulatePacing, type PacingStrategy } from "@/components/docs/playgrounds/cookbook-media/pacing";

const LENGTHS = [
  { value: "120000", label: "2 min" },
  { value: "600000", label: "10 min" },
  { value: "1800000", label: "30 min" },
  { value: "4200000", label: "70 min" },
];
const SEND_COSTS = ["0.5", "2", "5"];
const JITTERS = ["0", "2", "10"];
const SILENCES: Record<string, { label: string; silence: { atMs: number; lengthMs: number; pad: boolean } | null }> = {
  none: { label: "No silence", silence: null },
  skip12: { label: "12 s of silence, skipped", silence: { atMs: 30_000, lengthMs: 12_000, pad: false } },
  pad12: { label: "12 s of silence, padded", silence: { atMs: 30_000, lengthMs: 12_000, pad: true } },
  skip4: { label: "4 s of silence, skipped", silence: { atMs: 30_000, lengthMs: 4_000, pad: false } },
};

const W = 640;
const H = 220;
const PAD = { l: 52, r: 16, t: 14, b: 30 };

/** Clean axis steps: 1, 2 or 5 times a power of ten, about `count` of them across the span. */
function ticks(min: number, max: number, count = 5): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/**
 * The cutoff rules from the recipe as a simulator: pick how the client paces a recording's 80 ms frames, how slow
 * each send is, and whether silence is sent, and see the lateness over the session and whether, when and why Meta
 * would close it. Runs in the page; nothing is sent.
 */
export function PacingSimulator() {
  const id = useId();
  const [strategy, setStrategy] = useState<PacingStrategy>("fixed");
  const [length, setLength] = useState("600000");
  const [send, setSend] = useState("2");
  const [jitter, setJitter] = useState("2");
  const [silence, setSilence] = useState("none");
  const [cursor, setCursor] = useState<number | null>(null);

  const result = useMemo(
    () =>
      simulatePacing({
        strategy,
        frameMs: 80,
        sendMs: Number(send),
        jitterMs: Number(jitter),
        audioMs: Number(length),
        silence: SILENCES[silence].silence,
      }),
    [strategy, send, jitter, length, silence],
  );

  const pts = result.points;
  const tMax = Math.max(1, pts.at(-1)?.t ?? 1);
  const yMin = Math.min(-6, ...pts.map((p) => p.lateMs / 1000));
  const yMax = Math.max(11, ...pts.map((p) => p.lateMs / 1000));
  const x = (t: number) => PAD.l + (t / tMax) * (W - PAD.l - PAD.r);
  const y = (s: number) => PAD.t + ((yMax - s) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.lateMs / 1000).toFixed(1)}`).join(" ");
  const yTicks = ticks(yMin, yMax, 5);
  const xTicks = ticks(0, tMax / 1000, 5).filter((s) => s * 1000 <= tMax);
  const at = cursor === null ? null : pts[Math.min(pts.length - 1, Math.max(0, cursor))];

  const nearest = (clientX: number, rect: DOMRect) => {
    const t = ((clientX - rect.left) / rect.width) * W;
    const time = ((t - PAD.l) / (W - PAD.l - PAD.r)) * tMax;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - time) < Math.abs(pts[best].t - time)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setCursor(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const stepBy = Math.max(1, Math.round(pts.length / 40));
    if (e.key === "ArrowRight") setCursor((c) => Math.min(pts.length - 1, (c ?? -1) + stepBy));
    else if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, (c ?? pts.length) - stepBy));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(pts.length - 1);
    else return;
    e.preventDefault();
  };

  const close = result.close;
  const late = (ms: number) => (Math.abs(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  const verdict = close
    ? `Closed with ${close.code} at ${clock(close.atMs)}: ${close.reason}`
    : `Runs to the end: ${clock(result.sentMs)} of audio in ${clock(result.wallMs)}, at most ${late(result.maxLateMs)} behind and ${late(result.maxAheadMs)} ahead of real time.`;
  const table = useMemo(() => {
    const rows = 8;
    return Array.from({ length: rows + 1 }, (_, i) => pts[Math.round((i * (pts.length - 1)) / rows)]).filter((p, i, a) => p && a.indexOf(p) === i);
  }, [pts]);

  const rows: Array<{ rule: string; code: string; hit: boolean }> = [
    { rule: "No handshake within 10 seconds", code: "1008", hit: false },
    { rule: "More than 5 seconds of audio backlog", code: "1008", hit: close?.rule === "backlog" },
    { rule: "Ingress below real time for 10 seconds", code: "1008", hit: close?.rule === "lateness" },
    { rule: "Session open longer than 60 minutes", code: "1011", hit: close?.rule === "duration" },
    { rule: "Rate limited", code: "1013", hit: false },
  ];

  return (
    <div className={`pg ${styles.stack}`}>
      <p className={`${styles.note} pg-advanced`}>
        A recording streamed in 80 ms frames, the way the recipe&apos;s client sends a file. Nothing is sent: this runs the page&apos;s
        cutoff rules on a simulated session.
      </p>
      <div className={styles.row}>
        <Segmented<PacingStrategy>
          size="sm"
          label="How the client paces frames"
          value={strategy}
          onChange={setStrategy}
          options={[
            { value: "absolute", label: "Absolute schedule (the recipe)" },
            { value: "fixed", label: "Sleep 80 ms after each send" },
            { value: "blast", label: "As fast as possible" },
          ]}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.control} htmlFor={`${id}-len`}>
          Recording
          <span className="select-wrap">
            <select id={`${id}-len`} className="select pg-select" value={length} onChange={(e) => setLength(e.target.value)}>
              {LENGTHS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className={styles.control} htmlFor={`${id}-send`}>
          Work per send
          <span className="select-wrap">
            <select id={`${id}-send`} className="select pg-select" value={send} onChange={(e) => setSend(e.target.value)}>
              {SEND_COSTS.map((v) => (
                <option key={v} value={v}>
                  {v} ms
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className={`${styles.control} pg-advanced`} htmlFor={`${id}-jit`}>
          Jitter
          <span className="select-wrap">
            <select id={`${id}-jit`} className="select pg-select" value={jitter} onChange={(e) => setJitter(e.target.value)}>
              {JITTERS.map((v) => (
                <option key={v} value={v}>
                  up to {v} ms
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className={`${styles.control} pg-advanced`} htmlFor={`${id}-sil`}>
          Silence at 0:30
          <span className="select-wrap">
            <select id={`${id}-sil`} className="select pg-select" value={silence} onChange={(e) => setSilence(e.target.value)}>
              {Object.entries(SILENCES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      <div className={styles.verdict} data-ok={close ? "false" : "true"} role="status">
        <Icon name={close ? "alert" : "check"} size={18} />
        <span>{verdict}</span>
      </div>

      <figure className={styles.tight} style={{ margin: 0 }}>
        <figcaption className={styles.label}>How far behind real time the stream runs (seconds; below zero is ahead)</figcaption>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Lateness over the session. ${verdict}`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setCursor(null)}
          onKeyDown={onKey}
          onBlur={() => setCursor(null)}
        >
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className={v === 0 ? styles.chartZero : styles.chartGrid} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
              <text className={styles.chartAxis} x={PAD.l - 8} y={y(v) + 4} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {xTicks.map((s) => (
            <text key={`x${s}`} className={styles.chartAxis} x={x(s * 1000)} y={H - 8} textAnchor="middle">
              {clock(s * 1000)}
            </text>
          ))}
          <line className={styles.chartLimit} x1={PAD.l} x2={W - PAD.r} y1={y(CUTOFF.latenessMs / 1000)} y2={y(CUTOFF.latenessMs / 1000)} />
          <text className={styles.chartLimitLabel} x={W - PAD.r} y={y(CUTOFF.latenessMs / 1000) - 6} textAnchor="end">
            10 s behind: closes (1008)
          </text>
          <line className={styles.chartLimit} x1={PAD.l} x2={W - PAD.r} y1={y(-CUTOFF.backlogMs / 1000)} y2={y(-CUTOFF.backlogMs / 1000)} />
          <text className={styles.chartLimitLabel} x={W - PAD.r} y={y(-CUTOFF.backlogMs / 1000) + 14} textAnchor="end">
            5 s ahead: closes (1008)
          </text>
          <path className={styles.chartLine} d={path} />
          {close ? <circle className={styles.chartClose} cx={x(close.atMs)} cy={y(pts.at(-1)!.lateMs / 1000)} r={5} /> : null}
          {at ? (
            <g pointerEvents="none">
              <line className={styles.chartZero} x1={x(at.t)} x2={x(at.t)} y1={PAD.t} y2={H - PAD.b} />
              <circle cx={x(at.t)} cy={y(at.lateMs / 1000)} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
        <p className={styles.note} aria-live="polite">
          {at ? (
            <>
              <span className={styles.strong}>{at.lateMs >= 0 ? `${late(at.lateMs)} behind` : `${late(-at.lateMs)} ahead`}</span> at {clock(at.t)}
            </>
          ) : (
            "Point at the chart, or focus it and use the arrow keys, to read the lateness at any moment."
          )}
        </p>
      </figure>

      <details className={`${styles.details} pg-advanced`}>
        <summary>The run as a table</summary>
        <table className={styles.codes}>
          <thead>
            <tr>
              <th scope="col">Wall time</th>
              <th scope="col">Lateness</th>
            </tr>
          </thead>
          <tbody>
            {table.map((p) => (
              <tr key={p.t}>
                <td>{clock(p.t)}</td>
                <td>{p.lateMs >= 0 ? `${late(p.lateMs)} behind` : `${late(-p.lateMs)} ahead`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <table className={`${styles.codes} pg-advanced`}>
        <caption className={styles.note} style={{ textAlign: "left", paddingBottom: 6 }}>
          What the server checks, from the recipe&apos;s cutoff table. The rule this run trips is highlighted.
        </caption>
        <thead>
          <tr>
            <th scope="col">What the server checks</th>
            <th scope="col">Close code</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rule} data-hit={r.hit ? "true" : undefined}>
              <td>{r.rule}</td>
              <td className={styles.mono}>{r.code}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
