"use client";

import { useId, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, TextArea, Toggle } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { collectReply, type Collected } from "@/lib/docs/client/stream";

/**
 * The quickstart-chat-completions recipe's point about statelessness, live: Chat Completions answers from the
 * messages a request carries, so the same follow-up is sent twice, alone and after turn 1 and its reply, side by side.
 */

interface Sent {
  messages: Array<{ role: string; content: string }>;
  reply: Collected | null;
  model: string | null;
  error: string | null;
}

function MessagesList({ messages }: { messages: Sent["messages"] }) {
  return (
    <ol className="pg-checks" aria-label="Messages sent">
      {messages.map((m, i) => (
        <li key={i}>
          <code>{m.role}</code> <span className="pg-muted">{m.content.length > 90 ? `${m.content.slice(0, 90)}...` : m.content}</span>
        </li>
      ))}
    </ol>
  );
}

function SentView({ title, sent, running }: { title: string; sent: Sent | null; running: boolean }) {
  return (
    <div className={styles.compareCol}>
      <p className={styles.compareTitle}>{title}</p>
      {sent ? (
        <>
          <p className="pg-section-label">messages ({sent.messages.length})</p>
          <MessagesList messages={sent.messages} />
          <p className="pg-section-label">Reply</p>
          {sent.error ? (
            <p className="pg-bad">{sent.error}</p>
          ) : sent.reply ? (
            <>
              <p className={styles.textBlock}>{sent.reply.text || "(no text)"}</p>
              <p className="pg-small">
                <UsageLine model={sent.model} usage={sent.reply.usage} />
              </p>
            </>
          ) : (
            <StatusPill tone="busy">Waiting</StatusPill>
          )}
        </>
      ) : (
        <p className="pg-empty">{running ? "Waiting for turn 1." : "Run to send it."}</p>
      )}
    </div>
  );
}

export interface StatelessCompareProps {
  turn1?: string;
  turn2?: string;
}

/** Turn 1, then turn 2 sent alone and with the history: the quickstart recipe's point about statelessness. */
export function StatelessCompare({
  turn1 = "In one sentence, name the most underrated module in the Python standard library.",
  turn2 = "Expand your previous answer into a short paragraph with an example.",
}: StatelessCompareProps) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("minimal");
  const [first, setFirst] = useState(turn1);
  const [second, setSecond] = useState(turn2);
  const [one, setOne] = useState<Sent | null>(null);
  const [alone, setAlone] = useState<Sent | null>(null);
  const [withHistory, setWithHistory] = useState<Sent | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const stopped = useRef(false);

  const body = (messages: Sent["messages"]) => {
    const e = fitEffort(model, effort);
    return { model, messages, ...(e ? { reasoning_effort: e } : {}) };
  };

  const send = async (messages: Sent["messages"], set: (s: Sent) => void): Promise<Sent> => {
    set({ messages, reply: null, model: null, error: null });
    const res = await runner.run("chat/completions", { method: "POST", body: body(messages) });
    const sent: Sent = {
      messages,
      reply: res.ok ? collectReply("chat", res.json) : null,
      model: res.model,
      error: res.ok ? null : (res.error?.message ?? "The request failed."),
    };
    set(sent);
    return sent;
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    stopped.current = false;
    setOne(null);
    setAlone(null);
    setWithHistory(null);
    try {
      const t1 = [{ role: "user", content: first.trim() }];
      const a = await send(t1, setOne);
      if (!a.reply || stopped.current) return;
      // Turn 2 on its own: Chat Completions only sees the messages in this request.
      await send([{ role: "user", content: second.trim() }], setAlone);
      if (stopped.current) return;
      // Turn 2 with the history: append the assistant's reply and the new message, then send the whole array.
      await send([...t1, { role: "assistant", content: a.reply.text }, { role: "user", content: second.trim() }], setWithHistory);
    } finally {
      setBusy(false);
    }
  };

  const codeMessages = withHistory?.messages ?? [
    { role: "user", content: first.trim() },
    { role: "assistant", content: one?.reply?.text || "<turn 1's reply>" },
    { role: "user", content: second.trim() },
  ];

  return (
    <div className="pg">
      <p className={`${styles.lead} pg-advanced`}>
        Chat Completions is stateless: each request is answered from the messages it carries. Run sends turn 1, then
        turn 2 twice: once alone, once with turn 1 and its reply in front of it.
      </p>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
      </div>
      <div className="pg-split">
        <Field id={`${id}-t1`} label="Turn 1">
          <TextArea id={`${id}-t1`} rows={2} value={first} onChange={(e) => setFirst(e.target.value)} disabled={busy} />
        </Field>
        <Field id={`${id}-t2`} label="Turn 2">
          <TextArea id={`${id}-t2`} rows={2} value={second} onChange={(e) => setSecond(e.target.value)} disabled={busy} />
        </Field>
      </div>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">Three calls, well under a cent.</span>
        <RunButton
          running={busy}
          onRun={() => void run()}
          onStop={() => {
            stopped.current = true;
            runner.abort();
          }}
          disabled={!first.trim() || !second.trim()}
          label="Run both ways"
        />
      </div>
      <ErrorBox error={runner.error} />
      {one ? (
        <div className={styles.compareCol}>
          <p className={styles.compareTitle}>Turn 1</p>
          {one.reply ? <p className={styles.textBlock}>{one.reply.text || "(no text)"}</p> : one.error ? <p className="pg-bad">{one.error}</p> : <StatusPill tone="busy">Running</StatusPill>}
        </div>
      ) : null}
      {one?.reply ? (
        <div className={styles.compare} aria-live="polite">
          <SentView title="Turn 2 alone (no history)" sent={alone} running={busy} />
          <SentView title="Turn 2 with the history" sent={withHistory} running={busy} />
        </div>
      ) : null}
      {alone?.reply && withHistory?.reply ? (
        <p className={`${styles.note} pg-advanced`}>
          Alone, the model never saw turn 1, so it asks what you mean or guesses. With the history it can expand the
          answer it gave. You own the messages array: trim or summarize old turns as it grows, or let the Responses API
          keep state with previous_response_id.
        </p>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="chat/completions" body={body(codeMessages)} caption="Turn 2 with the history" /> : null}
    </div>
  );
}
