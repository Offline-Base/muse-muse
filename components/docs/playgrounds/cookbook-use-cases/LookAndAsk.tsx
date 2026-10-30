"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { PresetPills, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { useObjectUrl } from "@/components/docs/media/hooks";
import { Icon } from "@/components/icons";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import { prepareFile, type PickedMedia } from "@/lib/docs/media/prepare";
import { startMicRecording, type MicRecording } from "@/lib/docs/media/recorder";
import { transcribeRequestPart } from "@/lib/docs/media/requests";
import { cleanTranscript } from "@/lib/docs/media/realtime";
import type { DocsError } from "@/lib/docs/client/api";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";

/**
 * cookbook/rayban-openclaw: VisionClaw's look-and-ask loop in the browser. Capture one photo (a sample, an upload or
 * the camera), hold the talk button and ask out loud (the take goes to Muse Voice Transcribe, where the app uses
 * on-device speech), send one chat turn with the text and the image and no tools, then speak the answer with the
 * browser's speech synthesis (the app's AVSpeechSynthesizer). Typing works too.
 */

export interface LookAndAskProps {
  slug: string;
  sampleId?: string;
  question?: string;
  presets?: string[];
  /** Stands in for the gateway agent's own instructions. */
  instructions?: string;
}

type Stage = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "done";

const SAMPLES = ["fridge", "street", "receipt", "living-room", "cat-sofa", "sneaker"];

export function LookAndAsk({
  sampleId = "fridge",
  question: initialQuestion = "What can I make with these?",
  presets = ["What am I looking at?", "What can I make with these?", "Read the text in front of me.", "Translate this sign."],
  instructions: initialInstructions = "You are a hands-free assistant on smart glasses. The user is looking at the attached photo and asked out loud. Your reply is spoken aloud: answer in one to three short sentences, no lists, no markdown.",
}: LookAndAskProps) {
  const id = useId();
  const listen = useDocsRun();
  const ask = useDocsRun();
  const [photo, setPhoto] = useState<PickedMedia | null>(null);
  const [question, setQuestion] = useState(initialQuestion);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [speak, setSpeak] = useState(true);
  const [stage, setStage] = useState<Stage>("idle");
  const [answer, setAnswer] = useState("");
  const [heard, setHeard] = useState<{ text: string; ms: number } | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [camera, setCamera] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [preset, setPreset] = useState<number | null>(null);
  const recording = useRef<MicRecording | null>(null);
  const holding = useRef(false);
  const photoUrl = useObjectUrl(photo?.blob ?? null);

  const body = useMemo(
    () => ({
      model,
      // Reasoning spends from the same budget, so leave room for a short spoken answer after it.
      max_completion_tokens: 1500,
      reasoning_effort: "low",
      messages: [
        ...(instructions.trim() ? [{ role: "system", content: instructions.trim() }] : []),
        {
          role: "user",
          content: [
            { type: "text", text: question.trim() || "What am I looking at?" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,<capture>" } },
          ],
        },
      ],
    }),
    [model, instructions, question],
  );

  const sayAloud = (text: string) => {
    if (!speak || typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => resolve();
      u.onerror = () => resolve();
      setStage("speaking");
      window.speechSynthesis.speak(u);
      // Some browsers never fire onend for a muted output; don't hang the demo on it.
      setTimeout(resolve, Math.min(30000, 1500 + text.length * 80));
    });
  };

  const askWith = async (text: string) => {
    if (!photo || !text.trim()) return;
    setAnswer("");
    setStage("thinking");
    const dataUrl = await fileToDataUrl(photo.blob, photo.mime);
    const sent = {
      ...body,
      messages: body.messages.map((m) =>
        m.role === "user"
          ? { role: "user", content: [{ type: "text", text: text.trim() }, { type: "image_url", image_url: { url: dataUrl } }] }
          : m,
      ),
    };
    const res = await ask.run("chat/completions", { method: "POST", body: sent });
    if (!res.ok) {
      setStage("idle");
      return;
    }
    const choice = (res.json as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }> } | null)?.choices?.[0];
    const reply = (choice?.message?.content ?? "").trim();
    setAnswer(reply ? `${reply}${choice?.finish_reason === "length" ? " (cut off at the token limit)" : ""}` : "(no answer)");
    if (reply) await sayAloud(reply);
    setStage("done");
  };

  const startTalking = async () => {
    if (holding.current || stage === "transcribing" || stage === "thinking") return;
    holding.current = true;
    setMicError(null);
    setHeard(null);
    try {
      const rec = await startMicRecording({ maxMs: 30000, onLevel: setLevel });
      recording.current = rec;
      setStage("listening");
      if (!holding.current) void stopTalking();
    } catch (err) {
      holding.current = false;
      setMicError(err instanceof Error ? err.message : "The microphone isn't available.");
      setStage("idle");
    }
  };

  const stopTalking = async () => {
    holding.current = false;
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    const audio = await rec.stop();
    setLevel(0);
    if (audio.durationMs < 400) {
      setStage("idle");
      setMicError("That was too short. Hold the button while you ask.");
      return;
    }
    setStage("transcribing");
    const form = new FormData();
    form.append("request", JSON.stringify(transcribeRequestPart({})));
    form.append("audio", audio.wav, "question.wav");
    const res = await listen.run("asr/transcribe", { form, record: false });
    const text = cleanTranscript(String((res.json as { transcript?: unknown } | null)?.transcript ?? ""));
    if (!res.ok || !text) {
      setStage("idle");
      if (res.ok) setMicError("No speech found in that take. Try again a little closer to the mic.");
      return;
    }
    setHeard({ text, ms: audio.durationMs });
    setQuestion(text);
    await askWith(text);
  };

  const onTalkKey = (e: KeyboardEvent<HTMLButtonElement>, down: boolean) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (down && !e.repeat) void startTalking();
    if (!down) void stopTalking();
  };

  useEffect(() => () => recording.current?.cancel(), []);

  const busy = stage === "listening" || stage === "transcribing" || stage === "thinking";
  const err: DocsError | null = ask.error ?? listen.error;
  const chatJson = ask.result?.json as { usage?: unknown } | null;

  return (
    <div className="pg">
      <div className={styles.grid2}>
        <div className={styles.stack}>
          <p className="pg-section-label">1. Capture: what you see</p>
          {camera ? (
            <CameraCapture
              onCapture={(m) => {
                setPhoto(m);
                setCamera(false);
              }}
              onCancel={() => setCamera(false)}
            />
          ) : (
            <FilePicker accept="image/*" value={photo} onChange={setPhoto} samples={SAMPLES} defaultSampleId={sampleId} preview="compact" disabled={busy} />
          )}
          {!camera ? (
            <button type="button" className="btn btn-sm pg-advanced" onClick={() => setCamera(true)} disabled={busy}>
              <Icon name="video" size={15} /> Use my camera (iPhone mode)
            </button>
          ) : null}
        </div>

        <div className={styles.stack}>
          <p className="pg-section-label">2. Listen: ask out loud</p>
          <button
            type="button"
            className="btn btn-primary"
            aria-pressed={stage === "listening"}
            disabled={!photo || stage === "transcribing" || stage === "thinking"}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              void startTalking();
            }}
            onPointerUp={() => void stopTalking()}
            onPointerCancel={() => void stopTalking()}
            onKeyDown={(e) => onTalkKey(e, true)}
            onKeyUp={(e) => onTalkKey(e, false)}
            style={{ minHeight: 56, fontSize: 16 }}
          >
            <Icon name="mic" size={18} /> {stage === "listening" ? "Listening, release to ask" : "Hold to talk"}
          </button>
          <div aria-hidden style={{ height: 6, borderRadius: 3, background: "var(--surface-3)", overflow: "hidden" }}>
            <div style={{ width: `${Math.round(Math.min(1, level * 3) * 100)}%`, height: "100%", background: "var(--accent)", transition: "width 80ms" }} />
          </div>
          <p className="pg-hint">Hold the button (or Space while it has focus), ask, and let go. Or type the question:</p>
          <div className="pg-advanced">
            <PresetPills
              presets={presets.map((p) => ({ label: p }))}
              active={preset}
              onPick={(i) => {
                setPreset(i);
                setQuestion(presets[i]);
              }}
              disabled={busy}
            />
          </div>
          <div className={styles.textAnswer}>
            <label className="sr-only" htmlFor={`${id}-q`}>
              Question
            </label>
            <TextInput id={`${id}-q`} value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy} />
            <RunButton running={stage === "thinking"} onRun={() => void askWith(question)} onStop={ask.abort} label="Ask" disabled={!photo || !question.trim() || busy} />
          </div>
          {micError ? <div className="pg-hint pg-bad">{micError}</div> : null}
        </div>
      </div>

      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={busy} />
        <span className="pg-advanced">
          <Toggle id={`${id}-speak`} label="Speak the answer" checked={speak} onChange={setSpeak} />
        </span>
      </div>

      <div className={styles.card} aria-live="polite">
        <p className={styles.cardTitle}>On the glasses</p>
        <div className={styles.grid2}>
          <div>{photoUrl ? <img src={photoUrl} alt={photo?.description ?? "The captured photo"} className={styles.shot} style={{ maxHeight: 360 }} /> : <p className="pg-empty">No photo yet.</p>}</div>
          <div className={styles.stack}>
            <ol className="pg-checks" aria-label="Pipeline">
              <li className={photo ? "pg-check-ok" : ""}>
                <span className="pg-check-mark">{photo ? "✓" : "·"}</span> Capture: {photo ? `${photo.name}${photo.width ? `, ${photo.width} x ${photo.height}` : ""}` : "waiting"}
              </li>
              <li className={heard ? "pg-check-ok" : ""}>
                <span className="pg-check-mark">{heard ? "✓" : stage === "transcribing" ? "…" : "·"}</span> Listen:{" "}
                {heard ? `"${heard.text}" (${(heard.ms / 1000).toFixed(1)} s of audio, Muse Voice Transcribe)` : stage === "listening" ? "recording" : stage === "transcribing" ? "transcribing" : "typed, or hold to talk"}
              </li>
              <li className={answer ? "pg-check-ok" : ""}>
                <span className="pg-check-mark">{answer ? "✓" : stage === "thinking" ? "…" : "·"}</span> Ask: one chat turn, text and image, no tools
                {ask.result?.elapsedMs && answer ? `, ${latencyLabel(ask.result.elapsedMs)}` : ""}
              </li>
              <li className={stage === "done" && speak ? "pg-check-ok" : ""}>
                <span className="pg-check-mark">{stage === "speaking" ? "…" : stage === "done" && speak ? "✓" : "·"}</span> Speak:{" "}
                {speak ? "the browser's speech synthesis reads the answer" : "off"}
              </li>
            </ol>
            {answer ? (
              <div className="pg-final">
                <p className="pg-section-label">The answer</p>
                <MarkdownText text={answer} />
                <div className={styles.row} style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-sm" onClick={() => void sayAloud(answer)}>
                    <Icon name="play" size={14} /> Say it again
                  </button>
                  {chatJson?.usage ? <UsageLine model={ask.result?.model ?? model} usage={chatJson.usage} /> : null}
                </div>
              </div>
            ) : null}
            {listen.result?.json && heard ? (
              <p className="pg-hint">
                Transcription: <UsageLine model="muse-voice-transcribe-1.0" usage={null} audioMs={heard.ms} />
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <ErrorBox error={err} />

      <details className="pg-system">
        <summary>Gateway instructions</summary>
        <p className="pg-hint">
          The app itself sends only the turn: text plus image, model <code>openclaw/default</code>, no tools. The gateway adds its agent&apos;s instructions and
          resolves the real model. These stand in for them here.
        </p>
        <TextArea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Gateway instructions" />
      </details>

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <>
          <CodeView method="POST" path="chat/completions" body={body} caption="The one chat turn (the app sends it to its gateway; here it goes to the Model API)" />
          <CodeView
            method="POST"
            path="asr/transcribe"
            form={[
              { name: "request", value: JSON.stringify(transcribeRequestPart({})) },
              { name: "audio", value: "question.wav", file: { label: "Audio (16 kHz mono WAV)", accept: "audio/wav" } },
            ]}
            caption="The spoken question, transcribed"
          />
        </>
      ) : null}
    </div>
  );
}

/** iPhone mode: a live camera preview and a shutter button that hands back one JPEG. */
function CameraCapture({ onCapture, onCancel }: { onCapture(m: PickedMedia): void; onCancel(): void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "The camera isn't available."));
    if (!navigator.mediaDevices) setError("This browser has no camera access here.");
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const shoot = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.88));
    if (!blob) return;
    const file = new File([blob], "capture.jpg", { type: "image/jpeg" });
    onCapture(await prepareFile(file, { source: "upload" }));
  };

  return (
    <div className={styles.stack}>
      {error ? <div className="pg-hint pg-bad">{error}</div> : <video ref={video} className={styles.shot} muted playsInline aria-label="Camera preview" />}
      <div className={styles.row}>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void shoot()} disabled={!!error}>
          Take the photo
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
