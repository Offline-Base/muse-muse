"use client";

import { useId, useMemo, useState } from "react";
import { TextArea } from "@/components/docs/kit/Field";
import { FORMAT_LABEL, SAMPLE_ROWS, checkDataset, type DatasetFormat } from "@/components/docs/playgrounds/open-weights/dataset";
import { Badge, SegmentField, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * Paste training rows (JSONL) and check each against the format its page specifies: the roles and content parts,
 * image and audio parts with paths, the fields DPO, GRPO, Miles and Fireworks rows need, and the page's own gotchas
 * (Axolotl's top-level images column, audio that isn't WAV, a ground_truth that isn't a JSON string). Nothing leaves
 * the page.
 */

export interface DatasetCheckProps {
  formats: DatasetFormat[];
}

export function DatasetCheck({ formats }: DatasetCheckProps) {
  const id = useId();
  const [format, setFormat] = useState<DatasetFormat>(formats[0]);
  const [text, setText] = useState<string>(SAMPLE_ROWS[formats[0]]);
  const report = useMemo(() => checkDataset(text, format), [text, format]);
  const totals = Object.entries(report.totals).filter(([, v]) => v > 0);

  return (
    <div className={styles.stack}>
      {formats.length > 1 ? (
        <SegmentField<DatasetFormat>
          label="Format"
          value={format}
          options={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
          onChange={(f) => {
            setFormat(f);
            setText(SAMPLE_ROWS[f]);
          }}
        />
      ) : null}
      <div className="pg-field">
        <div className="pg-bar" style={{ justifyContent: "space-between" }}>
          <label className="pg-label" htmlFor={`${id}-rows`}>
            Your rows, one JSON object per line
          </label>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setText(SAMPLE_ROWS[format])}>
            Load the page&apos;s sample rows
          </button>
        </div>
        <TextArea id={`${id}-rows`} rows={7} className={`pg-code-input ${styles.textarea}`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <p className="pg-hint">Checked in your browser; nothing is sent. The samples include one broken row on purpose.</p>
      </div>
      <Status tone={!report.rows.length ? "neutral" : report.invalid ? "bad" : report.rows.some((r) => r.warnings.length) ? "warn" : "ok"}>
        {report.rows.length
          ? `${report.valid} of ${report.rows.length} row${report.rows.length === 1 ? "" : "s"} valid${report.invalid ? `, ${report.invalid} with errors` : ""}${totals.length ? ` · ${totals.map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}.`
          : "Paste some rows to check them."}
      </Status>
      {report.rows.length ? (
        <ol className={styles.msgs} aria-label="Row checks">
          {report.rows.map((r) => (
            <li key={r.line} className={styles.msg}>
              <div className={styles.msgHead}>
                <span className={styles.role}>line {r.line}</span>
                <Badge tone={!r.ok ? "bad" : r.warnings.length ? "warn" : "ok"}>{!r.ok ? "Error" : r.warnings.length ? "Check" : "OK"}</Badge>
                <span className="pg-small pg-muted">{r.summary}</span>
              </div>
              {r.errors.length || r.warnings.length ? (
                <ul className="pg-list pg-small">
                  {r.errors.map((e) => (
                    <li key={e} className="pg-bad">
                      {e}
                    </li>
                  ))}
                  {r.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
