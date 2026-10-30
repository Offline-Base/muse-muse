"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Segmented, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { docsModelLabel } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import {
  SCENARIOS,
  approvalText,
  coveredBy,
  ledgerLine,
  notSentMessage,
  remember,
  remoteBody,
  ruleKey,
  scenarioById,
  sha256Hex,
  utf8Bytes,
  type Approvals,
  type Choice,
  type LedgerRow,
  type LocalStep,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/glimmer";

/**
 * cookbook/glimmer-api-agent: the recipe's approval gate around consult_remote_model. The local Muse Glimmer agent
 * is simulated in the browser (it reads local files and drafts the question; nothing it does leaves the page). Every
 * escalation stops at the gate with the exact outbound text, its byte count and the reason; only Allow sends, and
 * what it sends is that same string as the input of a Responses call. Deny can carry a note so the local model
 * rewrites the question; a timeout denies. Approvals are scoped to one text by its SHA-256 digest, and the egress
 * ledger records sizes and digests, never content.
 */

export interface GlimmerGateProps {
  slug: string;
  scenario?: string;
  /** approvals.timeout in seconds. Hermes defaults to 300. */
  timeoutSec?: number;
}

type Json = Record<string, unknown>;

type Entry =
  | { kind: "user"; text: string }
  | { kind: "local"; step: LocalStep }
  | { kind: "call"; question: string; reason: string; bytes: number; digest: string }
  | { kind: "auto"; text: string }
  | { kind: "remote"; answer: string; ms: number; usage: unknown; model: string | null }
  | { kind: "notsent"; text: string }
  | { kind: "final"; text: string };

interface Pending {
  question: string;
  reason: string;
  bytes: number;
  digest: string;
  requestId: string;
  deadline: number;
  custom: boolean;
}

type Decision = { choice: Choice; feedback?: string; rewrite?: string } | "timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function GlimmerGate({ scenario: initialScenario = "wash-sale", timeoutSec: initialTimeout = 300 }: GlimmerGateProps) {
  const id = useId();
  const runner = useDocsRun();
  const [scenarioId, setScenarioId] = useState<string>(initialScenario);
  const [custom, setCustom] = useState("What changed in the US capital gains tax brackets for 2026?");
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [timeoutSec, setTimeoutSec] = useState(initialTimeout);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [approvals, setApprovals] = useState<Approvals>({ session: [], always: [] });
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<((d: Decision) => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [rewrite, setRewrite] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [showCode, setShowCode] = useState(false);
  const [lastQuestion, setLastQuestion] = useState("How does the US wash sale rule adjust the cost basis of replacement shares?");
  const stopped = useRef(false);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [pending]);

  useEffect(() => {
    if (pending && now >= pending.deadline) {
      const r = resolver.current;
      resolver.current = null;
      setPending(null);
      r?.("timeout");
    }
  }, [now, pending]);

  const push = (e: Entry) => setEntries((cur) => [...cur, e]);
  const event = (type: string, data: Json) => setEvents((cur) => [...cur, `data: ${JSON.stringify({ event: type, ...data })}`]);
  const log = (row: Omit<LedgerRow, "ts">) => setLedger((cur) => [...cur, { ...row, ts: new Date().toISOString().slice(0, 19) }]);

  const decide = (d: Decision) => {
    const r = resolver.current;
    resolver.current = null;
    setPending(null);
    setFeedback("");
    r?.(d);
  };

  const play = async () => {
    if (busy) return;
    stopped.current = false;
    setBusy(true);
    setEntries([]);
    setEvents([]);
    runner.reset();
    const sc = scenarioById(scenarioId);
    const isCustom = scenarioId === "custom";
    const prompt = isCustom ? custom.trim() : sc.prompt;
    push({ kind: "user", text: prompt });
    const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
    event("run.started", { run_id: runId });
    const steps: LocalStep[] = isCustom
      ? [{ kind: "think", text: "That needs knowledge I don't hold locally. I'll ask the remote model a self-contained question and send nothing else." }]
      : sc.local;
    for (const s of steps) {
      await sleep(450);
      if (stopped.current) return setBusy(false);
      push({ kind: "local", step: s });
      if (s.kind === "answer") {
        push({ kind: "final", text: s.text });
        event("run.completed", { output: s.text });
        return setBusy(false);
      }
    }
    const drafts = isCustom ? [{ question: prompt, reason: "needs knowledge beyond the local model" }] : sc.drafts;
    let draft = 0;
    let question = drafts[0].question;
    const reason = drafts[0].reason;
    for (let round = 0; round < 6; round++) {
      await sleep(350);
      if (stopped.current) break;
      const digest = await sha256Hex(question);
      const bytes = utf8Bytes(question);
      const key = ruleKey(digest);
      setLastQuestion(question);
      push({ kind: "call", question, reason, bytes, digest });
      event("tool.started", { tool: "consult_remote_model" });
      const covered = coveredBy(approvalsRef.current, key);
      let decision: Decision;
      if (covered) {
        push({ kind: "auto", text: `Approved without asking: "${covered === "always" ? "Always allow" : "Allow for this session"}" already covers this exact text (${key}).` });
        decision = { choice: covered };
      } else {
        const requestId = `apr_${digest.slice(0, 10)}_${round}`;
        event("approval.request", { request_id: requestId, description: approvalText(question, reason, docsModelLabel(model)) });
        setRewrite(question);
        decision = await new Promise<Decision>((resolve) => {
          resolver.current = resolve;
          setNow(Date.now());
          setPending({ question, reason, bytes, digest, requestId, deadline: Date.now() + timeoutSec * 1000, custom: isCustom });
        });
      }
      if (stopped.current) break;
      if (decision === "timeout") {
        log({ event: "not sent", outcome: "timeout", model });
        push({ kind: "notsent", text: notSentMessage("timeout") });
        push({ kind: "final", text: sc.deniedReply || "Nothing was sent, and I won't retry. Ask again when you're back." });
        event("run.completed", { output: "(denied by timeout)" });
        break;
      }
      if (decision.choice === "deny") {
        log({ event: "not sent", outcome: "denied", model });
        if (decision.feedback) {
          push({ kind: "notsent", text: notSentMessage("denied", decision.feedback) });
          const next = isCustom ? decision.rewrite?.trim() || question : drafts[Math.min(draft + 1, drafts.length - 1)].question;
          draft = Math.min(draft + 1, drafts.length - 1);
          push({ kind: "local", step: { kind: "think", text: `Rewrites the question from your note ("${decision.feedback}").${next === question ? " It found nothing to change." : ""}` } });
          question = next;
          continue;
        }
        push({ kind: "notsent", text: notSentMessage("denied") });
        push({ kind: "final", text: sc.deniedReply || "Nothing was sent. I'll continue with what I have locally." });
        event("run.completed", { output: "(denied)" });
        break;
      }
      setApprovals((a) => remember(a, key, decision.choice));
      const res = await runner.run("responses", { method: "POST", body: remoteBody(model, question) });
      if (!res.ok) {
        log({ event: "send failed", bytes, digest, model, ms: Math.round(res.elapsedMs) });
        push({ kind: "notsent", text: `The call failed after approval: ${res.error?.message ?? "unknown error"}` });
        break;
      }
      log({ event: "sent", bytes, digest, model: res.model ?? model, ms: Math.round(res.elapsedMs) });
      const answer = responseText(res.json);
      push({ kind: "remote", answer, ms: res.elapsedMs, usage: (res.json as Json | null)?.usage, model: res.model });
      event("message.delta", { delta: `${answer.slice(0, 60)}...` });
      push({ kind: "final", text: `${sc.wrap || "From Muse Spark:"} ${answer}` });
      event("run.completed", { output: "(final answer)" });
      break;
    }
    setBusy(false);
  };

  const stop = () => {
    stopped.current = true;
    runner.abort();
    if (resolver.current) decide({ choice: "deny" });
    setBusy(false);
  };

  const left = pending ? Math.max(0, Math.ceil((pending.deadline - now) / 1000)) : 0;
  const sc = scenarioById(scenarioId);

  return (
    <div className="pg">
      <div className="pg-presets" role="group" aria-label="Scenario">
        <span className="pg-presets-label" aria-hidden>
          Try
        </span>
        {[...SCENARIOS.map((s) => ({ id: s.id, label: s.label })), { id: "custom", label: "Ask your own" }].map((s) => (
          <button key={s.id} type="button" className="pg-pill" aria-pressed={scenarioId === s.id} onClick={() => setScenarioId(s.id)} disabled={busy}>
            {s.label}
          </button>
        ))}
      </div>
      {scenarioId === "custom" ? (
        <div className={styles.textAnswer}>
          <label className="sr-only" htmlFor={`${id}-custom`}>
            Your question
          </label>
          <TextInput id={`${id}-custom`} value={custom} onChange={(e) => setCustom(e.target.value)} disabled={busy} />
        </div>
      ) : (
        <p className="pg-hint">
          <strong>You:</strong> {sc.prompt}
        </p>
      )}
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} label="Remote model" />
        <span className="pg-inline-field pg-advanced">
          <span className="pg-label">approvals.timeout</span>
          <Segmented<string>
            label="Approval timeout"
            size="sm"
            options={[
              { value: "30", label: "30 s" },
              { value: "300", label: "300 s (Hermes default)" },
            ]}
            value={String(timeoutSec)}
            onChange={(v) => setTimeoutSec(Number(v))}
            disabled={busy}
          />
        </span>
      </div>
      <div className="pg-actions">
        <RunButton running={busy} onRun={() => void play()} onStop={stop} label="Run the local agent" disabled={scenarioId === "custom" && !custom.trim()} />
        <button
          type="button"
          className="btn btn-sm pg-advanced"
          onClick={() => setApprovals((a) => ({ ...a, session: [] }))}
          disabled={busy || !approvals.session.length}
          title="Session approvals end with the session; Always allow stays"
        >
          Start a new session
        </button>
        <span className="pg-hint pg-advanced">
          {approvals.session.length} session approval{approvals.session.length === 1 ? "" : "s"}, {approvals.always.length} always
        </span>
      </div>
      <p className="pg-hint">Muse Glimmer&apos;s steps are simulated in this page and send nothing. Only an approved question goes out, through the docs proxy.</p>

      {entries.length ? (
        <ol className={styles.timeline} aria-label="Agent steps" aria-live="polite">
          {entries.map((e, i) => (
            <li key={i} className={styles.entry}>
              <EntryView e={e} fallbackModel={model} />
            </li>
          ))}
        </ol>
      ) : null}

      {pending ? (
        <div className={styles.gate} role="alertdialog" aria-labelledby={`${id}-gate-title`} aria-describedby={`${id}-gate-text`}>
          <p className={styles.cardTitle} id={`${id}-gate-title`}>
            Approval needed: consult_remote_model
          </p>
          <pre className={styles.gateText} id={`${id}-gate-text`}>
            {approvalText(pending.question, pending.reason, docsModelLabel(model))}
          </pre>
          <p className="pg-hint">
            digest {pending.digest.slice(0, 16)}… · rule_key {ruleKey(pending.digest)} · denies in {left} s
          </p>
          <div className={styles.options}>
            <button type="button" className={styles.option} onClick={() => decide({ choice: "once" })}>
              1) Allow once
            </button>
            <button type="button" className={styles.option} onClick={() => decide({ choice: "session" })}>
              2) Allow for this session
            </button>
            <button type="button" className={styles.option} onClick={() => decide({ choice: "always" })}>
              3) Always allow
            </button>
            <button type="button" className={styles.option} onClick={() => decide({ choice: "deny" })}>
              4) Deny
            </button>
          </div>
          <form
            className={`${styles.stack} pg-advanced`}
            onSubmit={(ev) => {
              ev.preventDefault();
              if (feedback.trim()) decide({ choice: "deny", feedback: feedback.trim(), rewrite });
            }}
          >
            <label className="pg-label" htmlFor={`${id}-fb`}>
              Deny and say what to change (/deny &lt;what to change&gt;)
            </label>
            <div className={styles.textAnswer}>
              <TextInput id={`${id}-fb`} value={feedback} placeholder={sc.revisions?.[0] ?? "Make it about the general rule, not my details."} onChange={(e) => setFeedback(e.target.value)} />
              <button type="submit" className="btn btn-sm" disabled={!feedback.trim()}>
                Deny with a note
              </button>
            </div>
            {sc.revisions?.length && !feedback ? (
              <button type="button" className="pg-pill" onClick={() => setFeedback(sc.revisions![0])} style={{ alignSelf: "flex-start" }}>
                Use: {sc.revisions[0]}
              </button>
            ) : null}
            {pending.custom ? (
              <>
                <label className="pg-label" htmlFor={`${id}-rw`}>
                  The rewrite (simulated: in Hermes, Muse Glimmer writes this from your note)
                </label>
                <TextArea id={`${id}-rw`} rows={2} value={rewrite} onChange={(e) => setRewrite(e.target.value)} />
              </>
            ) : null}
          </form>
        </div>
      ) : null}

      <ErrorBox error={runner.error} />

      <div className={styles.grid2}>
        <div className={styles.stack}>
          <p className="pg-label">$HERMES_HOME/egress.jsonl</p>
          <pre className={styles.ledger} aria-label="Egress ledger">
            {ledger.length ? ledger.map(ledgerLine).join("\n") : "(empty: nothing has left this device)"}
          </pre>
          <p className="pg-hint">Sizes, digests and timings only. The ledger never stores the question or the answer.</p>
        </div>
        <div className={`${styles.stack} pg-advanced`}>
          <p className="pg-label">Runs API events (what a phone app reads)</p>
          <pre className={styles.ledger} aria-label="Run events">
            {events.length ? events.join("\n") : "(no run yet)"}
          </pre>
          <p className="pg-hint">An app answers approval.request with POST /v1/runs/&lt;run_id&gt;/approval and a choice of once, session, always or deny.</p>
        </div>
      </div>

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={remoteBody(model, lastQuestion)} caption="What an approval sends: the approved string as the input, nothing else" /> : null}
    </div>
  );
}

function EntryView({ e, fallbackModel }: { e: Entry; fallbackModel: string }) {
  switch (e.kind) {
    case "user":
      return (
        <p className={styles.entryHead}>
          <span className={styles.agent}>you</span> <span style={{ fontWeight: 400 }}>{e.text}</span>
        </p>
      );
    case "local":
      return (
        <div className={styles.stack}>
          <p className={styles.entryHead}>
            <span className={styles.agent} style={{ ["--badge" as string]: "var(--chart-3)" }}>
              Muse Glimmer (local, simulated)
            </span>
            <span style={{ fontWeight: 400 }}>{e.step.text}</span>
          </p>
          {e.step.file ? (
            <pre className="pg-pre">
              read({e.step.file}){"\n"}
              {e.step.content}
            </pre>
          ) : null}
        </div>
      );
    case "call":
      return (
        <div className={styles.stack}>
          <p className={styles.entryHead}>
            <span className={styles.agent} style={{ ["--badge" as string]: "var(--chart-3)" }}>
              Muse Glimmer
            </span>
            <span>calls consult_remote_model</span>
            <span className={styles.entryMeta}>
              {e.bytes} bytes · digest {e.digest.slice(0, 8)}…
            </span>
          </p>
          <pre className="pg-pre">{JSON.stringify({ question: e.question, reason: e.reason }, null, 2)}</pre>
        </div>
      );
    case "auto":
      return <p className={styles.note} data-tone="warn">{e.text}</p>;
    case "remote":
      return (
        <div className={styles.stack}>
          <p className={styles.entryHead}>
            <span className={styles.agent} style={{ ["--badge" as string]: "var(--chart-1)" }}>
              {docsModelLabel(e.model ?? fallbackModel)} (remote)
            </span>
            <span className={styles.entryMeta}>
              {latencyLabel(e.ms)} <UsageLine model={e.model ?? fallbackModel} usage={e.usage} />
            </span>
          </p>
          <p className={styles.answer}>{e.answer}</p>
        </div>
      );
    case "notsent":
      return (
        <p className={styles.note} data-tone="bad">
          <span className={styles.noteMark}>{"✗"}</span> {e.text}
        </p>
      );
    case "final":
      return (
        <div className="pg-final">
          <p className="pg-section-label">Agent reply</p>
          <p className={styles.answer}>{e.text}</p>
        </div>
      );
  }
}
