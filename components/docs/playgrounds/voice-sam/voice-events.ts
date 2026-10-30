/**
 * Muse Voice Transcribe's server events folded into what a reader watches: the open partial, finished turns with
 * their speaker labels, progress, and an event timeline. One fold serves both streams the docs demos read: POST
 * /v1/asr/transcribe with `Accept: text/event-stream`, and Muse Muse's realtime relay (POST /api/docs/asr-realtime,
 * which adds `handshake` first and `done` last). The rules come from the pages themselves:
 *
 * - speech-to-text, "Detect speech turns": `speechStart`, `transcript` partials, `speechEnd`, then `speechComplete`
 *   with the turn's text. `speechEnd` is a boundary, not the transcript; turns can overlap, so state is keyed by
 *   `turnId`; partials carry no `turnId` and belong to the turn the latest `speechStart` opened.
 * - "Read partials and finals": CUMULATIVE partials replace the last one, DELTA partials are appended. PUSH_TO_TALK
 *   completes on `final: true` (in DELTA mode that event holds the whole transcript); ENDPOINTING and DIARIZATION
 *   complete each turn on `speechComplete`. In those modes the stream also ends with a `final: true` transcript event
 *   (empty in our tests), which must not become a turn of its own.
 * - "Label speakers": a `speaker` event labels the audio behind it, from the later of the last `speechStart` or
 *   `speaker` event, and there is one per turn.
 * - api-reference/voice/schemas, "Server Message": dispatch on `type` and ignore unknown values.
 */

export type VoiceMode = "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";
export type PartialMode = "CUMULATIVE" | "DELTA";

export const VOICE_MODES: readonly VoiceMode[] = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"];

export interface VoiceTurn {
  /** Null for PUSH_TO_TALK's single turn, which has no id on the wire. */
  turnId: number | null;
  transcript: string;
  speaker?: string;
  /** audioProcessedMs of speechStart, speechEnd and speechComplete: processing progress, not acoustic boundaries. */
  startMs?: number;
  endMs?: number;
  completeMs?: number;
  /** speechComplete (or the final transcript) has arrived. */
  done: boolean;
  /** The last partial heard for this turn, which the completed text may revise (punctuation, casing). */
  lastPartial?: string;
}

export interface SpeakerSpan {
  label: string;
  fromMs: number;
  toMs: number;
  turnId: number | null;
}

export interface VoiceTimelineEntry {
  /** Position in the stream, counting every event. */
  index: number;
  type: string;
  atMs?: number;
  turnId?: number;
  text?: string;
  label?: string;
  final?: boolean;
  /** The frame exactly as it arrived (the event's data), for views that print frames: every field, final included. */
  raw?: string;
}

/** One server-sent event as the fold reads it: its name, its data parsed, and the data as sent. */
export interface VoiceEventIn {
  event?: string | null;
  json: Record<string, unknown> | null;
  data?: string;
}

export interface VoiceView {
  mode: VoiceMode;
  partialMode: PartialMode;
  sessionId: string | null;
  /** What the model hears so far in the open turn. */
  partial: string;
  /** Turns in turnId order (PUSH_TO_TALK: the one final transcript). */
  turns: VoiceTurn[];
  /** The turn the latest speechStart opened, which partials belong to. */
  activeTurn: number | null;
  speakerSpans: SpeakerSpan[];
  /** Where the next speaker span starts: the later, in stream order, of the last speechStart or speaker event. */
  spanFromMs: number;
  processedMs: number;
  speaking: boolean;
  /** Events seen, by type ("handshake" and "done" included for the relay). */
  counts: Record<string, number>;
  /** Every event but audioProgress, in order, capped at TIMELINE_MAX. */
  timeline: VoiceTimelineEntry[];
  error: { message: string; code?: string; type?: string; param?: string; sessionId?: string } | null;
  /** The relay's last event: whether the session finished, the audio sent and processed, and the close code. */
  done: { ok: boolean; audioMs: number; processedMs: number; code: number | null } | null;
  /** The `final: true` transcript event's text, as sent. */
  finalText: string | null;
  events: number;
  /** Event types the docs don't list, counted and otherwise ignored. */
  unknown: number;
}

export const TIMELINE_MAX = 400;

export function emptyVoiceView(mode: VoiceMode = "PUSH_TO_TALK", partialMode: PartialMode = "CUMULATIVE"): VoiceView {
  return {
    mode,
    partialMode,
    sessionId: null,
    partial: "",
    turns: [],
    activeTurn: null,
    speakerSpans: [],
    spanFromMs: 0,
    processedMs: 0,
    speaking: false,
    counts: {},
    timeline: [],
    error: null,
    done: null,
    finalText: null,
    events: 0,
    unknown: 0,
  };
}

/** Transcripts can end with a zero-width space (docs/SPIKES.md) and often start with a space. */
export function cleanText(text: string): string {
  return text.replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const KNOWN = new Set(["transcript", "speechStart", "speechEnd", "speechComplete", "speaker", "audioProgress", "error"]);

/** The event's type: the JSON's own `type`, else the SSE event name, else "handshake" for the acknowledgement. */
export function voiceEventType(e: VoiceEventIn): string {
  const j = e.json ?? {};
  const type = str(j.type);
  if (type) return type;
  if (e.event === "handshake" || e.event === "done") return e.event;
  if (str(j.sessionId) && Object.keys(j).length === 1) return "handshake";
  return e.event ?? "message";
}

function upsertTurn(turns: VoiceTurn[], turnId: number | null, change: (t: VoiceTurn) => VoiceTurn): VoiceTurn[] {
  const at = turns.findIndex((t) => t.turnId === turnId);
  const base: VoiceTurn = at >= 0 ? turns[at] : { turnId, transcript: "", done: false };
  const next = change(base);
  const list = at >= 0 ? turns.map((t, i) => (i === at ? next : t)) : [...turns, next];
  return list.sort((a, b) => (a.turnId ?? -1) - (b.turnId ?? -1));
}

/** Folds one server-sent event into the view. Pure: returns a new view. */
export function voiceStep(view: VoiceView, e: VoiceEventIn): VoiceView {
  const j = e.json ?? {};
  const type = voiceEventType(e);
  const next: VoiceView = { ...view, events: view.events + 1, counts: { ...view.counts, [type]: (view.counts[type] ?? 0) + 1 } };
  const at = num(j.audioProcessedMs);
  if (at !== undefined) next.processedMs = Math.max(view.processedMs, at);
  const turnId = num(j.turnId);
  if (type !== "audioProgress" && view.timeline.length < TIMELINE_MAX) {
    const entry: VoiceTimelineEntry = { index: next.events, type };
    if (at !== undefined) entry.atMs = at;
    if (turnId !== undefined) entry.turnId = turnId;
    const text = str(j.transcript) ?? (type === "error" ? str(j.message) : undefined) ?? (type === "handshake" ? str(j.sessionId) : undefined);
    if (text !== undefined) entry.text = text;
    if (type === "speaker") entry.label = str(j.label);
    if (j.final === true) entry.final = true;
    const raw = typeof e.data === "string" && e.data ? e.data : e.json ? JSON.stringify(e.json) : undefined;
    if (raw !== undefined) entry.raw = raw;
    next.timeline = [...view.timeline, entry];
  }

  switch (type) {
    case "handshake":
      next.sessionId = str(j.sessionId) ?? view.sessionId;
      return next;
    case "done":
      next.done = { ok: j.ok === true, audioMs: num(j.audioMs) ?? 0, processedMs: num(j.processedMs) ?? 0, code: num(j.code) ?? null };
      next.sessionId = view.sessionId ?? str(j.sessionId) ?? null;
      return next;
    case "audioProgress":
      return next;
    case "transcript": {
      const t = str(j.transcript) ?? "";
      const final = j.final === true;
      if (!final) {
        next.partial = view.partialMode === "DELTA" ? view.partial + t : t;
        return next;
      }
      next.finalText = t;
      next.partial = "";
      if (view.mode === "PUSH_TO_TALK") {
        // In DELTA mode the final event carries the complete transcript, not one more piece.
        const text = cleanText(t) || cleanText(view.partial);
        next.turns = upsertTurn(view.turns, null, (turn) => ({ ...turn, transcript: text, done: true, completeMs: at, lastPartial: cleanText(view.partial) || undefined }));
      }
      return next;
    }
    case "speechStart": {
      const id = turnId ?? null;
      next.activeTurn = id;
      next.speaking = true;
      next.partial = "";
      next.spanFromMs = at ?? view.processedMs;
      next.turns = upsertTurn(view.turns, id, (turn) => ({ ...turn, startMs: turn.startMs ?? at }));
      return next;
    }
    case "speaker": {
      const label = str(j.label);
      if (!label) return next;
      // The span runs from whichever came later in the stream, the last speechStart or speaker event, to this one.
      const toMs = at ?? view.processedMs;
      next.speakerSpans = [...view.speakerSpans, { label, fromMs: view.spanFromMs, toMs, turnId: view.activeTurn }];
      next.spanFromMs = toMs;
      if (view.activeTurn !== null || view.mode !== "PUSH_TO_TALK") {
        next.turns = upsertTurn(view.turns, view.activeTurn, (turn) => ({ ...turn, speaker: label }));
      }
      return next;
    }
    case "speechEnd": {
      const id = turnId ?? view.activeTurn;
      if (id === view.activeTurn) next.speaking = false;
      next.turns = upsertTurn(view.turns, id ?? null, (turn) => ({ ...turn, endMs: at }));
      return next;
    }
    case "speechComplete": {
      const id = turnId ?? view.activeTurn ?? null;
      const mine = id === view.activeTurn;
      next.turns = upsertTurn(view.turns, id, (turn) => ({
        ...turn,
        transcript: cleanText(str(j.transcript) ?? ""),
        completeMs: at,
        done: true,
        lastPartial: mine && view.partial ? cleanText(view.partial) : turn.lastPartial,
      }));
      if (mine) next.partial = "";
      return next;
    }
    case "error":
      next.error = {
        message: str(j.message) ?? "The transcription stream failed.",
        code: str(j.code) ?? str(j.errorCode),
        type: str(j.errorType),
        param: str(j.errorParam),
        sessionId: str(j.sessionId),
      };
      return next;
    default:
      if (!KNOWN.has(type)) next.unknown = view.unknown + 1;
      return next;
  }
}

/** Folds a whole list of events. */
export function foldVoiceEvents(
  events: ReadonlyArray<VoiceEventIn>,
  mode: VoiceMode = "PUSH_TO_TALK",
  partialMode: PartialMode = "CUMULATIVE",
): VoiceView {
  return events.reduce(voiceStep, emptyVoiceView(mode, partialMode));
}

/** The transcript so far: finished turns in order, then the open partial. */
export function voiceText(view: VoiceView): string {
  const done = view.turns.filter((t) => t.done && t.transcript).map((t) => t.transcript);
  return [...done, cleanText(view.partial)].filter(Boolean).join(" ");
}

/** Turns as a reader should see them: finished ones, plus open ones that already have a boundary or a label. */
export function shownTurns(view: VoiceView): VoiceTurn[] {
  return view.turns.filter((t) => t.done || t.endMs !== undefined || t.speaker);
}

export interface PlainLine {
  speaker?: string;
  text: string;
}

/**
 * The `Accept: text/plain` reply (speech-to-text, "Choose another response format"): one turn per line in
 * ENDPOINTING, lines like `A:Hello` in DIARIZATION, where a turn the model never attributed reads `unknown:...`
 * (api-reference/voice/transcribe), and the transcript itself in PUSH_TO_TALK.
 */
export function parsePlainTranscript(text: string, mode: VoiceMode): PlainLine[] {
  const lines = text
    .replace(/\u200b/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (mode !== "DIARIZATION") return lines.map((l) => ({ text: l }));
  return lines.map((l) => {
    const m = /^([A-Za-z0-9_-]{1,16}):(.*)$/.exec(l);
    return m ? { speaker: m[1], text: m[2].trim() } : { text: l };
  });
}

/** Billed seconds: the audio processed, rounded down to whole seconds (speech-to-text, "Pricing"). */
export function billedSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

/** $0.18 per hour of audio processed. */
export function transcribeCostUsd(ms: number): number {
  return (billedSeconds(ms) / 3600) * 0.18;
}

/** Close codes as api-reference/voice/realtime lists them. */
export const CLOSE_CODES: Readonly<Record<number, { meaning: string; action: string }>> = {
  1000: { meaning: "Normal completion", action: "Finish after consuming the final result." },
  1008: {
    meaning: "Invalid request, or a streaming-policy failure such as backlog or below-real-time ingress",
    action: "Correct the configuration or the audio pacing. Retrying the same request fails again.",
  },
  1011: {
    meaning: "Internal or backend failure",
    action: "Retry with backoff. When the reason is Max session duration reached, open a new session.",
  },
  1013: { meaning: "Rate limited", action: "Back off before reconnecting." },
};
