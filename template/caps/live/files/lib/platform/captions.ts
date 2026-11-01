"use client";
// Platform file (Muse Muse platform services). Don't edit: call useCaptions from a client component.
//
//   const { captions, text, status, error, start, stop, clear } = useCaptions();
//
// Near-live captions: records the microphone, sends a piece of 2 to 3 seconds at a time to the platform's own
// /api/musemuse/live-caption route, and gives back [{ text, startMs, endMs }], so text appears a few seconds behind.
// start() must come from the person's click, since the browser asks for the microphone then. Show CAPTIONS_NOTICE next to
// the button. It isn't a voice conversation: nothing talks back.
import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav, toWav16k } from "@/lib/client/wav";
import { addCaption, ChunkCutter, isSilent, type AudioPiece, type Caption } from "@/lib/platform/captions-chunks";

export type { Caption } from "@/lib/platform/captions-chunks";

/** What the page must say near the button, before anyone clicks it. */
export const CAPTIONS_NOTICE = "Audio goes to Muse Voice Transcribe to make these captions. This app doesn't keep it.";

export type CaptionStatus = "idle" | "starting" | "listening" | "stopped" | "limit" | "error";

export interface UseCaptions {
  /** Each piece of text with where it falls in the recording, in milliseconds. */
  captions: Caption[];
  /** All the captions as one text. */
  text: string;
  status: CaptionStatus;
  /** Plain words to show as they are, or null. */
  error: string | null;
  start(): Promise<void>;
  stop(): void;
  clear(): void;
}

export interface CaptionOptions {
  /** New audio in each piece, 2000 to 3000 ms. */
  chunkMs?: number;
  /** The route that takes a piece. The platform's own by default. */
  endpoint?: string;
}

const ENDPOINT = "/api/musemuse/live-caption";
/** Pieces waiting for their turn. Past this the oldest goes, so text stays near the speaker on a slow connection. */
const MOST_WAITING = 3;
/** Failures in a row before captions stop and say so. */
const MOST_FAILURES = 3;

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked. Allow it in the browser's settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  return "The microphone couldn't start. Try again.";
}

interface Session {
  id: string;
  stream: MediaStream;
  context: AudioContext;
  node: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  cutter: ChunkCutter;
  waiting: AudioPiece[];
  sending: boolean;
  failures: number;
  ended: boolean;
}

/** What a start() under way holds so far, so Stop and leaving can turn it off even if the start never gets further. */
interface Starting {
  stream: MediaStream | null;
  context: AudioContext | null;
}

function letGo(held: Starting) {
  held.stream?.getTracks().forEach((t) => t.stop());
  void held.context?.close().catch(() => undefined);
}

const newSessionId = () => (crypto.randomUUID?.() ?? `s${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

export function useCaptions(options: CaptionOptions = {}): UseCaptions {
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [status, setStatus] = useState<CaptionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  // The start() under way, from the click until the session exists. Stop, leaving and a second click all look at this.
  const starting = useRef<Starting | null>(null);
  const endpoint = options.endpoint ?? ENDPOINT;
  const chunkMs = options.chunkMs;

  const release = useCallback((s: Session) => {
    s.ended = true;
    s.node.onaudioprocess = null;
    s.source.disconnect();
    s.node.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    void s.context.close().catch(() => undefined);
  }, []);

  /** One piece at a time, in order, so captions never arrive out of turn. */
  const drain = useCallback(
    async (s: Session) => {
      if (s.sending) return;
      s.sending = true;
      try {
        while (s.waiting.length) {
          const piece = s.waiting.shift()!;
          const wav = await toWav16k(encodeWav(piece.samples, s.context.sampleRate));
          const query = new URLSearchParams({ session: s.id, startMs: String(piece.startMs), endMs: String(piece.endMs) });
          const res = await fetch(`${endpoint}?${query}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav }).catch(() => null);
          const reply = ((await res?.json().catch(() => null)) ?? {}) as { text?: unknown; error?: unknown; code?: unknown };
          if (res?.ok && typeof reply.text === "string") {
            s.failures = 0;
            setCaptions((list) => addCaption(list, { text: reply.text as string, startMs: piece.startMs, endMs: piece.endMs }));
            continue;
          }
          if (reply.code === "quota_exceeded" || res?.status === 403) {
            if (session.current === s) session.current = null;
            if (!s.ended) release(s);
            s.waiting.length = 0;
            setStatus(reply.code === "quota_exceeded" ? "limit" : "error");
            setError(typeof reply.error === "string" ? reply.error : "Captions aren't available right now.");
            return;
          }
          // Too many at once on this product: this piece's words are lost, and the next one tries again.
          if (res?.status === 429) continue;
          s.failures += 1;
          if (s.failures >= MOST_FAILURES) {
            if (session.current === s) session.current = null;
            if (!s.ended) release(s);
            s.waiting.length = 0;
            setStatus("error");
            setError("Captions stopped: the last few pieces couldn't be read. Try again.");
            return;
          }
        }
      } finally {
        s.sending = false;
      }
    },
    [endpoint, release],
  );

  const queue = useCallback(
    (s: Session, piece: AudioPiece | null) => {
      if (!piece || isSilent(piece.samples)) return;
      s.waiting.push(piece);
      while (s.waiting.length > MOST_WAITING) s.waiting.shift();
      void drain(s);
    },
    [drain],
  );

  const start = useCallback(async () => {
    if (session.current || starting.current) return;
    const attempt: Starting = { stream: null, context: null };
    starting.current = attempt;
    setError(null);
    setStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      attempt.stream = stream;
      // Stop, or leaving the page, came while this waited.
      if (starting.current !== attempt) return letGo(attempt);
      const context = new AudioContext();
      attempt.context = context;
      await context.resume().catch(() => undefined);
      if (starting.current !== attempt) return letGo(attempt);
      const source = context.createMediaStreamSource(stream);
      // A script processor needs no extra file, and every browser has one. It only copies samples out.
      const node = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      const s: Session = { id: newSessionId(), stream, context, node, source, cutter: new ChunkCutter(context.sampleRate, { chunkMs }), waiting: [], sending: false, failures: 0, ended: false };
      node.onaudioprocess = (event) => {
        for (const piece of s.cutter.push(new Float32Array(event.inputBuffer.getChannelData(0)))) queue(s, piece);
      };
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      session.current = s;
      starting.current = null;
      setStatus("listening");
    } catch (err) {
      letGo(attempt);
      if (starting.current !== attempt) return;
      starting.current = null;
      setStatus("error");
      setError(micError(err));
    }
  }, [chunkMs, queue]);

  const stop = useCallback(() => {
    // Still starting: this turns off what it has, and start() turns off anything it gets after this.
    if (starting.current) {
      letGo(starting.current);
      starting.current = null;
      setStatus("stopped");
      return;
    }
    const s = session.current;
    if (!s) return;
    session.current = null;
    // Sends what was said since the last piece. Pieces already on their way still show.
    const last = s.cutter.flush();
    release(s);
    queue(s, last);
    setStatus("stopped");
  }, [queue, release]);

  const clear = useCallback(() => {
    setCaptions([]);
    setError(null);
  }, []);

  // Leaving the page turns the microphone off.
  useEffect(
    () => () => {
      if (starting.current) letGo(starting.current);
      starting.current = null;
      const s = session.current;
      session.current = null;
      if (s) {
        s.waiting.length = 0;
        release(s);
      }
    },
    [release],
  );

  return { captions, text: captions.map((c) => c.text).join(" "), status, error, start, stop, clear };
}
