"use client";

import { useId, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Toggle } from "@/components/docs/kit/Field";
import { latencyLabel, ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { statusReport, type StatusTone } from "@/components/docs/playgrounds/start/reference";
import styles from "@/components/docs/playgrounds/start/start.module.css";

const TONE_CLASS: Record<StatusTone, string> = { ok: styles.statusOk, warn: styles.statusWarn, bad: styles.statusBad, unknown: "" };
const TONE_TITLE: Record<StatusTone, string> = {
  ok: "All systems operational",
  warn: "Degraded",
  bad: "Disruption",
  unknown: "Status unknown",
};

/**
 * GET /v1/status, the unauthenticated health endpoint, with its reply drawn as a status badge: is_alive,
 * service_status and service_message, when it was updated, and any per-model statuses. The docs proxy sends this one
 * upstream without a key, as the page says it needs none. Free.
 */
export function StatusDemo() {
  const id = useId();
  const runner = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const running = runner.state === "running";
  const report = runner.result?.ok ? statusReport(runner.result.json) : null;

  return (
    <div className="pg">
      <div className="pg-console-line">
        <span className="pg-method pg-method-get">GET</span>
        <code className="docs-code-inline">/v1/status</code>
        <RunButton running={running} onRun={() => void runner.run("status", { method: "GET" })} onStop={runner.abort} label="Check status" />
        <span className="pg-hint">No API key needed: the live docs send this one to Meta without theirs.</span>
      </div>
      <ErrorBox error={runner.error} />
      {report ? (
        <div className={`${styles.statusBadge} ${TONE_CLASS[report.tone]}`} role="status" aria-live="polite">
          <span className={styles.statusDot} aria-hidden />
          <div className={styles.stack} style={{ gap: 4 }}>
            <span className={styles.statusTitle}>
              {report.tone === "ok" && report.status.toLowerCase() === "operational"
                ? TONE_TITLE.ok
                : report.status
                  ? `${TONE_TITLE[report.tone]}: ${report.status}`
                  : TONE_TITLE[report.tone]}
            </span>
            <span className={styles.small}>
              is_alive: {String(report.alive)}
              {report.message ? ` · ${report.message}` : ""} · {report.updatedAt ? `updated ${report.updatedAt}` : "no update time given"} · checked in{" "}
              {latencyLabel(runner.result!.elapsedMs)}
            </span>
            {report.models.length ? (
              <span className={styles.tags}>
                {report.models.map((m) => (
                  <span key={m.model} className={`${styles.tag} ${m.tone === "ok" ? styles.tagOk : m.tone === "warn" ? styles.tagWarn : m.tone === "bad" ? styles.tagBad : ""}`}>
                    {m.model}: {m.status || "unknown"}
                  </span>
                ))}
              </span>
            ) : (
              <span className={styles.small}>No per-model statuses reported (model_statuses is empty).</span>
            )}
          </div>
        </div>
      ) : null}
      <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} />
      <p className="pg-hint">
        Check it before retrying failed requests: a disruption here means wait rather than hammer the API with retries.
      </p>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="GET" path="status" caption="The page's examples send the Authorization header too; status works without it." /> : null}
    </div>
  );
}
