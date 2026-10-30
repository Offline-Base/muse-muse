"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { runOnModEnter, TextArea, Toggle, useModEnterHint } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { RunButton } from "@/components/docs/kit/RunButton";
import { Citations, StreamView } from "@/components/docs/kit/StreamView";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { SseEvent } from "@/lib/docs/client/api";
import { ASK_MAX_CHARS, starterQuestions, titleFromSlug, trimHistory, type AskMessage } from "@/lib/docs/client/ask";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { responsesCollector, type Citation } from "@/lib/docs/client/stream";

/**
 * "Ask about this page": a chat grounded in the page's own Markdown. Questions go to /api/docs/ask with the page's
 * slug and the last few turns; the proxy answers with a streamed Responses call that cites the page's sections
 * (docs/DOCS_MIRROR.md, "Ask"). Three starter questions come from the page title. Nothing here is recorded for the
 * copy prompt: it's a question about the docs, not an API request the reader would build.
 */

export const ASK_BASE = "/api/docs/ask";
const ASK_MODELS = [DEFAULT_TEXT_MODEL, "muse-spark-1.2", "muse-wonder-1.0"];

interface Exchange {
  question: string;
  answer: string;
  citations: Citation[];
  stopped?: boolean;
  failed?: boolean;
}

export function AskPagePanel({ slug }: { slug: string }) {
  const id = useId();
  const { page } = useDocsPage();
  const title = page.slug === slug && page.title ? page.title : titleFromSlug(slug);
  const starters = starterQuestions(title, slug);
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<Exchange[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [showCode, setShowCode] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const running = runner.state === "running";
  const hint = useModEnterHint("to ask");
  const markdownUrl = page.slug === slug && page.markdownUrl ? page.markdownUrl : `https://dev.meta.ai/docs/${slug}.md`;

  const ask = async (raw: string) => {
    const q = raw.trim().slice(0, ASK_MAX_CHARS);
    if (!q || running) return;
    const history: AskMessage[] = log.filter((x) => !x.failed && x.answer).flatMap((x) => [
      { role: "user" as const, content: x.question },
      { role: "assistant" as const, content: x.answer },
    ]);
    const messages = trimHistory([...history, { role: "user", content: q }]);
    const collector = responsesCollector();
    // The ask route relays a Responses stream; a plain {delta} or {text} event is read too, in case it's reshaped.
    let loose = "";
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      const j = e.json;
      if (j && typeof j.type !== "string") {
        if (typeof j.delta === "string") loose += j.delta;
        else if (typeof j.text === "string") loose = j.text;
      }
      setAnswer(collector.snapshot().text || loose);
    };
    setPending(q);
    setAnswer("");
    setQuestion("");
    const res = await runner.run("", { base: ASK_BASE, stream: true, body: { slug, messages, model }, onEvent, record: false });
    const reply = collector.snapshot();
    const text = reply.text || loose;
    const failed = !res.ok || !!reply.error;
    setLog((l) => [...l, { question: q, answer: text, citations: reply.citations, stopped: isAborted(res), failed: failed && !isAborted(res) }].slice(-10));
    setPending(null);
    setAnswer("");
    if (failed && !isAborted(res)) setQuestion(q);
    input.current?.focus();
  };

  return (
    <div className="pg pg-ask">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} allow={ASK_MODELS} disabled={running} />
      </div>
      {!log.length && !pending ? (
        <div className="pg-presets" role="group" aria-label="Starter questions">
          <span className="pg-presets-label" aria-hidden>
            Ask
          </span>
          {starters.map((s, i) => (
            <button key={s} type="button" className={i < 2 ? "pg-pill" : "pg-pill pg-advanced"} onClick={() => void ask(s)} disabled={running}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {log.length || pending ? (
        <ol className="pg-transcript" aria-label="Questions and answers">
          {log.map((x, i) => (
            <li key={i} className="pg-turn">
              <p className="pg-bubble-user">{x.question}</p>
              <div className="pg-bubble-assistant">
                {x.answer ? <MarkdownText className="pg-stream-text" text={x.answer} /> : <p className="pg-empty">{x.failed ? "No answer: see the error below." : "No answer."}</p>}
                {x.stopped ? <p className="pg-muted">Stopped.</p> : null}
                <Citations citations={x.citations} />
              </div>
            </li>
          ))}
          {pending ? (
            <li className="pg-turn">
              <p className="pg-bubble-user">{pending}</p>
              <div className="pg-bubble-assistant" aria-live="polite" aria-busy={running}>
                <StreamView text={answer} running={running} />
              </div>
            </li>
          ) : null}
        </ol>
      ) : null}

      <ErrorBox error={runner.error} />

      <div className="pg-composer">
        <label className="sr-only" htmlFor={`${id}-q`}>
          Your question about {title}
        </label>
        <TextArea
          ref={input}
          id={`${id}-q`}
          rows={2}
          maxLength={ASK_MAX_CHARS}
          placeholder={`Ask about "${title}"`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={runOnModEnter(() => void ask(question))}
        />
        <div className="pg-composer-bar">
          {hint ? <span className="pg-muted pg-kbd-hint">{hint}</span> : <span className="pg-kbd-hint" />}
          {log.length ? (
            <button type="button" className="btn btn-sm" onClick={() => setLog([])} disabled={running}>
              Clear
            </button>
          ) : null}
          <RunButton running={running} onRun={() => void ask(question)} onStop={runner.abort} label="Ask" disabled={!question.trim()} />
        </div>
      </div>
      <p className="pg-muted pg-small">Answers come from this page only, and say so when it doesn&apos;t cover something.</p>
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView
          method="POST"
          path="responses"
          body={askCodeBody(model, markdownUrl, log, question.trim() || starters[0])}
          caption="The same idea from your own code: the page's Markdown goes in the instructions, the question in the input."
        />
      ) : null}
    </div>
  );
}

/**
 * The Responses request a reader would send to build this panel themselves. The proxy's real request (lib/docs/proxy/
 * ask.ts) carries the page's Markdown; the code says where it goes, since pasting a whole page would bury the point.
 */
export function askCodeBody(model: string, markdownUrl: string, log: ReadonlyArray<{ question: string; answer: string }>, question: string) {
  const history = log
    .filter((x) => x.answer)
    .slice(-2)
    .flatMap((x) => [
      { role: "user", content: x.question },
      { role: "assistant", content: [{ type: "output_text", text: x.answer }] },
    ]);
  return {
    model,
    instructions: `Answer questions about the docs page below, using only that page. Say when it doesn't cover something, and name the section you used.\n\n<the Markdown of ${markdownUrl}>`,
    input: history.length ? [...history, { role: "user", content: question }] : question,
    reasoning: { effort: "low" },
    max_output_tokens: 2000,
    stream: true,
  };
}
