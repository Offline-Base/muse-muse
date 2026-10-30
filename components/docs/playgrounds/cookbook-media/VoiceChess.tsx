"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, PresetPills, Segmented, TextInput, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { AudioRecorder } from "@/components/docs/media/AudioRecorder";
import { FilePicker } from "@/components/docs/media/FilePicker";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { Chessboard } from "@/components/docs/playgrounds/cookbook-media/Chessboard";
import { coordinateLabel, startPosition } from "@/components/docs/playgrounds/cookbook-media/chess";
import {
  cleanHeard,
  moveListText,
  newGame,
  runTurn,
  type GameState,
  type Grammar,
  type TurnOutcome,
} from "@/components/docs/playgrounds/cookbook-media/chess-voice";
import type { SseEvent } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { formatDuration } from "@/lib/docs/media/audio";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { EMPTY_REALTIME, realtimeStep, type RealtimeView } from "@/lib/docs/media/realtime";
import { commaList, realtimeHandshake, realtimeQuery, transcribeRequestPart, type TranscribeMode } from "@/lib/docs/media/requests";

export interface VoiceChessProps {
  slug?: string;
  /** The audio sample picked on load. */
  sampleId?: string;
  /** Keyword presets for vocabulary biasing; the first is used on load. */
  keywordSets?: Array<{ label: string; keywords: string[] }>;
  /** The grammar on load: "exact" is the recipe's (the default); "pieces" is the demo's wider one. */
  grammar?: Grammar;
  /** Black answers each move (standing in for the Chess app's computer player). */
  autoReply?: boolean;
  endpoint?: "realtime" | "transcribe";
  /** Typed phrases to try the parser without audio. */
  phrases?: string[];
}

interface Decision {
  key: number;
  source: string;
  heard: string;
  outcome: TurnOutcome;
}

type Source = "sample" | "mic" | "type";

/**
 * Spoken chess moves on an on-page board, the way the voice chess recipe works: Muse Voice Transcribe hears the
 * audio (realtime, with speech-turn detection and keyword biasing, or one file request), partials only feed the HUD,
 * and each finished turn goes through a deterministic parser that accepts only the exact grammar. Every move is
 * checked against the board's legal moves before anything changes; an ambiguous, illegal or unparseable turn moves
 * nothing. Dry run validates without moving, as the recipe's --dry-run does. It starts on the recipe's exact grammar,
 * under which the sample's piece names ("Pawn to e4") fail closed; the wider grammar is opt-in.
 */
export function VoiceChess({
  sampleId = "chess-moves",
  keywordSets = [{ label: "None", keywords: [] }],
  grammar: initialGrammar = "exact",
  autoReply: initialReply = true,
  endpoint: initialEndpoint = "realtime",
  phrases = [],
}: VoiceChessProps) {
  const id = useId();
  const runner = useDocsRun();
  const running = runner.state === "running";
  const { recordRequest } = useDocsPage();
  const [source, setSource] = useState<Source>("sample");
  const [file, setFile] = useState<PickedMedia | null>(null);
  const [take, setTake] = useState<PickedMedia | null>(null);
  const [typed, setTyped] = useState(phrases[0] ?? "Move E2 to E4");
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [keywordSet, setKeywordSet] = useState(0);
  const [keywords, setKeywords] = useState((keywordSets[0]?.keywords ?? []).join(", "));
  const [grammar, setGrammar] = useState<Grammar>(initialGrammar);
  const [autoReply, setAutoReply] = useState(initialReply);
  const [dryRun, setDryRun] = useState(false);
  const [labels, setLabels] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [game, setGame] = useState<GameState>(() => newGame(startPosition()));
  const gameRef = useRef(game);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [view, setView] = useState<RealtimeView>(EMPTY_REALTIME);
  const [reply, setReply] = useState<{ transcript?: string; turns?: Array<{ transcript?: string }> } | null>(null);
  const counter = useRef(0);

  // ENDPOINTING finds the turn boundaries, as the recipe's speech-turn detection does.
  const mode: TranscribeMode = "ENDPOINTING";
  const audio = source === "mic" ? take : file;
  const kw = commaList(keywords);

  const decide = (heard: string, from: string) => {
    const text = cleanHeard(heard);
    if (!text) return;
    const outcome = runTurn(gameRef.current, text, { grammar, autoReply, dryRun });
    if (outcome.ok && !outcome.dryRun) {
      gameRef.current = outcome.state;
      setGame(outcome.state);
    }
    setDecisions((d) => [{ key: ++counter.current, source: from, heard: text, outcome }, ...d].slice(0, 30));
  };

  const listenRealtime = async (a: PickedMedia) => {
    let current = EMPTY_REALTIME;
    setView(EMPTY_REALTIME);
    // Only a finished turn authorizes a move, and each turn only once: partials and repeats never do.
    const handled = new Set<number>();
    const onEvent = (e: SseEvent) => {
      current = realtimeStep(current, e, "CUMULATIVE");
      setView(current);
      if ((e.json?.type ?? e.event) === "speechComplete") {
        const turnId = typeof e.json?.turnId === "number" ? e.json.turnId : -1;
        if (handled.has(turnId)) return;
        handled.add(turnId);
        decide(String(e.json?.transcript ?? ""), `Turn ${turnId}`);
      }
    };
    const res = await runner.run(`asr-realtime?${realtimeQuery({ mode, keywords: kw })}`, {
      base: "/api/docs",
      raw: { data: a.blob, contentType: "audio/wav" },
      stream: true,
      onEvent,
      record: false,
    });
    const said = current.turns.map((t) => t.transcript).join(" | ");
    recordRequest({
      method: "GET",
      path: "asr/realtime (WebSocket)",
      body: realtimeHandshake({ mode, keywords: kw }),
      status: res.status,
      outcome: current.error ? `error: ${current.error.message}` : said ? `speechComplete turns: ${said.slice(0, 180)}` : "no finished turns",
    });
  };

  const listenFile = async (a: PickedMedia) => {
    setReply(null);
    const form = new FormData();
    form.append("request", JSON.stringify(transcribeRequestPart({ mode, keywords: kw })));
    form.append("audio", a.blob, /\.wav$/i.test(a.name) ? a.name : "recording.wav");
    const res = await runner.run("asr/transcribe", { form });
    if (!res.ok) return;
    const json = res.json as { transcript?: string; turns?: Array<{ transcript?: string }> };
    setReply(json);
    const turns = (json.turns ?? []).map((t) => cleanHeard(t.transcript ?? "")).filter(Boolean);
    if (turns.length) turns.forEach((t, i) => decide(t, `Turn ${i}`));
    else decide(json.transcript ?? "", "Transcript");
  };

  const listen = () => {
    if (!audio) return;
    void (endpoint === "realtime" ? listenRealtime(audio) : listenFile(audio));
  };

  const reset = () => {
    const fresh = newGame(startPosition());
    gameRef.current = fresh;
    setGame(fresh);
    setDecisions([]);
  };

  const lastPlayed = decisions.find((d) => d.outcome.ok && !d.outcome.dryRun);
  const lastMove = lastPlayed?.outcome.ok ? lastPlayed.outcome.played.at(-1)?.move : game.history.at(-1);
  const dry = decisions[0]?.outcome.ok && decisions[0].outcome.dryRun ? decisions[0].outcome.played[0]?.move : null;
  const voice = running
    ? endpoint === "transcribe"
      ? "uploading"
      : !view.sessionId
        ? "connecting"
        : view.speaking
          ? "hearing speech"
          : "listening"
    : view.done || reply
      ? "finished"
      : "idle";
  const heard = view.partial || decisions[0]?.heard || "nothing yet";
  const seconds = audio?.durationMs ? Math.floor(audio.durationMs / 1000) : 0;

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <ModelSelect kind="voice" value="muse-voice-transcribe-1.0" onChange={() => {}} />
        <Segmented<Source>
          size="sm"
          label="Where the moves come from"
          value={source}
          onChange={setSource}
          disabled={running}
          options={[
            { value: "sample", label: "Sample" },
            { value: "mic", label: "Microphone" },
            { value: "type", label: "Type it (no audio)" },
          ]}
        />
      </div>

      <div className={styles.chessLayout}>
        <div className={styles.tight}>
          <dl className={styles.hud} aria-label="HUD">
            <div className={styles.hudCell}>
              <dt>VOICE</dt>
              <dd>{voice}</dd>
            </div>
            <div className={styles.hudCell}>
              <dt>TURN</dt>
              <dd>{game.position.turn === "w" ? "white" : "black"}{view.openTurn !== null && running ? ` · ${view.openTurn}` : ""}</dd>
            </div>
            <div className={`${styles.hudCell} ${styles.hudHeard}`}>
              <dt>HEARD</dt>
              <dd aria-live="polite">{heard}</dd>
            </div>
          </dl>
          <Chessboard position={game.position} last={lastMove ? { from: lastMove.from, to: lastMove.to } : null} preview={dry ? { from: dry.from, to: dry.to } : null} labels={labels} />
          <p className={styles.moveList} aria-label="Moves">
            {game.sans.length ? moveListText(game.sans) : "No moves yet."}
          </p>
          <div className={styles.row}>
            <button type="button" className="btn btn-outline btn-sm" onClick={reset} disabled={running || !game.history.length}>
              Reset the board
            </button>
            <span className="pg-advanced">
              <Toggle id={`${id}-labels`} label="Label every square" checked={labels} onChange={setLabels} />
            </span>
          </div>
        </div>

        <div className={styles.stack}>
          {source === "sample" ? (
            <FilePicker
              label="Audio"
              accept="audio/*,.wav,.mp3,.m4a"
              value={file}
              onChange={setFile}
              samples={["audio"]}
              defaultSampleId={sampleId}
              maxAudioSeconds={60}
              preview="full"
              disabled={running}
            />
          ) : source === "mic" ? (
            <AudioRecorder onRecorded={setTake} maxSeconds={30} disabled={running} label='Say a move, such as "Move E2 to E4"' />
          ) : (
            <div className={styles.tight}>
              <Field id={`${id}-typed`} label="What you'd say" hint="Runs the same parser on the text, without Muse Voice Transcribe. Free.">
                <TextInput id={`${id}-typed`} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={runOnModEnter(() => decide(typed, "Typed"))} />
              </Field>
              {phrases.length ? (
                <div className="pg-presets" role="group" aria-label="Try">
                  <span className="pg-presets-label" aria-hidden>
                    Try
                  </span>
                  {phrases.map((p, i) => (
                    <button key={`${i}-${p}`} type="button" className={`pg-pill${i >= 5 ? " pg-advanced" : ""}`} onClick={() => setTyped(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          {source === "sample" && file?.description ? <p className={`${styles.note} pg-advanced`}>About this sample: {file.description}</p> : null}
          {source === "sample" && file?.sampleId === "chess-moves" ? (
            <p className="pg-notice" role="note">
              <Icon name="info" size={16} className="pg-notice-icon" />
              <span>
                {grammar === "exact"
                  ? "This sample says piece moves (“Pawn to e4”), not the recipe’s “Move E2 to E4”, so with the exact grammar every finished turn is rejected and nothing moves: the recipe failing closed, as it should. Switch the grammar to Plus piece moves to watch the same audio play, or say or type “Move E2 to E4”."
                  : "This sample says piece moves (“Pawn to e4”), which only the demo’s wider grammar plays. The recipe itself would reject every turn: switch back to Exact to see it fail closed."}
              </span>
            </p>
          ) : null}

          {source !== "type" ? (
            <div className={`${styles.tight} pg-advanced`}>
              <span className={styles.control}>
                <span className={styles.label}>Endpoint</span>
                <Segmented<"realtime" | "transcribe">
                  size="sm"
                  label="Endpoint"
                  value={endpoint}
                  onChange={setEndpoint}
                  disabled={running}
                  options={[
                    { value: "realtime", label: "Realtime" },
                    { value: "transcribe", label: "One request" },
                  ]}
                />
              </span>
              <p className={styles.note}>
                {endpoint === "realtime"
                  ? "The recipe's path: wss://api.meta.ai/v1/asr/realtime in ENDPOINTING mode, so the model finds where each spoken move ends."
                  : "POST /v1/asr/transcribe in ENDPOINTING mode: the whole clip at once, then each returned turn is parsed in order."}
              </p>
              <Field id={`${id}-kw`} label="Vocabulary biasing (keywords)" hint="Nudges recognition toward these words. Try None to hear what the parser has to reject without it.">
                <TextInput id={`${id}-kw`} value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={running} />
              </Field>
              {keywordSets.length > 1 ? (
                <PresetPills
                  label="Keywords"
                  presets={keywordSets}
                  active={keywordSet}
                  onPick={(i) => {
                    setKeywordSet(i);
                    setKeywords(keywordSets[i].keywords.join(", "));
                  }}
                  disabled={running}
                />
              ) : null}
            </div>
          ) : null}

          <div className={styles.tight}>
            <span className={styles.control}>
              <span className={styles.label}>Grammar</span>
              <Segmented<Grammar>
                size="sm"
                label="Move grammar"
                value={grammar}
                onChange={setGrammar}
                options={[
                  { value: "exact", label: "Exact (the recipe)" },
                  { value: "pieces", label: "Plus piece moves" },
                ]}
              />
            </span>
            <div className={`${styles.row} pg-advanced`}>
              <Toggle id={`${id}-reply`} label="Black replies" checked={autoReply} onChange={setAutoReply} />
              <Toggle id={`${id}-dry`} label="Dry run (validate, move nothing)" checked={dryRun} onChange={setDryRun} />
            </div>
            <p className={`${styles.note} pg-advanced`}>
              {grammar === "exact"
                ? 'The recipe\'s grammar: a case-insensitive full match of "Move A1 to B2" with an optional trailing period, files A to H, ranks 1 to 8, two different squares. Nothing is repaired: spoken ranks, extra spaces or surrounding words reject the turn.'
                : 'The recipe\'s phrase, plus "Knight to f3", "Castle kingside" and several moves in one turn, as long as every word belongs to a move. A piece move that two pieces could make is ambiguous and rejected.'}
              {autoReply ? " Black's replies stand in for the Chess app's computer player: a short opening book, then the first legal move." : " You play both sides."}
            </p>
          </div>

          <div className={styles.row}>
            {source === "type" ? (
              <RunButton running={false} onRun={() => decide(typed, "Typed")} label="Parse and play" disabled={!typed.trim()} />
            ) : (
              <RunButton running={running} onRun={listen} onStop={runner.abort} label="Listen" disabled={!audio || (audio?.problems.length ?? 0) > 0} />
            )}
            <span className={styles.note}>
              {source === "type"
                ? "No API call."
                : `$0.18 per audio hour${seconds ? `: about ${formatUsd((seconds / 3600) * 0.18)} for ${formatDuration(audio!.durationMs!)}` : ""}.${endpoint === "realtime" ? " Realtime streams at real-time pace." : ""}`}
            </span>
          </div>
          <ErrorBox error={runner.error} />

          <div className={styles.tight}>
            <span className="pg-section-label">Decisions, newest first</span>
            {decisions.length ? (
              <ul className={styles.decisions} aria-live="polite">
                {decisions.map((d) => (
                  <li key={d.key} className={styles.decision} data-ok={!d.outcome.ok ? "false" : d.outcome.dryRun ? "dry" : "true"}>
                    <span>
                      <span className={styles.note}>{d.source}: </span>
                      <span className={styles.heard}>&ldquo;{d.heard}&rdquo;</span>
                    </span>
                    {d.outcome.ok ? (
                      <span>
                        {d.outcome.dryRun ? "Dry run, would play: " : "Played: "}
                        {d.outcome.played
                          .map((p) => (p.by === "you" ? `${p.san} (${coordinateLabel(p.move)})` : `Black ${p.san}`))
                          .join(", ")}
                      </span>
                    ) : (
                      <span>
                        <strong>Rejected, nothing moved.</strong>{" "}
                        {d.outcome.rejection.at !== undefined && d.outcome.commands.length > 1 ? `Move ${d.outcome.rejection.at + 1} of ${d.outcome.commands.length}: ` : ""}
                        {d.outcome.rejection.message}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.note}>Each finished turn shows here: what was heard, and what it played or why it was rejected.</p>
            )}
          </div>
        </div>
      </div>

      {source !== "type" && (running || runner.result) ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          model="muse-voice-transcribe-1.0"
          usage={{}}
          json={
            endpoint === "realtime"
              ? {
                  sessionId: view.sessionId,
                  turns: view.turns,
                  partial: view.partial,
                  events: view.events,
                  audioDurationMs: view.done ? Math.max(view.done.audioMs, view.done.processedMs) : view.processedMs,
                }
              : (reply ?? undefined)
          }
        >
          <p className={styles.note}>
            {endpoint === "realtime"
              ? `${view.events} events${view.sessionId ? ` in session ${view.sessionId}` : ""}: ${view.turns.length} finished turn${view.turns.length === 1 ? "" : "s"}. Partials only update the HUD; the decisions above came from finished turns.`
              : reply
                ? `Transcript: ${cleanHeard(reply.transcript ?? "") || "(no speech found)"}`
                : "Transcribing..."}
          </p>
        </ResponseView>
      ) : null}

      {source !== "type" ? (
        <>
          <div className="pg-actions">
            <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
          </div>
          {showCode ? (
            endpoint === "transcribe" ? (
              <CodeView
                method="POST"
                path="asr/transcribe"
                form={[
                  { name: "request", value: JSON.stringify(transcribeRequestPart({ mode, keywords: kw })) },
                  { name: "audio", value: audio?.name ?? "move.wav", file: { label: "Audio (16 kHz mono WAV)", accept: "audio/wav" } },
                ]}
                caption="The request Listen sends"
              />
            ) : (
              <div className={styles.tight}>
                <p className={styles.note}>
                  Realtime is a WebSocket session at wss://api.meta.ai/v1/asr/realtime: this handshake is the first text frame (the key travels in
                  it, so Muse Muse&apos;s server opens the socket for the demo), then 16-bit PCM in binary frames at real-time pace, then{" "}
                  {'{"type": "endStream"}'}.
                </p>
                <pre className={styles.raw}>{JSON.stringify(realtimeHandshake({ mode, keywords: kw, sampleRate: 16_000 }), null, 2)}</pre>
              </div>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
