"use client";

import { useId, useMemo, useState } from "react";
import { BlobOutput, CodeView, ErrorBox, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { DemoTabs } from "@/components/docs/playgrounds/media/DemoTabs";
import { uploadPicked, useRecentFiles } from "@/components/docs/playgrounds/media/FileIdBar";
import {
  EXPIRES_MAX_SECONDS,
  EXPIRES_MIN_SECONDS,
  FILES_STEPS,
  expiresProblem,
  filePath,
  filesOfList,
  limitProblem,
  listPath,
  nextCursor,
  when,
  type FilesStep,
  type ListQuery,
  type ListedFile,
} from "@/components/docs/playgrounds/media/files-api";
import { SchemaCheckTable } from "@/components/docs/playgrounds/media/SchemaCheckTable";
import type { SchemaDoc } from "@/components/docs/playgrounds/media/schema-tables";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import type { FormSpec } from "@/lib/docs/client/form";
import { formatBytes } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileUploadFields } from "@/lib/docs/media/requests";

export interface FilesApiConsoleProps {
  slug?: string;
  /** The call this page documents; its step opens first. */
  start: FilesStep;
  /** api-reference/files/schemas, parsed on the server, to check each reply against. */
  schemas: SchemaDoc[];
  /** The file the upload step starts with. */
  sampleId?: string;
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,audio/wav,audio/mpeg,application/pdf,text/plain,application/json";

/** "expires_at is created_at + 3,600 s": how the reply carries the expiry it was given (File Expires After). */
function ExpiryLine({ file }: { file: unknown }) {
  const f = file as ListedFile | null;
  if (!f || typeof f.created_at !== "number") return null;
  // The schemas page says a file that never expires has expires_at null; file-handling says the field is left out.
  if (typeof f.expires_at !== "number") {
    return <p className={styles.note}>{f.expires_at === null ? "expires_at is null" : "No expires_at"}: this file never expires.</p>;
  }
  const seconds = f.expires_at - f.created_at;
  return (
    <p className={styles.note}>
      expires_at is created_at + {seconds.toLocaleString("en-US")} seconds ({seconds % 3600 ? `${(seconds / 3600).toFixed(1)} hours` : `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`}).
    </p>
  );
}

function EndpointLine({ method, route }: { method: "GET" | "POST" | "DELETE"; route: string }) {
  return (
    <div className="pg-console-line">
      <span className={`pg-method pg-method-${method.toLowerCase()}`}>{method}</span>
      <code className={styles.mono}>/v1{route}</code>
    </div>
  );
}

/**
 * The Files API reference as one console, opened on the page's own call: upload (purpose and expires_after), list
 * (purpose, limit, order and the after cursor, with Next page), retrieve, download the content, and delete. Every
 * call runs live through the docs proxy on files this visitor uploaded, and every JSON reply is checked field by
 * field against the page's schemas (FileObject, ListFilesResponse, DeleteFileResponse).
 */
export function FilesApiConsole({ start, schemas, sampleId = "receipt" }: FilesApiConsoleProps) {
  const id = useId();
  const files = useRecentFiles();
  const upload = useDocsRun();
  const list = useDocsRun();
  const retrieve = useDocsRun();
  const content = useDocsRun();
  const remove = useDocsRun();
  const quick = useDocsRun();
  const [fileId, setFileId] = useState("");
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [quickPick, setQuickPick] = useState<PickedMedia | null>(null);
  const [expires, setExpires] = useState(false);
  const [seconds, setSeconds] = useState("86400");
  const [query, setQuery] = useState<ListQuery>({ purpose: "user_data", limit: null, order: "desc", after: "" });
  const [limitText, setLimitText] = useState("");
  const [rows, setRows] = useState<ListedFile[] | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [code, setCode] = useState<Record<FilesStep, boolean>>({ upload: false, list: false, retrieve: false, content: false, delete: false });

  const expirySeconds = Number(seconds);
  const expiryProblem = expires ? expiresProblem(expirySeconds) : null;
  const limitValue = limitText.trim() ? Number(limitText) : null;
  const listProblem = limitProblem(limitValue);
  const busy = [upload, list, retrieve, content, remove, quick].some((r) => r.state === "running");

  const remember = (f: ListedFile) => typeof f.bytes === "number" && setSizes((s) => ({ ...s, [f.id]: f.bytes as number }));

  const doUpload = async () => {
    if (!picked || busy || expiryProblem) return;
    const form = new FormData();
    for (const [k, v] of fileUploadFields({ expiresAfterSeconds: expires ? expirySeconds : null })) form.append(k, v);
    form.append("file", picked.blob, picked.name);
    const res = await upload.run("files", { form });
    const f = res.json as ListedFile | null;
    if (res.ok && f?.id) {
      setFileId(f.id);
      remember(f);
    }
  };

  const quickUpload = async () => {
    if (!quickPick || busy) return;
    const up = await uploadPicked(quick.run, quickPick);
    if (up.id) {
      setFileId(up.id);
      remember(up.json as ListedFile);
    }
  };

  const doList = async (after?: string) => {
    if (busy || listProblem) return;
    const q = { ...query, limit: limitValue, after: after ?? query.after };
    if (after !== undefined) setQuery(q);
    const res = await list.run(listPath(q), { method: "GET" });
    if (res.ok) {
      const found = filesOfList(res.json);
      setRows(found);
      found.forEach(remember);
    }
  };

  const doOne = async (step: "retrieve" | "content" | "delete") => {
    if (!fileId.trim() || busy) return;
    const runner = step === "retrieve" ? retrieve : step === "content" ? content : remove;
    const res = await runner.run(filePath(step, fileId.trim()), { method: step === "delete" ? "DELETE" : "GET" });
    if (step === "retrieve" && res.ok && res.json) remember(res.json as ListedFile);
    if (step === "delete" && res.ok) setRows((r) => r?.filter((f) => f.id !== fileId.trim()) ?? r);
  };

  const uploadForm: FormSpec[] = [
    ...fileUploadFields({ expiresAfterSeconds: expires && !expiryProblem ? expirySeconds : null }).map(([name, value]) => ({ name, value })),
    { name: "file", value: picked?.name ?? "document.pdf", file: { label: "File" } },
  ];
  // The proxy keeps every docs upload for an hour (lib/docs/proxy/rewrite.ts); the code keeps the reader's choice.
  const expiryNote = expires && expirySeconds !== EXPIRES_MIN_SECONDS ? " The live demos keep uploads for an hour, so the docs send 3,600 seconds; the code keeps yours." : "";

  const listed = list.result?.ok ? list.result.json : null;
  const cursor = nextCursor(listed);
  const contentBlob = content.result?.ok
    ? (content.result.blob ?? (content.result.text ? new Blob([content.result.text], { type: content.result.headers["content-type"] ?? "text/plain" }) : null))
    : null;
  const knownSize = sizes[fileId.trim()];

  const idPicker = (step: "retrieve" | "content" | "delete") => (
    <div className={styles.stack}>
      <Field id={`${id}-${step}-id`} label="file_id (path parameter, required)">
        <TextInput
          id={`${id}-${step}-id`}
          className={styles.urlInput}
          value={fileId}
          placeholder="file-..."
          spellCheck={false}
          onChange={(e) => setFileId(e.target.value.trim())}
          disabled={busy}
        />
      </Field>
      {files.length ? (
        <div className="pg-presets" role="group" aria-label="Your files">
          <span className="pg-presets-label">Your files</span>
          {files.slice(0, 6).map((f) => (
            <button key={f.id} type="button" className="pg-pill" aria-pressed={f.id === fileId} onClick={() => setFileId(f.id)} disabled={busy}>
              {f.label ? `${f.id} (${f.label})` : f.id}
            </button>
          ))}
        </div>
      ) : null}
      {!files.length || !fileId ? (
        <details className={files.length ? "pg-system" : styles.neededUpload} open={!files.length}>
          <summary>{files.length ? "Upload another file" : "No files yet: upload one to get an id"}</summary>
          <div className={styles.stack}>
            <FilePicker accept={ACCEPT} value={quickPick} onChange={setQuickPick} defaultSampleId={sampleId} preview="compact" prepare="none" disabled={busy} />
            <div className={styles.row}>
              <RunButton running={quick.state === "running"} onRun={() => void quickUpload()} onStop={quick.abort} label="Upload" disabled={!quickPick || quickPick.problems.length > 0} />
              <span className={`${styles.note} pg-advanced`}>POST /v1/files, purpose user_data. Its id fills in above.</span>
            </div>
            <ErrorBox error={quick.error} />
          </div>
        </details>
      ) : null}
    </div>
  );

  const codeToggle = (step: FilesStep) => (
    <div className="pg-actions">
      <Toggle id={`${id}-${step}-code`} label="Show code" checked={code[step]} onChange={(v) => setCode((c) => ({ ...c, [step]: v }))} />
    </div>
  );
  const shownId = fileId.trim() || "file-abc123";

  return (
    <DemoTabs label="Files API" initial={start} tabs={FILES_STEPS.map((s) => ({ id: s.id, label: s.label }))}>
      {/* Upload */}
      <div className={`pg ${styles.lab}`}>
        <EndpointLine method="POST" route="/files" />
        <FilePicker accept={ACCEPT} value={picked} onChange={setPicked} defaultSampleId={sampleId} preview="compact" prepare="none" label="file (required)" disabled={busy} />
        <div className={`${styles.controls} pg-advanced`}>
          <span className={styles.inline}>
            <span className={styles.label}>purpose (required)</span>
            <Segmented<"user_data" | "batch">
              size="sm"
              label="purpose"
              value="user_data"
              onChange={() => {}}
              disabled={busy}
              options={[
                { value: "user_data", label: "user_data" },
                { value: "batch", label: "batch", disabled: true },
              ]}
            />
          </span>
          <Toggle id={`${id}-exp`} label="expires_after" checked={expires} onChange={setExpires} disabled={busy} />
          {expires ? (
            <span className={styles.inline}>
              <label className={styles.label} htmlFor={`${id}-sec`}>
                seconds
              </label>
              <TextInput
                id={`${id}-sec`}
                className={styles.numberInput}
                inputMode="numeric"
                value={seconds}
                onChange={(e) => setSeconds(e.target.value.replace(/[^\d]/g, ""))}
                disabled={busy}
                aria-invalid={!!expiryProblem}
              />
              <span className={styles.note}>anchor: created_at</span>
            </span>
          ) : null}
        </div>
        {expiryProblem ? <p className={styles.problem}>{expiryProblem}</p> : null}
        <p className={`${styles.note} pg-advanced`}>
          user_data is for files requests reference; batch takes JSONL for the Batch API, and the live demos upload user_data only. expires_after.seconds runs from{" "}
          {EXPIRES_MIN_SECONDS.toLocaleString("en-US")} to {EXPIRES_MAX_SECONDS.toLocaleString("en-US")}; without it a file never expires.{expiryNote}
        </p>
        <div className={styles.row}>
          <RunButton running={upload.state === "running"} onRun={() => void doUpload()} onStop={upload.abort} label="Upload" disabled={!picked || picked.problems.length > 0 || !!expiryProblem || busy} />
        </div>
        <ErrorBox error={upload.error} />
        {upload.state === "running" || upload.result ? (
          <ResponseView result={upload.result} running={upload.state === "running"} elapsedMs={upload.elapsedMs}>
            {upload.result?.ok ? (
              <div className={styles.stack}>
                <SchemaCheckTable schemas={schemas} schema="file-object" value={upload.result.json} mode="reply" />
                <ExpiryLine file={upload.result.json} />
              </div>
            ) : undefined}
          </ResponseView>
        ) : null}
        {codeToggle("upload")}
        {code.upload ? <CodeView method="POST" path="files" form={uploadForm} caption="The upload, with the file as the last part" /> : null}
      </div>

      {/* List */}
      <div className={`pg ${styles.lab}`}>
        <EndpointLine method="GET" route={`/${listPath({ ...query, limit: limitValue })}`} />
        <div className={`${styles.controls} pg-advanced`}>
          <span className={styles.inline}>
            <span className={styles.label}>purpose</span>
            <Segmented<string>
              size="sm"
              label="purpose"
              value={query.purpose ?? ""}
              onChange={(v) => setQuery((q) => ({ ...q, purpose: v }))}
              disabled={busy}
              options={[
                { value: "", label: "Any" },
                { value: "user_data", label: "user_data" },
                { value: "batch", label: "batch" },
              ]}
            />
          </span>
          <span className={styles.inline}>
            <span className={styles.label}>order</span>
            <Segmented<"" | "desc" | "asc">
              size="sm"
              label="order"
              value={query.order ?? ""}
              onChange={(v) => setQuery((q) => ({ ...q, order: v }))}
              disabled={busy}
              options={[
                { value: "", label: "Default" },
                { value: "desc", label: "desc, newest first" },
                { value: "asc", label: "asc, oldest first" },
              ]}
            />
          </span>
        </div>
        <div className={`${styles.controls} pg-advanced`}>
          <span className={styles.inline}>
            <label className={styles.label} htmlFor={`${id}-limit`}>
              limit
            </label>
            <TextInput
              id={`${id}-limit`}
              className={styles.numberInput}
              inputMode="numeric"
              value={limitText}
              placeholder="10000"
              onChange={(e) => setLimitText(e.target.value.replace(/[^\d]/g, ""))}
              disabled={busy}
              aria-invalid={!!listProblem}
            />
          </span>
          <span className={styles.inline}>
            <label className={styles.label} htmlFor={`${id}-after`}>
              after
            </label>
            <TextInput
              id={`${id}-after`}
              className={styles.cursorInput}
              value={query.after ?? ""}
              placeholder="a file id: the page starts after it"
              spellCheck={false}
              onChange={(e) => setQuery((q) => ({ ...q, after: e.target.value.trim() }))}
              disabled={busy}
            />
          </span>
        </div>
        {listProblem ? <p className={styles.problem}>{listProblem}</p> : null}
        <p className={`${styles.note} pg-advanced`}>Set limit to 1 and press Next page to walk the list with the after cursor. The live demos list only files uploaded from this browser in the last hour.</p>
        <div className={styles.row}>
          <RunButton running={list.state === "running"} onRun={() => void doList()} onStop={list.abort} label="Send" disabled={busy || !!listProblem} />
          {cursor ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void doList(cursor)} disabled={busy}>
              Next page (after {cursor})
            </button>
          ) : null}
        </div>
        <ErrorBox error={list.error} />
        {list.state === "running" || list.result ? (
          <ResponseView result={list.result} running={list.state === "running"} elapsedMs={list.elapsedMs}>
            {list.result?.ok ? (
              <div className={styles.stack}>
                {rows && rows.length ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <caption className="sr-only">Files in this page of the list</caption>
                      <thead>
                        <tr>
                          <th>id</th>
                          <th>filename</th>
                          <th className={styles.right}>bytes</th>
                          <th>created_at</th>
                          <th>expires_at</th>
                          <th>
                            <span className="sr-only">Select</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((f) => (
                          <tr key={f.id} className={f.id === fileId ? styles.hit : undefined}>
                            <td className={`${styles.mono} ${styles.nowrap}`}>{f.id}</td>
                            <td>{f.filename}</td>
                            <td className={`${styles.right} ${styles.num}`}>{typeof f.bytes === "number" ? formatBytes(f.bytes) : ""}</td>
                            <td>{when(f.created_at)}</td>
                            <td>{when(f.expires_at)}</td>
                            <td>
                              <button type="button" className="btn btn-outline btn-sm" aria-pressed={f.id === fileId} onClick={() => setFileId(f.id)}>
                                {f.id === fileId ? "Selected" : "Use this id"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={styles.note}>No files on this page. Upload one in the Upload step.</p>
                )}
                <SchemaCheckTable schemas={schemas} schema="list-files-response" value={list.result.json} mode="reply" />
              </div>
            ) : undefined}
          </ResponseView>
        ) : null}
        {codeToggle("list")}
        {code.list ? <CodeView method="GET" path={listPath({ ...query, limit: limitValue })} /> : null}
      </div>

      {/* Retrieve */}
      <div className={`pg ${styles.lab}`}>
        <EndpointLine method="GET" route="/files/{file_id}" />
        {idPicker("retrieve")}
        <div className={styles.row}>
          <RunButton running={retrieve.state === "running"} onRun={() => void doOne("retrieve")} onStop={retrieve.abort} label="Send" disabled={!fileId.trim() || busy} />
        </div>
        <ErrorBox error={retrieve.error} />
        {retrieve.state === "running" || retrieve.result ? (
          <ResponseView result={retrieve.result} running={retrieve.state === "running"} elapsedMs={retrieve.elapsedMs}>
            {retrieve.result?.ok ? <SchemaCheckTable schemas={schemas} schema="file-object" value={retrieve.result.json} mode="reply" /> : undefined}
          </ResponseView>
        ) : null}
        {codeToggle("retrieve")}
        {code.retrieve ? <CodeView method="GET" path={`files/${shownId}`} /> : null}
      </div>

      {/* Content */}
      <div className={`pg ${styles.lab}`}>
        <EndpointLine method="GET" route="/files/{file_id}/content" />
        {idPicker("content")}
        <div className={styles.row}>
          <RunButton running={content.state === "running"} onRun={() => void doOne("content")} onStop={content.abort} label="Send" disabled={!fileId.trim() || busy} />
        </div>
        <ErrorBox error={content.error} />
        {content.state === "running" || content.result ? (
          <ResponseView result={content.result} running={content.state === "running"} elapsedMs={content.elapsedMs}>
            {contentBlob ? (
              <div className={styles.stack}>
                <BlobOutput blob={contentBlob} name={`${fileId.trim() || "file"}-content`} />
                <p className={styles.note}>
                  The raw bytes: {formatBytes(contentBlob.size)} as {content.result?.headers["content-type"] ?? "binary"}.
                  {knownSize !== undefined ? (knownSize === contentBlob.size ? " Same size as the FileObject's bytes." : ` The FileObject says ${formatBytes(knownSize)}.`) : ""}
                </p>
              </div>
            ) : undefined}
          </ResponseView>
        ) : null}
        {codeToggle("content")}
        {code.content ? <CodeView method="GET" path={`files/${shownId}/content`} /> : null}
      </div>

      {/* Delete */}
      <div className={`pg ${styles.lab}`}>
        <EndpointLine method="DELETE" route="/files/{file_id}" />
        {idPicker("delete")}
        <div className={styles.row}>
          <RunButton running={remove.state === "running"} onRun={() => void doOne("delete")} onStop={remove.abort} label="Delete" disabled={!fileId.trim() || busy} />
        </div>
        <p className={`${styles.note} pg-advanced`}>Deleting frees the file&apos;s share of the team&apos;s 100 GiB. Retrieve the same id afterwards and the API answers 404.</p>
        <ErrorBox error={remove.error} />
        {remove.state === "running" || remove.result ? (
          <ResponseView result={remove.result} running={remove.state === "running"} elapsedMs={remove.elapsedMs}>
            {remove.result?.ok ? <SchemaCheckTable schemas={schemas} schema="delete-file-response" value={remove.result.json} mode="reply" /> : undefined}
          </ResponseView>
        ) : null}
        {codeToggle("delete")}
        {code.delete ? <CodeView method="DELETE" path={`files/${shownId}`} /> : null}
      </div>
    </DemoTabs>
  );
}
