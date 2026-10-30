"use client";

import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import { CodeView, ErrorBox, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, TextInput, Toggle } from "@/components/docs/kit/Field";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { ImageOutput } from "@/components/docs/media/ImageOutput";
import { useRecentFiles } from "@/components/docs/playgrounds/media/FileIdBar";
import { exampleFor, formFieldsFrom } from "@/components/docs/playgrounds/media/schema-check";
import { SchemaCheckTable } from "@/components/docs/playgrounds/media/SchemaCheckTable";
import { findSchema, type FieldType, type SchemaDoc, type SchemaField } from "@/components/docs/playgrounds/media/schema-tables";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import type { FormSpec } from "@/lib/docs/client/form";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import { imagesOfImagesReply } from "@/lib/docs/media/images";
import type { PickedMedia } from "@/lib/docs/media/prepare";

export interface SchemaLive {
  label: string;
  /** What it costs and shows, one line. */
  note?: string;
  /** The request schema it sends, when it has a body. */
  schema?: string;
  method: "GET" | "POST" | "DELETE";
  /** Meta's path; "{file_id}" takes the newest file this visitor uploaded. */
  path: string;
  /** "json" sends the body, "multipart" sends its fields as form parts with a picked file, "none" sends nothing. */
  body: "json" | "multipart" | "none";
  /** The schema the reply is checked against. */
  reply: string;
  /** Multipart: the field that carries the file, and the sample it starts with. */
  fileField?: string;
  sampleId?: string;
}

export interface SchemaExplorerProps {
  slug?: string;
  /** The page's schemas, parsed from its Markdown on the server (schema-tables.ts). */
  schemas: SchemaDoc[];
  /** The schema shown first (anchor or name). */
  initial?: string;
  /** Example values by field name or "<schema id>.<field>"; null leaves a field out (schema-check.ts, ExampleOptions). */
  hints?: Record<string, unknown>;
  /** Live calls that send a request schema or bring back a reply schema, checked field by field. */
  live?: SchemaLive[];
}

const GROUPS = ["Requests", "Replies", "Stream events", "Parts"] as const;

function groupOf(s: SchemaDoc): (typeof GROUPS)[number] {
  if (/(Request|Param)$/.test(s.name)) return "Requests";
  if (/Response$/.test(s.name)) return "Replies";
  if (/Event$/.test(s.name)) return "Stream events";
  return "Parts";
}

function refsOf(type: FieldType): string[] {
  switch (type.kind) {
    case "ref":
      return [type.ref];
    case "array":
      return refsOf(type.items);
    case "union":
      return type.options.flatMap(refsOf);
    default:
      return [];
  }
}

/** Inline code in a description, as the page writes it with backticks. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

function constraintTags(f: SchemaField): string[] {
  const c = f.constraints;
  const tags: string[] = [];
  if (c.minimum !== undefined) tags.push(`min ${c.minimum}`);
  if (c.maximum !== undefined) tags.push(`max ${c.maximum}`);
  if (c.minItems !== undefined) tags.push(`at least ${c.minItems} item${c.minItems === 1 ? "" : "s"}`);
  if (c.maxItems !== undefined) tags.push(`at most ${c.maxItems} items`);
  if (c.default !== undefined) tags.push(`default ${String(c.default)}`);
  return tags;
}

/**
 * The schema tables of an API reference "Schemas" page, explorable: every schema grouped as requests, replies, stream
 * events and parts, a field finder across all of them, links between schemas both ways, an example body built from
 * the table (required fields, or every field), a checker that tells what Meta would refuse in a body you write
 * (missing required fields, wrong types, values out of range, unknown fields, and the rules the pages state in prose,
 * such as moderation on Muse Image or an edit's 1 to 10 images: schema-check.ts), and live calls whose real replies
 * are checked against the documented reply schema.
 */
export function SchemaExplorer({ schemas, initial, hints, live = [] }: SchemaExplorerProps) {
  const id = useId();
  const files = useRecentFiles();
  const runner = useDocsRun();
  const start = (initial && findSchema(schemas, initial)?.id) || schemas[0]?.id || "";
  const [selected, setSelected] = useState(start);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [optional, setOptional] = useState(false);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [ran, setRan] = useState<{ action: SchemaLive; path: string } | null>(null);
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [showCode, setShowCode] = useState(false);
  const running = runner.state === "running";

  const schema = findSchema(schemas, selected);
  const usedBy = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const s of schemas) {
      const targets = [...s.fields.flatMap((f) => refsOf(f.type)), ...(s.oneOf ?? []).map((o) => o.id)];
      for (const t of targets) {
        if (!map.has(t)) map.set(t, new Set());
        map.get(t)!.add(s.id);
      }
    }
    return map;
  }, [schemas]);

  const hits = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2) return [];
    return schemas
      .flatMap((s) => s.fields.filter((f) => f.name.toLowerCase().includes(q) || f.typeLabel.toLowerCase().includes(q)).map((f) => ({ s, f })))
      .slice(0, 24);
  }, [find, schemas]);

  const exampleText = (schemaId: string, withOptional: boolean) => formatJson(exampleFor(schemas, schemaId, { optional: withOptional, hints }));
  const sendsSelected = live.find((a) => a.schema && findSchema(schemas, a.schema)?.id === schema?.id);
  const isRequest = !!schema && (groupOf(schema) === "Requests" || !!sendsSelected);
  const bodyText = schema ? (bodies[schema.id] ?? exampleText(schema.id, optional)) : "";
  const parsed = useMemo(() => (isRequest ? parseJsonText(bodyText) : null), [isRequest, bodyText]);

  const open = (schemaId: string, field?: string) => {
    setSelected(schemaId);
    setHighlight(field ?? null);
  };

  const bodyFor = (a: SchemaLive): unknown => {
    if (!a.schema) return undefined;
    const target = findSchema(schemas, a.schema);
    if (!target) return undefined;
    const text = bodies[target.id] ?? exampleText(target.id, target.id === schema?.id ? optional : false);
    const p = parseJsonText(text);
    return p.ok ? p.value : undefined;
  };

  const pathFor = (a: SchemaLive) => a.path.replace("{file_id}", encodeURIComponent(files[0]?.id ?? ""));

  const runLive = async (a: SchemaLive) => {
    if (running) return;
    const path = pathFor(a);
    setRan({ action: a, path });
    if (a.body === "multipart") {
      const body = bodyFor(a);
      if (!body || typeof body !== "object" || !picked) return;
      const form = new FormData();
      for (const [k, v] of formFieldsFrom(body as Record<string, unknown>, { [a.fileField ?? "file"]: picked.blob })) {
        if (typeof v === "string") form.append(k, v);
        else form.append(k, v, picked.name);
      }
      await runner.run(path, { form });
      return;
    }
    await runner.run(path, { method: a.method, ...(a.body === "json" ? { body: bodyFor(a) } : {}) });
  };

  // An images reply shows its pictures above the check, as the other images demos do.
  const replyImages = runner.result?.ok ? imagesOfImagesReply(runner.result.json) : [];

  if (!schema) return <p className={styles.note}>No schema tables on this page.</p>;

  const fieldsTop = schema.fields;
  const usedHere = [...(usedBy.get(schema.id) ?? [])].map((sid) => findSchema(schemas, sid)).filter((s): s is SchemaDoc => !!s);
  const actionCode = ran
    ? ran.action.body === "multipart"
      ? {
          method: ran.action.method,
          path: ran.path,
          // An empty stand-in for the file keeps it last, where the upload sends it.
          form: formFieldsFrom((bodyFor(ran.action) as Record<string, unknown>) ?? {}, { [ran.action.fileField ?? "file"]: new Blob([]) }).map(([name, value]): FormSpec =>
            typeof value === "string" ? { name, value } : { name, value: picked?.name ?? "file", file: { label: "File" } },
          ),
        }
      : { method: ran.action.method, path: ran.path, body: ran.action.body === "json" ? bodyFor(ran.action) : undefined }
    : null;

  const typeCell = (t: FieldType): ReactNode => {
    switch (t.kind) {
      case "ref":
        return (
          <button type="button" className={styles.refLink} onClick={() => open(t.ref)}>
            {t.name}
          </button>
        );
      case "array":
        return <>array of {typeCell(t.items)}</>;
      case "union":
        return t.options.map((o, i) => (
          <Fragment key={i}>
            {i ? " | " : ""}
            {typeCell(o)}
          </Fragment>
        ));
      case "enum":
        return <>enum: {t.values.map((v) => `"${v}"`).join(", ")}</>;
      case "binary":
        return "string (binary)";
      default:
        return t.format ? `${t.kind} (${t.format})` : t.kind;
    }
  };

  return (
    <div className={`pg ${styles.lab}`}>
      <Field id={`${id}-find`} label="Find a field" hint={find.trim().length >= 2 ? `${hits.length} match${hits.length === 1 ? "" : "es"} across ${schemas.length} schemas.` : undefined}>
        <TextInput id={`${id}-find`} value={find} placeholder="n, file_id, stream, tool_enablement..." spellCheck={false} onChange={(e) => setFind(e.target.value)} />
      </Field>
      {hits.length ? (
        <div className={styles.hits} role="group" aria-label="Matching fields">
          {hits.map(({ s, f }) => (
            <button key={`${s.id}:${f.name}`} type="button" className="pg-pill" aria-pressed={s.id === schema.id && highlight === f.name} onClick={() => open(s.id, f.name)}>
              <code>{f.name}</code> in {s.title}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.groups}>
        {GROUPS.map((g) => {
          const list = schemas.filter((s) => groupOf(s) === g);
          if (!list.length) return null;
          return (
            <div key={g} className={styles.group} role="group" aria-label={g}>
              <span className={styles.groupLabel}>{g}</span>
              {list.map((s) => (
                <button key={s.id} type="button" className="pg-pill" aria-pressed={s.id === schema.id} onClick={() => open(s.id)}>
                  {s.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <section className={styles.card} aria-labelledby={`${id}-title`}>
        <div className={styles.cardHead}>
          <h3 className={styles.schemaTitle} id={`${id}-title`}>
            {schema.title}
          </h3>
          <span className={styles.schemaName}>{schema.name}</span>
        </div>
        {schema.description ? (
          <p className={styles.desc}>
            <Prose text={schema.description} />
          </p>
        ) : null}
        {schema.oneOf?.length ? (
          <p className={styles.desc}>
            One of:{" "}
            {schema.oneOf.map((o, i) => (
              <Fragment key={o.id}>
                {i ? ", " : ""}
                <button type="button" className={styles.refLink} onClick={() => open(o.id)}>
                  {o.name}
                </button>
              </Fragment>
            ))}
            . A stream sends each event as its own server-sent event.
          </p>
        ) : null}
        {fieldsTop.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Fields of {schema.title}</caption>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {fieldsTop.map((f) => (
                  <tr key={f.name} className={highlight === f.name ? styles.hit : undefined}>
                    <td className={styles.fieldName}>{f.name}</td>
                    <td className={styles.typeCell}>{typeCell(f.type)}</td>
                    <td>{f.required ? <span className={`${styles.tag} ${styles.tagAccent}`}>Yes</span> : <span className={styles.note}>No</span>}</td>
                    <td className={styles.desc}>
                      {f.description ? <Prose text={f.description} /> : <span className={styles.note}>No description on the page.</span>}
                      {constraintTags(f).length ? (
                        <span className={styles.tags}>
                          {" "}
                          {constraintTags(f).map((t) => (
                            <span key={t} className={styles.tag}>
                              {t}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {usedHere.length ? (
          <p className={styles.note}>
            Used in:{" "}
            {usedHere.map((s, i) => (
              <Fragment key={s.id}>
                {i ? ", " : ""}
                <button type="button" className={styles.refLink} onClick={() => open(s.id)}>
                  {s.name}
                </button>
              </Fragment>
            ))}
          </p>
        ) : null}
      </section>

      {isRequest ? (
        <div className={styles.stack}>
          <div className={styles.spread}>
            <Toggle
              id={`${id}-opt`}
              label="Include optional fields"
              checked={optional}
              onChange={(v) => {
                setOptional(v);
                setBodies((b) => {
                  const next = { ...b };
                  delete next[schema.id];
                  return next;
                });
              }}
            />
            <CopyButton value={bodyText} label="Copy the body" className="btn btn-outline btn-sm" />
          </div>
          <JsonEditor
            id={`${id}-body`}
            label={`A ${schema.name} body: edit it to see what the API would refuse`}
            value={bodyText}
            onChange={(t) => setBodies((b) => ({ ...b, [schema.id]: t }))}
            resetTo={exampleText(schema.id, optional)}
            rows={10}
          />
          {parsed?.ok ? <SchemaCheckTable schemas={schemas} schema={schema.id} value={parsed.value} mode="request" caption={`The body checked against ${schema.name}`} /> : null}
        </div>
      ) : (
        <details className="pg-system">
          <summary>An example {schema.name}, built from the table</summary>
          <pre className={styles.pre}>{exampleText(schema.id, true)}</pre>
        </details>
      )}

      {live.length ? (
        <div className={`${styles.stack} ${styles.divider}`}>
          <p className={styles.sectionTitle}>Check a real reply</p>
          <div className={styles.stack}>
            {live.map((a) => {
              const needsId = a.path.includes("{file_id}");
              const relevant = (a.schema && findSchema(schemas, a.schema)?.id === schema.id) || findSchema(schemas, a.reply)?.id === schema.id;
              return (
                <div key={a.label} className={styles.action}>
                  <span className={`${styles.desc} ${styles.actionText}`}>
                    {relevant ? <span className={`${styles.tag} ${styles.tagAccent}`}>This schema</span> : null} <strong>{a.label}</strong>
                    {a.note ? <span className={styles.note}> {a.note}</span> : null}
                  </span>
                  <RunButton
                    running={running && ran?.action.label === a.label}
                    onRun={() => void runLive(a)}
                    onStop={runner.abort}
                    label="Send"
                    disabled={running || (needsId && !files.length) || (a.body === "multipart" && !picked) || (a.body === "json" && bodyFor(a) === undefined)}
                  />
                </div>
              );
            })}
          </div>
          {live.some((a) => a.body === "multipart") ? (
            <FilePicker
              accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"
              value={picked}
              onChange={setPicked}
              defaultSampleId={live.find((a) => a.body === "multipart")?.sampleId ?? "receipt"}
              preview="compact"
              prepare="none"
              label="The file for the upload"
            />
          ) : null}
          {live.some((a) => a.path.includes("{file_id}")) ? (
            <p className={styles.note}>{files.length ? `Calls on {file_id} use your newest file, ${files[0].id}.` : "Calls on {file_id} need a file: upload one first."}</p>
          ) : null}
          <ErrorBox error={runner.error} />
          {running || runner.result ? (
            <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs}>
              {runner.result?.ok && ran ? (
                <div className={styles.stack}>
                  {replyImages.length ? <ImageOutput images={replyImages} name="muse-image" /> : null}
                  <SchemaCheckTable schemas={schemas} schema={ran.action.reply} value={runner.result.json} mode="reply" />
                </div>
              ) : undefined}
            </ResponseView>
          ) : null}
          {actionCode ? (
            <>
              <div className="pg-actions">
                <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
              </div>
              {showCode ? <CodeView method={actionCode.method} path={actionCode.path} body={"body" in actionCode ? actionCode.body : undefined} form={"form" in actionCode ? actionCode.form : undefined} caption="The last call" /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
