"use client";

import { useId, useMemo, useState } from "react";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { PresetRow } from "@/components/docs/playgrounds/common/PresetRow";
import { StructuredOutputPlayground, type SchemaPreset } from "@/components/docs/playgrounds/common/StructuredOutputPlayground";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import type { Effort } from "@/lib/docs/client/models";
import { strictSubsetProblems } from "@/lib/docs/client/schema";
import { Badge, cx, DemoTabs, n } from "@/components/docs/playgrounds/text/parts";
import { RuleChecks } from "@/components/docs/playgrounds/text/RuleChecks";
import type { RuleCheck } from "@/components/docs/playgrounds/text/rules";
import { generatedSchema, limitChecks, schemaStats, SCHEMA_LIMITS, type GeneratedSchema } from "@/components/docs/playgrounds/text/schema-size";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * The structured output page's demo: the kit's StructuredOutputPlayground with the page's Address example and
 * practical schemas (Chat Completions' response_format or Responses' text.format, strict on or off), a local checker
 * that measures any schema against the limits the page lists before it's sent, and the page's rules checked live
 * (recursion, depth, the strict subset). "Run it in the playground" takes a checked schema straight to the first tab.
 */

export interface SizePreset {
  label: string;
  /** The schema itself, or `generate` for one built in the page (lib: schema-size generatedSchema). */
  schema?: Record<string, unknown>;
  generate?: GeneratedSchema;
}

function presetSchema(p: SizePreset): Record<string, unknown> {
  return p.schema ?? (p.generate ? generatedSchema(p.generate) : { type: "object", properties: {} });
}

export interface StructuredOutputDemoProps {
  slug: string;
  presets: SchemaPreset[];
  /** Default ["chat", "responses"]: the page's examples are Chat Completions. */
  protocols?: Array<"responses" | "chat">;
  /** Default false, as the API's own default; the playground warns when strict would reject the schema. */
  strict?: boolean;
  effort?: Effort | null;
  model?: string;
  models?: string[];
  stream?: boolean;
  /** Schemas the size checker offers. */
  sizePresets?: SizePreset[];
  /** The enum allowance this demo's key has, when it differs from the page's default of 1,000. */
  enumAllowance?: number;
  checks?: RuleCheck[];
  checksIntro?: string;
}

export function StructuredOutputDemo(props: StructuredOutputDemoProps) {
  const [tab, setTab] = useState("run");
  const [extra, setExtra] = useState<SchemaPreset | null>(null);
  const [generation, setGeneration] = useState(0);
  const presets = useMemo(() => (extra ? [extra, ...props.presets] : props.presets), [extra, props.presets]);
  const protocols = props.protocols ?? ["chat", "responses"];

  const tabs = [
    {
      id: "run",
      label: "Run a schema",
      content: (
        <StructuredOutputPlayground
          key={generation}
          slug={props.slug}
          presets={presets}
          protocols={protocols}
          protocol={protocols[0]}
          strict={props.strict ?? false}
          effort={props.effort}
          model={props.model}
          models={props.models}
          stream={props.stream}
        />
      ),
    },
    {
      id: "size",
      label: "Check a schema's size",
      content: (
        <SchemaSizeCheck
          presets={[...(props.sizePresets ?? []), ...props.presets.map((p) => ({ label: p.label, schema: p.schema }))]}
          enumAllowance={props.enumAllowance}
          onUse={(schema, label) => {
            setExtra({ label: `Checked: ${label}`, name: "Checked", schema, prompt: "Fill in this schema with realistic sample values." });
            setGeneration((g) => g + 1);
            setTab("run");
          }}
        />
      ),
    },
    ...(props.checks?.length
      ? [{ id: "rules", label: "Check the rules", count: props.checks.length, content: <RuleChecks slug={props.slug} checks={props.checks} intro={props.checksIntro} models={props.models} /> }]
      : []),
  ];

  return <DemoTabs label="Structured output demo" tabs={tabs} value={tab} onChange={setTab} />;
}

/** Measures a schema against the page's limits, locally; nothing is sent until "Run it in the playground". */
export function SchemaSizeCheck({
  presets,
  enumAllowance,
  onUse,
}: {
  presets: SizePreset[];
  enumAllowance?: number;
  onUse?(schema: Record<string, unknown>, label: string): void;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(presets.length ? 0 : null);
  const [text, setText] = useState(presets[0] ? formatJson(presetSchema(presets[0])) : '{\n  "type": "object",\n  "properties": {}\n}');
  const parsed = useMemo(() => parseJsonText(text), [text]);
  const schema = parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : null;
  const stats = useMemo(() => (schema ? schemaStats(schema) : null), [schema]);
  const checks = stats ? limitChecks(stats, SCHEMA_LIMITS.enumValues) : [];
  const strict = useMemo(() => (schema ? strictSubsetProblems(schema) : []), [schema]);
  const failing = checks.filter((c) => c.ok === false);
  const enumOver = stats && stats.enumValues > SCHEMA_LIMITS.enumValues;

  return (
    <div className={`pg ${styles.stack}`}>
      <p className={cx(styles.about, "pg-advanced")}>
        Model API checks a schema before decoding starts and answers HTTP 400 when it goes past a limit. These limits apply to <code>response_format</code>,{" "}
        <code>text.format</code> and function tools&apos; <code>parameters</code>. Edit the schema; the checks run here as you type.
      </p>
      {presets.length ? (
        <PresetRow
          keep={4}
          label="Schema"
          presets={presets}
          active={active}
          onPick={(i) => {
            setActive(i);
            setText(formatJson(presetSchema(presets[i])));
          }}
        />
      ) : null}
      <div className={styles.stack}>
        <JsonEditor
          id={`${id}-schema`}
          label="JSON Schema"
          value={text}
          onChange={(t) => {
            setText(t);
            setActive(null);
          }}
          rows={12}
        />
        <div className={styles.tight}>
          {stats ? (
            <>
              <p className={cx(styles.cardTitle)} role="status">
                {failing.length ? `${failing.length} limit${failing.length === 1 ? "" : "s"} exceeded: the API would answer HTTP 400.` : "Within every limit."}
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Check</th>
                      <th scope="col" className={styles.num}>
                        This schema
                      </th>
                      <th scope="col" className={styles.num}>
                        Limit
                      </th>
                      <th scope="col">
                        <span className="sr-only">Result</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.id}>
                        <td>
                          {c.label}
                          {c.note ? <span className={cx(styles.muted, styles.small)}> {c.note}</span> : null}
                        </td>
                        <td className={styles.num}>{c.id === "recursive" ? (c.value ? "yes" : "no") : c.ok === null ? "unbounded" : n(c.value)}</td>
                        <td className={styles.num}>{c.id === "recursive" ? "none allowed" : n(c.limit)}</td>
                        <td>{c.ok === null ? <Badge>n/a</Badge> : c.ok ? <Badge tone="ok">OK</Badge> : <Badge tone="bad">{c.id === "recursive" ? "Rejected" : "Over"}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {enumOver && enumAllowance && stats.enumValues <= enumAllowance ? (
                <p className={cx(styles.about, styles.small, "pg-advanced")}>
                  Over the default of 1,000 enum values, but the limit can be raised per app: this demo&apos;s key accepted up to {n(enumAllowance)} when we checked, so it may still run here.
                </p>
              ) : null}
              {strict.length ? (
                <div className="pg-warn" role="note">
                  <p className="pg-warn-title">With strict: true the API would also reject it (the strict subset):</p>
                  <ul>
                    {strict.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className={cx(styles.about, styles.small, "pg-advanced")}>
                  {failing.length ? "Apart from the limits above, it fits the strict subset." : "It fits the strict subset too, so strict: true accepts it."}
                </p>
              )}
              {onUse && schema ? (
                <div className="pg-advanced">
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => onUse(schema, active !== null ? presets[active].label : "your schema")}>
                    Run it in the playground
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="pg-hint pg-bad">{parsed.ok ? "A schema is a JSON object." : parsed.message}</div>
          )}
        </div>
      </div>
    </div>
  );
}
