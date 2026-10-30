"use client";

import { useMemo } from "react";
import { checkAgainst, sortRows, type CheckMode, type CheckRow, type Severity } from "@/components/docs/playgrounds/media/schema-check";
import { findSchema, type SchemaDoc } from "@/components/docs/playgrounds/media/schema-tables";
import styles from "@/components/docs/playgrounds/media/demos.module.css";

const SEVERITY_LABEL: Record<Severity, string> = { ok: "OK", error: "Problem", warning: "Differs", info: "Note" };
const SEVERITY_CLASS: Record<Severity, string> = { ok: styles.tagOk, error: styles.tagBad, warning: styles.tagWarn, info: styles.tag };

/** A value short enough for a table cell; Unix-second timestamps get their date too. */
export function cellValue(path: string, v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v.length > 64 ? `"${v.slice(0, 40)}..." (${v.length.toLocaleString("en-US")} characters)` : `"${v}"`;
  if (typeof v === "number" && /(^|\.)(created_at|expires_at|created)$/.test(path) && v > 1e9) {
    return `${v} (${new Date(v * 1000).toLocaleString("en-US")})`;
  }
  const text = JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * A check of a request body or a real reply against a schema from the page (schema-check.ts): a verdict, then one
 * row per field with its documented type, the value found and what the check found, problems first.
 */
export function SchemaCheckTable({
  schemas,
  schema,
  value,
  mode,
  caption,
}: {
  schemas: readonly SchemaDoc[];
  /** The schema's anchor or name. */
  schema: string;
  value: unknown;
  mode: CheckMode;
  caption?: string;
}) {
  const report = useMemo(() => checkAgainst(schemas, schema, value, mode), [schemas, schema, value, mode]);
  const doc = findSchema(schemas, schema);
  const rows = useMemo(() => sortRows(report.rows), [report]);
  const name = report.matched ?? doc?.name ?? schema;
  const verdict =
    report.errors > 0
      ? `${report.errors} problem${report.errors === 1 ? "" : "s"} against ${name}.`
      : report.warnings > 0
        ? `Mostly matches ${name}: ${report.warnings} field${report.warnings === 1 ? " differs" : "s differ"} from the documented schema, noted below.`
        : mode === "reply"
          ? `This reply matches ${name}, as the schema documents it.`
          : `This body fits ${name}.`;

  return (
    <div className={styles.stack} aria-live="polite">
      <p className={`${styles.verdict} ${report.errors ? styles.verdictBad : report.warnings ? styles.verdictWarn : styles.verdictOk}`}>{verdict}</p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">{caption ?? `Each field checked against ${name}`}</caption>
          <thead>
            <tr>
              <th>Field</th>
              <th>Schema type</th>
              <th>Value</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: CheckRow, i) => (
              <tr key={`${r.path}-${i}`}>
                <td className={styles.fieldName}>{r.path}</td>
                <td className={styles.typeCell}>{r.field ? `${r.field.typeLabel}${r.field.required ? ", required" : ""}` : "not documented"}</td>
                <td className={styles.mono}>{cellValue(r.path, r.value)}</td>
                <td>
                  <span className={`${styles.tag} ${SEVERITY_CLASS[r.severity]}`}>{SEVERITY_LABEL[r.severity]}</span> <span className={styles.desc}>{r.message}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
