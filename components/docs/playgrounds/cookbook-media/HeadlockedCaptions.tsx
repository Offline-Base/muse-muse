"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { CodeView, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { Segmented, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import "@/components/docs/media/mask-decoder";
import { useObjectUrl } from "@/components/docs/media/hooks";
import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import {
  anchorNear,
  captionChunks,
  chunkAt,
  defaultMapping,
  faceRect,
  headAnchor,
  peopleOf,
  placeBubble,
  smoothAnchors,
  speakersOf,
  speechTurns,
  wrapText,
  type Person,
  type SpeechTurn,
} from "@/components/docs/playgrounds/cookbook-media/captions";
import { samRunOutcome } from "@/components/docs/playgrounds/cookbook-media/sam-summary";
import { formatUsd } from "@/lib/docs/client/cost";
import { trimForRecord } from "@/lib/docs/client/record";
import { formatDuration } from "@/lib/docs/media/audio";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { fileUploadFields, samRequest, transcribeRequestPart, type MediaRef } from "@/lib/docs/media/requests";
import { SamStreamParser, recordsByFrame, samDelta, samTextOfResponse, type SamRecord } from "@/lib/docs/media/sam";
import { decodeMaskRaster } from "@/lib/docs/media/sam-mask";
import { samVideoCost } from "@/lib/docs/media/video";

export interface HeadlockedCaptionsProps {
  slug?: string;
  audioSampleId?: string;
  imageSampleId?: string;
  videoSampleId?: string;
  media?: Array<"image" | "video">;
  /** What SAM is asked for; the recipe asks for "people". */
  concept?: string;
  /** Most words in one bubble. */
  maxWords?: number;
}

type Kind = "image" | "video";

const FALLBACK = ["#7489f7", "#f2b97c", "#5bbfa3", "#ec8a9e"];

function speakerColors(el: Element | null): string[] {
  if (!el || typeof getComputedStyle !== "function") return FALLBACK;
  const css = getComputedStyle(el);
  return FALLBACK.map((f, i) => {
    const v = css.getPropertyValue(`--chart-${i + 1}`).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : f;
  });
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A mask as a tinted canvas the size of its box, for the active speaker's highlight. */
function tintedMask(r: SamRecord, color: string, alpha: number): HTMLCanvasElement | null {
  const res = decodeMaskRaster(r.mask);
  if (!res.ok) return null;
  const c = document.createElement("canvas");
  c.width = r.mask.width;
  c.height = r.mask.height;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(c.width, c.height);
  const [cr, cg, cb] = hexRgb(color);
  for (let i = 0; i < res.raster.length; i++) {
    if (!res.raster[i]) continue;
    img.data[i * 4] = cr;
    img.data[i * 4 + 1] = cg;
    img.data[i * 4 + 2] = cb;
    img.data[i * 4 + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * The headlocked captions recipe with the docs' samples: Muse Voice Transcribe diarizes a two-voice call while SAM
 * 3.1 finds the people in a street photo or clip, in parallel; you match each anonymous voice to a person; then the
 * preview plays the call with a speech bubble over whoever is talking, anchored at the top of their mask, on a
 * stable side, clear of their face and everyone else. In the clip the bubble follows the person's track. The clip is
 * uploaded with purpose=user_data and segmented by file_id, as the recipe's server does; the photo goes inline. Masks
 * come back one_bit, the compact encoding for decoding to a raster. The samples aren't one conversation video, so the
 * call is laid over the scene; the recipe uploads one video for both.
 */
export function HeadlockedCaptions({
  audioSampleId = "two-voices",
  imageSampleId = "street",
  videoSampleId = "street-pan",
  media: kinds = ["image", "video"],
  concept = "people",
  maxWords = 7,
}: HeadlockedCaptionsProps) {
  const id = useId();
  const voice = useDocsRun();
  const sam = useDocsRun();
  const { recordRequest } = useDocsPage();
  const busy = voice.state === "running" || sam.state === "running";
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "image");
  const [audio, setAudio] = useState<PickedMedia | null>(null);
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [turns, setTurns] = useState<SpeechTurn[] | null>(null);
  const [voiceReply, setVoiceReply] = useState<unknown>(null);
  const [records, setRecords] = useState<SamRecord[]>([]);
  const [samFinal, setSamFinal] = useState<unknown>(null);
  /** The clip's upload, reused while the same clip is picked (the Files API keeps it for an hour here). */
  const [upload, setUpload] = useState<{ fileId: string; file: PickedMedia } | null>(null);
  const [samPhase, setSamPhase] = useState<"uploading" | "segmenting" | null>(null);
  const [analyzed, setAnalyzed] = useState<{ audio: PickedMedia; scene: PickedMedia; kind: Kind } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [minArea, setMinArea] = useState(0.4);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [recording, setRecording] = useState<"idle" | "recording" | "done">("idle");
  const [videoHref, setVideoHref] = useState<{ url: string; name: string } | null>(null);
  const [frameHref, setFrameHref] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const sides = useRef(new Map<string, "left" | "right">());
  const tints = useRef(new Map<string, HTMLCanvasElement | null>());
  const [colors, setColors] = useState(FALLBACK);
  useEffect(() => setColors(speakerColors(wrap.current)), []);

  const scene = kind === "image" ? image : video;
  const audioUrl = useObjectUrl(audio?.blob ?? null);
  const sceneUrl = useObjectUrl(scene?.blob ?? null);
  const ready = !!analyzed && analyzed.audio === audio && analyzed.scene === scene && analyzed.kind === kind && !!turns;
  const fps = scene?.fps ?? 24;

  const people: Person[] = useMemo(() => peopleOf(records, minArea / 100), [records, minArea]);
  const speakers = useMemo(() => speakersOf(turns ?? []), [turns]);
  const chunks = useMemo(() => captionChunks(turns ?? [], maxWords), [turns, maxWords]);
  const byFrame = useMemo(() => recordsByFrame(records), [records]);
  const durationMs = audio?.durationMs ?? turns?.at(-1)?.endMs ?? 1;

  // Head anchors per person and frame, smoothed across frames for the clip.
  const anchors = useMemo(() => {
    const out = new Map<string, Map<number, { x: number; y: number }>>();
    for (const r of records) {
      const res = decodeMaskRaster(r.mask);
      const a = headAnchor(res.ok ? res.raster : null, r.box);
      if (!out.has(r.objectId)) out.set(r.objectId, new Map());
      out.get(r.objectId)!.set(r.frame, a);
    }
    if (kind === "video") for (const [k, m] of out) out.set(k, smoothAnchors(m, 3));
    return out;
  }, [records, kind]);

  // Load the photo for drawing.
  useEffect(() => {
    if (kind !== "image" || !sceneUrl) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.src = sceneUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, sceneUrl]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const source = kind === "image" ? imgRef.current : videoRef.current;
    const W = (kind === "image" ? imgRef.current?.naturalWidth : videoRef.current?.videoWidth) || scene?.width || 1280;
    const H = (kind === "image" ? imgRef.current?.naturalHeight : videoRef.current?.videoHeight) || scene?.height || 720;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    if (source) ctx.drawImage(source, 0, 0, W, H);
    if (!ready) return;
    const ms = audioRef.current ? audioRef.current.currentTime * 1000 : t;
    const frame = kind === "image" ? 0 : Math.max(0, Math.floor((videoRef.current?.currentTime ?? 0) * fps));
    const chunk = chunkAt(chunks, ms);
    if (!chunk) return;
    const personId = mapping[chunk.speaker];
    if (!personId) return;
    const color = colors[Math.max(0, speakers.indexOf(chunk.speaker)) % colors.length];
    const frameRecords = kind === "image" ? (byFrame.get(0) ?? records) : (byFrame.get(frame) ?? []);
    const rec = frameRecords.find((r) => r.objectId === personId) ?? null;
    const anchor = kind === "image" ? (anchors.get(personId)?.get(0) ?? null) : anchorNear(anchors.get(personId) ?? new Map(), frame, 6);
    if (!anchor) return;
    // Only the speaker is highlighted; the other tracks stay hidden, as the recipe's preview does.
    if (highlight && rec) {
      const key = `${rec.frame}:${rec.objectId}:${color}`;
      if (!tints.current.has(key)) {
        if (tints.current.size > 400) tints.current.clear();
        tints.current.set(key, tintedMask(rec, color, 125));
      }
      const m = tints.current.get(key);
      if (m) ctx.drawImage(m, rec.box.x1, rec.box.y1, rec.box.x2 - rec.box.x1 + 1, rec.box.y2 - rec.box.y1 + 1);
    }
    const box = rec?.box ?? people.find((p) => p.id === personId)?.box ?? { x1: anchor.x - 40, y1: anchor.y, x2: anchor.x + 40, y2: anchor.y + 200 };
    const others = frameRecords
      .filter((r) => r.objectId !== personId && people.some((p) => p.id === r.objectId))
      .map((r) => ({ x: r.box.x1, y: r.box.y1, w: r.box.x2 - r.box.x1 + 1, h: r.box.y2 - r.box.y1 + 1 }));
    const fontPx = Math.max(14, Math.round(W * 0.021));
    ctx.font = `700 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = wrapText(chunk.text, W * 0.3, measure);
    const padX = fontPx * 0.75;
    const padY = fontPx * 0.55;
    const lineH = fontPx * 1.25;
    const size = { w: Math.max(...lines.map(measure)) + padX * 2, h: lines.length * lineH + padY * 2 };
    const place = placeBubble({ anchor, size, frame: { w: W, h: H }, face: faceRect(anchor, box), others, prefer: sides.current.get(chunk.speaker), gap: fontPx * 0.7 });
    sides.current.set(chunk.speaker, place.side);
    const { rect, tail } = place;
    const r = Math.min(fontPx * 0.9, rect.h / 2);
    const line = Math.max(2, fontPx * 0.12);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111112";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(tail[0].x, tail[0].y);
    ctx.lineTo(tail[2].x, tail[2].y);
    ctx.lineTo(tail[1].x, tail[1].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, r);
    ctx.fill();
    ctx.stroke();
    // Cover the bubble's outline where the tail joins it.
    ctx.beginPath();
    ctx.moveTo(tail[0].x + (tail[2].x - tail[0].x) * 0.12, tail[0].y + (tail[2].y - tail[0].y) * 0.12);
    ctx.lineTo(tail[1].x + (tail[2].x - tail[1].x) * 0.12, tail[1].y + (tail[2].y - tail[1].y) * 0.12);
    ctx.lineTo(tail[1].x, tail[1].y);
    ctx.lineTo(tail[0].x, tail[0].y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#111112";
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, rect.x + padX, rect.y + padY + i * lineH + (lineH - fontPx) / 2));
    // The speaker's label on the bubble's corner, in their color.
    const tag = chunk.speaker;
    ctx.font = `800 ${Math.round(fontPx * 0.7)}px system-ui, sans-serif`;
    const tw = ctx.measureText(tag).width + fontPx * 0.6;
    const th = fontPx * 0.95;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(rect.x + rect.w - tw * 0.6, rect.y - th * 0.55, tw, th, th / 2);
    ctx.fill();
    ctx.fillStyle = "#111112";
    ctx.textBaseline = "middle";
    ctx.fillText(tag, rect.x + rect.w - tw * 0.6 + fontPx * 0.3, rect.y - th * 0.55 + th / 2);
  }, [kind, scene, ready, t, fps, chunks, mapping, colors, speakers, byFrame, records, anchors, highlight, people]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Follow playback.
  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    const loop = () => {
      const a = audioRef.current;
      if (a) setT(a.currentTime * 1000);
      draw();
      handle = window.requestAnimationFrame(loop);
    };
    handle = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(handle);
  }, [playing, draw]);

  const analyze = async () => {
    if (!audio || !scene) return;
    setProblem(null);
    setTurns(null);
    setRecords([]);
    setSamFinal(null);
    setVideoHref(null);
    setFrameHref(null);
    sides.current.clear();
    tints.current.clear();
    const transcribe = async () => {
      const form = new FormData();
      form.append("request", JSON.stringify(transcribeRequestPart({ mode: "DIARIZATION" })));
      form.append("audio", audio.blob, /\.wav$/i.test(audio.name) ? audio.name : "conversation.wav");
      const res = await voice.run("asr/transcribe", { form });
      if (!res.ok) return null;
      setVoiceReply(res.json);
      return speechTurns((res.json as { turns?: [] } | null)?.turns);
    };
    const segment = async () => {
      let media: MediaRef;
      if (kind === "video") {
        // The recipe uploads the video and segments it by file_id; a re-analysis of the same clip reuses the upload.
        let fileId = upload && upload.file === scene ? upload.fileId : null;
        if (!fileId) {
          setSamPhase("uploading");
          const form = new FormData();
          for (const [k, v] of fileUploadFields({})) form.append(k, v);
          form.append("file", scene.blob, scene.name);
          const res = await sam.run("files", { form });
          const got = (res.json as { id?: unknown } | null)?.id;
          if (!res.ok || typeof got !== "string") {
            setSamPhase(null);
            return null;
          }
          fileId = got;
          setUpload({ fileId, file: scene });
        }
        media = { fileId };
      } else media = { dataUrl: await fileToDataUrl(scene.blob, scene.mime) };
      setSamPhase("segmenting");
      const { path, body } = samRequest({ prompt: concept, media, kind, stream: true, maskEncoding: "one_bit" });
      const parser = new SamStreamParser();
      let sawDelta = false;
      let final: unknown = null;
      const res = await sam.run(path, {
        body,
        stream: true,
        onEvent: (e) => {
          const delta = samDelta(e.json);
          if (delta !== null) {
            sawDelta = true;
            if (parser.push(delta).length) setRecords(parser.output().records);
            return;
          }
          if (e.json?.type === "response.completed" || e.json?.type === "response.incomplete") {
            final = e.json.response ?? null;
            if (!sawDelta && final) parser.push(samTextOfResponse(final));
          }
        },
        // Recorded below with what SAM found, rather than the start of the wire text.
        record: false,
      });
      parser.end();
      setSamPhase(null);
      setSamFinal(final);
      const out = parser.output().records;
      recordRequest({
        method: "POST",
        path,
        body: trimForRecord(body),
        status: res.status,
        outcome: samRunOutcome({ ok: res.ok, status: res.status, aborted: res.error?.code === "aborted", error: res.error?.message, media: kind, records: out }),
      });
      setRecords(out);
      return res.ok ? out : null;
    };
    // The two analyses run in parallel, as the recipe's server runs them.
    const [heard, found] = await Promise.all([transcribe(), segment()]);
    if (!heard || !found) return;
    setTurns(heard);
    if (!heard.length) {
      setProblem("The transcription came back without speaker turns, so there's nothing to caption. Try again, or a clip with two clear voices.");
      return;
    }
    const ppl = peopleOf(found, minArea / 100);
    if (!ppl.length) {
      setProblem(`SAM found no ${concept} big enough to caption. Lower the minimum size, or pick another scene.`);
      return;
    }
    setMapping(defaultMapping(speakersOf(heard), ppl));
    setAnalyzed({ audio, scene, kind });
    setT(heard[0]?.startMs ?? 0);
    if (audioRef.current) audioRef.current.currentTime = (heard[0]?.startMs ?? 0) / 1000 + 0.05;
  };

  const seekTo = (ms: number) => {
    setT(ms);
    if (audioRef.current) audioRef.current.currentTime = ms / 1000;
    window.requestAnimationFrame(draw);
  };

  const playLine = (speaker: string) => {
    const first = turns?.find((x) => x.speaker === speaker);
    const a = audioRef.current;
    if (!first || !a) return;
    a.currentTime = first.startMs / 1000;
    void a.play();
    const stopAt = first.endMs / 1000;
    const check = () => {
      if (a.currentTime >= stopAt) {
        a.pause();
        a.removeEventListener("timeupdate", check);
      }
    };
    a.addEventListener("timeupdate", check);
  };

  const saveFrame = () => {
    canvasRef.current?.toBlob((b) => {
      if (!b) return;
      if (frameHref) URL.revokeObjectURL(frameHref);
      setFrameHref(URL.createObjectURL(b));
    }, "image/png");
  };

  // Records the preview in real time: the canvas as video and the call as audio, the way the recipe's render step
  // makes its MP4 (this makes WebM, or MP4 where the browser records that).
  const audioGraph = useRef<{ ctx: AudioContext; node: MediaElementAudioSourceNode; el: HTMLAudioElement } | null>(null);
  const record = async () => {
    const c = canvasRef.current;
    const a = audioRef.current;
    if (!c || !a || typeof MediaRecorder === "undefined") return;
    setProblem(null);
    try {
      // An element can feed one source node, and the player remounts after a new analysis: rebuild for a new element.
      if (!audioGraph.current || audioGraph.current.el !== a) {
        void audioGraph.current?.ctx.close().catch(() => {});
        const ctx = new AudioContext();
        const node = ctx.createMediaElementSource(a);
        node.connect(ctx.destination);
        audioGraph.current = { ctx, node, el: a };
      }
      const { ctx, node } = audioGraph.current;
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      node.connect(dest);
      const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.onstop = () => {
        node.disconnect(dest);
        const blob = new Blob(parts, { type: rec.mimeType || "video/webm" });
        setVideoHref((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return { url: URL.createObjectURL(blob), name: `captioned.${blob.type.includes("mp4") ? "mp4" : "webm"}` };
        });
        setRecording("done");
      };
      a.currentTime = 0;
      if (videoRef.current) videoRef.current.currentTime = 0;
      setRecording("recording");
      rec.start(500);
      await a.play();
      const stopWhenDone = () => {
        a.removeEventListener("ended", stopWhenDone);
        if (rec.state !== "inactive") rec.stop();
      };
      a.addEventListener("ended", stopWhenDone);
    } catch (err) {
      setRecording("idle");
      setProblem(err instanceof Error ? err.message : "Recording the preview failed.");
    }
  };

  const current = ready ? chunkAt(chunks, t) : null;
  const currentPerson = current ? mapping[current.speaker] : null;
  const samCost = kind === "video" ? samVideoCost(scene?.frames ?? 50) : 0.0025;
  const voiceCost = ((Math.floor((audio?.durationMs ?? 0) / 1000) / 3600) * 0.18) || 0;

  return (
    <div className={`pg ${styles.stack}`} ref={wrap}>
      <div className="pg-bar">
        {kinds.length > 1 ? (
          <Segmented<Kind>
            label="Scene"
            value={kind}
            onChange={setKind}
            disabled={busy}
            options={kinds.map((k) => ({ value: k, label: k === "image" ? "Street photo" : "Street clip (bubbles follow the track)" }))}
          />
        ) : null}
      </div>
      <div className={styles.row}>
        <ModelSelect kind="voice" value="muse-voice-transcribe-1.0" onChange={() => {}} label="Voices" />
        <ModelSelect kind="sam" value="sam-3.1" onChange={() => {}} label="People" />
      </div>

      <div className={styles.row} style={{ alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <FilePicker label="Conversation audio" accept="audio/*,.wav,.mp3,.m4a" value={audio} onChange={setAudio} samples={["audio"]} defaultSampleId={audioSampleId} preview="compact" disabled={busy} />
        </div>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          {kind === "image" ? (
            <FilePicker key="image" label="Scene" accept="image/png,image/jpeg,image/webp" value={image} onChange={setImage} samples={["image"]} defaultSampleId={imageSampleId} preview="compact" disabled={busy} />
          ) : (
            <FilePicker key="video" label="Scene (MP4, up to 3 MB here)" accept="video/mp4,video/quicktime" value={video} onChange={setVideo} samples={["video"]} defaultSampleId={videoSampleId} forSam preview="compact" disabled={busy} />
          )}
        </div>
      </div>

      <div className={styles.row}>
        <RunButton
          running={busy}
          onRun={() => void analyze()}
          onStop={() => {
            voice.abort();
            sam.abort();
          }}
          label="Analyze voices and people"
          disabled={!audio || !scene || [audio, scene].some((f) => (f?.problems.length ?? 0) > 0)}
        />
        <span className={styles.note}>
          {kind === "video"
            ? `In parallel: diarization (about ${formatUsd(voiceCost)}), and the clip's upload followed by SAM "${concept}" by file_id (about ${formatUsd(samCost)} for its frames).`
            : `Two calls in parallel: diarization (about ${formatUsd(voiceCost)}) and SAM "${concept}" on the photo ($0.0025).`}
        </span>
      </div>

      <ul className={styles.progressList} aria-live="polite" aria-label="Analysis">
        <li className={styles.progressItem}>
          <Icon name={voice.state === "running" ? "refresh" : turns ? "check" : voice.state === "error" ? "alert" : "mic"} size={15} />
          <span>
            Muse Voice Transcribe, DIARIZATION:{" "}
            {voice.state === "running"
              ? "transcribing..."
              : turns
                ? `${turns.length} turns from ${speakers.length} speaker${speakers.length === 1 ? "" : "s"} (${speakers.join(", ") || "none"}) in ${(voice.elapsedMs / 1000).toFixed(1)} s`
                : voice.state === "error"
                  ? "failed"
                  : "not run yet"}
          </span>
        </li>
        <li className={styles.progressItem}>
          <Icon name={sam.state === "running" ? "refresh" : records.length ? "check" : sam.state === "error" ? "alert" : "image"} size={15} />
          <span>
            SAM 3.1, &quot;{concept}&quot;:{" "}
            {sam.state === "running"
              ? samPhase === "uploading"
                ? "uploading the clip with purpose=user_data..."
                : `segmenting${records.length ? `, ${new Set(records.map((r) => r.objectId)).size} so far` : "..."}`
              : records.length
                ? `${new Set(records.map((r) => r.objectId)).size} found, ${people.length} big enough to caption${kind === "video" ? ` across ${byFrame.size} frames` : ""}`
                : sam.state === "error"
                  ? "failed"
                  : sam.state === "done"
                    ? "nobody found"
                    : "not run yet"}
          </span>
        </li>
      </ul>
      <ErrorBox error={voice.error ?? sam.error} />
      {problem ? <p className={styles.problem}>{problem}</p> : null}

      {ready ? (
        <div className={styles.stack}>
          <div className={styles.tight}>
            <span className="pg-section-label">Match each voice to a person</span>
            <div className={styles.mapping}>
              {speakers.map((s, i) => (
                <div key={s} className={styles.speakerCard} style={{ borderLeftColor: colors[i % colors.length] }}>
                  <div className={styles.spread}>
                    <span className={styles.strong}>Speaker {s}</span>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => playLine(s)}>
                      <Icon name="play" size={14} />
                      Play {s}&apos;s first line
                    </button>
                  </div>
                  <label className={styles.control} htmlFor={`${id}-map-${s}`}>
                    Is
                    <span className="select-wrap">
                      <select id={`${id}-map-${s}`} className="select pg-select" value={mapping[s] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [s]: e.target.value }))}>
                        <option value="">Nobody here (no bubble)</option>
                        {people.map((p, rank) => (
                          <option key={p.id} value={p.id}>
                            Person {p.id}: {rank === 0 ? "the largest" : `size ${rank + 1}`}, {Math.round(((p.box.x1 + p.box.x2) / 2 / ((records[0]?.box.w ?? 1280) || 1280)) * 100)}% from the left
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <p className={styles.note}>&ldquo;{turns?.find((x) => x.speaker === s)?.text.slice(0, 90)}&rdquo;</p>
                </div>
              ))}
            </div>
            <div className={`${styles.row} pg-advanced`}>
              <label className={styles.control} htmlFor={`${id}-area`}>
                Skip people smaller than
                <input id={`${id}-area`} type="range" min={0.1} max={4} step={0.1} value={minArea} onChange={(e) => setMinArea(Number(e.target.value))} />
                <span className={styles.mono}>{minArea.toFixed(1)}% of the frame</span>
              </label>
              <Toggle id={`${id}-hl`} label="Highlight the speaker" checked={highlight} onChange={setHighlight} />
            </div>
          </div>

          <div className={styles.stage}>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={current ? `Speaker ${current.speaker}${currentPerson ? `, person ${currentPerson}` : ""}, says: ${current.text}` : "The scene, with no one speaking right now"}
            />
          </div>
          {kind === "video" && sceneUrl ? (
            <video ref={videoRef} src={sceneUrl} muted loop playsInline preload="auto" style={{ display: "none" }} onLoadedData={() => draw()} />
          ) : null}
          <p className={styles.note} aria-live="polite">
            {current ? (
              <>
                <span className={styles.strong}>{current.speaker}:</span> {current.text}
              </>
            ) : (
              "Nobody is speaking at this moment."
            )}
          </p>
          <div className={styles.timeline} aria-label="Speech turns">
            {turns?.map((x) => (
              <button
                key={x.turnId}
                type="button"
                className={styles.segment}
                style={{ left: `${(x.startMs / durationMs) * 100}%`, width: `${((x.endMs - x.startMs) / durationMs) * 100}%`, background: colors[Math.max(0, speakers.indexOf(x.speaker)) % colors.length] }}
                onClick={() => seekTo(x.startMs + 30)}
                title={`${x.speaker}, ${formatDuration(x.startMs)}: ${x.text}`}
                aria-label={`Go to ${x.speaker} at ${formatDuration(x.startMs)}: ${x.text}`}
              >
                {x.speaker}
              </button>
            ))}
            <span className={styles.playhead} style={{ left: `${Math.min(100, (t / durationMs) * 100)}%` }} aria-hidden="true" />
          </div>
          {audioUrl ? (
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              preload="auto"
              className={styles.range}
              onPlay={() => {
                setPlaying(true);
                void videoRef.current?.play().catch(() => {});
              }}
              onPause={() => {
                setPlaying(false);
                videoRef.current?.pause();
                setT((audioRef.current?.currentTime ?? 0) * 1000);
              }}
              onSeeked={() => {
                setT((audioRef.current?.currentTime ?? 0) * 1000);
                window.requestAnimationFrame(draw);
              }}
            />
          ) : null}
          <div className={styles.downloads}>
            <button type="button" className="btn btn-outline btn-sm" onClick={saveFrame}>
              <Icon name="image" size={16} />
              Save this frame as PNG
            </button>
            {frameHref ? (
              <a className="btn btn-outline btn-sm" href={frameHref} download="captioned-frame.png">
                <Icon name="download" size={16} />
                captioned-frame.png
              </a>
            ) : null}
            {typeof window !== "undefined" && typeof MediaRecorder !== "undefined" ? (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void record()} disabled={recording === "recording"}>
                <Icon name="video" size={16} />
                {recording === "recording" ? `Recording (${formatDuration(durationMs)} in real time)...` : "Record the captioned video"}
              </button>
            ) : null}
            {videoHref ? (
              <a className="btn btn-outline btn-sm" href={videoHref.url} download={videoHref.name}>
                <Icon name="download" size={16} />
                {videoHref.name}
              </a>
            ) : null}
          </div>
          <details className={styles.details}>
            <summary>Transcript with speakers</summary>
            <ol className={styles.flow}>
              {turns?.map((x) => (
                <li key={x.turnId}>
                  <span className={styles.mono}>[{(x.startMs / 1000).toFixed(2)}s]</span> <strong>{x.speaker}:</strong> {x.text}
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}

      {voice.result || sam.result || busy ? (
        <details className={styles.details}>
          <summary>The two replies</summary>
          <div className={styles.stack}>
            <ResponseView result={voice.result} running={voice.state === "running"} elapsedMs={voice.elapsedMs} model="muse-voice-transcribe-1.0" usage={{}} json={voiceReply ?? undefined} />
            <ResponseView result={sam.result} running={sam.state === "running"} elapsedMs={sam.elapsedMs} model="sam-3.1" json={samFinal ?? undefined} usage={(samFinal as { usage?: unknown } | null)?.usage ?? undefined}>
              <p className={styles.note}>{records.length ? `${new Set(records.map((r) => r.objectId)).size} tracked ${concept}, ${records.length} box and mask records.` : "No records yet."}</p>
            </ResponseView>
          </div>
        </details>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className={styles.stack}>
          <CodeView
            method="POST"
            path="asr/transcribe"
            form={[
              { name: "request", value: JSON.stringify(transcribeRequestPart({ mode: "DIARIZATION" })) },
              { name: "audio", value: audio?.name ?? "conversation.wav", file: { label: "Audio (16 kHz mono WAV)", accept: "audio/wav" } },
            ]}
            caption="1. Who spoke when (runs at the same time as 2)"
          />
          {kind === "video" ? (
            <CodeView
              method="POST"
              path="files"
              form={[...fileUploadFields({}).map(([name, value]) => ({ name, value })), { name: "file", value: scene?.name ?? "conversation.mp4", file: { label: "Video", accept: "video/mp4" } }]}
              caption="2a. Upload the video (once; a re-analysis reuses the file id)"
            />
          ) : null}
          <CodeView
            method="POST"
            path="responses"
            body={
              samRequest({
                prompt: concept,
                media: kind === "video" ? { fileId: upload?.fileId ?? "file-abc123" } : { dataUrl: "data:image/jpeg;base64,<BASE64>" },
                kind,
                stream: true,
                maskEncoding: "one_bit",
              }).body
            }
            stream
            caption={`${kind === "video" ? "2b" : "2"}. Every ${concept === "people" ? "person" : concept}, with one_bit masks${kind === "video" ? " and tracks, by file_id" : ""}`}
          />
        </div>
      ) : null}
    </div>
  );
}
