"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, runOnModEnter, Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { PresetRow } from "@/components/docs/playgrounds/common/PresetRow";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { buildBody, PROTOCOL_LABEL, PROTOCOL_PATH } from "@/lib/docs/client/body";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { strictSubsetProblems, validateJson, type ValidationReport } from "@/lib/docs/client/schema";
import { collectorFor, collectReply, type Collected } from "@/lib/docs/client/stream";

/**
 * Structured output, live: pick a schema preset (or edit the schema), send the prompt with a strict json_schema
 * (text.format on Responses, response_format on Chat Completions, structured-output page), then see the reply parsed
 * and checked against the schema field by field. Before sending, it warns when strict mode would reject the schema.
 */

export interface SchemaPreset {
  label: string;
  /** The schema's name, sent as text.format.name or json_schema.name. */
  name: string;
  schema: Record<string, unknown>;
  prompt: string;
  system?: string;
}

export interface StructuredOutputPlaygroundProps {
  slug: string;
  presets: SchemaPreset[];
  /** Default "responses". */
  protocol?: "responses" | "chat";
  /** Offer a switcher between the two. */
  protocols?: Array<"responses" | "chat">;
  model?: string;
  models?: string[];
  /** Default true, as in Meta's examples. */
  strict?: boolean;
  /** Default "low". */
  effort?: Effort | null;
  /** Default true. */
  stream?: boolean;
}

type Proto = "responses" | "chat";

interface Outcome {
  reply: Collected | null;
  parsed: { ok: true; value: unknown } | { ok: false; message: string } | null;
  report: ValidationReport | null;
}

export function StructuredOutputPlayground(props: StructuredOutputPlaygroundProps) {
  const id = useId();
  const protocols: Proto[] = props.protocols?.length ? props.protocols : [props.protocol ?? "responses"];
  const runner = useDocsRun();
  const first = props.presets[0];
  const [protocol, setProtocol] = useState<Proto>(props.protocol && protocols.includes(props.protocol) ? props.protocol : protocols[0]);
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(props.effort === undefined ? "low" : props.effort);
  const [strict, setStrict] = useState(props.strict ?? true);
  const [stream, setStream] = useState(props.stream ?? true);
  const [active, setActive] = useState<number | null>(first ? 0 : null);
  const [name, setName] = useState(first?.name ?? "Result");
  const blank = '{\n  "type": "object",\n  "properties": {},\n  "required": [],\n  "additionalProperties": false\n}';
  const [baseSchema, setBaseSchema] = useState(first ? formatJson(first.schema) : blank);
  const [schemaText, setSchemaText] = useState(baseSchema);
  const [prompt, setPrompt] = useState(first?.prompt ?? "");
  const [system, setSystem] = useState(first?.system ?? "");
  const [live, setLive] = useState<Collected | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [showCode, setShowCode] = useState(false);
  const eventsRef = useRef<EventLogEntry[]>([]);
  const running = runner.state === "running";

  const schema = useMemo(() => parseJsonText(schemaText), [schemaText]);
  const schemaObj = schema.ok && schema.value && typeof schema.value === "object" && !Array.isArray(schema.value) ? (schema.value as Record<string, unknown>) : null;
  const problems = useMemo(() => (strict && schemaObj ? strictSubsetProblems(schemaObj) : []), [strict, schemaObj]);

  const body = useMemo(
    () =>
      buildBody(protocol, {
        model,
        system,
        messages: [{ role: "user", content: prompt.trim() || "..." }],
        effort: fitEffort(model, effort),
        stream,
        schema: { name: name.trim() || "Result", schema: schemaObj ?? {}, strict },
      }),
    [protocol, model, system, prompt, effort, stream, name, schemaObj, strict],
  );

  const pick = (i: number) => {
    const p = props.presets[i];
    if (!p) return;
    setActive(i);
    setName(p.name);
    setBaseSchema(formatJson(p.schema));
    setSchemaText(formatJson(p.schema));
    setPrompt(p.prompt);
    setSystem(p.system ?? "");
    setOutcome(null);
  };

  const send = async () => {
    if (running || !schemaObj || !prompt.trim()) return;
    const collector = collectorFor(protocol);
    eventsRef.current = [];
    setEvents([]);
    setLive(null);
    setOutcome(null);
    const sent = body;
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      eventsRef.current = logEvent(eventsRef.current, e);
      setLive(collector.snapshot());
      setEvents(eventsRef.current);
    };
    const res = await runner.run(PROTOCOL_PATH[protocol], { method: "POST", body: sent, stream, onEvent: stream ? onEvent : undefined });
    const reply = stream ? collector.snapshot() : res.ok ? collectReply(protocol, res.json) : null;
    if (!reply || !reply.text) {
      setOutcome({ reply, parsed: null, report: null });
      return;
    }
    const parsed = parseJsonText(reply.text);
    setOutcome({ reply, parsed, report: parsed.ok ? validateJson(schemaObj, parsed.value) : null });
  };

  const report = outcome?.report;
  const failed = report ? report.fields.filter((f) => !f.ok).length : 0;
  const reply = running ? live : (outcome?.reply ?? null);

  return (
    <div className="pg pg-structured">
      <div className="pg-bar">
        {protocols.length > 1 ? (
          <Segmented<Proto>
            label="Protocol"
            options={protocols.map((p) => ({ value: p, label: PROTOCOL_LABEL[p] }))}
            value={protocol}
            onChange={(p) => {
              setProtocol(p);
              setOutcome(null);
              runner.reset();
            }}
            disabled={running}
          />
        ) : null}
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        <span className="pg-advanced">
          <Toggle id={`${id}-strict`} label={<code>strict</code>} checked={strict} onChange={setStrict} disabled={running} />
        </span>
        <Toggle id={`${id}-stream`} label="Stream" checked={stream} onChange={setStream} disabled={running} />
      </div>

      {props.presets.length > 1 ? <PresetRow label="Schema" presets={props.presets} active={active} onPick={pick} disabled={running} /> : null}

      {/* auto-fit: with the schema column behind Options, the prompt column takes the whole row. */}
      <div className="pg-split" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
        <div className="pg-col">
          {/* The preset's schema runs as it is; a schema that doesn't parse stays in view, since it stops Run. */}
          <div className={`pg-col${schemaObj ? " pg-advanced" : ""}`}>
            <Field id={`${id}-name`} label="Schema name">
              <TextInput id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} disabled={running} spellCheck={false} />
            </Field>
            <JsonEditor
              id={`${id}-schema`}
              label="JSON Schema"
              value={schemaText}
              onChange={setSchemaText}
              resetTo={baseSchema}
              rows={14}
              disabled={running}
            />
          </div>
          {problems.length ? (
            <div className="pg-warn" role="note">
              <p className="pg-warn-title">With strict on, the API would reject this schema (HTTP 400):</p>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="pg-col">
          {system || props.presets.some((p) => p.system) ? (
            <div className="pg-col pg-advanced">
              <Field id={`${id}-system`} label="Instructions">
                <TextArea id={`${id}-system`} rows={2} value={system} onChange={(e) => setSystem(e.target.value)} disabled={running} />
              </Field>
            </div>
          ) : null}
          <Field id={`${id}-prompt`} label="Prompt">
            <TextArea
              id={`${id}-prompt`}
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={runOnModEnter(() => void send())}
              disabled={running}
            />
          </Field>
          <div className="pg-composer-bar">
            <span className="pg-muted pg-kbd-hint">
              {protocol === "responses" ? "Sent as text.format" : "Sent as response_format"} with {strict ? "strict: true" : "strict: false"}
            </span>
            <RunButton running={running} onRun={() => void send()} onStop={runner.abort} disabled={!schemaObj || !prompt.trim()} />
          </div>
        </div>
      </div>

      <ErrorBox error={runner.error} />

      {running || outcome ? (
        <ResponseView
          result={running ? null : runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={reply?.final ?? undefined}
          usage={reply?.usage ?? undefined}
          model={runner.result?.model ?? reply?.model ?? null}
          events={events.length ? events : undefined}
        >
          {running || !outcome?.parsed ? (
            <StreamView text={reply?.text ?? ""} running={running} placeholder="No reply text." />
          ) : outcome.parsed.ok && report ? (
            <div className="pg-schema-result">
              <p className={`pg-verdict ${report.valid ? "pg-good" : "pg-bad"}`} role="status">
                {report.valid
                  ? `Matches the schema: all ${report.fields.length} field${report.fields.length === 1 ? "" : "s"} passed.`
                  : `${failed} of ${report.fields.length} field${report.fields.length === 1 ? "" : "s"} failed${report.issues.length > failed ? `, ${report.issues.length} problems in all` : ""}.`}
              </p>
              <div className="pg-split">
                <div className="pg-col">
                  <p className="pg-section-label">Parsed reply</p>
                  <JsonTree value={outcome.parsed.value} />
                </div>
                <div className="pg-col">
                  <p className="pg-section-label">Fields</p>
                  <ul className="pg-checks">
                    {report.fields.map((f) => (
                      <li key={f.path} className={f.ok ? "pg-check-ok" : "pg-check-bad"}>
                        <span className="pg-check-mark" aria-hidden>
                          {f.ok ? "✓" : "✗"}
                        </span>
                        <span className="sr-only">{f.ok ? "Passed: " : "Failed: "}</span>
                        <code>{f.path || "/"}</code> <span className="pg-muted">{f.expected}</span>
                        {f.note ? <span className="pg-check-note"> {f.note}</span> : null}
                      </li>
                    ))}
                  </ul>
                  {report.issues.filter((i) => !report.fields.some((f) => f.path === i.path)).length ? (
                    <ul className="pg-checks">
                      {report.issues
                        .filter((i) => !report.fields.some((f) => f.path === i.path))
                        .map((i) => (
                          <li key={`${i.path}-${i.message}`} className="pg-check-bad">
                            <span className="pg-check-mark" aria-hidden>
                              ✗
                            </span>
                            <code>{i.path || "/"}</code> {i.message}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p className="pg-verdict pg-bad">The reply isn&apos;t valid JSON: {outcome.parsed.ok ? "" : outcome.parsed.message}</p>
              <pre className="pg-pre">{outcome.reply?.text}</pre>
            </div>
          )}
        </ResponseView>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={PROTOCOL_PATH[protocol]} body={body} caption="The request Run sends" /> : null}
    </div>
  );
}
