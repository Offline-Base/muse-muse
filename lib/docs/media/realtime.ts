/**
 * Reading a realtime transcription stream as the docs describe it (speech-to-text, Detect speech turns and Label
 * speakers; api-reference/voice/schemas, Server Message): `transcript` partials replace each other under CUMULATIVE
 * and append under DELTA, `final: true` ends a PUSH_TO_TALK stream, `speechComplete` carries each turn's text in
 * ENDPOINTING and DIARIZATION, a `speaker` event labels the active turn, and partials carry no turnId. The docs relay
 * (POST /api/docs/asr-realtime) adds `handshake` first, `error` on a failure and `done` last.
 */

export interface RealtimeTurn {
  turnId: number | null;
  transcript: string;
  speaker?: string;
  startMs?: number;
  endMs?: number;
}

export interface RealtimeView {
  sessionId: string | null;
  /** The current partial: what the model hears so far in the open turn. */
  partial: string;
  /** Finished text: one entry per completed turn, or the final transcript in PUSH_TO_TALK. */
  turns: RealtimeTurn[];
  processedMs: number;
  speaking: boolean;
  error: { code?: string; message: string } | null;
  done: { ok: boolean; audioMs: number; processedMs: number; code: number | null } | null;
  events: number;
  /** The turn the latest speechStart opened, and the label a speaker event gave it. */
  openTurn: number | null;
  openStartMs?: number;
  openSpeaker?: string;
}

export const EMPTY_REALTIME: RealtimeView = {
  sessionId: null,
  partial: "",
  turns: [],
  processedMs: 0,
  speaking: false,
  error: null,
  done: null,
  events: 0,
  openTurn: null,
};

/** Transcripts can end with a zero-width space (docs/SPIKES.md). */
export function cleanTranscript(text: string): string {
  return text.replace(/​/g, "").trim();
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Folds one server-sent event into the view. Unknown event types are counted and otherwise ignored, as the docs ask. */
export function realtimeStep(
  view: RealtimeView,
  e: { event: string | null; json: Json | null },
  partialMode: "CUMULATIVE" | "DELTA" = "CUMULATIVE",
): RealtimeView {
  const j = e.json ?? {};
  const type = str(j.type) ?? e.event ?? "";
  const next: RealtimeView = { ...view, events: view.events + 1 };
  const at = num(j.audioProcessedMs);
  if (at !== undefined) next.processedMs = Math.max(next.processedMs, at);

  if (e.event === "handshake" || (type === "" && str(j.sessionId))) {
    next.sessionId = str(j.sessionId) ?? next.sessionId;
    return next;
  }
  if (e.event === "done") {
    next.done = { ok: j.ok === true, audioMs: num(j.audioMs) ?? 0, processedMs: num(j.processedMs) ?? 0, code: num(j.code) ?? null };
    return next;
  }
  switch (type) {
    case "transcript": {
      const t = str(j.transcript) ?? "";
      next.partial = partialMode === "DELTA" ? view.partial + t : t;
      if (j.final === true) {
        // In DELTA mode the final event holds the whole transcript, not one more piece (speech-to-text, partials).
        next.turns = [...view.turns, { turnId: view.openTurn, transcript: cleanTranscript(t), speaker: view.openSpeaker }];
        next.partial = "";
      }
      return next;
    }
    case "speechStart":
      next.speaking = true;
      next.openTurn = num(j.turnId) ?? null;
      next.openStartMs = at;
      next.openSpeaker = undefined;
      return next;
    case "speaker":
      next.openSpeaker = str(j.label) ?? next.openSpeaker;
      return next;
    case "speechEnd":
      next.speaking = false;
      return next;
    case "speechComplete": {
      const turnId = num(j.turnId) ?? null;
      const turn: RealtimeTurn = {
        turnId,
        transcript: cleanTranscript(str(j.transcript) ?? ""),
        speaker: turnId === view.openTurn ? view.openSpeaker : undefined,
        startMs: turnId === view.openTurn ? view.openStartMs : undefined,
        endMs: at,
      };
      // Turns can overlap and finish out of order, so key by turnId.
      const others = view.turns.filter((x) => x.turnId === null || x.turnId !== turnId);
      next.turns = [...others, turn].sort((a, b) => (a.turnId ?? 0) - (b.turnId ?? 0));
      next.partial = "";
      return next;
    }
    case "error":
      next.error = { code: str(j.code) ?? str(j.errorCode), message: str(j.message) ?? "The transcription stream failed." };
      return next;
    default:
      return next;
  }
}

/** The whole transcript so far: finished turns, then the open partial. */
export function realtimeText(view: RealtimeView): string {
  return [...view.turns.map((t) => t.transcript), cleanTranscript(view.partial)].filter(Boolean).join(" ");
}
