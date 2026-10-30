"use client";

import { useId, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Field, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { StreamView } from "@/components/docs/kit/StreamView";
import { FilePicker } from "@/components/docs/media/FilePicker";
import styles from "@/components/docs/media/media.module.css";
import { docsCall, type DocsError } from "@/lib/docs/client/api";
import { responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { fileToBase64, fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { audioQuestionRequest, fileUploadFields, videoRequest, type MediaRef } from "@/lib/docs/media/requests";

export type VideoSend = "inline" | "input_file" | "input_video";

export interface VideoPlaygroundProps {
  slug?: string;
  question?: string;
  /** The clip picked on load. Defaults to the 5 s street clip. */
  sampleId?: string;
  /**
   * How the clip goes in: "inline" as input_video with a data URL, or uploaded with POST /v1/files and referenced
   * by file_id as "input_file" or "input_video".
   */
  send?: VideoSend;
  /** Offer the inline / upload switch. Default true. */
  sendSwitch?: boolean;
  model?: string;
  models?: string[];
  presets?: Array<{ label: string; question: string }>;
  /** Also offer spoken audio as an input_audio part (video-understanding, Audio). */
  audio?: boolean;
  /** Start on audio instead of video. */
  startWith?: "video" | "audio";
  audioQuestion?: string;
  stream?: boolean;
  maxOutputTokens?: number;
}

const SEND_LABEL: Record<VideoSend, string> = {
  inline: "Inline (input_video data URL)",
  input_file: "Upload, then input_file",
  input_video: "Upload, then input_video",
};

/**
 * Ask about a short clip on the Responses API: inline as input_video, or uploaded through the Files API and
 * referenced by file_id. With `audio`, a second tab sends speech as input_audio, which the page runs on Muse Spark 1.2.
 */
export function VideoPlayground({
  question: initialQuestion = "Describe what happens in this video, step by step.",
  sampleId = "street-pan",
  send: initialSend = "inline",
  sendSwitch = true,
  model: initialModel = DEFAULT_TEXT_MODEL,
  models,
  presets = [],
  audio = false,
  startWith = "video",
  audioQuestion = "Transcribe this audio. Return only the transcript.",
  stream = true,
  maxOutputTokens,
}: VideoPlaygroundProps) {
  const id = useId();
  const runner = useDocsRun();
  const [showCode, setShowCode] = useState(false);
  const [media, setMedia] = useState<"video" | "audio">(audio ? startWith : "video");
  const [model, setModel] = useState(media === "audio" ? "muse-spark-1.2" : initialModel);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [clip, setClip] = useState<PickedMedia | null>(null);
  const [question, setQuestion] = useState(media === "audio" ? audioQuestion : initialQuestion);
  const [send, setSend] = useState<VideoSend>(initialSend);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [live, setLive] = useState<Collected | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const running = runner.state === "running" || uploading;
  const picked = media === "video" ? video : clip;

  const switchMedia = (next: "video" | "audio") => {
    setMedia(next);
    setQuestion(next === "audio" ? audioQuestion : initialQuestion);
    setModel(next === "audio" ? "muse-spark-1.2" : initialModel);
    setLive(null);
    runner.reset();
  };

  const shown =
    media === "audio"
      ? audioQuestionRequest({ model, question, base64: "<BASE64>", format: "wav", maxOutputTokens })
      : videoRequest({
          model,
          question,
          video: send === "inline" ? { dataUrl: "data:video/mp4;base64,<BASE64>" } : { fileId: uploaded ?? "file-abc123" },
          as: send === "input_file" ? "input_file" : "input_video",
          stream,
          maxOutputTokens,
        });
  if (media === "audio" && stream) shown.body.stream = true;

  const run = async () => {
    if (!picked) return;
    setLocalError(null);
    setLive(null);
    let path: string;
    let body: Record<string, unknown>;
    if (media === "audio") {
      ({ path, body } = audioQuestionRequest({ model, question, base64: await fileToBase64(picked.blob), format: "wav", maxOutputTokens }));
      if (stream) body.stream = true;
    } else {
      let ref: MediaRef;
      if (send === "inline") {
        ref = { dataUrl: await fileToDataUrl(picked.blob, picked.mime === "video/quicktime" ? "video/quicktime" : "video/mp4") };
      } else {
        const form = new FormData();
        for (const [k, v] of fileUploadFields({})) form.append(k, v);
        form.append("file", picked.blob, picked.name);
        setUploading(true);
        const up = await docsCall<{ id?: string }>("files", { form }).finally(() => setUploading(false));
        if (!up.ok || !up.json?.id) return setLocalError(up.error ?? { message: "The upload didn't return a file id." });
        setUploaded(up.json.id);
        ref = { fileId: up.json.id };
      }
      ({ path, body } = videoRequest({ model, question, video: ref, as: send === "input_file" ? "input_file" : "input_video", stream, maxOutputTokens }));
    }
    const collector = responsesCollector();
    const res = await runner.run(path, {
      body,
      stream,
      onEvent: (e) => {
        collector.push(e);
        setLive(collector.snapshot());
      },
    });
    if (!stream && res.json && typeof res.json === "object") {
      collector.push(res.json as Record<string, unknown>);
      setLive(collector.snapshot());
    }
  };

  return (
    <div className={`pg ${styles.playground}`}>
      <div className="pg-bar">
        {audio ? (
          <span className="pg-advanced">
            <Segmented
              label="Input"
              value={media}
              onChange={switchMedia}
              disabled={running}
              options={[
                { value: "video", label: "Video" },
                { value: "audio", label: "Audio (input_audio)" },
              ]}
            />
          </span>
        ) : null}
        <ModelSelect kind="vision" value={model} onChange={setModel} allow={models} disabled={running} />
      </div>
      {media === "video" ? (
        <FilePicker
          label="Video (MP4, up to 3 MB for this demo)"
          accept="video/mp4,video/quicktime"
          value={video}
          onChange={setVideo}
          samples={["video"]}
          defaultSampleId={sampleId}
          disabled={running}
        />
      ) : (
        <FilePicker
          label="Audio (converted to 16 kHz mono WAV in your browser)"
          accept="audio/*,.wav,.mp3,.m4a"
          value={clip}
          onChange={setClip}
          samples={["audio"]}
          defaultSampleId="speech-paragraph"
          disabled={running}
        />
      )}
      <PresetPills presets={presets} onPick={(i) => setQuestion(presets[i].question)} disabled={running} />
      <Field id={`${id}-q`} label="Question">
        <TextArea id={`${id}-q`} value={question} rows={3} onChange={(e) => setQuestion(e.target.value)} disabled={running} />
      </Field>
      {media === "video" && sendSwitch ? (
        <span className={`${styles.inline} pg-advanced`}>
          <span className={styles.label}>Send as</span>
          <Segmented<VideoSend>
            size="sm"
            label="How the video is sent"
            value={send}
            onChange={setSend}
            disabled={running}
            options={(["inline", "input_file", "input_video"] as const).map((v) => ({ value: v, label: SEND_LABEL[v] }))}
          />
        </span>
      ) : null}
      <div className={styles.spread}>
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!picked || !question.trim() || (picked?.problems.length ?? 0) > 0} />
      </div>
      {media === "audio" ? (
        <p className={`${styles.note} pg-advanced`}>
          The page notes that audio on Muse Spark 1.3 isn&apos;t fully supported yet, so this starts on Muse Spark 1.2, with 4,000 output
          tokens of room because reasoning shares the budget.
        </p>
      ) : send !== "inline" ? (
        <p className={`${styles.note} pg-advanced`}>
          Run uploads the clip with POST /v1/files first{uploaded ? ` (${uploaded})` : ""}, then references its file_id. Demo files are
          deleted within an hour.
        </p>
      ) : null}
      <ErrorBox error={localError ?? runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} json={live?.final ?? undefined} usage={live?.usage ?? undefined}>
          <StreamView text={live?.text ?? ""} reasoning={live?.reasoning} refusal={live?.refusal} running={running} />
        </ResponseView>
      ) : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={shown.path} body={shown.body} stream={stream} caption="The request Run sends" /> : null}
    </div>
  );
}
