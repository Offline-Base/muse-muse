import { Fragment } from "react";
import { Icon } from "@/components/icons";
import { clockUtc, eventLine, groupEvents, progressText, type LogItem } from "@/components/train/format";
import type { TrainEventView, TrainProgress } from "@/lib/train/types";

/** Progress runs longer than this fold into one row that opens to show every report. */
const PROGRESS_FOLD_AT = 4;

/**
 * A job's event log, oldest first, in a polite live region so new rows are read out. Back-to-back heartbeats, eval items
 * and judgements each become one row (the results below the log show them in full), and long runs of progress reports
 * fold behind the latest one.
 */
export function EventLog({
  events,
  jobId,
  label = "Job event log",
}: {
  events: TrainEventView[];
  /** The job the log belongs to: an artifact links to its file only under that job's own folder. */
  jobId: string;
  label?: string;
}) {
  const items = groupEvents(events);
  return (
    <ol className="train-log" role="log" aria-live="polite" aria-relevant="additions" aria-label={label}>
      {items.map((item) => (
        <LogRow key={item.kind === "one" ? item.event.id : `${item.type}-${item.events[0].id}`} item={item} jobId={jobId} />
      ))}
      {!items.length ? <li className="train-ev-empty muted">Nothing logged yet.</li> : null}
    </ol>
  );
}

function LogRow({ item, jobId }: { item: LogItem; jobId: string }) {
  if (item.kind === "one" || item.events.length === 1) {
    return <EventRow ev={item.kind === "one" ? item.event : item.events[0]} jobId={jobId} />;
  }
  const first = item.events[0];
  const last = item.events[item.events.length - 1];
  if (item.type === "heartbeat") {
    const msg = last.payload.type === "heartbeat" ? last.payload.message : undefined;
    return (
      <li className="train-ev">
        <time className="train-ev-time" dateTime={first.at}>
          {clockUtc(first.at)}
        </time>
        <span className="train-ev-icon" aria-hidden>
          <Icon name="refresh" size={16} />
        </span>
        <div className="train-ev-body">
          <p>
            <strong>Heartbeat</strong> {item.events.length} reports, the last at {clockUtc(last.at)}
            {msg ? `. ${msg}` : ""}
          </p>
        </div>
      </li>
    );
  }
  if (item.type === "eval" || item.type === "judgement") {
    const evalRun = item.type === "eval";
    return (
      <li className="train-ev">
        <time className="train-ev-time" dateTime={first.at}>
          {clockUtc(first.at)}
        </time>
        <span className="train-ev-icon" aria-hidden>
          <Icon name={evalRun ? "clipboard" : "check"} size={16} />
        </span>
        <div className="train-ev-body">
          <p>
            <strong>{evalRun ? "Eval items" : "Judged"}</strong> {item.events.length} {evalRun ? "sent" : "items"}, the
            last at {clockUtc(last.at)}. <a href="#eval-results">See the results</a>
          </p>
        </div>
      </li>
    );
  }
  if (item.events.length < PROGRESS_FOLD_AT) {
    return (
      <Fragment>
        {item.events.map((ev) => (
          <EventRow key={ev.id} ev={ev} jobId={jobId} />
        ))}
      </Fragment>
    );
  }
  return (
    <li className="train-ev">
      <time className="train-ev-time" dateTime={first.at}>
        {clockUtc(first.at)}
      </time>
      <span className="train-ev-icon" aria-hidden>
        <Icon name="chart" size={16} />
      </span>
      <div className="train-ev-body">
        <details className="train-fold">
          <summary>
            <strong>Progress</strong> {progressText(asProgress(last))}{" "}
            <span className="muted">({item.events.length} reports)</span>
          </summary>
          <ol className="train-fold-list">
            {item.events.map((ev) => (
              <li key={ev.id}>
                <time className="train-ev-time" dateTime={ev.at}>
                  {clockUtc(ev.at)}
                </time>
                <span>{progressText(asProgress(ev))}</span>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </li>
  );
}

function asProgress(ev: TrainEventView): TrainProgress {
  return ev.payload.type === "progress" ? ev.payload : {};
}

function EventRow({ ev, jobId }: { ev: TrainEventView; jobId: string }) {
  const line = eventLine(ev.payload, jobId);
  return (
    <li className={`train-ev${line.tone ? ` train-ev-${line.tone}` : ""}`}>
      <time className="train-ev-time" dateTime={ev.at}>
        {clockUtc(ev.at)}
      </time>
      <span className="train-ev-icon" aria-hidden>
        <Icon name={line.icon} size={16} />
      </span>
      <div className="train-ev-body">
        <p>
          <strong>{line.lead}</strong>
          {line.text ? " " : null}
          {line.text && line.href ? (
            <a href={line.href} target="_blank" rel="noopener noreferrer">
              {line.text}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            line.text
          )}
        </p>
        {line.detail ? <pre className="pre train-pre">{line.detail}</pre> : null}
      </div>
    </li>
  );
}
