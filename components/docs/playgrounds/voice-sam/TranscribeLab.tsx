"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { AudioRecorder } from "@/components/docs/media/AudioRecorder";
import { FilePicker } from "@/components/docs/media/FilePicker";
import media from "@/components/docs/media/media.module.css";
import { GroupedPresets } from "@/components/docs/playgrounds/voice-sam/GroupedPresets";
import { SnippetTabs } from "@/components/docs/playgrounds/voice-sam/SnippetTabs";
import { pickSample } from "@/components/docs/playgrounds/voice-sam/pick-sample";
import { useVoiceRun } from "@/components/docs/playgrounds/voice-sam/useVoiceRun";
import {
  CLOSE_CODES,
  billedSeconds,
  cleanText,
  emptyVoiceView,
  parsePlainTranscript,
  shownTurns,
  transcribeCostUsd,
  voiceStep,
  voiceText,
  type PartialMode,
  type VoiceMode,
  type VoiceView,
} from "@/components/docs/playgrounds/voice-sam/voice-events";
import {
  ACCEPT_HEADER,
  VOICE_LANGUAGES,
  VOICE_MODEL,
  multipartPreview,
  presetEndpoint,
  realtimeHandshakeFrame,
  realtimeSnippets,
  relayQuery,
  splitList,
  transcribePath,
  transcribeRequestJson,
  transcribeSnippets,
  unknownLanguages,
  type VoiceAccept,
  type VoiceSettings,
} from "@/components/docs/playgrounds/voice-sam/voice-request";
import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import type { DocsResult, SseEvent } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import { formatDuration, MAX_REALTIME_SECONDS, MAX_TRANSCRIBE_SECONDS } from "@/lib/docs/media/audio";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { sampleById } from "@/lib/docs/media/samples";

export type VoiceEndpoint = "transcribe" | "realtime";

export interface TranscribePreset {
  label: string;
  /** Presets with the same group share a row of pills under that label. */
  group?: string;
  endpoint?: VoiceEndpoint;
  sampleId?: string;
  mode?: VoiceMode;
  accept?: VoiceAccept;
  keywords?: string[];
  languageBias?: string[];
  partialMode?: PartialMode;
  emitAudioProgress?: boolean;
  sessionId?: string;
  /** Sent as the request part instead of the settings, to show an error the API returns (a missing field). */
  requestOverride?: Record<string, unknown>;
  /** Sent as the Accept header instead of the three the API takes, to show its 406. */
  acceptOverride?: string;
  /** What to look for in the result. */
  note?: string;
}

export interface TranscribeLabProps {
  slug?: string;
  /** Endpoints offered; the first is where it starts. */
  endpoints?: VoiceEndpoint[];
  /** Reply formats offered for asr/transcribe (the Accept header). */
  accepts?: VoiceAccept[];
  presets?: TranscribePreset[];
  sampleId?: string;
  mode?: VoiceMode;
  modes?: VoiceMode[];
  accept?: VoiceAccept;
  keywords?: string[];
  languageBias?: string[];
  partialMode?: PartialMode;
  emitAudioProgress?: boolean;
  sessionId?: string;
  microphone?: boolean;
  /** "reference" opens with the HTTP exchange showing (request line, headers, both parts, the reply as it came). */
  view?: "guide" | "reference";
}

interface TranscribeReply {
  sessionId?: string;
  transcript?: string;
  audioDurationMs?: number;
  turns?: Array<{ turnId?: number; startMs?: number; endMs?: number; transcript?: string; speaker?: string }>;
}

interface Ran {
  endpoint: VoiceEndpoint;
  settings: VoiceSettings;
  request: Record<string, unknown>;
  accept: string;
  audio: { name: string; bytes: number; durationMs?: number };
}

const MODE_INFO: Record<VoiceMode, string> = {
  PUSH_TO_TALK: "Single-turn: the clip (or the stream until endStream) is the turn. Completes on a transcript with final: true.",
  ENDPOINTING: "The model finds each utterance's edges: one turn per detected speech segment, each completed by speechComplete.",
  DIARIZATION: "Speaker labels such as A and B on each turn. Not tuned for low-latency voice commands; use ENDPOINTING for those.",
};

const ACCEPT_INFO: Record<VoiceAccept, string> = {
  json: "One JSON response with the complete transcript and its turns.",
  sse: "Server-sent events in the realtime event format, as the audio is processed. No JSON summary at the end.",
  text: "Plain text: one turn per line in ENDPOINTING, lines such as A:Hello in DIARIZATION.",
};

const ACCEPT_LABEL: Record<VoiceAccept, string> = { json: "application/json", sse: "text/event-stream", text: "text/plain" };

const SAMPLE_IDS = ["speech-paragraph", "two-voices", "chess-moves"];

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Muse Voice Transcribe, everything speech-to-text and the Voice API reference teach: POST /v1/asr/transcribe with
 * the two-part multipart body and its three reply formats (the Accept header), the realtime WebSocket session through
 * Muse Muse's relay, the three modes, vocabulary and language biasing, CUMULATIVE and DELTA partials, audio progress
 * and the optional sessionId. Event streams are folded as they arrive (voice-events.ts) into partials, turns and
 * speaker labels, with the raw timeline beside them; "Show the HTTP exchange" prints the request and reply as sent.
 */
export function TranscribeLab({
  endpoints = ["transcribe", "realtime"],
  accepts = ["json", "sse", "text"],
  presets = [],
  sampleId = "speech-paragraph",
  mode: initialMode = "PUSH_TO_TALK",
  modes = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"],
  accept: initialAccept = "json",
  keywords: initialKeywords = [],
  languageBias: initialLanguages = [],
  partialMode: initialPartial = "CUMULATIVE",
  emitAudioProgress: initialProgress = true,
  sessionId: initialSession = "",
  microphone = true,
  view: initialView = "guide",
}: TranscribeLabProps) {
  const id = useId();
  const runner = useVoiceRun();
  const running = runner.state === "running";
  const [endpoint, setEndpoint] = useState<VoiceEndpoint>(endpoints[0] ?? "transcribe");
  const [source, setSource] = useState<"file" | "mic">("file");
  const [file, setFile] = useState<PickedMedia | null>(null);
  const [take, setTake] = useState<PickedMedia | null>(null);
  const [mode, setMode] = useState<VoiceMode>(initialMode);
  const [accept, setAccept] = useState<VoiceAccept>(accepts.includes(initialAccept) ? initialAccept : (accepts[0] ?? "json"));
  const [keywords, setKeywords] = useState(initialKeywords.join(", "));
  const [languages, setLanguages] = useState(initialLanguages.join(", "));
  const [partialMode, setPartialMode] = useState<PartialMode>(initialPartial);
  const [progress, setProgress] = useState(initialProgress);
  const [sessionId, setSessionId] = useState(initialSession);
  const [preset, setPreset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHttp, setShowHttp] = useState(initialView === "reference");
  const [showCode, setShowCode] = useState(false);
  const [showLanguages, setShowLanguages] = useState(false);
  const [ran, setRan] = useState<Ran | null>(null);
  const [view, setView] = useState<VoiceView>(emptyVoiceView());
  const viewRef = useRef<VoiceView>(view);
  const frame = useRef<number | null>(null);

  const audio = source === "mic" ? take : file;
  const maxSeconds = endpoint === "realtime" ? MAX_REALTIME_SECONDS : MAX_TRANSCRIBE_SECONDS;
  const tooLong = !!audio?.durationMs && audio.durationMs > maxSeconds * 1000;
  const active = preset !== null ? presets[preset] : null;
  const settings: VoiceSettings = useMemo(
    () => ({
      mode,
      keywords: splitList(keywords),
      languageBias: splitList(languages),
      partialMode,
      emitAudioProgress: progress,
      accept,
      sessionId,
    }),
    [mode, keywords, languages, partialMode, progress, accept, sessionId],
  );
  const requestPart = active?.requestOverride ?? transcribeRequestJson(settings);
  const acceptHeader = active?.acceptOverride ?? ACCEPT_HEADER[accept];
  const strange = unknownLanguages(settings.languageBias);
  const streaming = endpoint === "realtime" || accept === "sse";
  const sample = sampleById(audio?.sampleId ?? "");
  const suggested = (sample?.prompts ?? []).filter((p) => !settings.keywords.includes(p));

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  /** A manual change ends the preset, and with it any deliberately broken request it carried. */
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setPreset(null);
    set(v);
  };

  const applyPreset = async (i: number) => {
    const p = presets[i];
    if (!p) return;
    setPreset(i);
    const next = presetEndpoint(p, endpoints);
    if (next) setEndpoint(next);
    if (p.mode) setMode(p.mode);
    if (p.accept && accepts.includes(p.accept)) setAccept(p.accept);
    setKeywords((p.keywords ?? []).join(", "));
    setLanguages((p.languageBias ?? []).join(", "));
    setPartialMode(p.partialMode ?? "CUMULATIVE");
    setProgress(p.emitAudioProgress ?? true);
    setSessionId(p.sessionId ?? "");
    runner.reset();
    setRan(null);
    if (p.sampleId && p.sampleId !== file?.sampleId) {
      setSource("file");
      setLoading(true);
      try {
        const picked = await pickSample(p.sampleId, { maxAudioSeconds: MAX_TRANSCRIBE_SECONDS });
        if (picked) setFile(picked);
      } finally {
        setLoading(false);
      }
    } else if (p.sampleId) {
      setSource("file");
    }
  };

  const onEvent = useCallback((e: SseEvent) => {
    viewRef.current = voiceStep(viewRef.current, e);
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setView(viewRef.current);
      });
    }
  }, []);

  const finish = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setView(viewRef.current);
  };

  const run = async () => {
    if (!audio) return;
    const name = /\.wav$/i.test(audio.name) ? audio.name : "recording.wav";
    const shot: Ran = {
      endpoint,
      settings,
      request: endpoint === "realtime" ? realtimeHandshakeFrame(settings) : requestPart,
      accept: acceptHeader,
      audio: { name, bytes: audio.bytes, durationMs: audio.durationMs },
    };
    setRan(shot);
    viewRef.current = emptyVoiceView(mode, partialMode);
    setView(viewRef.current);

    if (endpoint === "realtime") {
      await runner.run(`asr-realtime?${relayQuery(settings)}`, {
        base: "/api/docs",
        raw: { data: audio.blob, contentType: "audio/wav" },
        onEvent,
        // A WebSocket session opens with a GET upgrade; its first frame, the handshake, is the body worth recording.
        // The relay's HTTP 200 isn't Meta's answer (the close code in the outcome is), so only a failed relay call keeps its status.
        record: (r) => ({
          method: "GET",
          path: "asr/realtime (WebSocket)",
          body: realtimeHandshakeFrame(settings),
          ...(r.ok ? {} : { status: r.status }),
          outcome: outcomeOfView(viewRef.current, r),
        }),
      });
      finish();
      return;
    }

    const form = new FormData();
    form.append("request", JSON.stringify(requestPart));
    form.append("audio", audio.blob, name);
    await runner.run(transcribePath(settings), {
      form,
      accept: acceptHeader,
      onEvent,
      record: (r) => ({
        method: "POST",
        path: transcribePath(settings),
        body: `multipart: request=${JSON.stringify(requestPart)}, audio=${name} (${kb(audio.bytes)}); Accept: ${acceptHeader}`,
        status: r.status,
        outcome: r.ok && accept === "sse" ? outcomeOfView(viewRef.current, r) : outcomeOfReply(r),
      }),
    });
    finish();
  };

  const result = runner.result;
  const reply = (result?.json ?? null) as TranscribeReply | null;
  const ranStream = ran?.endpoint === "realtime" || (ran?.accept === "text/event-stream" && result?.headers["content-type"]?.startsWith("text/event-stream"));
  const ranPlain = !!result?.ok && (result.headers["content-type"] ?? "").startsWith("text/plain");
  const ranMode = ran?.settings.mode ?? mode;
  const durationMs = audio?.durationMs ?? 0;
  const processedMs = view.done ? Math.max(view.done.audioMs, view.done.processedMs) : view.processedMs;

  // Streams and text/plain replies carry no audioDurationMs of their own: these summaries give the cost line the audio
  // processed (the events' progress, or the clip's length).
  const summary = ranStream
    ? { sessionId: view.sessionId, transcript: voiceText(view), audioDurationMs: processedMs, turns: shownTurns(view), events: view.counts }
    : ranPlain && ran?.audio.durationMs
      ? { reply: "text/plain, no JSON body", audioDurationMs: ran.audio.durationMs }
      : undefined;
  // A stream that ended on an error event failed, though its HTTP status was 200: the status shows it.
  const shownResult = result?.ok && view.error && !result.error ? { ...result, error: { code: view.error.code, message: view.error.message } } : result;

  return (
    <div className={styles.lab}>
      {presets.length ? <GroupedPresets presets={presets} active={preset} onPick={(i) => void applyPreset(i)} disabled={running || loading} /> : null}
      {active?.note ? <p className={`${styles.note} pg-advanced`}>{active.note}</p> : null}

      <div className={endpoints.length > 1 ? "pg-bar" : "pg-bar pg-advanced"}>
        {endpoints.length > 1 ? (
          <Segmented<VoiceEndpoint>
            label="Endpoint"
            value={endpoint}
            onChange={(v) => {
              setPreset(null);
              setEndpoint(v);
              runner.reset();
              setRan(null);
            }}
            disabled={running}
            options={endpoints.map((e) => ({ value: e, label: e === "transcribe" ? "File: POST asr/transcribe" : "Realtime: WS asr/realtime" }))}
          />
        ) : (
          <span className="pg-badge">{endpoint === "transcribe" ? "POST /v1/asr/transcribe" : "WS /v1/asr/realtime"}</span>
        )}
        <ModelSelect kind="voice" value={VOICE_MODEL} onChange={() => {}} />
      </div>

      {microphone ? (
        <div className="pg-advanced">
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
        </div>
      ) : null}
      {source === "file" ? (
        <FilePicker
          label="Audio"
          accept="audio/*,.wav,.mp3,.m4a"
          value={file}
          onChange={(f) => {
            setPreset(null);
            setFile(f);
          }}
          samples={SAMPLE_IDS}
          defaultSampleId={sampleId}
          maxAudioSeconds={MAX_TRANSCRIBE_SECONDS}
          disabled={running || loading}
        />
      ) : (
        <AudioRecorder onRecorded={setTake} maxSeconds={maxSeconds} disabled={running} />
      )}
      {source === "file" ? (
        <p className={`${media.hint} pg-advanced`}>The API takes mono 16-bit PCM WAV at 16 or 24 kHz only. Anything your browser plays is converted to 16 kHz mono WAV here first.</p>
      ) : null}
      {audio?.description ? <p className={`${styles.note} pg-advanced`}>What it says: {audio.description}</p> : null}

      <div className={`${styles.grid} pg-advanced`}>
        <div className={styles.stack}>
          <span className={styles.label} id={`${id}-mode`}>
            Mode
          </span>
          <Segmented<VoiceMode> size="sm" label="Mode" value={mode} onChange={edit(setMode)} disabled={running} options={modes.map((m) => ({ value: m, label: m }))} />
          <p className={styles.note}>{MODE_INFO[mode]}</p>
        </div>
        {endpoint === "transcribe" && accepts.length ? (
          <div className={styles.stack}>
            <span className={styles.label}>Reply format (Accept)</span>
            <Segmented<VoiceAccept>
              size="sm"
              label="Accept header"
              value={accept}
              onChange={edit(setAccept)}
              disabled={running}
              options={accepts.map((a) => ({ value: a, label: ACCEPT_LABEL[a] }))}
            />
            <p className={styles.note}>{ACCEPT_INFO[accept]}</p>
          </div>
        ) : (
          <div className={styles.stack}>
            <span className={styles.label}>Session</span>
            <p className={styles.note}>
              Muse Muse&apos;s server opens the WebSocket for this demo, since the key travels in the handshake frame: it sends the handshake,
              streams the WAV in 80 ms frames at real-time pace, sends endStream, and relays every server frame back as it arrives. Audio
              progress events stay on.
            </p>
          </div>
        )}
      </div>

      <div className={`${styles.grid} pg-advanced`}>
        <Field id={`${id}-kw`} label="Vocabulary biasing (keywords)" hint="Names, product terms and acronyms the model might mishear. Biasing doesn't guarantee a spelling.">
          <TextInput id={`${id}-kw`} value={keywords} placeholder="Acme Mobile, eSIM, 5G" onChange={(e) => edit(setKeywords)(e.target.value)} disabled={running} aria-describedby={`${id}-kw-hint`} />
        </Field>
        <Field
          id={`${id}-lb`}
          label="Language bias (languageBias)"
          hint={strange.length ? `Not in the 25 supported languages: ${strange.join(", ")}.` : "Language names, not free text. Omit it to let the model detect the language."}
        >
          <TextInput id={`${id}-lb`} value={languages} placeholder="English, French" onChange={(e) => edit(setLanguages)(e.target.value)} disabled={running} aria-describedby={`${id}-lb-hint`} />
        </Field>
      </div>
      {
        <div className={`${styles.row} pg-advanced`}>
          {suggested.length ? (
            <div className={media.chips} role="group" aria-label="Keywords for this sample">
              <span className={styles.note}>Add for this sample:</span>
              {suggested.map((k) => (
                <button key={k} type="button" className={media.chip} disabled={running} onClick={() => edit(setKeywords)([...settings.keywords, k].join(", "))}>
                  + {k}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="link-btn" onClick={() => setShowLanguages((s) => !s)} aria-expanded={showLanguages}>
            {showLanguages ? "Hide" : "Show"} the 25 languages
          </button>
        </div>
      }
      {showLanguages ? (
        <div className={`${media.chips} pg-advanced`} role="group" aria-label="Supported languages">
          {VOICE_LANGUAGES.map((l) => (
            <button
              key={l}
              type="button"
              className={`${media.chip} ${styles.pressable}`}
              aria-pressed={settings.languageBias.includes(l)}
              disabled={running}
              onClick={() =>
                edit(setLanguages)(
                  (settings.languageBias.includes(l) ? settings.languageBias.filter((x) => x !== l) : [...settings.languageBias, l]).join(", "),
                )
              }
            >
              {l}
            </button>
          ))}
        </div>
      ) : null}

      <div className={`${media.options} pg-advanced`}>
        {streaming ? (
          <span className={media.inline}>
            <span className={styles.label}>Partials</span>
            <Segmented<PartialMode>
              size="sm"
              label="Partial mode"
              value={partialMode}
              onChange={edit(setPartialMode)}
              disabled={running}
              options={[
                { value: "CUMULATIVE", label: "CUMULATIVE" },
                { value: "DELTA", label: "DELTA" },
              ]}
            />
          </span>
        ) : null}
        {endpoint === "transcribe" && accept === "sse" ? (
          <Toggle id={`${id}-progress`} label="Audio progress events" checked={progress} onChange={edit(setProgress)} disabled={running} />
        ) : null}
        {endpoint === "transcribe" ? (
          <span className={media.inline}>
            <label className={styles.label} htmlFor={`${id}-sid`}>
              sessionId
            </label>
            <TextInput
              id={`${id}-sid`}
              value={sessionId}
              placeholder="optional"
              onChange={(e) => edit(setSessionId)(e.target.value.slice(0, 80))}
              disabled={running}
              style={{ width: 200 }}
            />
          </span>
        ) : null}
      </div>
      {streaming ? (
        <p className={`${styles.note} pg-advanced`}>
          {partialMode === "CUMULATIVE"
            ? "CUMULATIVE: each partial is the whole current hypothesis and replaces the last one; it can revise earlier words."
            : "DELTA: each partial is only the new text, appended. The final: true event still holds the whole transcript."}
          {endpoint === "transcribe" && accept !== "sse" ? "" : " partialMode and emitAudioProgress change event streams only."}
        </p>
      ) : null}
      {mode !== "PUSH_TO_TALK" ? (
        <p className={`${styles.note} pg-advanced`}>
          Turns can come back empty in this mode too, so don&apos;t depend on them alone: the transcript always comes back.
        </p>
      ) : null}
      {active?.requestOverride || active?.acceptOverride ? (
        <p className={styles.warn}>
          <strong>This preset is rejected on purpose.</strong> It sends{" "}
          {active.acceptOverride ? <code>Accept: {active.acceptOverride}</code> : <code>request={JSON.stringify(active.requestOverride)}</code>}, so you
          can see the error the API returns. Failed requests aren&apos;t billed.
        </p>
      ) : null}

      <div className={media.spread}>
        <RunButton
          running={running}
          onRun={() => void run()}
          onStop={runner.abort}
          label={endpoint === "realtime" ? "Stream it" : "Transcribe"}
          disabled={!audio || tooLong || loading || (audio?.problems.length ?? 0) > 0}
        />
      </div>
      <p className={tooLong ? styles.note : `${styles.note} pg-advanced`}>
        {tooLong
          ? `This audio is longer than the ${maxSeconds} s this demo takes for ${endpoint === "realtime" ? "realtime" : "file transcription"}.`
          : `$0.18 per hour of audio, billed on what's processed and rounded down to whole seconds${
              durationMs ? `: about ${formatUsd(transcribeCostUsd(durationMs))} for this ${formatDuration(durationMs)} clip (${billedSeconds(durationMs)} s billed)` : ""
            }. Requests that fail before a transcript, and 429s, aren't billed.${endpoint === "realtime" ? " Realtime runs at real-time pace, so a clip takes as long as it lasts." : ""}`}
      </p>

      <ErrorBox error={runner.error} />
      {view.error && result?.ok ? (
        <ErrorBox error={{ code: view.error.code, type: view.error.type, message: `${view.error.message}${view.error.sessionId ? ` (session ${view.error.sessionId})` : ""}` }} />
      ) : null}

      {running || result ? (
        <ResponseView result={shownResult} running={running} elapsedMs={runner.elapsedMs} model={VOICE_MODEL} usage={{}} json={summary}>
          <div className={media.output} aria-live="polite">
            {ranStream ? (
              <StreamOutput view={view} durationMs={ran?.audio.durationMs ?? durationMs} running={running} realtime={ran?.endpoint === "realtime"} />
            ) : running ? (
              <p className={styles.note}>Transcribing...</p>
            ) : ranPlain && result ? (
              <PlainOutput text={result.text} mode={ranMode} />
            ) : result?.ok ? (
              <JsonOutput reply={reply} mode={ranMode} />
            ) : (
              <p className={styles.note}>No transcript: the request failed. The error above says why.</p>
            )}
          </div>
        </ResponseView>
      ) : null}

      {ranStream && (view.events > 0 || running) ? <Timeline view={view} /> : null}

      <div className="pg-actions">
        <Toggle id={`${id}-http`} label="Show the HTTP exchange" checked={showHttp} onChange={setShowHttp} />
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showHttp ? (
        <div className="pg-advanced">
          <HttpExchange endpoint={ran?.endpoint ?? endpoint} settings={ran?.settings ?? settings} request={ran?.request ?? requestPart} accept={ran?.accept ?? acceptHeader} audio={ran?.audio ?? (audio ? { name: audio.name, bytes: audio.bytes, durationMs: audio.durationMs } : null)} result={result} view={view} />
        </div>
      ) : null}
      {showCode ? (
        <div className="pg-advanced">
          {endpoint === "realtime" ? (
            <SnippetTabs
              snippets={realtimeSnippets(settings, audio?.name && /\.wav$/i.test(audio.name) ? audio.name : "recording.wav")}
              caption="A realtime client for these settings. The key goes in the handshake frame, not an Authorization header."
            />
          ) : (
            <SnippetTabs snippets={transcribeSnippets(settings, audio?.name && /\.wav$/i.test(audio.name) ? audio.name : "recording.wav")} caption="The request Transcribe sends, with its Accept header" />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** JSON with one field per line and short arrays kept on one line, for frames a reader scans. */
function compactJson(value: Record<string, unknown>): string {
  const lines = Object.entries(value).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${lines.join(",\n")}\n}`;
}

function outcomeOfReply(r: DocsResult): string {
  if (!r.ok) return `error ${r.status}: ${r.error?.message ?? ""}`.trim();
  const json = r.json as TranscribeReply | null;
  if (json && typeof json.transcript === "string") {
    const turns = json.turns ?? [];
    return `transcript: ${cleanText(json.transcript).slice(0, 160)}${turns.length ? ` | ${turns.length} turns${turns.some((t) => t.speaker) ? " with speaker labels" : ""}` : " | turns: []"}`;
  }
  return r.text ? `text/plain: ${r.text.replace(/\s+/g, " ").slice(0, 180)}` : `HTTP ${r.status}`;
}

/** What a stream did, for the copy prompt: Meta's events by type (not the relay's handshake and done), the text, the close. */
function outcomeOfView(v: VoiceView, r: DocsResult): string {
  if (!r.ok) return `error ${r.status}: ${r.error?.message ?? ""}`.trim();
  if (v.error) return `error event: ${v.error.message}`;
  const counts = Object.entries(v.counts)
    .filter(([k]) => k !== "audioProgress" && k !== "handshake" && k !== "done")
    .map(([k, n]) => `${k} x${n}`)
    .join(", ");
  const text = voiceText(v);
  return `events: ${counts || "none"}${text ? `; transcript: ${text.slice(0, 100)}` : ""}${v.done?.code ? `; closed with ${v.done.code}` : ""}`;
}

function JsonOutput({ reply, mode }: { reply: TranscribeReply | null; mode: VoiceMode }) {
  if (!reply) return <p className={styles.note}>The reply had no JSON body.</p>;
  const turns = reply.turns ?? [];
  return (
    <>
      <p className={media.live}>{cleanText(reply.transcript ?? "") || "(no speech found)"}</p>
      <ul className={styles.counts} aria-label="Reply fields">
        {reply.sessionId ? (
          <li className={styles.count}>
            sessionId <b>{reply.sessionId}</b>
          </li>
        ) : null}
        {typeof reply.audioDurationMs === "number" ? (
          <li className={styles.count}>
            audioDurationMs <b>{reply.audioDurationMs}</b> ({billedSeconds(reply.audioDurationMs)} s billed)
          </li>
        ) : null}
        <li className={styles.count}>
          turns <b>{turns.length}</b>
        </li>
      </ul>
      {turns.length ? (
        <TurnTable
          turns={turns.map((t) => ({ turnId: t.turnId ?? null, startMs: t.startMs, endMs: t.endMs, transcript: t.transcript ?? "", speaker: t.speaker }))}
          speakers={mode === "DIARIZATION" || turns.some((t) => t.speaker)}
        />
      ) : null}
      {!turns.length && mode !== "PUSH_TO_TALK" ? <p className={styles.note}>The turns array came back empty this time. The transcript above is still complete.</p> : null}
      {!turns.length && mode === "PUSH_TO_TALK" ? <p className={styles.note}>turns is empty in PUSH_TO_TALK: the clip is one turn. Try ENDPOINTING or DIARIZATION for turns.</p> : null}
    </>
  );
}

function TurnTable({
  turns,
  speakers,
}: {
  turns: Array<{ turnId: number | null; startMs?: number; endMs?: number; transcript: string; speaker?: string; lastPartial?: string }>;
  /** Show the speaker column: DIARIZATION, or any turn that came back labeled. */
  speakers: boolean;
}) {
  return (
    <div className={media.tableWrap}>
      <table className={`${media.table} ${styles.turnTable}`}>
        <thead>
          <tr>
            <th scope="col">turnId</th>
            <th scope="col">startMs to endMs</th>
            {speakers ? <th scope="col">speaker</th> : null}
            <th scope="col">transcript</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((t, i) => (
            <tr key={`${t.turnId ?? "x"}-${i}`}>
              <td>{t.turnId ?? "(none)"}</td>
              <td className={`${styles.mono} ${styles.nowrap}`}>
                {t.startMs ?? "?"} to {t.endMs ?? "?"}
              </td>
              {speakers ? <td>{t.speaker ? <span className={media.speaker}>{t.speaker}</span> : <span className={styles.empty}>none</span>}</td> : null}
              <td>
                {cleanText(t.transcript) || <span className={styles.empty}>(empty: the model gave this turn no text)</span>}
                {t.lastPartial && cleanText(t.lastPartial) !== cleanText(t.transcript) ? (
                  <div className={styles.revised}>Last partial: {t.lastPartial}</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlainOutput({ text, mode }: { text: string; mode: VoiceMode }) {
  const lines = parsePlainTranscript(text, mode);
  return (
    <>
      <pre className={styles.pre}>{text || "(empty)"}</pre>
      {mode === "DIARIZATION" && lines.some((l) => l.speaker) ? (
        <ol className={media.turns} aria-label="Lines by speaker">
          {lines.map((l, i) => (
            <li key={i} className={media.turn}>
              <span className={media.speaker} title="Speaker label">
                {l.speaker ?? "?"}
              </span>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <p className={styles.note}>
        {mode === "DIARIZATION"
          ? "Each line is speaker:text. A turn the model never attributed reads unknown:text."
          : mode === "ENDPOINTING"
            ? `One turn per line: ${lines.length} line${lines.length === 1 ? "" : "s"}.`
            : "PUSH_TO_TALK: the whole clip as one transcript."}
      </p>
    </>
  );
}

function StreamOutput({ view, durationMs, running, realtime }: { view: VoiceView; durationMs: number; running: boolean; realtime: boolean }) {
  const turns = shownTurns(view);
  const processed = view.done ? Math.max(view.done.audioMs, view.done.processedMs) : view.processedMs;
  const close = view.done?.code ? CLOSE_CODES[view.done.code] : null;
  return (
    <>
      <div className={media.progress} aria-hidden="true">
        <div className={media.progressFill} style={{ width: `${durationMs ? Math.min(100, (view.processedMs / durationMs) * 100) : 0}%` }} />
      </div>
      <p className={styles.note}>
        {view.sessionId ? `Session ${view.sessionId}. ` : running && realtime ? "Connecting and sending the handshake... " : ""}
        {formatDuration(processed)} of {formatDuration(durationMs)} processed{view.speaking ? ", hearing speech" : ""}
        {view.counts.audioProgress ? ` (${view.counts.audioProgress} audioProgress events)` : ""}.
      </p>
      {view.mode === "PUSH_TO_TALK" && turns.length ? (
        <p className={media.live}>{turns[0].transcript || "(no speech found)"}</p>
      ) : turns.length ? (
        <TurnTable turns={turns} speakers={view.mode === "DIARIZATION" || turns.some((t) => t.speaker)} />
      ) : null}
      {view.partial ? (
        <p className={`${media.live} ${media.partial}`} aria-label="Current partial">
          {cleanText(view.partial)}
        </p>
      ) : null}
      {!running && !turns.length && !view.partial && !view.error ? <p className={styles.note}>No speech came back.</p> : null}
      {view.done ? (
        <p className={styles.note}>
          {view.done.ok ? "Done." : "Ended early."} {formatDuration(view.done.audioMs)} of audio sent
          {view.done.code ? `; the socket closed with ${view.done.code}${close ? ` (${close.meaning})` : ""}` : ""}.
        </p>
      ) : null}
    </>
  );
}

function Timeline({ view }: { view: VoiceView }) {
  const counts = Object.entries(view.counts);
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [view.timeline.length]);
  return (
    <section className={styles.card} aria-label="Server events">
      <p className={styles.cardTitle}>Server events, in order</p>
      <ul className={styles.counts}>
        {counts.map(([type, n]) => (
          <li key={type} className={styles.count}>
            {type} <b>{n}</b>
          </li>
        ))}
        {view.unknown ? (
          <li className={styles.count}>
            unknown, ignored <b>{view.unknown}</b>
          </li>
        ) : null}
      </ul>
      <ol
        ref={list}
        className={styles.timeline}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {view.timeline.map((e) => (
          <li key={e.index}>
            <span className={styles.ms}>{e.atMs !== undefined ? `${e.atMs} ms` : ""}</span>
            <span className={`${styles.evType} ${styles[`ev-${e.type}`] ?? ""}`}>
              {e.type}
              {e.turnId !== undefined ? ` #${e.turnId}` : ""}
            </span>
            <span className={styles.evText}>
              {e.type === "speaker" ? `label ${e.label}` : e.text !== undefined ? (e.text ? JSON.stringify(e.text) : '""') : ""}
              {e.final ? " (final: true)" : ""}
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.note}>
        audioProgress events are counted, not listed. audioProcessedMs is processing progress, not a word timestamp. Partials carry no turnId:
        each belongs to the turn the latest speechStart opened.
      </p>
    </section>
  );
}

function HttpExchange({
  endpoint,
  settings,
  request,
  accept,
  audio,
  result,
  view,
}: {
  endpoint: VoiceEndpoint;
  settings: VoiceSettings;
  request: Record<string, unknown>;
  accept: string;
  audio: { name: string; bytes: number; durationMs?: number } | null;
  result: DocsResult | null;
  view: VoiceView;
}) {
  if (endpoint === "realtime") {
    const frames = audio?.durationMs ? Math.ceil(audio.durationMs / 80) : null;
    // Each frame as Meta sent it (the relay forwards it unchanged), so every field shows: final, sessionId on errors.
    const serverFrames = view.timeline
      .filter((e) => e.type !== "done")
      .slice(0, 40)
      .map((e) => {
        const frame = e.raw ?? JSON.stringify(e.type === "handshake" ? { sessionId: e.text ?? "" } : { type: e.type });
        return e.type === "handshake" ? `${frame}   <- the acknowledgement, the only frame without a type` : frame;
      });
    return (
      <div className={styles.split}>
        <section className={styles.stack} aria-label="Client frames">
          <p className={styles.cardTitle}>Client frames</p>
          <pre className={styles.pre}>
            {[
              "GET wss://api.meta.ai/v1/asr/realtime?sessionId=<optional> (WebSocket upgrade)",
              "",
              "1. text frame, within 10 s of connecting:",
              compactJson({ ...request, authorization: { accessToken: "Bearer $MODEL_API_KEY" } }),
              "",
              `2. ${frames ? `${frames} binary frames` : "binary frames"} of raw PCM, 80 ms each (2,560 bytes at 16 kHz), paced at real time`,
              "",
              '3. text frame: {"type":"endStream"}, then nothing more; keep reading until the server closes with 1000',
            ].join("\n")}
          </pre>
        </section>
        <section className={styles.stack} aria-label="Server frames">
          <p className={styles.cardTitle}>Server frames{view.done?.code ? `, then close ${view.done.code}` : ""}</p>
          <pre className={styles.pre}>{serverFrames.length ? `${serverFrames.join("\n")}${view.timeline.length > 41 ? "\n..." : ""}` : "Run it to see the frames. audioProgress frames are left out here."}</pre>
          {serverFrames.length ? <p className={styles.note}>Each frame as Meta sent it, passed on unchanged by Muse Muse&apos;s relay. audioProgress frames are left out.</p> : null}
        </section>
      </div>
    );
  }
  const preview = multipartPreview({ path: transcribePath(settings), accept, request }, audio);
  const contentType = result?.headers["content-type"] ?? "";
  const body = !result
    ? ""
    : result.json
      ? JSON.stringify(result.json, null, 2)
      : result.text.length > 6000
        ? `${result.text.slice(0, 6000)}\n... (${(result.text.length - 6000).toLocaleString("en-US")} more characters)`
        : result.text;
  return (
    <div className={styles.split}>
      <section className={styles.stack} aria-label="Request">
        <p className={styles.cardTitle}>Request</p>
        <pre className={styles.pre}>{preview}</pre>
        <p className={styles.note}>The boundary is illustrative. Muse Muse&apos;s proxy adds the key on the server; your code sends its own.</p>
      </section>
      <section className={styles.stack} aria-label="Response">
        <p className={styles.cardTitle}>Response</p>
        <pre className={styles.pre}>
          {result
            ? [
                `HTTP/1.1 ${result.status}`,
                ...(contentType ? [`content-type: ${contentType}`] : []),
                ...(result.headers["x-docs-model"] ? [`x-docs-model: ${result.headers["x-docs-model"]}`] : []),
                "",
                body || "(no body)",
              ].join("\n")
            : "Run it to see the reply as it came back."}
        </pre>
      </section>
    </div>
  );
}
