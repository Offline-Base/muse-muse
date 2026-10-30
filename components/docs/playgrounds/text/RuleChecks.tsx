"use client";

import { useRef, useState } from "react";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { DocsError } from "@/lib/docs/client/api";
import { DEFAULT_TEXT_MODEL, docsModelLabel } from "@/lib/docs/client/models";
import { outcomeOfReply } from "@/lib/docs/client/record";
import { Badge, LazyDetails } from "@/components/docs/playgrounds/text/parts";
import { failureOutcome, recordOf } from "@/components/docs/playgrounds/text/record";
import { acceptedSummary, checkVerdict, mayBill, outcomeLabel, withModel, type RuleCheck } from "@/components/docs/playgrounds/text/rules";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * A page's rules, checked live: each row sends the smallest request that shows one rule and says whether the API
 * answered the way the page says. "Check all" runs them one after another. A 400 here is the expected answer, so it is
 * shown as the API's message under its rule, not as an error; only a call that couldn't decide (a rate limit, a paused
 * demo) gets the ErrorBox. Checks that should fail aren't recorded for the copy prompt: they are deliberately broken.
 * Accepted ones are recorded once the reply is in, with the rule they test and the start of the reply.
 */

export interface RuleChecksProps {
  slug: string;
  checks: RuleCheck[];
  /** A line above the list. */
  intro?: string;
  /** Default muse-spark-1.3-contributor. */
  model?: string;
  models?: string[];
}

interface RowResult {
  status: number;
  message: string | null;
  summary: string | null;
  json: unknown;
  model: string | null;
  elapsedMs: number;
  error: DocsError | null;
}

export function RuleChecks(props: RuleChecksProps) {
  const runner = useDocsRun();
  const { recordRequest } = useDocsPage();
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const stop = useRef(false);
  const anyBill = props.checks.some(mayBill);

  const runOne = async (check: RuleCheck): Promise<boolean> => {
    setBusy(check.id);
    const body = withModel(check.body, model);
    const res = await runner.run(check.path, { method: "POST", body, record: false });
    const aborted = res.error?.code === "aborted";
    if (check.expect === "accepted" && !aborted) {
      const reply = res.ok ? outcomeOfReply(res.json, res.status) : failureOutcome(res);
      recordRequest(recordOf(check.path, body, res, `rule check (${check.rule}): ${reply}`));
    }
    if (!aborted) {
      setResults((r) => ({
        ...r,
        [check.id]: {
          status: res.status,
          message: res.ok ? null : (res.error?.message ?? null),
          summary: res.ok ? acceptedSummary(check.path, res.json, check.replyHas) : null,
          json: res.json,
          model: res.model,
          elapsedMs: res.elapsedMs,
          error: res.error,
        },
      }));
    }
    setBusy(null);
    return !aborted;
  };

  const runAll = async () => {
    stop.current = false;
    for (const check of props.checks) {
      if (stop.current) break;
      const finished = await runOne(check);
      if (!finished) break;
    }
    setBusy(null);
  };

  const done = Object.keys(results).length;
  const verdictFor = (c: RuleCheck) => (results[c.id] ? checkVerdict(c, results[c.id].status, results[c.id].json) : null);
  const matches = props.checks.filter((c) => verdictFor(c) === "matches").length;
  const differs = props.checks.filter((c) => verdictFor(c) === "differs").length;

  return (
    <div className={`pg ${styles.stack}`}>
      {props.intro ? <p className={styles.about}>{props.intro}</p> : null}
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={!!busy} />
        <RunButton
          running={!!busy}
          onRun={() => void runAll()}
          onStop={() => {
            stop.current = true;
            runner.abort();
          }}
          label={done ? "Check all again" : "Check all"}
        />
        <span className="pg-muted pg-small" role="status">
          {done ? `${matches} of ${done} checked match the page${differs ? `, ${differs} differ` : ""}.` : anyBill ? "Most checks expect HTTP 400 and cost nothing; the accepted ones cost a few tokens." : "Every check expects HTTP 400, which costs nothing."}
        </span>
      </div>
      <ol className={styles.checks} aria-label="Rule checks">
        {props.checks.map((check, i) => {
          const r = results[check.id];
          const verdict = verdictFor(check);
          const running = busy === check.id;
          return (
            <li key={check.id} className={styles.check} aria-busy={running || undefined}>
              <div className={styles.checkHead}>
                <p className={styles.checkRule}>
                  {i + 1}. {check.rule}
                </p>
                <Badge tone="neutral">The page says: {check.expect === "accepted" ? "accepted" : "HTTP 400"}</Badge>
              </div>
              <p className={styles.checkSends}>
                Sends {check.sends} to <code>POST /v1/{check.path}</code>
                {check.anchor ? (
                  <>
                    {" "}
                    (
                    <a href={`#${check.anchor}`} aria-label={`The page's section on this rule`}>
                      on this page
                    </a>
                    )
                  </>
                ) : null}
                .
              </p>
              <div className={styles.checkResult} aria-live="polite">
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void runOne(check)} disabled={!!busy}>
                  {running ? "Checking" : r ? "Check again" : "Check"}
                </button>
                {r ? (
                  <>
                    <Badge tone={r.status >= 200 && r.status < 300 ? "ok" : r.status === 400 || r.status === 422 ? "bad" : "neutral"}>{outcomeLabel(r.status)}</Badge>
                    {verdict === "matches" ? <Badge tone="ok">Matches the page</Badge> : verdict === "differs" ? <Badge tone="warn">Differs from the page</Badge> : <Badge>Couldn&apos;t check</Badge>}
                    <span className="pg-muted pg-small">
                      {r.model ? `${docsModelLabel(r.model)}, ` : ""}
                      {latencyLabel(r.elapsedMs)}
                    </span>
                  </>
                ) : null}
              </div>
              {r && verdict !== "unknown" && r.message ? <p className={styles.checkMessage}>{r.message}</p> : null}
              {r && r.summary ? <p className={styles.checkSends}>{r.summary}</p> : null}
              {r && verdict === "unknown" ? <ErrorBox error={r.error} /> : null}
              {check.note ? <p className={styles.checkNote}>{check.note}</p> : null}
              <LazyDetails summary={`Request${r?.json ? " and reply" : ""}`}>
                <JsonTree value={withModel(check.body, model)} openDepth={4} label={`Request for check ${i + 1}`} />
                {r?.json ? <JsonTree value={r.json} openDepth={2} label={`Reply to check ${i + 1}`} /> : null}
              </LazyDetails>
            </li>
          );
        })}
      </ol>
      <p className={styles.about}>
        A rule check sends one small request through the docs proxy. Meta&apos;s own error message is shown as it came back.
      </p>
    </div>
  );
}
