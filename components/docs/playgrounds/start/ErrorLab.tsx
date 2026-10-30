"use client";

import { useId, useMemo, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { Toggle } from "@/components/docs/kit/Field";
import { ContributorNotice } from "@/components/docs/kit/ContributorNotice";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { ResponseView, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import {
  displayCaseBody,
  ERROR_CASES,
  errorCase,
  errorParts,
  missesTarget,
  STATUS_ADVICE,
  whoAnswered,
  type Answerer,
  type ErrorCase,
  type RecordedError,
  type Retry,
} from "@/components/docs/playgrounds/start/error-cases";
import { RetrySimulator } from "@/components/docs/playgrounds/start/RetrySimulator";
import { SectionTabs } from "@/components/docs/playgrounds/start/SectionTabs";
import { SplitPills } from "@/components/docs/playgrounds/start/SplitPills";
import styles from "@/components/docs/playgrounds/start/start.module.css";

const RETRY_LABEL: Record<Retry, string> = {
  no: "Don't retry: fix the request",
  yes: "Retry with backoff",
  differently: "Don't simply retry: change how you send it",
};

const RETRY_TONE: Record<Retry, string> = { no: styles.tagBad, yes: styles.tagOk, differently: styles.tagWarn };

const ANSWERED_BY: Record<Answerer, string> = {
  meta: "Answered by Meta",
  proxy: "Answered by the docs proxy, before Meta",
  other: "Not an API error: no JSON error envelope, so the docs' host or the network answered before the docs proxy",
};

/**
 * The error-handling page, live. The lab triggers real errors through the docs proxy (a missing field, bad
 * parameters, a broken conversation, an unknown model, malformed JSON, a typo in the path) and takes each reply apart
 * the way the page's table does: status, message, type, param and code, who answered, and the page's fix. Edit a body
 * to fix it and send it again. The page's 413 can't be triggered live, so its case shows the page's recorded replies.
 * The retry simulator plays 429s and 5xx against the page's backoff rules, and "Status codes" lists every status the
 * page covers with its example body.
 */
export function ErrorLab({ initial = "lab", caseId = "top-p" }: { slug: string; initial?: "lab" | "retry" | "codes"; caseId?: string }) {
  const [tab, setTab] = useState<string>(initial);
  const [picked, setPicked] = useState(() => Math.max(0, ERROR_CASES.findIndex((c) => c.id === caseId)));
  const tryCase = (id: string) => {
    const i = ERROR_CASES.findIndex((c) => c.id === id);
    if (i >= 0) {
      setPicked(i);
      setTab("lab");
    }
  };
  return (
    <SectionTabs
      label="Error handling"
      value={tab}
      onChange={setTab}
      sections={[
        { id: "lab", label: "Error lab", content: <Lab picked={picked} onPick={setPicked} /> },
        { id: "retry", label: "Retry simulator", content: <RetrySimulator scenario="rate-limit" /> },
        { id: "codes", label: "Status codes", content: <StatusCodes onTry={tryCase} /> },
      ]}
    />
  );
}

function Lab({ picked, onPick }: { picked: number; onPick(i: number): void }) {
  const c = ERROR_CASES[picked] ?? ERROR_CASES[0];
  // Each case keeps its own editor, so switching cases resets the body to that case's.
  return (
    <div className="pg">
      <SplitPills label="Trigger" presets={ERROR_CASES} active={picked} onPick={onPick} />
      {c.recorded ? <RecordedCase key={c.id} c={c} recorded={c.recorded} /> : <CaseRunner key={c.id} c={c} />}
    </div>
  );
}

function CaseRunner({ c }: { c: ErrorCase }) {
  const id = useId();
  const runner = useDocsRun();
  const original = c.body ? formatJson(c.body) : "";
  const [text, setText] = useState(original);
  const [showCode, setShowCode] = useState(false);
  const parsed = useMemo(() => (c.body ? parseJsonText(text) : null), [c.body, text]);
  const running = runner.state === "running";
  const editedBody = parsed?.ok ? parsed.value : undefined;
  const sendsModel = (editedBody && typeof editedBody === "object" ? (editedBody as { model?: unknown }).model : undefined) ?? (c.raw ? DEFAULT_TEXT_MODEL : undefined);

  const run = () => {
    if (running) return;
    if (c.raw !== undefined) {
      void runner.run(c.path, { method: "POST", raw: { data: new Blob([c.raw], { type: "application/json" }), contentType: "application/json" }, record: { body: c.raw } });
    } else if (c.method === "GET") {
      void runner.run(c.path, { method: "GET" });
    } else if (parsed?.ok) {
      void runner.run(c.path, { method: c.method, body: parsed.value });
    }
  };

  const result = runner.result;
  const parts = result && !isAborted(result) ? errorParts(result.status, result.json, result.text) : null;
  const who = result && parts ? whoAnswered(result.headers, parts) : null;
  const fromMeta = who === "meta";
  const fixed = result?.ok;

  return (
    <div className={styles.stack}>
      <div className="pg-console-line">
        <span className={`pg-method pg-method-${c.method.toLowerCase()}`}>{c.method}</span>
        <code className="docs-code-inline">/v1/{c.path}</code>
        <span className={`${styles.tag} ${c.answeredBy === "meta" ? styles.tagAccent : ""}`}>
          {c.answeredBy === "meta" ? "Meta answers" : "The docs proxy answers"}
        </span>
      </div>
      <p className={`${styles.lead} pg-advanced`}>{c.teaches}</p>
      {c.body ? (
        <JsonEditor id={`${id}-body`} value={text} onChange={setText} resetTo={original} disabled={running} rows={Math.min(14, original.split("\n").length + 1)} hint="Fix it and send it again to see the request go through." />
      ) : c.raw !== undefined ? (
        <pre className="pg-pre" aria-label="Request body">
          {displayCaseBody(c)}
        </pre>
      ) : null}
      {sendsModel ? <ContributorNotice model={String(sendsModel)} /> : null}
      <div className="pg-actions">
        <RunButton running={running} onRun={run} onStop={runner.abort} label="Send" disabled={!!parsed && !parsed.ok} />
        <span className="pg-hint">
          {c.body && text !== original
            ? "Edited: if the request is valid now, the model runs, at fractions of a cent on Contributor."
            : "Refused before any model runs, so it costs nothing."}
        </span>
      </div>

      {result && parts && !result.ok && missesTarget(c, parts) ? (
        <>
          <p className="pg-hint">
            This isn&apos;t the error this case aims for ({c.expect.status}
            {c.expect.code ? ` ${c.expect.code}` : ""}): something else answered first.
          </p>
          <ErrorBox error={runner.error} />
        </>
      ) : null}
      {parts && result ? (
        <div className={styles.card} aria-live="polite">
          <p className={styles.cardTitle}>
            <span className={`pg-status ${fixed ? "pg-status-ok" : "pg-status-bad"}`}>{statusText(result)}</span>{" "}
            <span className="pg-meta">
              {who === "meta"
                ? `${ANSWERED_BY.meta}${result.headers["x-request-id"] ? `, request id ${result.headers["x-request-id"]}` : ""}`
                : who && result.status
                  ? ANSWERED_BY[who]
                  : ""}
            </span>
          </p>
          {fixed ? (
            <p>The request went through: whatever you changed fixed it. That&apos;s the page&apos;s advice for every 4xx: fix the request, don&apos;t retry it unchanged.</p>
          ) : (
            <>
              <dl className={styles.kv}>
                <dt>message</dt>
                <dd>{parts.message ?? <span className="pg-muted">(none)</span>}</dd>
                <dt>type</dt>
                <dd>
                  <code>{parts.type ?? "null"}</code>
                </dd>
                <dt>param</dt>
                <dd>
                  <code>{parts.param ?? "null"}</code>
                  {parts.param ? <span className="pg-muted"> the field that caused it</span> : null}
                </dd>
                <dt>code</dt>
                <dd>
                  <code>{parts.code ?? "null"}</code>
                  {parts.code === null && parts.envelope ? <span className="pg-muted"> usual for validation errors: branch on type and message</span> : null}
                </dd>
              </dl>
              {!fromMeta && c.metaWouldSay ? <p className="pg-hint">Meta itself: {c.metaWouldSay}</p> : null}
              <p className={styles.tags}>
                <span className={`${styles.tag} ${RETRY_TONE[c.retry]}`}>{RETRY_LABEL[c.retry]}</span>
              </p>
              <p className="pg-hint">
                Fix: {c.fix}{" "}
                <a className={styles.link} href={`#${c.anchor}`}>
                  On this page
                </a>
              </p>
            </>
          )}
        </div>
      ) : null}
      <ResponseView result={result} running={running} elapsedMs={runner.elapsedMs} />
      {c.body || c.method === "GET" ? (
        <>
          <div className="pg-actions">
            <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
          </div>
          {showCode ? <CodeView method={c.method} path={c.path} body={c.method === "GET" ? undefined : (editedBody ?? c.body)} caption="The same request with your own key" /> : null}
        </>
      ) : null}
    </div>
  );
}

/** A case no live request can trigger: the request the page describes, its recorded replies, and the same reading as a live case. */
function RecordedCase({ c, recorded }: { c: ErrorCase; recorded: RecordedError }) {
  const [first, ...rest] = recorded.replies;
  const parts = errorParts(c.expect.status, first?.body ?? null, "");
  const status = `${c.expect.status} ${STATUS_ADVICE.find((s) => s.status === c.expect.status)?.name ?? ""}`.trim();
  return (
    <div className={styles.stack}>
      <div className="pg-console-line">
        <span className={`pg-method pg-method-${c.method.toLowerCase()}`}>{c.method}</span>
        <code className="docs-code-inline">/v1/{c.path}</code>
        <span className={styles.tag}>Recorded from the page</span>
      </div>
      <p className={`${styles.lead} pg-advanced`}>{c.teaches}</p>
      <pre className="pg-pre" aria-label="The request, as the page describes it">
        {recorded.request}
      </pre>
      <p className="pg-hint">{recorded.why}</p>
      <div className={styles.card}>
        <p className={styles.cardTitle}>
          <span className="pg-status pg-status-bad">{status}</span> <span className="pg-meta">Recorded example: {first?.cause}</span>
        </p>
        <dl className={styles.kv}>
          <dt>message</dt>
          <dd>{parts.message ?? <span className="pg-muted">(none)</span>}</dd>
          <dt>type</dt>
          <dd>
            <code>{parts.type ?? "null"}</code>
          </dd>
          <dt>param</dt>
          <dd>
            <code>{parts.param ?? "null"}</code>
          </dd>
          <dt>code</dt>
          <dd>
            <code>{parts.code ?? "null"}</code>
            {parts.code ? <span className="pg-muted"> populated, unlike most validation errors: branch on it</span> : null}
          </dd>
        </dl>
        {rest.map((reply) => (
          <details key={reply.cause} className="pg-raw pg-advanced">
            <summary>The page&apos;s other {c.expect.status}: {reply.cause}</summary>
            <JsonTree value={reply.body} openDepth={2} />
          </details>
        ))}
        <p className={styles.tags}>
          <span className={`${styles.tag} ${RETRY_TONE[c.retry]}`}>{RETRY_LABEL[c.retry]}</span>
        </p>
        <p className="pg-hint">
          Fix: {c.fix}{" "}
          <a className={styles.link} href={`#${c.anchor}`}>
            On this page
          </a>
        </p>
      </div>
    </div>
  );
}

function StatusCodes({ onTry }: { onTry(caseId: string): void }) {
  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        Every status the page covers. Errors share one envelope, <code>{"{ error: { message, type, param, code } }"}</code>; a 404 for an
        unknown path has an empty body, and the Files list can answer a 400 in plain text, so branch on the status and Content-Type
        before parsing.
      </p>
      <ul className={styles.items}>
        {STATUS_ADVICE.map((s) => (
          <li key={s.status} className={styles.item}>
            <span className={styles.itemHead}>
              <strong>
                {s.status} {s.name}
              </strong>
              <span className={`${styles.tag} ${RETRY_TONE[s.retry]}`}>{RETRY_LABEL[s.retry]}</span>
              {s.liveCase ? (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => onTry(s.liveCase!)}>
                  {errorCase(s.liveCase)?.recorded ? "See the recorded example" : "Trigger one live"}
                </button>
              ) : null}
            </span>
            <ul className="pg-list pg-small pg-advanced">
              {s.causes.map((cause) => (
                <li key={cause}>{cause}</li>
              ))}
            </ul>
            <span className="pg-hint pg-advanced">Fix: {s.fix}</span>
            {s.example ? (
              <details className="pg-raw pg-advanced">
                <summary>The page&apos;s example body</summary>
                <JsonTree value={s.example} openDepth={2} />
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="pg-hint">
        On a stream, a failure after the first event arrives as a terminal event instead of a status: <code>response.failed</code> (the
        response with <code>status: &quot;failed&quot;</code> and an <code>error</code>) or <code>error</code> (code and message at the top
        level, such as <code>server_shutting_down</code>). Handle both next to <code>response.completed</code> and{" "}
        <code>response.incomplete</code>.
      </p>
    </div>
  );
}
