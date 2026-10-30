"use client";

import { useId, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, Segmented, TextInput } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { SchemaChecks } from "@/components/docs/playgrounds/start/ModelsEndpoint";
import { checkSchema, MODELS_SCHEMAS, searchSchemas, type SchemaField } from "@/components/docs/playgrounds/start/reference";
import styles from "@/components/docs/playgrounds/start/start.module.css";

type Source = "list" | "retrieve";

/**
 * The Models schemas page as an explorer: each schema's fields with their types, required badges and descriptions,
 * searchable, with "array of Model" linking to Model; and next to it a live object (from GET /v1/models or
 * GET /v1/models/{model}) checked against the schema field by field. Free.
 */
export function SchemaExplorer({ source: initialSource = "list" }: { slug: string; source?: Source }) {
  const id = useId();
  const runner = useDocsRun();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(MODELS_SCHEMAS.map((s) => [s.id, true])));
  const [source, setSource] = useState<Source>(initialSource);
  const [ran, setRan] = useState<Source | null>(null);
  const running = runner.state === "running";
  const found = searchSchemas(query);
  const json = runner.result?.ok ? runner.result.json : null;
  const schemaId = ran === "retrieve" ? "model" : "list-models-response";

  const run = () => {
    setRan(source);
    void runner.run(source === "list" ? "models" : `models/${DEFAULT_TEXT_MODEL}`, { method: "GET" });
  };

  const jump = (schema: string) => {
    setQuery("");
    setOpen((o) => ({ ...o, [schema]: true }));
    requestAnimationFrame(() => document.getElementById(`${id}-${schema}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  return (
    <div className="pg">
      <Field id={`${id}-search`} label="Search fields">
        <TextInput id={`${id}-search`} type="search" value={query} placeholder="created, enum, metadata..." onChange={(e) => setQuery(e.target.value)} />
      </Field>
      <div className={styles.stack} aria-live="polite">
        {found.length ? null : <p className="pg-empty">No field matches &quot;{query}&quot;.</p>}
        {found.map(({ schema, fields }) => (
          <details
            key={schema.id}
            id={`${id}-${schema.id}`}
            className={styles.schema}
            open={query ? true : open[schema.id]}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              if (!query) setOpen((o) => (o[schema.id] === isOpen ? o : { ...o, [schema.id]: isOpen }));
            }}
          >
            <summary>
              {schema.name}
              <span className="pg-meta">{schema.description}</span>
            </summary>
            <div className={styles.schemaBody}>
              {fields.map((f) => (
                <FieldRow key={f.name} field={f} onRef={jump} />
              ))}
            </div>
          </details>
        ))}
      </div>

      <div className={styles.card}>
        <p className={styles.cardTitle}>A live object, checked against these schemas</p>
        <div className="pg-actions">
          <Segmented<Source>
            label="Object"
            size="sm"
            options={[
              { value: "list", label: "GET /v1/models" },
              { value: "retrieve", label: `GET /v1/models/${DEFAULT_TEXT_MODEL}` },
            ]}
            value={source}
            onChange={setSource}
            disabled={running}
          />
          <RunButton running={running} onRun={run} onStop={runner.abort} label="Fetch and check" />
        </div>
        <ErrorBox error={runner.error} />
        {json ? (
          <>
            <p className="pg-hint">
              {ran === "list" ? "ListModelsResponse" : "Model"}, fetched in {latencyLabel(runner.result!.elapsedMs)}.
            </p>
            <SchemaChecks checks={checkSchema(schemaId, json)} schema={ran === "list" ? "ListModelsResponse" : "Model"} />
            <JsonTree value={json} openDepth={ran === "list" ? 1 : 2} />
          </>
        ) : running ? (
          <p className="pg-wait">Fetching...</p>
        ) : null}
      </div>
    </div>
  );
}

function FieldRow({ field, onRef }: { field: SchemaField; onRef(schema: string): void }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldName}>{field.name}</span>
      <span className={styles.tags}>
        {field.items ? (
          <button type="button" className={`pg-pill ${styles.fieldType}`} onClick={() => onRef(field.items!)} aria-label={`${field.type}: go to the Model schema`}>
            {field.type}
          </button>
        ) : (
          <span className={styles.fieldType}>{field.type}</span>
        )}
        <span className={`${styles.tag} ${field.required ? styles.tagAccent : ""}`}>{field.required ? "Required" : "Optional"}</span>
      </span>
      <span />
      <span className="pg-hint">{field.description.replace(/`/g, "")}</span>
    </div>
  );
}
