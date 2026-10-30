"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { EventLog, Images, ReplyView } from "@/components/docs/kit/StreamView";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import type { DocsResult } from "@/lib/docs/client/api";
import { costExtrasOf } from "@/lib/docs/client/cost";
import type { EventLogEntry } from "@/lib/docs/client/events";
import { sizeLabel } from "@/lib/docs/client/files";
import { docsModelLabel } from "@/lib/docs/client/models";
import { collectReply, imageMime, protocolOfReply, type GeneratedImage } from "@/lib/docs/client/stream";

/**
 * One reply, the way the docs' API console shows it: a status line (HTTP status, the model the proxy actually ran,
 * latency, tokens and estimated cost, and any note the proxy added), then Output, JSON and Headers tabs (and Events
 * for a stream). Output is the text, images, transcript or file the reply carries; JSON is the whole body, folded
 * below the third level.
 */

const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function statusText(result: DocsResult): string {
  if (result.error?.code === "aborted") return "Stopped";
  if (result.status === 0) return "No connection";
  return `${result.status} ${REASONS[result.status] ?? ""}`.trim();
}

/** "640 ms", "1.4 s", "1 min 5 s". */
export function latencyLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

type Tab = "output" | "json" | "headers" | "events";

export function ResponseView({
  result,
  text,
  children,
  json,
  usage,
  model,
  events,
  running = false,
  elapsedMs,
}: {
  result: DocsResult | null;
  /** Output tab text, instead of what the reply carries. */
  text?: string;
  /** Output tab content, instead of `text` or the reply's own. */
  children?: ReactNode;
  /** JSON tab content, such as a stream's final response (result.json is null for streams). */
  json?: unknown;
  /** Usage for the status line, when it isn't `json.usage`. */
  usage?: unknown;
  /** The model the call ran on, when it isn't x-docs-model or `json.model`. */
  model?: string | null;
  /** A stream's event log, for an Events tab. */
  events?: readonly EventLogEntry[];
  /** Shows the view with a running status before the reply ends. */
  running?: boolean;
  /** Live elapsed time while running (useDocsRun's elapsedMs). */
  elapsedMs?: number;
}) {
  const idBase = useId();
  const [tab, setTab] = useState<Tab>("output");
  if (!result && !running) return null;

  const body = json !== undefined ? json : (result?.json ?? null);
  const bodyObj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const usedModel = model ?? result?.model ?? (typeof bodyObj?.model === "string" ? bodyObj.model : null);
  const usageObj = usage !== undefined ? usage : (bodyObj?.usage ?? null);
  const headers = Object.entries(result?.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "output", label: "Output" },
    { id: "json", label: "JSON" },
    { id: "headers", label: "Headers", count: headers.length },
    ...(events?.length ? [{ id: "events" as const, label: "Events", count: events.reduce((n, e) => n + e.count, 0) }] : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : "output";
  const ok = result ? result.ok && !result.error : true;
  const ms = running ? (elapsedMs ?? 0) : (result?.elapsedMs ?? elapsedMs ?? 0);

  return (
    <section className="pg-response" aria-label="Response">
      <div className="pg-response-head" role="status">
        {running ? (
          <span className="pg-status pg-status-busy">
            <span className="pg-dot pg-dot-busy" aria-hidden />
            Running
          </span>
        ) : result ? (
          <span className={`pg-status ${ok ? "pg-status-ok" : "pg-status-bad"}`}>
            <span className={`pg-dot ${ok ? "pg-dot-ok" : "pg-dot-bad"}`} aria-hidden />
            {statusText(result)}
          </span>
        ) : null}
        {usedModel ? <span className="pg-meta">{docsModelLabel(usedModel)}</span> : null}
        {ms ? <span className="pg-meta">{latencyLabel(ms)}</span> : null}
        {!running && usageObj !== null ? <UsageLine model={usedModel} usage={usageObj} {...costExtrasOf(body)} /> : null}
      </div>
      {result?.note ? (
        <p className="pg-proxy-note">
          <Icon name="info" size={14} /> {result.note}
        </p>
      ) : null}
      <Tabs<Tab> label="Response" idBase={idBase} tabs={tabs} value={active} onChange={setTab} />
      <TabPanel idBase={idBase} id="output" active={active === "output"}>
        {children ?? (text !== undefined ? <div className="pg-stream-text">{text}</div> : <AutoOutput result={result} body={body} running={running} />)}
      </TabPanel>
      <TabPanel idBase={idBase} id="json" active={active === "json"}>
        {bodyObj || Array.isArray(body) ? (
          <div className="pg-json-wrap">
            <CopyButton value={JSON.stringify(body, null, 2)} label="Copy the JSON" className="icon-btn icon-btn-plain icon-btn-sm pg-json-copy" />
            <JsonTree value={body} />
          </div>
        ) : result?.text ? (
          <pre className="pg-pre">{result.text}</pre>
        ) : (
          <p className="pg-empty">{running ? "The JSON appears when the reply finishes." : "This reply has no JSON body."}</p>
        )}
      </TabPanel>
      <TabPanel idBase={idBase} id="headers" active={active === "headers"}>
        {headers.length ? (
          <table className="pg-headers">
            <tbody>
              {headers.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="pg-empty">No headers yet.</p>
        )}
      </TabPanel>
      {events?.length ? (
        <TabPanel idBase={idBase} id="events" active={active === "events"}>
          <EventLog events={events} />
        </TabPanel>
      ) : null}
    </section>
  );
}

/** The Output tab when the playground doesn't fill it: whatever the reply carries, by its shape. */
function AutoOutput({ result, body, running }: { result: DocsResult | null; body: unknown; running: boolean }) {
  const protocol = protocolOfReply(body);
  const reply = useMemo(() => (protocol ? collectReply(protocol, body) : null), [protocol, body]);
  if (running) return <p className="pg-empty">Waiting for the reply.</p>;
  if (result?.blob) return <BlobOutput blob={result.blob} name={fileNameOf(result)} />;
  if (reply) return <ReplyView reply={reply} />;
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (o && Array.isArray(o.data)) {
    const images: GeneratedImage[] = (o.data as Array<Record<string, unknown>>)
      .filter((d) => d && typeof d.b64_json === "string")
      .map((d, i) => ({ id: `img-${i}`, b64: d.b64_json as string, mime: imageMime(d.b64_json as string) }));
    if (images.length) return <Images images={images} />;
    const urls = (o.data as Array<Record<string, unknown>>).filter((d) => d && typeof d.url === "string");
    if (urls.length) {
      return (
        <ul className="pg-list">
          {urls.map((d, i) => (
            <li key={i}>
              <a href={String(d.url)} target="_blank" rel="noopener noreferrer">
                Image {i + 1}
              </a>
            </li>
          ))}
        </ul>
      );
    }
  }
  if (o && typeof o.transcript === "string") return <div className="pg-stream-text">{o.transcript.replace(/​/g, "").trim() || "(no speech found)"}</div>;
  if (body !== null && body !== undefined) return <JsonTree value={body} openDepth={2} />;
  if (result?.text) return <pre className="pg-pre">{result.text}</pre>;
  return <p className="pg-empty">{result?.ok ? "The reply was empty." : "No reply body."}</p>;
}

function fileNameOf(result: DocsResult): string {
  const disposition = result.headers["content-disposition"] ?? "";
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  if (named) return decodeURIComponent(named);
  const type = result.blob?.type ?? "";
  const ext = type.includes("pdf") ? "pdf" : type.includes("png") ? "png" : type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : type.includes("wav") ? "wav" : type.includes("mp4") ? "mp4" : "bin";
  return `file-content.${ext}`;
}

/** A file the API sent back: a download link, and a preview for images. */
export function BlobOutput({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  const type = blob.type || "application/octet-stream";
  return (
    <div className="pg-blob">
      <p>
        A file came back: <code>{type}</code>, {sizeLabel(blob.size)}.
      </p>
      {url ? (
        <a className="btn btn-outline btn-sm" href={url} download={name}>
          <Icon name="download" size={16} />
          <span>Download {name}</span>
        </a>
      ) : null}
      {url && type.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="pg-blob-preview" src={url} alt={`Preview of ${name}`} />
      ) : null}
    </div>
  );
}
