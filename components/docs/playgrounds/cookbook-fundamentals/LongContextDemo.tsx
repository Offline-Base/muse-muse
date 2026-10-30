"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { numberFactsHistory, trimHistory, type Msg } from "@/components/docs/playgrounds/cookbook-fundamentals/context";
import {
  CONTEXT_WINDOW,
  costBeforeSending,
  denseFiller,
  MAX_BODY_BYTES,
  repeatDocument,
  STAND_IN_SUMMARY,
  standInDocument,
  tokensLabel,
  utf8Bytes,
  windowCheck,
} from "@/components/docs/playgrounds/cookbook-fundamentals/long-context";
import { BarList, DemoTabs, Meter, Note, Stats, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { formatUsd } from "@/lib/docs/client/cost";
import { fetchSample, sizeLabel } from "@/lib/docs/client/files";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";
import { sampleById } from "@/lib/docs/media/samples";

/**
 * The long-context recipe, live: measure a request with POST /v1/responses/input_tokens before sending it (free),
 * price it and check input plus planned output against the 1,048,576-token window, then send it; compare a full text
 * with its summary; cap a conversation with the recipe's sliding window; and push past the window to see the 400 the
 * API returns instead of truncating.
 */

export interface LongContextDemoProps {
  slug: string;
}

type Doc = "alice" | "standin" | "own";
type Copies = "1" | "4" | "16" | "64";
type Planned = "1000" | "4000" | "16000";

const QUESTIONS: Record<Doc, Array<{ label: string; prompt: string }>> = {
  alice: [
    { label: "Exact wording", prompt: "Quote, word for word, the sentence where the White Rabbit takes a watch out of its waistcoat-pocket." },
    { label: "Who and where", prompt: "Who does Alice meet first after she falls, and where?" },
    { label: "Summarize", prompt: "Summarize chapter II in three sentences." },
  ],
  standin: [{ label: "Key decisions", prompt: "Summarize the key architecture decisions." }],
  own: [{ label: "Summarize", prompt: "Summarize this in five bullet points." }],
};

const ANSWER_FROM_DOC = "Answer from the document in the user's message. When asked for exact wording, quote it exactly.";

function useAlice() {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const sample = sampleById("alice");
    if (!sample) {
      setError("The Alice sample is missing.");
      return;
    }
    fetchSample(sample)
      .then((f) => f.text())
      .then((t) => live && setText(t))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load the sample."));
    return () => {
      live = false;
    };
  }, []);
  return { text, error };
}

function MeasureThenAsk() {
  const id = useId();
  const counter = useDocsRun();
  const runner = useDocsRun();
  const alice = useAlice();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [doc, setDoc] = useState<Doc>("alice");
  const [own, setOwn] = useState("");
  const [copies, setCopies] = useState<Copies>("1");
  const [planned, setPlanned] = useState<Planned>("4000");
  const [question, setQuestion] = useState(QUESTIONS.alice[0].prompt);
  const [preset, setPreset] = useState<number | null>(0);
  const [counted, setCounted] = useState<{ key: string; tokens: number } | null>(null);
  const [showCode, setShowCode] = useState(false);

  const base = doc === "alice" ? (alice.text ?? "") : doc === "standin" ? standInDocument() : own;
  const name = doc === "alice" ? "alice-chapters-1-3.txt" : doc === "standin" ? "architecture.md" : "your text";
  const text = useMemo(() => repeatDocument(base, Number(copies), name), [base, copies, name]);
  const userContent = `${text}\n\n${question.trim()}`;
  const key = `${model}|${doc}|${copies}|${question.trim()}|${base.length}`;
  const fresh = counted?.key === key ? counted.tokens : null;
  const bytes = useMemo(() => utf8Bytes(userContent), [userContent]);
  const tooBig = bytes > MAX_BODY_BYTES * 0.98;
  const check = fresh !== null ? windowCheck(fresh, Number(planned)) : null;
  const cost = fresh !== null ? costBeforeSending(model, fresh, Number(planned)) : null;
  const running = counter.state === "running" || runner.state === "running";

  const chatBody = (content: string) => ({
    model,
    messages: [
      { role: "developer", content: ANSWER_FROM_DOC },
      { role: "user", content },
    ],
    max_completion_tokens: Number(planned),
    reasoning_effort: "low",
  });

  const count = async () => {
    const res = await counter.run("responses/input_tokens", {
      method: "POST",
      body: { model, input: [{ role: "developer", content: ANSWER_FROM_DOC }, { role: "user", content: userContent }] },
    });
    const tokens = (res.json as { input_tokens?: number } | null)?.input_tokens;
    if (res.ok && typeof tokens === "number") setCounted({ key, tokens });
  };

  const send = async () => {
    await runner.run("chat/completions", { method: "POST", body: chatBody(userContent) });
  };

  const reply = runner.result?.ok ? collectReply("chat", runner.result.json) : null;
  const billed = reply?.usage ? (reply.usage as { prompt_tokens?: number }).prompt_tokens : null;
  const shownContent = `${text.slice(0, 160)}... (${text.length.toLocaleString("en-US")} characters in all)\n\n${question.trim()}`;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
      </div>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>Document</span>
        <Segmented<Doc>
          size="sm"
          label="Document"
          value={doc}
          onChange={(d) => {
            setDoc(d);
            setPreset(0);
            setQuestion(QUESTIONS[d][0].prompt);
          }}
          disabled={running}
          options={[
            { value: "alice", label: "Alice, chapters 1 to 3" },
            { value: "standin", label: "The recipe's stand-in" },
            { value: "own", label: "Paste your own" },
          ]}
        />
        <span className={styles.inlineLabel}>Copies</span>
        <Segmented<Copies>
          size="sm"
          label="Copies of the document"
          value={copies}
          onChange={setCopies}
          disabled={running}
          options={(["1", "4", "16", "64"] as const).map((c) => ({ value: c, label: `x${c}` }))}
        />
      </div>
      {doc === "own" ? (
        <Field id={`${id}-own`} label="Your text">
          <TextArea id={`${id}-own`} rows={5} value={own} onChange={(e) => setOwn(e.target.value)} disabled={running} placeholder="Paste a file, a log or a transcript." />
        </Field>
      ) : null}
      {doc === "alice" && alice.error ? <p className="pg-bad">{alice.error}</p> : null}
      <Note>
        {doc === "alice"
          ? "Lewis Carroll, chapters I to III (about 6,000 words, public domain)."
          : doc === "standin"
            ? "The recipe stands in for a large file with one sentence repeated 800 times."
            : "Anything you paste is sent to the model when you press Send."}{" "}
        Copies stand in for repo-scale context: {sizeLabel(bytes)} to send{tooBig ? ", over the live docs' 4.5 MB body limit" : ""}.
      </Note>
      <PresetPills
        presets={QUESTIONS[doc]}
        active={preset}
        disabled={running}
        onPick={(i) => {
          setPreset(i);
          setQuestion(QUESTIONS[doc][i].prompt);
        }}
      />
      <Field id={`${id}-q`} label="Question">
        <TextArea
          id={`${id}-q`}
          rows={2}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            setPreset(null);
          }}
          disabled={running}
        />
      </Field>
      <div className={styles.row}>
        <span className={styles.inlineLabel}>Planned output (max_completion_tokens)</span>
        <Segmented<Planned>
          size="sm"
          label="Planned output tokens"
          value={planned}
          onChange={setPlanned}
          disabled={running}
          options={[
            { value: "1000", label: "1k" },
            { value: "4000", label: "4k" },
            { value: "16000", label: "16k" },
          ]}
        />
      </div>
      <div className={styles.spread}>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void count()} disabled={running || !base || !question.trim() || tooBig}>
          1. Count the tokens (free)
        </button>
        <RunButton
          running={runner.state === "running"}
          onRun={() => void send()}
          onStop={runner.abort}
          disabled={fresh === null || !check?.fits || tooBig || counter.state === "running"}
          label={cost !== null && cost >= 0.01 ? `2. Send it (about ${formatUsd(cost)})` : "2. Send it"}
        />
      </div>
      <ErrorBox error={counter.error} />
      {check ? (
        <>
          <Stats
            label="Before sending"
            items={[
              { label: "Input tokens", value: check.input.toLocaleString("en-US"), note: "counted, nothing generated" },
              { label: "Planned output", value: check.output.toLocaleString("en-US") },
              { label: "Input + output", value: tokensLabel(check.total), note: `${(check.share * 100).toFixed(2)}% of the window` },
              { label: "At most", value: cost !== null ? formatUsd(cost) : "n/a", note: "if it uses all the output" },
            ]}
          />
          <Meter
            label="Input plus planned output against the context window"
            value={check.total}
            max={CONTEXT_WINDOW}
            left={`${tokensLabel(check.total)} of ${tokensLabel(CONTEXT_WINDOW)}`}
            right={check.fits ? "fits" : `over by ${check.over.toLocaleString("en-US")}`}
          />
        </>
      ) : (
        <Note>Count first: the Send button waits for a count of exactly what it will send.</Note>
      )}
      <ErrorBox error={runner.error} />
      {runner.state === "running" || runner.result ? (
        <ResponseView result={runner.result} running={runner.state === "running"} elapsedMs={runner.elapsedMs}>
          {reply ? (
            <div className={styles.stack}>
              <StreamView text={reply.text} placeholder="No text." />
              {billed && fresh ? (
                <p className="pg-muted pg-small">
                  Billed {billed.toLocaleString("en-US")} prompt tokens; the count said {fresh.toLocaleString("en-US")}.
                </p>
              ) : null}
            </div>
          ) : undefined}
        </ResponseView>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView
          method="POST"
          path="responses/input_tokens"
          body={{ model, input: [{ role: "developer", content: ANSWER_FROM_DOC }, { role: "user", content: shownContent }] }}
          caption="Step 1, the count (the document is shortened here)"
        />
      ) : null}
    </div>
  );
}

function FullOrSummary() {
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [counts, setCounts] = useState<{ full: number; summary: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const countOf = async (input: string) => {
    const res = await runner.run("responses/input_tokens", { method: "POST", body: { model, input } });
    return res.ok ? ((res.json as { input_tokens?: number }).input_tokens ?? null) : null;
  };

  const run = async () => {
    setBusy(true);
    setCounts(null);
    try {
      const full = await countOf(standInDocument());
      if (full === null) return;
      const summary = await countOf(STAND_IN_SUMMARY);
      if (summary === null) return;
      setCounts({ full, summary });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pg">
      <p className={styles.lead}>
        Full text keeps every detail (use it when exact wording matters, such as code); a summary costs a fraction (use it when the gist is
        enough). The recipe counts both before it decides. Two counts, free.
      </p>
      <div className={styles.spread}>
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <RunButton running={busy} onRun={() => void run()} onStop={runner.abort} label="Count both" />
      </div>
      <ErrorBox error={runner.error} />
      {counts ? (
        <>
          <BarList
            label="Input tokens: full file and summary"
            items={[
              { key: "full", label: "Full file", value: counts.full, display: `${counts.full.toLocaleString("en-US")} tokens` },
              { key: "summary", label: "Summary", value: counts.summary, display: `${counts.summary.toLocaleString("en-US")} tokens` },
            ]}
          />
          <Note>
            The summary is {Math.round(counts.full / Math.max(1, counts.summary))} times smaller, and every repeat of it in a long conversation saves the
            difference again.
          </Note>
        </>
      ) : null}
      <details className="pg-raw">
        <summary>The two texts</summary>
        <p className={styles.note}>Full: &quot;{standInDocument(2).trim()} ...&quot; (800 times)</p>
        <p className={styles.note}>Summary: &quot;{STAND_IN_SUMMARY}&quot;</p>
      </details>
    </div>
  );
}

function SlidingWindow() {
  const id = useId();
  const runner = useDocsRun();
  const counter = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [max, setMax] = useState(8);
  const [counts, setCounts] = useState<{ before: number; after: number } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const history = useMemo(() => numberFactsHistory(20), []);
  const trimmed = useMemo(() => trimHistory(history, max), [history, max]);
  const body = { model, messages: trimmed, reasoning_effort: "minimal" };

  const toInput = (messages: Msg[]) => messages.map((m) => ({ role: m.role, content: m.content }));
  const count = async () => {
    setCounts(null);
    const a = await counter.run("responses/input_tokens", { method: "POST", body: { model, input: toInput(history) } });
    if (!a.ok) return;
    const b = await counter.run("responses/input_tokens", { method: "POST", body: { model, input: toInput(trimmed) } });
    if (!b.ok) return;
    setCounts({ before: (a.json as { input_tokens: number }).input_tokens, after: (b.json as { input_tokens: number }).input_tokens });
  };

  const reply = runner.result?.ok ? collectReply("chat", runner.result.json) : null;
  return (
    <div className="pg">
      <p className={styles.lead}>
        The recipe&apos;s trim_history: always keep the instruction messages and drop the oldest turns past max_messages. Here, 20 made-up turns
        about numbers and a last question: {history.length} messages in all.
      </p>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={runner.state === "running"} />
        <span className="pg-inline-field">
          <label className="pg-label" htmlFor={`${id}-max`}>
            max_messages
          </label>
          <input
            id={`${id}-max`}
            type="range"
            min={2}
            max={history.length}
            value={max}
            onChange={(e) => {
              setMax(Number(e.target.value));
              setCounts(null);
            }}
          />
          <span className="pg-meta">{max}</span>
        </span>
      </div>
      <p className="pg-muted pg-small">
        Trimmed {history.length} messages down to {trimmed.length}: the developer message, then the newest {trimmed.length - 1}.
      </p>
      <ol className="pg-checks" aria-label="Messages kept">
        {trimmed.map((m, i) => (
          <li key={i}>
            <code>{m.role}</code> <span className="pg-muted">{m.content}</span>
          </li>
        ))}
      </ol>
      <div className={styles.spread}>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void count()} disabled={counter.state === "running"}>
          Count before and after (free)
        </button>
        <RunButton running={runner.state === "running"} onRun={() => void runner.run("chat/completions", { method: "POST", body })} onStop={runner.abort} label="Send the trimmed history" />
      </div>
      <ErrorBox error={counter.error ?? runner.error} />
      {counts ? (
        <Stats
          label="Input tokens"
          items={[
            { label: "Whole history", value: counts.before.toLocaleString("en-US") },
            { label: "Trimmed", value: counts.after.toLocaleString("en-US"), note: `${Math.round((1 - counts.after / Math.max(1, counts.before)) * 100)}% fewer` },
          ]}
        />
      ) : null}
      {reply ? <p className={styles.thought}>{reply.text.slice(0, 160)}</p> : null}
      <Note>Trimming simply forgets: summarize older turns instead when their content still matters (the multi-turn context recipe).</Note>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body} caption="The trimmed request" /> : null}
    </div>
  );
}

function PastTheWindow() {
  const counter = useDocsRun();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [text, setText] = useState<string | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);

  const make = async () => {
    const filler = denseFiller(2_200_000, 7);
    setText(filler);
    setTokens(null);
    const res = await counter.run("responses/input_tokens", { method: "POST", body: { model, input: filler } });
    if (res.ok) setTokens((res.json as { input_tokens?: number }).input_tokens ?? null);
  };

  const send = async () => {
    if (!text) return;
    await runner.run("chat/completions", { method: "POST", body: { model, messages: [{ role: "user", content: text }], max_completion_tokens: 400 } });
  };

  const err = runner.result && !runner.result.ok ? runner.result.error : null;
  const expected = err?.code === "context_length_exceeded";
  return (
    <div className="pg">
      <p className={styles.lead}>
        Input tokens plus the output you ask for must fit in {CONTEXT_WINDOW.toLocaleString("en-US")}. There is no server-side truncation: a
        request past the window is a 400. This makes 2.2 MB of random numbers (about two characters a token), counts it, and lets you send it.
      </p>
      <div className={styles.spread}>
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={counter.state === "running" || runner.state === "running"} />
        <span className={styles.row}>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => void make()} disabled={counter.state === "running" || runner.state === "running"}>
            {counter.state === "running" ? "Counting..." : "Make it and count it (free)"}
          </button>
          <RunButton
            running={runner.state === "running"}
            onRun={() => void send()}
            onStop={runner.abort}
            disabled={!tokens || tokens <= CONTEXT_WINDOW}
            label="Send it anyway (expect a 400)"
          />
        </span>
      </div>
      <ErrorBox error={counter.error ?? (err && !expected ? err : null)} />
      {tokens !== null ? (
        <Meter
          label="The filler against the context window"
          value={tokens}
          max={CONTEXT_WINDOW}
          left={`${tokens.toLocaleString("en-US")} tokens`}
          right={tokens > CONTEXT_WINDOW ? `over by ${(tokens - CONTEXT_WINDOW).toLocaleString("en-US")}` : "fits"}
        />
      ) : null}
      {runner.result && (expected || runner.result.ok) ? (
        <div className={styles.compareCol}>
          <p className={styles.turnHead}>
            <StatusPill tone={runner.result.ok ? "ok" : "bad"}>HTTP {runner.result.status}</StatusPill>
            {err?.code ? <code>{err.code}</code> : null}
          </p>
          <p className={styles.result}>{err?.message ?? "It went through."}</p>
          {err ? <Note>Measure first and compact on your side, by trimming or summarizing, so input plus planned output stays under the window.</Note> : null}
        </div>
      ) : null}
      <Note>The count is free, and the rejected request generates nothing.</Note>
    </div>
  );
}

export function LongContextDemo(_props: LongContextDemoProps) {
  return (
    <DemoTabs
      label="Long context demos"
      tabs={[
        { id: "measure", label: "Measure, then ask", content: <MeasureThenAsk /> },
        { id: "summary", label: "Full text or summary", content: <FullOrSummary /> },
        { id: "window", label: "Sliding window", content: <SlidingWindow /> },
        { id: "over", label: "Past the window", content: <PastTheWindow /> },
      ]}
    />
  );
}
