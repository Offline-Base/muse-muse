"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { FileSlotInput, type PickedFile } from "@/components/docs/kit/FileSlotInput";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { BlobOutput, ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { Images, ReplyView } from "@/components/docs/kit/StreamView";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import { sseReader, type SseEvent } from "@/lib/docs/client/api";
import {
  EXAMPLE_ID,
  isAllowedEndpoint,
  isBinaryReply,
  isStreamable,
  modelKindFor,
  placeholderKind,
} from "@/lib/docs/client/endpoints";
import { logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { readFileAs } from "@/lib/docs/client/files";
import type { FileSlot, FormSpec } from "@/lib/docs/client/form";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import { runsAs } from "@/lib/docs/client/models";
import { jsonSet } from "@/lib/docs/client/pointer";
import { recentIds, subscribeRecent, type RecentId } from "@/lib/docs/client/recent";
import { collectorFor, imageMime, protocolOfPath, type Collected, type GeneratedImage } from "@/lib/docs/client/stream";

/**
 * The API console: any request the docs proxy allows, editable before it's sent. The Run button on the docs' code
 * blocks opens one with the request it parsed, and the API reference pages use it directly. It edits the path and the
 * JSON body (with the model menu and a stream switch where they apply), fills multipart fields and file slots from a
 * picked file or a sample, sends through the proxy, and shows the reply in ResponseView, streamed when the body asks
 * for it. File replies (files/{id}/content) come with a download.
 */

export type { FileSlot, FileSlotSpec, FormSpec } from "@/lib/docs/client/form";

export interface ApiConsoleProps {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  form?: FormSpec[];
  fileSlots?: FileSlot[];
  /** Read the reply as SSE. Defaults to body.stream === true. */
  stream?: boolean;
  title?: string;
  /**
   * Leave out the "upload a file first" line for an example id in the path, for a host that offers the upload itself
   * (the Run panel on code blocks). The reader's own ids are still offered.
   */
  hideIdHint?: boolean;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Meta's muse-spark-1.3 shows as the Contributor model the proxy runs, so what the editor holds is what runs. */
function liveBody(body: unknown, stream: boolean | undefined): unknown {
  if (!isObj(body)) return body;
  let out: Json = body;
  if (typeof out.model === "string" && runsAs(out.model) !== out.model) out = { ...out, model: runsAs(out.model) };
  if (stream && out.stream === undefined) out = { ...out, stream: true };
  return out;
}

function slotKey(slot: { target?: string; pointer: string }) {
  return `${slot.target === "form" ? "form" : "body"}:${slot.pointer}`;
}

const NO_IDS: RecentId[] = [];

/** The ids this visitor created, kept fresh as other demos on the page create more. */
function useRecentIds(): RecentId[] {
  const cache = useRef<{ key: string; list: RecentId[] }>({ key: "", list: NO_IDS });
  return useSyncExternalStore(
    subscribeRecent,
    () => {
      const list = recentIds();
      const key = list.map((r) => r.id).join(",");
      if (key !== cache.current.key) cache.current = { key, list };
      return cache.current.list;
    },
    () => NO_IDS,
  );
}

export function ApiConsole(props: ApiConsoleProps) {
  const { method, title } = props;
  const id = useId();
  const runner = useDocsRun();
  const recent = useRecentIds();

  const original = useMemo(() => (props.body === undefined ? "" : formatJson(liveBody(props.body, props.stream))), [props.body, props.stream]);
  const [path, setPath] = useState(() => props.path.replace(/^\/+/, "").replace(/^v1\//, ""));
  const [text, setText] = useState(original);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((props.form ?? []).filter((f) => !f.file).map((f) => [f.name, f.value ?? ""])),
  );
  const [files, setFiles] = useState<Record<string, PickedFile | null>>({});
  const [showCode, setShowCode] = useState(false);
  const [live, setLive] = useState<Collected | null>(null);
  const [streamImages, setStreamImages] = useState<GeneratedImage[]>([]);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const eventsRef = useRef<EventLogEntry[]>([]);

  const hasBody = props.body !== undefined;
  const parsed = useMemo(() => (hasBody ? parseJsonText(text) : null), [hasBody, text]);
  const bodyValue = parsed?.ok ? parsed.value : undefined;
  const bodyObj = isObj(bodyValue) ? bodyValue : null;
  const model = typeof bodyObj?.model === "string" ? bodyObj.model : null;
  const kind = modelKindFor(path, model);
  const streamable = method === "POST" && isStreamable(path) && !!bodyObj;
  const streaming = method === "POST" ? streamable && bodyObj?.stream === true : /[?&]stream=true(?:&|$)/.test(path);
  const protocol = protocolOfPath(path);
  const running = runner.state === "running";

  // File pickers: the body slots, the form slots, and the form's own file fields (one picker per field).
  const bodySlots = useMemo(() => (props.fileSlots ?? []).filter((s) => s.target !== "form"), [props.fileSlots]);
  const formFileFields = useMemo(() => {
    const fromForm = (props.form ?? []).filter((f) => f.file).map((f) => ({ pointer: f.name, target: "form" as const, as: "file" as const, ...f.file! }));
    const fromSlots = (props.fileSlots ?? []).filter((s) => s.target === "form" && !fromForm.some((f) => f.pointer === s.pointer));
    return [...fromForm, ...fromSlots];
  }, [props.form, props.fileSlots]);
  const allSlots: FileSlot[] = [...bodySlots, ...formFileFields];
  const missing = allSlots.filter((s) => !files[slotKey(s)]);

  const allowed = isAllowedEndpoint(method, path);
  const needsId = placeholderKind(path);
  const idOptions = needsId ? recent.filter((r) => r.kind === needsId) : [];

  // An edit clears the last complaint about the request; it may well have fixed it.
  useEffect(() => {
    setProblem(null);
  }, [text, path]);

  const editBody = (change: (b: Json) => Json) => {
    if (!bodyObj) return;
    setText(formatJson(change(bodyObj)));
  };

  const setStream = (on: boolean) =>
    editBody((b) => {
      const next: Json = { ...b };
      if (on) {
        next.stream = true;
        // Chat Completions only reports usage on a stream when asked for it.
        if (path === "chat/completions" && next.stream_options === undefined) next.stream_options = { include_usage: true };
      } else {
        delete next.stream;
        if (isObj(next.stream_options) && Object.keys(next.stream_options).length === 1 && next.stream_options.include_usage === true) delete next.stream_options;
      }
      return next;
    });

  /** The body and form as code shows them: picked files as placeholders, not megabytes of base64. */
  const forCode = useMemo(() => {
    let body: unknown = bodyValue;
    for (const s of bodySlots) {
      const picked = files[slotKey(s)];
      if (!picked) continue;
      const mime = picked.file.type || "application/octet-stream";
      try {
        body = jsonSet(body, s.pointer, s.as === "base64" ? "<BASE64>" : `data:${mime};base64,<BASE64>`);
      } catch {
        // A pointer the edited body no longer has room for: the code shows the body as typed.
      }
    }
    const form: FormSpec[] | undefined = props.form?.length
      ? props.form.map((f) => (f.file ? { ...f, value: files[`form:${f.name}`]?.file.name ?? f.value } : { name: f.name, value: values[f.name] ?? "" }))
      : formFileFields.length
        ? formFileFields.map((s) => ({ name: s.pointer, value: files[slotKey(s)]?.file.name, file: { label: s.label, accept: s.accept, as: s.as } }))
        : undefined;
    return { body, form };
  }, [bodyValue, bodySlots, files, props.form, values, formFileFields]);

  const pushEvent = (e: SseEvent, collector: ReturnType<typeof collectorFor> | null) => {
    eventsRef.current = logEvent(eventsRef.current, e);
    setEvents(eventsRef.current);
    if (collector) {
      collector.push(e);
      setLive(collector.snapshot());
    } else if (e.json && typeof e.json.b64_json === "string") {
      // images/generations and images/edits stream one completed event per image.
      const b64 = e.json.b64_json;
      setStreamImages((list) => [...list, { id: `img-${list.length}`, b64, mime: imageMime(b64) }]);
    }
  };

  const send = async () => {
    if (running) return;
    if (parsed && !parsed.ok) return setProblem("Fix the JSON first: " + parsed.message);
    if (missing.length) return setProblem(`Choose a file for ${missing.map((s) => s.label).join(" and ")} first.`);
    setProblem(null);
    let body: unknown = bodyValue;
    try {
      for (const s of bodySlots) {
        const picked = files[slotKey(s)];
        if (picked) body = jsonSet(body, s.pointer, await readFileAs(picked.file, s.as === "base64" ? "base64" : "dataUrl"));
      }
    } catch (err) {
      return setProblem(err instanceof Error ? err.message : "Couldn't put the file into the body.");
    }
    let form: FormData | undefined;
    if (props.form?.length || formFileFields.length) {
      // Parts go in the request's own order (asr/transcribe sends request, then audio), slot-only files last.
      form = new FormData();
      const appendFile = async (s: FileSlot) => {
        const picked = files[slotKey(s)];
        if (!picked) return;
        if (s.as === "dataUrl" || s.as === "base64") form!.append(s.pointer, await readFileAs(picked.file, s.as));
        else form!.append(s.pointer, picked.file, picked.file.name);
      };
      for (const f of props.form ?? []) {
        const slot = formFileFields.find((s) => s.pointer === f.name);
        if (f.file && slot) await appendFile(slot);
        else if (!f.file) form.append(f.name, values[f.name] ?? "");
      }
      for (const s of formFileFields) if (!props.form?.some((f) => f.name === s.pointer)) await appendFile(s);
    }

    setLive(null);
    setStreamImages([]);
    eventsRef.current = [];
    setEvents([]);
    const collector = streaming && protocol ? collectorFor(protocol) : null;
    if (streaming && method === "POST") {
      await runner.run(path, { method, body, form, stream: true, onEvent: (e) => pushEvent(e, collector) });
      return;
    }
    const res = await runner.run(path, { method, ...(form ? { form } : body !== undefined ? { body } : {}) });
    // A GET stream (a background response's ?stream=true) arrives whole: replay its events into the same views.
    if (streaming && res.ok && res.text && (res.headers["content-type"] ?? "").startsWith("text/event-stream")) {
      const replay = protocol ?? (path.startsWith("responses/") ? "responses" : null);
      const c = replay ? collectorFor(replay) : null;
      const reader = sseReader((e) => pushEvent(e, c));
      reader.push(res.text);
      reader.end();
    }
  };

  const result = runner.result;
  const download =
    result?.ok && isBinaryReply(path)
      ? (result.blob ?? (result.text ? new Blob([result.text], { type: result.headers["content-type"] ?? "text/plain" }) : null))
      : null;

  const replaceId = (newId: string) => setPath((p) => p.replace(EXAMPLE_ID, newId));

  return (
    <div className="pg pg-console">
      {title ? <p className="pg-title">{title}</p> : null}
      <div className="pg-console-line">
        <span className={`pg-method pg-method-${method.toLowerCase()}`}>{method}</span>
        <label className="sr-only" htmlFor={`${id}-path`}>
          Path after /v1/
        </label>
        <span className="pg-path">
          <span className="pg-path-prefix" aria-hidden>
            /v1/
          </span>
          <TextInput id={`${id}-path`} className="pg-path-input" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value.replace(/^\/+/, "").replace(/^v1\//, ""))} />
        </span>
        <RunButton running={running} onRun={() => void send()} onStop={runner.abort} label="Send" disabled={!allowed || (parsed !== null && !parsed.ok)} />
      </div>
      {!allowed ? (
        <p className="pg-hint pg-bad">
          The live demos can&apos;t send {method} /v1/{path}. Copy the code below and run it with your own key.
        </p>
      ) : null}
      {needsId && (idOptions.length || !props.hideIdHint) ? (
        <div className="pg-hint">
          {idOptions.length ? (
            <span className="pg-presets">
              <span className="pg-presets-label">Use one of your {needsId === "file" ? "files" : "responses"}:</span>
              {idOptions.slice(0, 4).map((r) => (
                <button key={r.id} type="button" className="pg-pill" onClick={() => replaceId(r.id)}>
                  {r.label ? `${r.id} (${r.label})` : r.id}
                </button>
              ))}
            </span>
          ) : needsId === "response" ? (
            "This path holds an example id. Create a response first (POST /v1/responses), then its id shows up here to use."
          ) : (
            // The Run panel offers an upload for file ids itself (hideIdHint); elsewhere this says where one comes from.
            "This path holds an example id. Upload a file (POST /v1/files) and its id shows up here to use."
          )}
        </div>
      ) : null}

      {kind && model ? <ModelSelect kind={kind} value={model} onChange={(m) => editBody((b) => ({ ...b, model: m }))} disabled={running} /> : null}

      {props.form?.filter((f) => !f.file).length ? (
        <div className="pg-form-fields">
          {props.form
            .filter((f) => !f.file)
            .map((f) => {
              const fieldId = `${id}-form-${f.name}`;
              const value = values[f.name] ?? "";
              const multiline = value.includes("\n") || value.trim().startsWith("{");
              return (
                <Field key={f.name} id={fieldId} label={<code>{f.name}</code>}>
                  {multiline ? (
                    <TextArea id={fieldId} className="pg-code-input" rows={4} value={value} spellCheck={false} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                  ) : (
                    <TextInput id={fieldId} value={value} spellCheck={false} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                  )}
                </Field>
              );
            })}
        </div>
      ) : null}

      {allSlots.map((s) => (
        <FileSlotInput
          key={slotKey(s)}
          id={`${id}-${slotKey(s).replace(/[^a-z0-9]/gi, "-")}`}
          label={s.label}
          accept={s.accept}
          value={files[slotKey(s)] ?? null}
          onChange={(f) => setFiles((cur) => ({ ...cur, [slotKey(s)]: f }))}
          disabled={running}
          hint={s.target === "form" ? `Sent as the ${s.pointer} part.` : `Goes into the body at ${s.pointer}${s.as === "base64" ? " as base64" : " as a data URL"}.`}
        />
      ))}

      {hasBody ? <JsonEditor id={`${id}-body`} value={text} onChange={setText} resetTo={original} disabled={running} /> : null}
      {streamable ? <Toggle id={`${id}-stream`} label="Stream the reply" checked={bodyObj?.stream === true} onChange={setStream} disabled={running} /> : null}

      {problem ? (
        <p className="pg-hint pg-bad" role="alert">
          {problem}
        </p>
      ) : null}
      <ErrorBox error={runner.error} />

      {streaming && (running || live || events.length) && !isAborted(result) ? (
        <ResponseView
          result={result}
          running={running}
          elapsedMs={runner.elapsedMs}
          json={live?.final ?? undefined}
          usage={live?.usage ?? undefined}
          model={result?.model ?? live?.model ?? null}
          events={events}
        >
          {live ? <ReplyView reply={live} running={running} /> : streamImages.length ? <Images images={streamImages} /> : null}
        </ResponseView>
      ) : (
        <ResponseView result={result} running={running} elapsedMs={runner.elapsedMs} events={events.length ? events : undefined}>
          {download ? <BlobOutput blob={download} name={`${path.split("/")[1] ?? "file"}-content`} /> : live ? <ReplyView reply={live} /> : undefined}
        </ResponseView>
      )}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method={method} path={path} body={forCode.body} form={forCode.form} stream={streaming} /> : null}
    </div>
  );
}
