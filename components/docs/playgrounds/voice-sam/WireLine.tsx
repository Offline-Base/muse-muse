"use client";

import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import { maskDataSummary, shortMaskToken, wireSpans, type WireSpan } from "@/components/docs/playgrounds/voice-sam/sam-wire";

/**
 * One SAM output line with its parts colored as sam/reading-segmentation names them: the frame marker, each object
 * id, its box and its mask, and the comma between records. Long mask payloads are shortened unless `full`. With
 * `onPick`, every record's spans become buttons that select it.
 */
export function WireLine({
  line,
  full = false,
  selected,
  onPick,
  lineNo,
}: {
  line: string;
  full?: boolean;
  /** The record index (on this line) to outline. */
  selected?: number | null;
  onPick?: (record: number) => void;
  lineNo?: number;
}) {
  const spans = wireSpans(line);
  return (
    <code className={styles.wire}>
      {lineNo !== undefined ? <span className={styles.wireLineNo}>{lineNo}</span> : null}
      {spans.map((s, i) => {
        const text = s.kind === "mask" && !full ? maskText(s) : s.text;
        const cls = `${styles.sp} ${styles[`sp-${s.kind}`] ?? ""}`;
        if (onPick && s.record !== undefined && (s.kind === "id" || s.kind === "box" || s.kind === "mask")) {
          // A span, not a <button>: buttons are atomic inline boxes, and a long token must wrap with the line.
          const pick = () => onPick(s.record!);
          return (
            <span
              key={i}
              role="button"
              tabIndex={0}
              className={`${styles.spButton} ${cls}`}
              aria-pressed={selected === s.record}
              title={titleOf(s)}
              onClick={pick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick();
                }
              }}
            >
              {text}
            </span>
          );
        }
        return (
          <span key={i} className={cls} title={titleOf(s)}>
            {text}
          </span>
        );
      })}
    </code>
  );
}

function maskText(s: WireSpan): string {
  const data = s.fields?.data;
  return data ? shortMaskToken(s.text, data) : s.text;
}

function titleOf(s: WireSpan): string {
  switch (s.kind) {
    case "frame":
      return `Frame marker: source frame ${s.text.slice(1, -2)}`;
    case "id":
      return `Object id ${s.text}: stable for this object across frames`;
    case "box": {
      const f = s.fields ?? {};
      return `Box: corners (${f.x1}, ${f.y1}) to (${f.x2}, ${f.y2}), inclusive, in a ${f.w} x ${f.h} frame${f.c ? `, confidence ${f.c}` : ""}`;
    }
    case "mask": {
      const d = maskDataSummary(s.fields?.data ?? "");
      return d
        ? `Mask: ${d.height} rows x ${d.width} columns, ${d.marker === "~" ? "lossless (~)" : d.marker === "!" ? "one_bit (!)" : `marker ${d.marker}`}, ${d.payloadChars} base85 characters${s.fields?.c ? `, confidence ${s.fields.c}` : ""}`
        : "Mask";
    }
    case "point": {
      const f = s.fields ?? {};
      return `Point (${f.x}, ${f.y}) in a ${f.w} x ${f.h} frame`;
    }
    case "neg":
      return "Negative: the next point is not part of the object";
    case "sep":
      return "Record separator";
    default:
      return "";
  }
}

/** The color key for WireLine. */
export function WireLegend() {
  return (
    <div className={styles.legendRow} aria-label="Color key">
      <span className={`${styles.sp} ${styles["sp-frame"]}`}>&lt;Nf&gt; frame</span>
      <span className={`${styles.sp} ${styles["sp-id"]}`}>id</span>
      <span className={`${styles.sp} ${styles["sp-box"]}`}>&lt;|box;...|&gt;</span>
      <span className={`${styles.sp} ${styles["sp-mask"]}`}>&lt;|mask;...|&gt;</span>
      <span className={`${styles.sp} ${styles["sp-sep"]}`}>, separator</span>
    </div>
  );
}
