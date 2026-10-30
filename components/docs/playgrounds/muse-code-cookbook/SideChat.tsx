"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { PresetPills, TextArea, runOnModEnter } from "@/components/docs/kit/Field";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { RunButton } from "@/components/docs/kit/RunButton";
import { StreamView } from "@/components/docs/kit/StreamView";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { SseEvent } from "@/lib/docs/client/api";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { jobId } from "@/components/docs/playgrounds/muse-code-cookbook/logic/cron";
import { chatTurnBody } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { withChainRetry } from "@/components/docs/playgrounds/muse-code-cookbook/logic/live";
import { Chip, ShowCode, Terminal, Verdict } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The side-chats recipe, live on Responses: a main thread chained with previous_response_id, and a side chat that
 * branches from the main thread's last committed response. The side chat reads everything up to that cut (it
 * continues from that response) and keeps its own chain; the main thread keeps chaining from its own ids, so it never
 * sees a side turn. Both lanes run at once, so a side question can be answered while a long main turn streams.
 */

export interface SideChatProps {
  slug: string;
}

interface Turn {
  user: string;
  reply: Collected | null;
  id: string | null;
  done: boolean;
  failed: boolean;
}

const WIDGET_PY = `"""Frobnicator widget: computes a stability score for a Quibbex reading."""

def stability_score(reading: float) -> float:
    """Return the Frobnicator stability score for a Quibbex sensor reading.

    The score is the reading scaled by the Wozzle constant (0.73) and clamped
    to the range [0.0, 1.0].
    """
    WOZZLE = 0.73
    scaled = reading * WOZZLE
    if scaled < 0.0:
        return 0.0
    if scaled > 1.0:
        return 1.0
    return scaled`;

/** The main thread's presets, in the recipe's order (exported for the tests). */
export const MAIN_PRESETS = [
  { label: "1. Read widget.py", prompt: `Here is widget.py from /tmp/sidechat_demo:\n\n${WIDGET_PY}\n\nSay in one sentence what this module does.` },
  { label: "2. Start a long task", prompt: "Add a function batch_score(readings) to widget.py that returns a stability score for each reading. Show the full new code with docstrings." },
  { label: "3. What did I ask?", prompt: "Back on the main thread. List every question I have asked you in this conversation, in order. Answer only from this main thread history." },
  // The recipe also asks about the Wozzle constant, but here the main thread read widget.py itself (step 1), whose
  // docstring names it, so a yes would be true and look like a leak. A reading of 2.0 only ever comes up on the side.
  { label: "The recipe's check", prompt: "Back on the main thread. Did we discuss what score a reading of 2.0 gives on this main conversation? Answer only from this main thread history." },
];

const SIDE_PRESETS = [
  { label: "Wozzle and the clamp", prompt: "While that runs, quick side question: in widget.py what is the Wozzle constant and what range does stability_score clamp to?" },
  { label: "A reading of 2.0", prompt: "Follow-up on this side channel: if I pass a reading of 2.0, what score comes back and why?" },
  { label: "Spawn a subagent", prompt: "Spawn a subagent to write more tests for widget.py." },
];

const REFUSED = "Could not start side chat.\nReason: source session log is unavailable; resume a retained session or start a new chat";

function short(id: string | null): string {
  return id ? `${id.slice(0, 12)}...` : "(pending)";
}

export function SideChat(_props: SideChatProps) {
  const id = useId();
  const mainRun = useDocsRun();
  const sideRun = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [main, setMain] = useState<Turn[]>([]);
  const [side, setSide] = useState<Turn[]>([]);
  const [mainPrompt, setMainPrompt] = useState(MAIN_PRESETS[0].prompt);
  const [sidePrompt, setSidePrompt] = useState(SIDE_PRESETS[0].prompt);
  const [sideOpen, setSideOpen] = useState(false);
  const [cut, setCut] = useState<{ id: string; turn: number } | null>(null);
  const [sideSession, setSideSession] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"side" | "btw">("side");
  const [refused, setRefused] = useState(false);
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const [mainSession, setMainSession] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<{ main: boolean; side: boolean }>({ main: false, side: false });
  const mainBusy = mainRun.state === "running";
  const sideBusy = sideRun.state === "running";

  const committedMain = [...main].reverse().find((t) => t.done && t.id && !t.failed) ?? null;

  const send = async (lane: "main" | "side", text: string) => {
    const turns = lane === "main" ? main : side;
    const setTurns = lane === "main" ? setMain : setSide;
    const runner = lane === "main" ? mainRun : sideRun;
    const lastOwn = [...turns].reverse().find((t) => t.done && t.id && !t.failed);
    const previous = lane === "main" ? (lastOwn?.id ?? null) : (lastOwn?.id ?? cut?.id ?? null);
    const body = chatTurnBody(model, lane, text, previous);
    setLastBody(body);
    if (lane === "main" && !mainSession) setMainSession(jobId());
    const index = turns.length;
    setTurns((t) => [...t, { user: text, reply: null, id: null, done: false, failed: false }]);
    if (lane === "main") setMainPrompt("");
    else setSidePrompt("");
    const collector = responsesCollector();
    const update = (patch: Partial<Turn>) => setTurns((t) => t.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    const res = await withChainRetry(
      () =>
        runner.run("responses", {
          method: "POST",
          body,
          stream: true,
          onEvent: (e: SseEvent) => {
            collector.push(e);
            update({ reply: collector.snapshot() });
          },
        }),
      body,
      { onRetry: () => setRetrying((r) => ({ ...r, [lane]: true })) },
    );
    setRetrying((r) => ({ ...r, [lane]: false }));
    const reply = collector.snapshot();
    const failed = !res.ok || !!reply.error || !reply.id;
    update({ reply, id: reply.id, done: true, failed });
    // A failed turn gives the text back to its composer, so it can be sent again without retyping.
    if (failed) (lane === "main" ? setMainPrompt : setSidePrompt)((p) => p || text);
  };

  const openSide = (how: "side" | "btw") => {
    if (!committedMain?.id) {
      setRefused(true);
      return;
    }
    setRefused(false);
    setOrigin(how);
    setCut({ id: committedMain.id, turn: main.indexOf(committedMain) + 1 });
    setSideSession(jobId());
    setSide([]);
    setSideOpen(true);
  };

  const graph = [
    { text: `main  session ${mainSession ?? "(not started)"}`, tone: "plain" as const },
    ...main.map((t, i) => ({ text: `  turn ${i + 1}  ${short(t.id)}${cut && cut.turn === i + 1 ? "   <- the side chat branched here" : ""}`, tone: "plain" as const })),
    ...(cut
      ? [
          { text: `side  session ${sideSession} (command_origin: "${origin}"), seeded from ${short(cut.id)}`, tone: "muted" as const },
          ...side.map((t, i) => ({ text: `  side ${i + 1}  ${short(t.id)}  previous_response_id ${i === 0 ? short(cut.id) : short(side[i - 1].id)}`, tone: "muted" as const })),
        ]
      : []),
  ];

  const transcript = (turns: Turn[], label: string) => <Transcript turns={turns} label={label} />;

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={mainBusy || sideBusy} />
      </div>
      <div className={styles.lanes}>
        <section className={styles.laneBox} aria-labelledby={`${id}-main`}>
          <div className={styles.laneHead}>
            <span id={`${id}-main`}>Main thread</span>
            <Chip tone={mainBusy ? "accent" : undefined}>{mainBusy ? "running" : main.length ? `${main.length} turn(s)` : "new"}</Chip>
          </div>
          {transcript(main, "Main thread turns")}
          <PresetPills presets={MAIN_PRESETS} onPick={(i) => setMainPrompt(MAIN_PRESETS[i].prompt)} disabled={mainBusy} />
          <div className="pg-composer">
            <label className="sr-only" htmlFor={`${id}-main-input`}>
              Message on the main thread
            </label>
            <TextArea id={`${id}-main-input`} rows={3} value={mainPrompt} onChange={(e) => setMainPrompt(e.target.value)} onKeyDown={runOnModEnter(() => mainPrompt.trim() && !mainBusy && void send("main", mainPrompt.trim()))} disabled={mainBusy} />
            <div className="pg-composer-bar">
              <button type="button" className="btn btn-sm btn-outline" onClick={() => openSide("side")} disabled={sideOpen}>
                /side
              </button>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => openSide("btw")} disabled={sideOpen}>
                /btw
              </button>
              <RunButton running={mainBusy} onRun={() => void send("main", mainPrompt.trim())} onStop={mainRun.abort} label="Send" disabled={!mainPrompt.trim()} />
            </div>
          </div>
          {refused ? <Terminal title="Muse Code" lines={REFUSED.split("\n").map((t) => ({ text: t, tone: "err" as const }))} live /> : null}
          {refused ? <p className={styles.note}>A side chat branches from the source session&apos;s durable log, so the main thread needs a committed turn first. Send one, then open the side chat; it works while the main thread runs.</p> : null}
          {retrying.main ? <p className={styles.note} role="status">Meta is still storing the last reply; sending again in a moment.</p> : null}
          <ErrorBox error={retrying.main ? null : mainRun.error} />
        </section>

        {sideOpen ? (
          <section className={`${styles.laneBox} ${styles.laneBoxSide}`} aria-labelledby={`${id}-side`}>
            <div className={styles.laneHead}>
              <span id={`${id}-side`}>Side chat ({origin === "btw" ? "/btw" : "/side"})</span>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setSideOpen(false)}>
                Return to main (Ctrl+C)
              </button>
            </div>
            <p className={styles.cut}>reads the main thread up to turn {cut?.turn}</p>
            {transcript(side, "Side chat turns")}
            <PresetPills presets={SIDE_PRESETS} onPick={(i) => setSidePrompt(SIDE_PRESETS[i].prompt)} disabled={sideBusy} />
            <div className="pg-composer">
              <label className="sr-only" htmlFor={`${id}-side-input`}>
                Message in the side chat
              </label>
              <TextArea id={`${id}-side-input`} rows={3} value={sidePrompt} onChange={(e) => setSidePrompt(e.target.value)} onKeyDown={runOnModEnter(() => sidePrompt.trim() && !sideBusy && void send("side", sidePrompt.trim()))} disabled={sideBusy} />
              <div className="pg-composer-bar">
                <RunButton running={sideBusy} onRun={() => void send("side", sidePrompt.trim())} onStop={sideRun.abort} label="Ask on the side" disabled={!sidePrompt.trim()} />
              </div>
            </div>
            <p className={styles.footer} role="status">
              Side chat: {sideSession} · Ctrl+C to return · source {mainBusy ? "running" : "idle"}
            </p>
            {retrying.side ? <p className={styles.note} role="status">Meta is still storing the main thread&apos;s reply; sending again in a moment.</p> : null}
            <ErrorBox error={retrying.side ? null : sideRun.error} />
          </section>
        ) : (
          <div className={styles.laneBox}>
            <div className={styles.laneHead}>
              <span>Side chat</span>
              <Chip>{side.length ? "closed" : "not open"}</Chip>
            </div>
            {side.length ? (
              <Verdict tone="info" title={`Side chat ${sideSession} closed after ${side.length} turn(s)`} live={false}>
                <p className={styles.note}>
                  The main thread continues from its own last response, so it has no record of these turns. Ask it with step 3 (the list it gives has only the main thread&apos;s questions) or the recipe&apos;s check. That check asks only about a reading of 2.0: the recipe also names the Wozzle constant, but here the main thread read widget.py itself in step 1, and its docstring names the constant.
                </p>
              </Verdict>
            ) : (
              <p className={styles.note}>
                Send step 1 on the main thread, start step 2, then open <code>/side</code> (or <code>/btw</code>, an alias) while it runs. The side chat continues from the main thread&apos;s last committed response, so it can read the file; the main thread never chains through it.
              </p>
            )}
          </div>
        )}
      </div>

      {main.length || side.length ? <Terminal title="The response chains (previous_response_id)" lines={graph} /> : null}
      <p className={styles.note}>Each turn streams one Responses call, under a cent. Side questions add to the side chain&apos;s context, never to the main thread&apos;s.</p>
      <ShowCode body={lastBody ?? chatTurnBody(model, "main", mainPrompt || MAIN_PRESETS[0].prompt, null)} caption={lastBody ? "The last request either lane sent" : "The request Send sends"} />
    </div>
  );
}

/** One lane's turns, scrolled to the newest turn when one is added (not on every streamed token). */
function Transcript({ turns, label }: { turns: Turn[]; label: string }) {
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const el = list.current;
    const last = el?.lastElementChild as HTMLElement | null | undefined;
    if (el && last) el.scrollTop = last.offsetTop;
  }, [turns.length]);
  if (!turns.length) return null;
  return (
    <ol ref={list} className={styles.turns} aria-label={label}>
      {turns.map((t, i) => (
        <li key={i} className="pg-turn">
          <p className="pg-bubble-user">{t.user.length > 260 ? `${t.user.slice(0, 260)}...` : t.user}</p>
          <div className="pg-bubble-assistant">
            <StreamView text={t.reply?.text ?? ""} running={!t.done} placeholder={t.failed ? "No reply: the request failed." : "No text in this reply."} />
            {t.done && t.reply?.usage ? (
              <p className="pg-turn-meta">
                <UsageLine model={t.reply.model} usage={t.reply.usage} />
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
