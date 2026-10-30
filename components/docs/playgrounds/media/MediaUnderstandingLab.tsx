"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { EffortSelect, Field, PresetPills, Segmented, TextArea, TextInput, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { uploadPicked } from "@/components/docs/playgrounds/media/FileIdBar";
import {
  audioSendsFor,
  mediaBody,
  mediaSendUploads,
  PUBLIC_SAMPLE_VIDEO,
  ranOutOfOutput,
  videoSendsFor,
  type Api,
  type AudioSend,
  type MediaKind,
  type VideoSend,
} from "@/components/docs/playgrounds/media/bodies";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import { UploadCache } from "@/components/docs/playgrounds/media/upload-cache";
import type { DocsError } from "@/lib/docs/client/api";
import type { Effort } from "@/lib/docs/client/models";
import { chatCollector, responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { fileToBase64, fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";

export interface MediaLabPreset {
  label: string;
  /** The row of pills it sits in ("Video", "Audio"). */
  group?: string;
  media: MediaKind;
  question: string;
  sampleId?: string;
  api?: Api;
  send?: VideoSend | AudioSend;
}

export interface MediaUnderstandingLabProps {
  slug?: string;
  /** The first one loads on start. */
  presets: MediaLabPreset[];
  /** Video starts here: Muse Spark 1.3 Contributor. */
  videoModel?: string;
  /** Audio starts on Muse Spark 1.2, which the page uses because audio on 1.3 isn't fully supported yet. */
  audioModel?: string;
  models?: string[];
  effort?: Effort | null;
  /** Output room for audio, since reasoning shares it (the page's "Transcription tips"). */
  audioMaxOutputTokens?: number;
  /** The clip the Public URL mode starts with. */
  publicVideoUrl?: string;
}

type Send = VideoSend | AudioSend;

const VIDEO_LABEL: Record<VideoSend, string> = {
  upload_input_file: "Upload, input_file",
  upload_input_video: "Upload, input_video",
  inline: "Inline data URL",
  public_url: "Public URL",
};

const AUDIO_LABEL: Record<AudioSend, string> = {
  input_audio: "input_audio data + format",
  audio_url: "audio_url data URI",
  upload: "Upload, file_id",
};

function sendNote(media: MediaKind, api: Api, send: Send): string {
  if (media === "video") {
    if (api === "chat") {
      return send === "public_url"
        ? "Chat Completions takes video in a video_url part, here a public link to an MP4 that Meta fetches."
        : 'Chat Completions takes video in a video_url part: {"url": ...} with a base64 data URL.';
    }
    switch (send as VideoSend) {
      case "upload_input_file":
        return "Run uploads the clip with POST /v1/files (purpose user_data), then references its file_id in an input_file part: the flow the page recommends.";
      case "upload_input_video":
        return "Run uploads the clip with POST /v1/files, then references its file_id in an input_video part.";
      case "inline":
        return "The clip goes inline in input_video's video_url as a base64 data URL. No upload, nothing to clean up.";
      case "public_url":
        return "input_video's video_url holds a public http or https link to an MP4, and Meta fetches it.";
    }
  }
  switch (send as AudioSend) {
    case "input_audio":
      return `input_audio carries the bare base64 in data and its format ("wav" here: the demo converts audio to 16 kHz mono WAV in your browser).`;
    case "audio_url":
      return "input_audio carries audio_url, a data:audio/wav;base64 URI. Responses API only.";
    case "upload":
      return "Run uploads the WAV with POST /v1/files, then sends an input_audio part with its file_id. Responses API only.";
  }
}

function defaultSend(media: MediaKind, api: Api): Send {
  return media === "video" ? (api === "chat" ? "inline" : "upload_input_file") : "input_audio";
}

/**
 * Video and audio understanding as the page lays them out: a clip uploaded and referenced by file_id (input_file or
 * input_video), sent inline, or linked by a public URL, on the Responses API or Chat Completions (video_url); and
 * speech as input_audio (base64 and a format), an audio_url data URI or an uploaded file_id, starting on Muse Spark
 * 1.2 with 4,000 output tokens of room as the page advises.
 */
export function MediaUnderstandingLab({
  presets,
  videoModel = DEFAULT_TEXT_MODEL,
  audioModel = "muse-spark-1.2-contributor",
  models,
  effort: initialEffort = "low",
  audioMaxOutputTokens = 4000,
  publicVideoUrl = PUBLIC_SAMPLE_VIDEO,
}: MediaUnderstandingLabProps) {
  const id = useId();
  const first = presets[0] ?? { label: "Describe", media: "video" as const, question: "Describe what happens in this video." };
  const runner = useDocsRun();
  const uploader = useDocsRun();
  const [media, setMedia] = useState<MediaKind>(first.media);
  const [api, setApi] = useState<Api>(first.api ?? "responses");
  const [send, setSend] = useState<Send>(first.send ?? defaultSend(first.media, first.api ?? "responses"));
  const [model, setModel] = useState(first.media === "audio" ? audioModel : videoModel);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [audio, setAudio] = useState<PickedMedia | null>(null);
  const [videoSample, setVideoSample] = useState(first.media === "video" ? (first.sampleId ?? "street-pan") : "street-pan");
  const [audioSample, setAudioSample] = useState(first.media === "audio" ? (first.sampleId ?? "speech-paragraph") : "speech-paragraph");
  const [url, setUrl] = useState(publicVideoUrl);
  const [question, setQuestion] = useState(first.question);
  const [preset, setPreset] = useState<number | null>(presets.length ? 0 : null);
  const [live, setLive] = useState<Collected | null>(null);
  const [localError, setLocalError] = useState<DocsError | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  // An upload is reused while its picked file stays the same and the upload is under an hour old.
  const uploaded = useRef(new UploadCache<PickedMedia>());

  const groups = useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, number[]>();
    presets.forEach((p, i) => {
      const g = p.group ?? (p.media === "audio" ? "Audio" : "Video");
      if (!by.has(g)) {
        by.set(g, []);
        order.push(g);
      }
      by.get(g)!.push(i);
    });
    return order.map((g) => ({ label: g, indexes: by.get(g)! }));
  }, [presets]);

  const running = runner.state === "running" || uploader.state === "running";
  const picked = media === "video" ? video : audio;
  const urlMode = media === "video" && send === "public_url";
  const sends: Send[] = media === "video" ? videoSendsFor(api) : audioSendsFor(api);
  const ready = urlMode ? /^https?:\/\/\S+$/.test(url.trim()) : !!picked && picked.problems.length === 0;
  const maxOutputTokens = media === "audio" ? audioMaxOutputTokens : undefined;

  const switchTo = (nextMedia: MediaKind, nextApi: Api, nextSend?: Send) => {
    const allowed: Send[] = nextMedia === "video" ? videoSendsFor(nextApi) : audioSendsFor(nextApi);
    const s = nextSend && allowed.includes(nextSend) ? nextSend : allowed.includes(send) && nextMedia === media ? send : defaultSend(nextMedia, nextApi);
    if (nextMedia !== media) setModel(nextMedia === "audio" ? audioModel : videoModel);
    setMedia(nextMedia);
    setApi(nextApi);
    setSend(s);
  };

  const applyPreset = (i: number) => {
    const p = presets[i];
    setPreset(i);
    switchTo(p.media, p.api ?? "responses", p.send);
    setModel(p.media === "audio" ? audioModel : videoModel);
    setQuestion(p.question);
    if (p.sampleId) {
      if (p.media === "video" && p.sampleId !== video?.sampleId) {
        setVideo(null);
        setVideoSample(p.sampleId);
      }
      if (p.media === "audio" && p.sampleId !== audio?.sampleId) {
        setAudio(null);
        setAudioSample(p.sampleId);
      }
    }
    runner.reset();
    setLive(null);
    setLocalError(null);
  };

  /** What goes in the part: an upload's file id, a data URL, the bare base64, or the URL. */
  const resolveValue = async (): Promise<string | null> => {
    if (urlMode) return url.trim();
    if (!picked) return null;
    if (mediaSendUploads(media, send)) {
      const known = uploaded.current.get(picked);
      if (known) return known;
      const up = await uploadPicked(uploader.run, picked);
      if (!up.id) {
        // An HTTP error shows through the uploader's own error; a stopped upload shows nothing.
        if (up.error && up.error.code !== "aborted") setLocalError(up.error);
        return null;
      }
      uploaded.current.set(picked, up.id);
      setLastId(up.id);
      return up.id;
    }
    if (media === "audio" && send === "input_audio") return fileToBase64(picked.blob);
    return fileToDataUrl(picked.blob, media === "video" ? "video/mp4" : "audio/wav");
  };

  const run = async () => {
    if (running || !ready || !question.trim()) return;
    setLocalError(null);
    setLive(null);
    runner.reset();
    const value = await resolveValue();
    if (!value) return;
    const { path, body } = mediaBody({ model, api, media, send, question, value, format: "wav", effort, stream: true, maxOutputTokens });
    const collector = api === "chat" ? chatCollector() : responsesCollector();
    const res = await runner.run(path, {
      body,
      stream: true,
      onEvent: (e) => {
        collector.push(e);
        setLive(collector.snapshot());
      },
    });
    // After a 404 the id sent is gone (expired, or owned by an older cookie): the next run uploads the file again.
    if (res.status === 404 && picked && mediaSendUploads(media, send)) uploaded.current.forget(picked);
  };

  const placeholder = urlMode
    ? url.trim() || "https://example.com/clip.mp4"
    : mediaSendUploads(media, send)
      ? (lastId ?? "file-abc123")
      : media === "audio" && send === "input_audio"
        ? "<BASE64>"
        : `data:${media === "video" ? "video/mp4" : "audio/wav"};base64,<BASE64>`;
  const code = mediaBody({ model, api, media, send, question, value: placeholder, format: "wav", effort, stream: true, maxOutputTokens });

  return (
    <div className={`pg ${styles.lab}`}>
      <div className={styles.stack}>
        {groups.map((g) => (
          <PresetPills
            key={g.label}
            label={g.label}
            presets={g.indexes.map((i) => presets[i])}
            active={preset !== null && g.indexes.includes(preset) ? g.indexes.indexOf(preset) : null}
            onPick={(j) => applyPreset(g.indexes[j])}
            disabled={running}
          />
        ))}
      </div>

      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} allow={models} disabled={running} />
      </div>
      <div className={styles.controls}>
        <span className={styles.inline}>
          <span className={styles.label}>Input</span>
          <Segmented<MediaKind>
            size="sm"
            label="Input"
            value={media}
            onChange={(m) => switchTo(m, api)}
            disabled={running}
            options={[
              { value: "video", label: "Video" },
              { value: "audio", label: "Audio" },
            ]}
          />
        </span>
        <span className={styles.inline}>
          <span className={styles.label}>API</span>
          <Segmented<Api>
            size="sm"
            label="API"
            value={api}
            onChange={(a) => switchTo(media, a)}
            disabled={running}
            options={[
              { value: "responses", label: "Responses" },
              { value: "chat", label: "Chat Completions" },
            ]}
          />
        </span>
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
      </div>

      <div className={styles.stack}>
        <span className={`${styles.inline} ${styles.segWrap}`}>
          <span className={styles.label}>Send as</span>
          <Segmented<Send>
            size="sm"
            label={media === "video" ? "How the video is sent" : "How the audio is sent"}
            value={send}
            onChange={setSend}
            disabled={running}
            options={sends.map((s) => ({ value: s, label: media === "video" ? VIDEO_LABEL[s as VideoSend] : AUDIO_LABEL[s as AudioSend] }))}
          />
        </span>
        <p className={styles.note}>{sendNote(media, api, send)}</p>
      </div>

      {urlMode ? (
        <Field
          id={`${id}-url`}
          label="Public video URL"
          hint={`${url.trim() === PUBLIC_SAMPLE_VIDEO ? "MDN's sample clip of a flower opening. " : ""}Any link to an MP4 that Meta's servers can reach works; files on your computer need Inline or Upload.`}
        >
          <TextInput
            id={`${id}-url`}
            className={styles.urlInput}
            value={url}
            placeholder="https://example.com/clip.mp4"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            disabled={running}
            aria-describedby={`${id}-url-hint`}
          />
        </Field>
      ) : media === "video" ? (
        <FilePicker
          key={`video-${videoSample}`}
          label="Video (MP4, up to 3 MB here)"
          accept="video/mp4"
          value={video}
          onChange={setVideo}
          samples={["video"]}
          defaultSampleId={videoSample}
          hint="The sample clip has no sound. Drop an MP4 with speech to get a transcript of it next to the description."
          disabled={running}
        />
      ) : (
        <FilePicker
          key={`audio-${audioSample}`}
          label="Audio (WAV or MP3, converted to 16 kHz mono WAV in your browser)"
          accept="audio/wav,audio/mpeg,audio/*,.wav,.mp3"
          value={audio}
          onChange={setAudio}
          samples={["audio"]}
          defaultSampleId={audioSample}
          preview="full"
          disabled={running}
        />
      )}

      <Field id={`${id}-q`} label="Question">
        <TextArea id={`${id}-q`} value={question} rows={2} onChange={(e) => setQuestion(e.target.value)} onKeyDown={runOnModEnter(() => void run())} disabled={running} />
      </Field>

      <div className={styles.spread}>
        <p className={styles.note}>
          {media === "audio"
            ? `Audio on Muse Spark 1.3 isn't fully supported yet, so this starts on Muse Spark 1.2, with ${audioMaxOutputTokens.toLocaleString("en-US")} output tokens of room: reasoning shares the budget, and a transcript can come back empty without it.`
            : "Under a cent a run on the default model. Streaming keeps a long clip from timing out before the first token."}
        </p>
        <RunButton
          running={running}
          onRun={() => void run()}
          onStop={() => {
            runner.abort();
            uploader.abort();
          }}
          disabled={!ready || !question.trim()}
        />
      </div>

      <ErrorBox error={localError ?? uploader.error ?? runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} json={live?.final ?? undefined} usage={live?.usage ?? undefined}>
          <StreamView
            text={live?.text ?? ""}
            reasoning={live?.reasoning}
            refusal={live?.refusal}
            running={running}
            placeholder={uploader.state === "running" ? `Uploading the ${media === "video" ? "clip" : "audio"}...` : undefined}
          />
          {!running && ranOutOfOutput(live?.finishReason) && !live?.text ? (
            <p className={styles.problem}>The reply ran out of output tokens while reasoning. Give it more room or lower the reasoning effort.</p>
          ) : null}
        </ResponseView>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={styles.stack}>
          <CodeView method="POST" path={code.path} body={code.body} stream caption="The request Run sends" />
          {mediaSendUploads(media, send) ? <p className={styles.note}>Before it, the file is uploaded with POST /v1/files and purpose user_data.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
