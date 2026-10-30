"use client";

import { useId, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { AudioRecorder } from "@/components/docs/media/AudioRecorder";
import { FilePicker } from "@/components/docs/media/FilePicker";
import styles from "@/components/docs/media/media.module.css";
import type { SseEvent } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { formatDuration, MAX_REALTIME_SECONDS, MAX_TRANSCRIBE_SECONDS } from "@/lib/docs/media/audio";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { EMPTY_REALTIME, cleanTranscript, realtimeStep, realtimeText, type RealtimeView } from "@/lib/docs/media/realtime";
import { commaList, realtimeHandshake, realtimeQuery, transcribeRequestPart, type TranscribeMode } from "@/lib/docs/media/requests";

export type TranscribeEndpoint = "transcribe" | "realtime";

export interface TranscribePlaygroundProps {
  slug?: string;
  /** "transcribe" (POST /v1/asr/transcribe, one request) and "realtime" (the WebSocket session, relayed). First is the start. */
  endpoints?: TranscribeEndpoint[];
  /** The audio sample picked on load. Defaults to the spoken paragraph. */
  sampleId?: string;
  /** Offer the microphone next to files and samples. Default true. */
  microphone?: boolean;
  mode?: TranscribeMode;
  /** Modes offered. Defaults to all three. */
  modes?: TranscribeMode[];
  /** Vocabulary biasing terms to start with. */
  keywords?: string[];
  languageBias?: string[];
  /** Realtime partials: CUMULATIVE replaces, DELTA appends. */
  partialMode?: "CUMULATIVE" | "DELTA";
}

const ENDPOINT_LABEL: Record<TranscribeEndpoint, string> = {
  transcribe: "File (asr/transcribe)",
  realtime: "Realtime (asr/realtime)",
};

const MODE_LABEL: Record<TranscribeMode, string> = {
  PUSH_TO_TALK: "PUSH_TO_TALK",
  ENDPOINTING: "ENDPOINTING",
  DIARIZATION: "DIARIZATION",
};

interface TranscribeReply {
  sessionId?: string;
  transcript?: string;
  audioDurationMs?: number;
  turns?: Array<{ turnId?: number; startMs?: number; endMs?: number; transcript?: string; speaker?: string }>;
}

const usd = (ms: number) => formatUsd((Math.floor(ms / 1000) / 3600) * 0.18);

/**
 * Muse Voice Transcribe from a sample, a file or the microphone. File mode sends the two-part multipart request to
 * asr/transcribe; realtime mode posts the WAV to Muse Muse's relay, which streams it to the WebSocket endpoint at
 * real-time pace and passes every partial, turn and speaker event back as it arrives. Audio is converted to 16 kHz
 * mono 16-bit WAV in the browser first, the only format the API takes.
 */
export function TranscribePlayground({
  endpoints = ["transcribe", "realtime"],
  sampleId = "speech-paragraph",
  microphone = true,
  mode: initialMode = "PUSH_TO_TALK",
  modes = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"],
  keywords: initialKeywords = [],
  languageBias: initialLanguages = [],
  partialMode: initialPartial = "CUMULATIVE",
}: TranscribePlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const { recordRequest } = useDocsPage();
  const [endpoint, setEndpoint] = useState<TranscribeEndpoint>(endpoints[0] ?? "transcribe");
  const [source, setSource] = useState<"file" | "mic">("file");
  const [file, setFile] = useState<PickedMedia | null>(null);
  const [take, setTake] = useState<PickedMedia | null>(null);
  const [mode, setMode] = useState<TranscribeMode>(initialMode);
  const [keywords, setKeywords] = useState(initialKeywords.join(", "));
  const [languages, setLanguages] = useState(initialLanguages.join(", "));
  const [partialMode, setPartialMode] = useState(initialPartial);
  const [view, setView] = useState<RealtimeView>(EMPTY_REALTIME);
  const [log, setLog] = useState<string[]>([]);
  const running = runner.state === "running";
  const audio = source === "mic" ? take : file;
  const maxSeconds = endpoint === "realtime" ? MAX_REALTIME_SECONDS : MAX_TRANSCRIBE_SECONDS;
  const tooLong = !!audio?.durationMs && audio.durationMs > maxSeconds * 1000;
  const settings = { mode, keywords: commaList(keywords), languageBias: commaList(languages) };

  const requestPart = transcribeRequestPart(settings);
  const form = [
    { name: "request", value: JSON.stringify(requestPart) },
    { name: "audio", value: audio?.name ?? "recording.wav", file: { label: "Audio (16 kHz mono WAV)", accept: "audio/wav" } },
  ];

  const runTranscribe = async (a: PickedMedia) => {
    const body = new FormData();
    body.append("request", JSON.stringify(requestPart));
    body.append("audio", a.blob, /\.wav$/i.test(a.name) ? a.name : "recording.wav");
    await runner.run("asr/transcribe", { form: body });
  };

  const runRealtime = async (a: PickedMedia) => {
    setView(EMPTY_REALTIME);
    setLog([]);
    let current = EMPTY_REALTIME;
    const onEvent = (e: SseEvent) => {
      current = realtimeStep(current, e, partialMode);
      setView(current);
      setLog((l) => [...l.slice(-199), `${e.event ?? "message"}: ${e.data.slice(0, 160)}`]);
    };
    const res = await runner.run(`asr-realtime?${realtimeQuery({ ...settings, partialMode })}`, {
      base: "/api/docs",
      raw: { data: a.blob, contentType: "audio/wav" },
      stream: true,
      onEvent,
      record: false,
    });
    // Recorded by hand: the relay's path isn't Meta's, and the outcome is the transcript, known only now.
    const text = realtimeText(current);
    recordRequest({
      // A WebSocket session opens with a GET upgrade; the body is its first frame, the handshake.
      method: "GET",
      path: "asr/realtime (WebSocket)",
      body: realtimeHandshake({ ...settings, partialMode }),
      status: res.status,
      outcome: current.error ? `error: ${current.error.message}` : text ? `transcript: ${text.slice(0, 180)}` : `${current.events} events, no transcript`,
    });
  };

  const run = () => {
    if (!audio) return;
    void (endpoint === "realtime" ? runRealtime(audio) : runTranscribe(audio));
  };

  const reply = (runner.result?.json ?? null) as TranscribeReply | null;
  const transcript = reply?.transcript ? cleanTranscript(reply.transcript) : "";
  const turns = reply?.turns ?? [];
  const realtimeMs = audio?.durationMs ?? 0;

  return (
    <div className={`pg ${styles.playground}`}>
      <div className="pg-bar">
        {endpoints.length > 1 ? (
          <Segmented
            label="Endpoint"
            value={endpoint}
            onChange={(v) => {
              setEndpoint(v);
              runner.reset();
              setView(EMPTY_REALTIME);
            }}
            disabled={running}
            options={endpoints.map((e) => ({ value: e, label: ENDPOINT_LABEL[e] }))}
          />
        ) : null}
        <ModelSelect kind="voice" value="muse-voice-transcribe-1.0" onChange={() => {}} />
      </div>
      {microphone ? (
        <Segmented<"file" | "mic">
          size="sm"
          label="Audio source"
          value={source}
          onChange={setSource}
          disabled={running}
          options={[
            { value: "file", label: "Sample or file" },
            { value: "mic", label: "Microphone" },
          ]}
        />
      ) : null}
      {source === "file" ? (
        <FilePicker
          label="Audio"
          accept="audio/*,.wav,.mp3,.m4a"
          value={file}
          onChange={setFile}
          samples={["audio"]}
          defaultSampleId={sampleId}
          maxAudioSeconds={MAX_TRANSCRIBE_SECONDS}
          hint="Any audio your browser plays works: it's converted to 16 kHz mono 16-bit WAV here, the only format Muse Voice Transcribe takes."
          disabled={running}
        />
      ) : (
        <AudioRecorder onRecorded={setTake} maxSeconds={maxSeconds} disabled={running} />
      )}
      {audio?.description ? <p className={styles.note}>About this sample: {audio.description}</p> : null}

      <div className={styles.options}>
        <span className={styles.inline}>
          <span className={styles.label}>Mode</span>
          <Segmented<TranscribeMode> size="sm" label="Mode" value={mode} onChange={setMode} disabled={running} options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        </span>
        {endpoint === "realtime" ? (
          <span className={styles.inline}>
            <span className={styles.label}>Partials</span>
            <Segmented<"CUMULATIVE" | "DELTA">
              size="sm"
              label="Partial mode"
              value={partialMode}
              onChange={setPartialMode}
              disabled={running}
              options={[
                { value: "CUMULATIVE", label: "CUMULATIVE" },
                { value: "DELTA", label: "DELTA" },
              ]}
            />
          </span>
        ) : null}
      </div>
      <div className={styles.row}>
        <Field id={`${id}-kw`} label="Keywords (comma separated)" hint="Biases recognition toward these terms.">
          <TextInput id={`${id}-kw`} value={keywords} placeholder="Acme Mobile, eSIM, 5G" onChange={(e) => setKeywords(e.target.value)} disabled={running} />
        </Field>
        <Field id={`${id}-lb`} label="Language bias" hint="Language names, such as English, French.">
          <TextInput id={`${id}-lb`} value={languages} placeholder="English" onChange={(e) => setLanguages(e.target.value)} disabled={running} />
        </Field>
      </div>
      {mode === "DIARIZATION" || mode === "ENDPOINTING" ? (
        <p className={styles.note}>
          {mode === "DIARIZATION" ? "Speaker labels" : "Speech turns"} come back in turns (file) or as events (realtime). In our tests,
          file transcription&apos;s turns stayed empty even for two clear voices, so don&apos;t count on them; the transcript always comes back.
        </p>
      ) : null}

      <div className={styles.spread}>
        <RunButton
          running={running}
          onRun={run}
          onStop={runner.abort}
          label={endpoint === "realtime" ? "Stream" : "Transcribe"}
          disabled={!audio || tooLong || (audio?.problems.length ?? 0) > 0}
        />
      </div>
      <p className={styles.note}>
        {tooLong
          ? `This audio is longer than the ${maxSeconds} s this demo takes for ${endpoint === "realtime" ? "realtime" : "file transcription"}.`
          : `$0.18 per hour of audio${audio?.durationMs ? `: about ${usd(audio.durationMs)} for this ${formatDuration(audio.durationMs)} clip` : ""}.` +
            (endpoint === "realtime" ? " Realtime sends the audio at real-time pace, so a clip takes as long as it runs." : "")}
      </p>

      <ErrorBox error={runner.error} />

      {endpoint === "realtime" && (running || runner.result) ? (
        <ResponseView
          result={runner.result}
          running={running}
          elapsedMs={runner.elapsedMs}
          model="muse-voice-transcribe-1.0"
          usage={{}}
          json={{
            sessionId: view.sessionId,
            transcript: realtimeText(view),
            turns: view.turns,
            audioDurationMs: view.done ? Math.max(view.done.audioMs, view.done.processedMs) : view.processedMs,
            events: view.events,
          }}
        >
          <div className={styles.output} aria-live="polite">
            <div className={styles.progress} aria-hidden="true">
              <div className={styles.progressFill} style={{ width: `${realtimeMs ? Math.min(100, (view.processedMs / realtimeMs) * 100) : 0}%` }} />
            </div>
            <p className={styles.note}>
              {view.sessionId ? `Session ${view.sessionId}. ` : running ? "Connecting... " : ""}
              {formatDuration(view.processedMs)} of {formatDuration(realtimeMs)} processed{view.speaking ? ", hearing speech" : ""}.
            </p>
            {view.turns.length ? (
              <ol className={styles.turns}>
                {view.turns.map((t, i) => (
                  <li key={`${t.turnId ?? "f"}-${i}`} className={styles.turn}>
                    <span className={styles.speaker} title={t.speaker ? "Speaker label" : "Turn"}>
                      {t.speaker ?? t.turnId ?? i + 1}
                    </span>
                    <span>{t.transcript}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {view.partial ? <p className={`${styles.live} ${styles.partial}`}>{cleanTranscript(view.partial)}</p> : null}
            {!running && !view.turns.length && !view.partial && !view.error ? <p className={styles.note}>No speech came back.</p> : null}
            {view.error ? <p className={styles.problem}>{view.error.message}</p> : null}
            {view.done ? (
              <p className={styles.note}>
                {view.done.ok ? "Done." : "Ended early."} {formatDuration(view.done.audioMs)} of audio sent, about{" "}
                {usd(Math.max(view.done.audioMs, view.done.processedMs))}.
              </p>
            ) : null}
            <details className={styles.events}>
              <summary>{view.events} events</summary>
              <pre className={styles.raw}>{log.join("\n")}</pre>
            </details>
          </div>
        </ResponseView>
      ) : null}

      {endpoint === "transcribe" && (running || runner.result) ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} usage={{}}>
          {running ? (
            <p className={styles.note}>Transcribing...</p>
          ) : (
            <div className={styles.output}>
              {runner.result?.ok ? <p className={styles.live}>{transcript || "(no speech found)"}</p> : null}
              {reply?.audioDurationMs ? <p className={styles.note}>audioDurationMs: {reply.audioDurationMs}{reply.sessionId ? ` · sessionId: ${reply.sessionId}` : ""}</p> : null}
              {turns.length ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Turn</th>
                        <th>Time</th>
                        <th>Speaker</th>
                        <th>Transcript</th>
                      </tr>
                    </thead>
                    <tbody>
                      {turns.map((t, i) => (
                        <tr key={t.turnId ?? i}>
                          <td>{t.turnId}</td>
                          <td>
                            {formatDuration(t.startMs ?? 0)} to {formatDuration(t.endMs ?? 0)}
                          </td>
                          <td>{t.speaker ?? ""}</td>
                          <td>{cleanTranscript(t.transcript ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : mode !== "PUSH_TO_TALK" && runner.result?.ok ? (
                <p className={styles.note}>The turns array came back empty, as in our tests. The transcript above is complete.</p>
              ) : null}
            </div>
          )}
        </ResponseView>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {!showCode ? null : endpoint === "transcribe" ? (
        <CodeView method="POST" path="asr/transcribe" form={form} caption="The request Run sends" />
      ) : (
        <div className={styles.stack}>
          <p className={styles.note}>
            Realtime is a WebSocket session: the handshake below is the first text frame, then raw 16-bit PCM in binary frames at real-time
            pace, then {"{"}&quot;type&quot;: &quot;endStream&quot;{"}"}. The key travels in the handshake, so Muse Muse&apos;s server opens the socket
            for this demo.
          </p>
          <pre className={styles.raw}>{JSON.stringify(realtimeHandshake({ ...settings, partialMode, sampleRate: 16_000 }), null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
