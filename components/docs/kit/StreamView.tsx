import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { EventLogEntry } from "@/lib/docs/client/events";
import type { Citation, Collected, GeneratedImage, SearchCall, ToolCall } from "@/lib/docs/client/stream";

/**
 * How a model's reply reads in the playgrounds, streaming or done: the reasoning summary (folded once the answer
 * starts), the text as it arrives with a caret, as Markdown (MarkdownText, which never injects HTML), citations as
 * numbered sources, web searches, tool calls with their arguments, generated images, and the event log.
 */

export function StreamView({
  text,
  reasoning,
  refusal,
  running = false,
  events,
  placeholder = "The answer appears here.",
}: {
  text: string;
  reasoning?: string;
  refusal?: string;
  running?: boolean;
  /** The folded event log (lib/docs/client/events). */
  events?: readonly EventLogEntry[];
  placeholder?: string;
}) {
  const waiting = running && !text;
  return (
    <div className="pg-stream">
      {reasoning ? (
        <details className="pg-reasoning" open={running && !text}>
          <summary>Reasoning summary</summary>
          <p className="pg-reasoning-text">{reasoning}</p>
        </details>
      ) : null}
      {text || running ? (
        // aria-busy holds the announcement until the reply is whole, so a screen reader reads it once, not per token.
        <div aria-live="polite" aria-busy={running || undefined}>
          <MarkdownText className="pg-stream-text" text={text} streaming={running} />
        </div>
      ) : (
        <p className="pg-empty">{placeholder}</p>
      )}
      {waiting ? <p className="pg-wait">The model reasons before it writes, so the first words can take a few seconds.</p> : null}
      {refusal ? <p className="pg-refusal">The model declined: {refusal}</p> : null}
      {events?.length ? <EventLog events={events} /> : null}
    </div>
  );
}

export function EventLog({ events }: { events: readonly EventLogEntry[] }) {
  const total = events.reduce((n, e) => n + e.count, 0);
  return (
    <details className="pg-events">
      <summary>
        Stream events <span className="pg-tab-count">{total}</span>
      </summary>
      <ol className="pg-events-list">
        {events.map((e, i) => (
          <li key={`${i}-${e.type}`} title={e.sample}>
            <code>{e.type}</code>
            {e.count > 1 ? <span className="pg-events-count">×{e.count}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function Citations({ citations }: { citations: readonly Citation[] }) {
  if (!citations.length) return null;
  // One line per source: the same page cited for several spans is listed once.
  const sources = citations.filter((c, i) => citations.findIndex((x) => x.url === c.url) === i);
  return (
    <div className="pg-citations">
      <p className="pg-section-label">Sources</p>
      <ol className="pg-citation-list">
        {sources.map((c) => (
          <li key={c.url}>
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              {c.title || c.url}
            </a>
            <span className="pg-citation-host">{hostOf(c.url)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function Searches({ searches }: { searches: readonly SearchCall[] }) {
  if (!searches.length) return null;
  return (
    <ul className="pg-searches">
      {searches.map((s) => (
        <li key={s.id} className="pg-search">
          <span className={`pg-dot pg-dot-${s.status === "completed" ? "ok" : "busy"}`} aria-hidden />
          <span>
            Web search{s.query ? <>: <q>{s.query}</q></> : null}
            {s.status !== "completed" ? <span className="pg-muted"> ({s.status.replace(/_/g, " ")})</span> : null}
          </span>
          {s.results?.length ? <span className="pg-muted"> {s.results.length} results</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Arguments pretty-printed when they're complete JSON, as they streamed otherwise. */
export function prettyArguments(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export function ToolCalls({ calls, title = "Tool calls" }: { calls: readonly ToolCall[]; title?: string }) {
  if (!calls.length) return null;
  return (
    <div className="pg-toolcalls">
      <p className="pg-section-label">{title}</p>
      <ul className="pg-toolcall-list">
        {calls.map((c, i) => (
          <li key={c.id || i} className="pg-toolcall">
            <p className="pg-toolcall-head">
              <code className="pg-toolcall-name">{c.name || "(name pending)"}</code>
              {c.callId ? <code className="pg-muted">{c.callId}</code> : null}
              {!c.done ? <span className="pg-muted">streaming arguments</span> : null}
            </p>
            <pre className="pg-pre">{prettyArguments(c.arguments) || "{}"}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Images({ images, alt = "Generated image" }: { images: readonly GeneratedImage[]; alt?: string }) {
  if (!images.length) return null;
  return (
    <div className="pg-images">
      {images.map((img, i) => (
        <figure key={img.id || i} className="pg-image">
          {/* A data URL the model returned: next/image can't optimize it, and it never leaves the page. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:${img.mime};base64,${img.b64}`} alt={`${alt} ${i + 1}`} />
          {img.partial ? <figcaption className="pg-muted">Preview, still rendering</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}

/** A whole reply: reasoning, text, searches, sources, tool calls and images, in that order. */
export function ReplyView({
  reply,
  running = false,
  events,
  placeholder,
}: {
  reply: Collected | null;
  running?: boolean;
  events?: readonly EventLogEntry[];
  placeholder?: string;
}) {
  return (
    <div className="pg-reply">
      {reply?.searches.length ? <Searches searches={reply.searches} /> : null}
      <StreamView
        text={reply?.text ?? ""}
        reasoning={reply?.reasoning}
        refusal={reply?.refusal}
        running={running}
        events={events}
        placeholder={reply?.toolCalls.length || reply?.images.length ? "No text in this reply." : placeholder}
      />
      {reply ? <Citations citations={reply.citations} /> : null}
      {reply ? <ToolCalls calls={reply.toolCalls} /> : null}
      {reply ? <Images images={reply.images} /> : null}
    </div>
  );
}
