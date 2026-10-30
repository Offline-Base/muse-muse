"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { Icon } from "@/components/icons";
import { DICTATION_MAX_SECONDS, dictationError, insertDictation, tidyTranscript } from "@/lib/client/dictation";

export type DictationField = HTMLInputElement | HTMLTextAreaElement;

type Phase = "idle" | "starting" | "recording" | "transcribing";

/** Writes into a field the way typing does, so React's own handlers and the field's state see it. */
export function dictateInto(field: DictationField, words: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const { value, caret } = insertDictation(field.value, start, end, words, field.maxLength);
  if (value === field.value) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  field.setSelectionRange(caret, caret);
}

/** One take: the words Muse Voice Transcribe heard. Goes through the docs proxy, which adds the key on the server. */
async function transcribe(wav: Blob, signal: AbortSignal): Promise<string> {
  const [{ docsCall }, { transcribeRequestPart }, { cleanTranscript }] = await Promise.all([
    import("@/lib/docs/client/api"),
    import("@/lib/docs/media/requests"),
    import("@/lib/docs/media/realtime"),
  ]);
  const form = new FormData();
  form.append("request", JSON.stringify(transcribeRequestPart({})));
  form.append("audio", wav, "recording.wav");
  const result = await docsCall<{ transcript?: string }>("asr/transcribe", { form, signal });
  if (!result.ok) throw new Error(result.error?.message ?? "Voice input didn't work. Try again.");
  return tidyTranscript(cleanTranscript(result.json?.transcript ?? ""));
}

/**
 * The mic button: press to talk, press again and the words appear in the field, at the caret. It records first and
 * sends one request, rather than streaming, because Meta's realtime socket needs the key in its handshake and the key
 * never reaches the browser. Escape throws a take away. Nothing is sent until the reader stops.
 */
export function VoiceInputButton({
  target,
  className,
  size = 18,
  onBusyChange,
  ...rest
}: {
  /** The field the words go into. */
  target: () => DictationField | null;
  size?: number;
  /** Recording or transcribing, for a parent that has to keep the button where it is. */
  onBusyChange?: (busy: boolean) => void;
} & Omit<ComponentProps<"button">, "onClick" | "children" | "type">) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const recording = useRef<import("@/lib/docs/media/recorder").MicRecording | null>(null);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const errorTimer = useRef<number | null>(null);

  useEffect(() => setSupported(Boolean(navigator.mediaDevices?.getUserMedia)), []);

  const setBoth = useCallback(
    (next: Phase) => {
      setPhase(next);
      onBusyChange?.(next !== "idle");
    },
    [onBusyChange],
  );

  const stopClock = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };

  const fail = useCallback(
    (err: unknown) => {
      stopClock();
      recording.current = null;
      setBoth("idle");
      setError(dictationError(err));
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
      errorTimer.current = window.setTimeout(() => setError(null), 5_000);
    },
    [setBoth],
  );

  const finish = useCallback(
    async (audio: { wav: Blob; durationMs: number }) => {
      stopClock();
      recording.current = null;
      if (audio.durationMs < 300) {
        fail(new Error("That was too short. Hold on a moment longer."));
        return;
      }
      setBoth("transcribing");
      const controller = new AbortController();
      abort.current = controller;
      try {
        const words = await transcribe(audio.wav, controller.signal);
        if (controller.signal.aborted) return;
        if (!words) {
          fail(new Error("I didn't catch any words. Try again."));
          return;
        }
        const field = target();
        if (field?.isConnected) dictateInto(field, words);
        setBoth("idle");
      } catch (err) {
        if (controller.signal.aborted) return;
        fail(err);
      } finally {
        abort.current = null;
      }
    },
    [fail, setBoth, target],
  );

  const cancel = useCallback(() => {
    stopClock();
    recording.current?.cancel();
    recording.current = null;
    abort.current?.abort();
    setBoth("idle");
  }, [setBoth]);

  // Release the microphone if the field or the page goes away mid-take.
  useEffect(
    () => () => {
      stopClock();
      recording.current?.cancel();
      abort.current?.abort();
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, cancel]);

  const press = async () => {
    if (phase === "recording") {
      const current = recording.current;
      if (!current) return;
      try {
        await finish(await current.stop());
      } catch (err) {
        fail(err);
      }
      return;
    }
    if (phase === "transcribing") {
      cancel();
      return;
    }
    if (phase !== "idle") return;
    setError(null);
    setSeconds(0);
    setBoth("starting");
    try {
      const { startMicRecording } = await import("@/lib/docs/media/recorder");
      recording.current = await startMicRecording({
        maxMs: DICTATION_MAX_SECONDS * 1_000,
        onAutoStop: (audio) => void finish(audio),
        onError: fail,
      });
      setBoth("recording");
      const startedAt = Date.now();
      timer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 250);
    } catch (err) {
      fail(err);
    }
  };

  if (!supported) return null;

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const label = phase === "recording" ? "Stop and transcribe" : phase === "transcribing" ? "Cancel the transcription" : "Voice input";
  return (
    <span className={`voice-input is-${phase}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="voice-input-btn"
        aria-label={label}
        aria-pressed={phase === "recording"}
        title={phase === "idle" ? "Voice input, by Muse Voice Transcribe" : label}
        // Keeps the caret in the field, so the words land where the reader was typing.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void press()}
        {...rest}
      >
        {phase === "starting" || phase === "transcribing" ? <span className="spinner" aria-hidden /> : phase === "recording" ? <span className="voice-input-stop" aria-hidden /> : <Icon name="mic" size={size} />}
        {phase === "recording" ? <span className="voice-input-clock">{clock}</span> : null}
      </button>
      <span className="sr-only" aria-live="polite">
        {phase === "recording" ? "Recording. Press stop when you're done, or Escape to throw it away." : phase === "transcribing" ? "Transcribing." : ""}
      </span>
      {error ? (
        <span className="voice-input-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
