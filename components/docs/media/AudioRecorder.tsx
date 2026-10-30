"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import styles from "@/components/docs/media/media.module.css";
import { useObjectUrl } from "@/components/docs/media/hooks";
import { formatBytes } from "@/lib/docs/media/base64";
import { formatDuration } from "@/lib/docs/media/audio";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { startMicRecording, type MicRecording, type RecordedAudio } from "@/lib/docs/media/recorder";

export interface AudioRecorderProps {
  /** Called with the take as a 16 kHz mono WAV, ready to send. */
  onRecorded(file: PickedMedia): void;
  /** Stops by itself after this many seconds. Defaults to 60, the realtime relay's limit. */
  maxSeconds?: number;
  label?: string;
  disabled?: boolean;
}

type Phase = "idle" | "starting" | "recording" | "saving" | "done";

function toPicked(audio: RecordedAudio): PickedMedia {
  return {
    blob: audio.wav,
    name: "recording.wav",
    mime: "audio/wav",
    bytes: audio.wav.size,
    kind: "audio",
    source: "recording",
    durationMs: audio.durationMs,
    note: "Recorded from your microphone as 16 kHz mono 16-bit WAV.",
    problems: audio.durationMs < 300 ? ["That take is too short to transcribe. Record a few words."] : [],
  };
}

/**
 * Records from the microphone with a level meter and a running clock, stops at the cap, then plays the take back.
 * The take is a 16 kHz mono WAV (lib/docs/media/recorder.ts), so it goes straight to Muse Voice Transcribe.
 */
export function AudioRecorder({ onRecorded, maxSeconds = 60, label = "Record from your microphone", disabled }: AudioRecorderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [take, setTake] = useState<RecordedAudio | null>(null);
  const recording = useRef<MicRecording | null>(null);
  const timer = useRef<number | null>(null);
  const url = useObjectUrl(take?.wav ?? null);

  const clearTimer = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };

  // Release the microphone if the demo goes away mid-take.
  useEffect(
    () => () => {
      clearTimer();
      recording.current?.cancel();
    },
    [],
  );

  const finish = (audio: RecordedAudio) => {
    clearTimer();
    recording.current = null;
    setLevel(0);
    setTake(audio);
    setPhase("done");
    onRecorded(toPicked(audio));
  };

  const start = async () => {
    setError(null);
    setTake(null);
    setPhase("starting");
    try {
      const rec = await startMicRecording({
        maxMs: maxSeconds * 1000,
        onLevel: setLevel,
        onAutoStop: finish,
        onError: (err) => {
          clearTimer();
          recording.current = null;
          setError(err.message);
          setPhase("idle");
        },
      });
      recording.current = rec;
      setElapsed(0);
      setPhase("recording");
      timer.current = window.setInterval(() => setElapsed(performance.now() - rec.startedAt), 200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the microphone.");
      setPhase("idle");
    }
  };

  const stop = async () => {
    const rec = recording.current;
    if (!rec) return;
    setPhase("saving");
    clearTimer();
    try {
      finish(await rec.stop());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the recording.");
      setPhase("idle");
    }
  };

  const busy = phase === "starting" || phase === "saving";
  return (
    <div className={styles.recorder}>
      <span className={styles.label}>{label}</span>
      <div className={styles.row}>
        {phase === "recording" ? (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void stop()}>
            <span className={styles.recDot} aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void start()} disabled={disabled || busy}>
            <Icon name="mic" size={16} />
            {phase === "starting" ? "Starting..." : phase === "saving" ? "Saving..." : take ? "Record again" : "Record"}
          </button>
        )}
        <span className={styles.meter} role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
          <span className={styles.meterFill} style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
        <span className={styles.timer} aria-live="off">
          {formatDuration(phase === "recording" ? elapsed : (take?.durationMs ?? 0))} / {formatDuration(maxSeconds * 1000)}
        </span>
      </div>
      {take && url ? (
        <>
          <audio className={styles.audioPreview} src={url} controls preload="metadata" />
          <p className={styles.note}>
            {formatDuration(take.durationMs)} recorded, {formatBytes(take.wav.size)} as 16 kHz mono WAV.
          </p>
        </>
      ) : (
        <p className={styles.note}>Recording stops by itself after {maxSeconds} seconds. Nothing is sent until you press Run.</p>
      )}
      {error ? (
        <p className={styles.problem} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
