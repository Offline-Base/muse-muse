"use client";

import { useEffect, useId, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { StreamView } from "@/components/docs/kit/StreamView";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { useObjectUrl } from "@/components/docs/media/hooks";
import styles from "@/components/docs/media/media.module.css";
import type { FormSpec } from "@/lib/docs/client/form";
import { responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { kindOf, mimeFromName } from "@/lib/docs/media/accept";
import { formatBytes } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileQuestionRequest, fileUploadFields, partForKind, type FilePart } from "@/lib/docs/media/requests";
import type { SampleKind } from "@/lib/docs/media/samples";

export type FilesAction = "upload" | "list" | "retrieve" | "content" | "delete" | "use";

export interface FilesPlaygroundProps {
  slug?: string;
  /** The file picked on load. Defaults to the 2-page PDF. */
  sampleId?: string;
  /** The action whose code shows first, matching the API reference page the demo sits on. */
  focus?: FilesAction;
  /** Offer expires_after on upload. Default true. */
  expiry?: boolean;
  /** The question "Use in a request" starts with. Defaults by file kind. */
  question?: string;
  model?: string;
  models?: string[];
}

interface FileObject {
  id: string;
  object?: string;
  bytes?: number;
  created_at?: number;
  expires_at?: number | null;
  filename?: string;
  purpose?: string;
  status?: string;
}

const QUESTIONS: Record<SampleKind, string> = {
  pdf: "Summarize this document in three bullet points.",
  image: "Describe this image in two sentences.",
  video: "Describe what happens in this video.",
  audio: "Transcribe this audio. Return only the transcript.",
  text: "Summarize this text in three sentences.",
};

const EXPIRY: Array<{ value: string; label: string }> = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "2592000", label: "30 days" },
];

const ACTION_LABEL: Record<FilesAction, string> = {
  upload: "Upload",
  list: "List",
  retrieve: "Retrieve",
  content: "Content",
  delete: "Delete",
  use: "Use in a request",
};

function when(seconds?: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "never";
}

/**
 * The Files API end to end, on this visitor's own files: upload (purpose user_data, optional expires_after), list,
 * retrieve, download the content, delete, and "Use in a request", which runs a Responses call that references the
 * file_id with input_file or the typed part for its kind. The docs proxy shows each visitor only their own files and
 * deletes demo files after an hour.
 */
export function FilesPlayground({
  sampleId = "field-report",
  focus = "upload",
  expiry = true,
  question,
  model: initialModel = DEFAULT_TEXT_MODEL,
  models,
}: FilesPlaygroundProps) {
  const id = useId();
  const upload = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const list = useDocsRun();
  const one = useDocsRun();
  const use = useDocsRun();
  const [action, setAction] = useState<FilesAction>(focus);
  const [file, setFile] = useState<PickedMedia | null>(null);
  const [expires, setExpires] = useState(false);
  const [seconds, setSeconds] = useState("3600");
  const [fileId, setFileId] = useState("");
  const [known, setKnown] = useState<Record<string, { name: string; mime: string }>>({});
  const [rows, setRows] = useState<FileObject[] | null>(null);
  const [content, setContent] = useState<{ blob: Blob; name: string } | null>(null);
  const [model, setModel] = useState(initialModel);
  const [ask, setAsk] = useState(question ?? "");
  const [part, setPart] = useState<FilePart | "auto">("auto");
  const [live, setLive] = useState<Collected | null>(null);
  const contentUrl = useObjectUrl(content?.blob ?? null);

  const selected = fileId ? known[fileId] : undefined;
  const selectedKind: SampleKind = kindOf({ type: selected?.mime, name: selected?.name }) ?? "pdf";
  // Listed files carry a name, not a type, so the part follows the kind the name or upload says.
  const autoPart = partForKind(selectedKind);
  const resolvedPart: FilePart = part === "auto" ? autoPart : part;
  const questionText = ask || QUESTIONS[selectedKind];
  const idForCode = fileId || "file-abc123";
  const uploadFields = fileUploadFields({ expiresAfterSeconds: expiry && expires ? Number(seconds) : null });

  const remember = (f: FileObject, mime?: string) =>
    setKnown((k) => ({ ...k, [f.id]: { name: f.filename ?? k[f.id]?.name ?? f.id, mime: mime ?? k[f.id]?.mime ?? "" } }));

  const doUpload = async () => {
    if (!file) return;
    setAction("upload");
    const form = new FormData();
    for (const [k, v] of uploadFields) form.append(k, v);
    form.append("file", file.blob, file.name);
    const res = await upload.run("files", { form });
    const f = res.json as FileObject | null;
    if (res.ok && f?.id) {
      remember(f, file.mime);
      setFileId(f.id);
      setContent(null);
    }
  };

  const doList = async () => {
    setAction("list");
    const res = await list.run("files?purpose=user_data&order=desc&limit=20", { method: "GET" });
    const data = (res.json as { data?: FileObject[] } | null)?.data;
    if (res.ok && Array.isArray(data)) {
      setRows(data);
      data.forEach((f) => remember(f));
    }
  };

  const doRetrieve = async () => {
    setAction("retrieve");
    const res = await one.run(`files/${encodeURIComponent(fileId)}`, { method: "GET" });
    if (res.ok && res.json) remember(res.json as FileObject);
  };

  const doContent = async () => {
    setAction("content");
    const res = await one.run(`files/${encodeURIComponent(fileId)}/content`, { method: "GET" });
    if (!res.ok) return setContent(null);
    // Content comes back as application/octet-stream, so the preview takes its type from the upload or the name.
    const name = selected?.name ?? fileId;
    const sent = res.blob?.type && res.blob.type !== "application/octet-stream" ? res.blob.type : "";
    const type = sent || selected?.mime || mimeFromName(name) || "application/octet-stream";
    setContent({ blob: new Blob([res.blob ?? res.text], { type }), name });
  };

  const doDelete = async () => {
    setAction("delete");
    const res = await one.run(`files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    if (res.ok) {
      setRows((r) => r?.filter((x) => x.id !== fileId) ?? r);
      setContent(null);
    }
  };

  const doUse = async () => {
    setAction("use");
    setLive(null);
    const { path, body } = fileQuestionRequest({ model, question: questionText, fileId, part: resolvedPart, maxOutputTokens: selectedKind === "audio" ? 4000 : undefined });
    const collector = responsesCollector();
    await use.run(path, {
      body: { ...body, stream: true },
      stream: true,
      onEvent: (e) => {
        collector.push(e);
        setLive(collector.snapshot());
      },
    });
  };

  const code = ((): { method: "GET" | "POST" | "DELETE"; path: string; body?: unknown; form?: FormSpec[]; stream?: boolean } => {
    switch (action) {
      case "upload":
        return {
          method: "POST",
          path: "files",
          form: [...uploadFields.map(([name, value]) => ({ name, value })), { name: "file", value: file?.name ?? "document.pdf", file: { label: "File" } }],
        };
      case "list":
        return { method: "GET", path: "files?purpose=user_data&order=desc&limit=20" };
      case "retrieve":
        return { method: "GET", path: `files/${idForCode}` };
      case "content":
        return { method: "GET", path: `files/${idForCode}/content` };
      case "delete":
        return { method: "DELETE", path: `files/${idForCode}` };
      case "use": {
        const { path, body } = fileQuestionRequest({ model, question: questionText, fileId: idForCode, part: resolvedPart });
        return { method: "POST", path, body: { ...body, stream: true }, stream: true };
      }
    }
  })();

  const busy = [upload, list, one, use].some((r) => r.state === "running");
  const contentKind = content ? kindOf({ type: content.blob.type, name: content.name }) : null;

  return (
    <div className={`pg ${styles.playground}`}>
      <section className={styles.stack} aria-labelledby={`${id}-up`}>
        <h3 className={styles.sectionTitle} id={`${id}-up`}>
          1. Upload a file
        </h3>
        <FilePicker accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,audio/wav,audio/mpeg,application/pdf,text/plain,application/json" value={file} onChange={setFile} defaultSampleId={sampleId} preview="compact" prepare="none" disabled={busy} />
        <div className={styles.options}>
          <span className={styles.inline}>
            <span className={styles.label}>purpose</span>
            <code>user_data</code>
          </span>
          {expiry ? (
            <>
              <Toggle id={`${id}-exp`} label="expires_after" checked={expires} onChange={setExpires} disabled={busy} />
              {expires ? <Segmented size="sm" label="Expires after" value={seconds} onChange={setSeconds} disabled={busy} options={EXPIRY} /> : null}
            </>
          ) : null}
        </div>
        {/* The docs proxy sets every upload's expiry to an hour (lib/docs/proxy/rewrite.ts), whatever the form says. */}
        <p className={styles.note}>
          Live demo uploads expire an hour after upload{expiry && expires && seconds !== "3600" ? ", so the docs send 3,600 s here; the code keeps your choice" : ""}.
        </p>
        <div className={styles.row}>
          <RunButton running={upload.state === "running"} onRun={() => void doUpload()} onStop={upload.abort} label="Upload" disabled={!file || busy || file.problems.length > 0} />
        </div>
        <ErrorBox error={upload.error} />
        {upload.state === "running" || upload.result ? <ResponseView result={upload.result} running={upload.state === "running"} elapsedMs={upload.elapsedMs} /> : null}
      </section>

      <section className={styles.section} aria-labelledby={`${id}-ls`}>
        <h3 className={styles.sectionTitle} id={`${id}-ls`}>
          2. Your files
        </h3>
        <div className={styles.row}>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void doList()} disabled={busy}>
            {list.state === "running" ? "Listing..." : "List files"}
          </button>
          <span className={styles.note}>Lists only files you uploaded here; they&apos;re deleted after an hour.</span>
        </div>
        <ErrorBox error={list.error} />
        {rows ? (
          rows.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>id</th>
                    <th>filename</th>
                    <th>bytes</th>
                    <th>created_at</th>
                    <th>expires_at</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <code>{f.id}</code>
                      </td>
                      <td>{f.filename}</td>
                      <td>{f.bytes !== undefined ? formatBytes(f.bytes) : ""}</td>
                      <td>{when(f.created_at)}</td>
                      <td>{when(f.expires_at)}</td>
                      <td>
                        <button type="button" className="btn btn-outline btn-sm" aria-pressed={fileId === f.id} onClick={() => setFileId(f.id)}>
                          {fileId === f.id ? "Selected" : "Select"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.note}>No files yet. Upload one above.</p>
          )
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby={`${id}-one`}>
        <h3 className={styles.sectionTitle} id={`${id}-one`}>
          3. Retrieve, download or delete it
        </h3>
        <Field id={`${id}-fid`} label="file_id">
          <TextInput id={`${id}-fid`} className={styles.mono} value={fileId} placeholder="Upload or select a file" onChange={(e) => setFileId(e.target.value.trim())} disabled={busy} />
        </Field>
        <div className={styles.row}>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void doRetrieve()} disabled={!fileId || busy}>
            Retrieve
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void doContent()} disabled={!fileId || busy}>
            Download content
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void doDelete()} disabled={!fileId || busy}>
            Delete
          </button>
        </div>
        <ErrorBox error={one.error} />
        {one.result ? (
          <ResponseView result={one.result} running={one.state === "running"} elapsedMs={one.elapsedMs}>
            {action === "content" && content && contentUrl ? (
              <div className={styles.picked}>
                <div className={styles.spread}>
                  <span className={styles.pickedMeta}>
                    {content.name} · {formatBytes(content.blob.size)} · {content.blob.type || "binary"}
                  </span>
                  <a className="btn btn-outline btn-sm" href={contentUrl} download={content.name}>
                    Save file
                  </a>
                </div>
                {contentKind === "image" ? <img className={styles.mediaPreview} src={contentUrl} alt={content.name} /> : null}
                {contentKind === "video" ? <video className={styles.mediaPreview} src={contentUrl} controls muted playsInline /> : null}
                {contentKind === "audio" ? <audio className={styles.audioPreview} src={contentUrl} controls /> : null}
                {contentKind === "pdf" ? <iframe className={styles.mediaPreview} src={contentUrl} title={content.name} style={{ height: 340, background: "#fff" }} /> : null}
                {contentKind === "text" ? <TextPreview blob={content.blob} /> : null}
              </div>
            ) : undefined}
          </ResponseView>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby={`${id}-use`}>
        <h3 className={styles.sectionTitle} id={`${id}-use`}>
          4. Use it in a request
        </h3>
        <Field id={`${id}-q`} label="Question">
          <TextArea id={`${id}-q`} value={questionText} rows={2} onChange={(e) => setAsk(e.target.value)} disabled={busy} />
        </Field>
        <span className={styles.inline}>
          <span className={styles.label}>Part</span>
          <Segmented<FilePart | "auto">
            size="sm"
            label="Content part"
            value={part}
            onChange={setPart}
            disabled={busy}
            options={[
              { value: "auto", label: `By kind (${autoPart})` },
              { value: "input_file", label: "input_file" },
            ]}
          />
        </span>
        <div className={styles.spread}>
          <ModelSelect kind="vision" value={model} onChange={setModel} allow={models} disabled={busy} />
          <RunButton running={use.state === "running"} onRun={() => void doUse()} onStop={use.abort} label="Ask" disabled={!fileId || busy} />
        </div>
        <ErrorBox error={use.error} />
        {use.state === "running" || use.result ? (
          <ResponseView result={use.result} running={use.state === "running"} elapsedMs={use.elapsedMs} json={live?.final ?? undefined} usage={live?.usage ?? undefined}>
            <StreamView text={live?.text ?? ""} reasoning={live?.reasoning} refusal={live?.refusal} running={use.state === "running"} placeholder="Reading the file..." />
          </ResponseView>
        ) : null}
      </section>

      <div className={`pg-actions ${styles.divider}`}>
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={styles.stack}>
          <Segmented<FilesAction>
            size="sm"
            label="Show the code for"
            value={action}
            onChange={setAction}
            options={(Object.keys(ACTION_LABEL) as FilesAction[]).map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
          />
          <CodeView method={code.method} path={code.path} body={code.body} form={code.form} stream={code.stream} caption={`The ${ACTION_LABEL[action].toLowerCase()} request`} />
        </div>
      ) : null}
    </div>
  );
}

function TextPreview({ blob }: { blob: Blob }) {
  const [text, setText] = useState("");
  useEffect(() => {
    let live = true;
    void blob
      .slice(0, 4000)
      .text()
      .then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [blob]);
  return <pre className={styles.textPreview}>{text}</pre>;
}
