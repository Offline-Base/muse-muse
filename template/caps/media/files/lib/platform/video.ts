// Platform file (Muse Muse platform services). Don't edit: products call imagesToVideo.
//
// A real video from a sequence of pictures, made in the page: each picture is drawn on a canvas, encoded with the
// browser's own video encoder (WebCodecs), and written as an MP4 by lib/platform/mp4.ts. H.264 when the browser can
// encode it (Chrome, Edge and Safari can), else VP9. No ffmpeg, no upload, no special page headers. A browser without
// WebCodecs (older Firefox) records the canvas in real time with MediaRecorder instead, which is slower and gives
// WebM. Browser only.
import { MediaError } from "./media-assets";
import { muxMp4, type Mp4Sample } from "./mp4";

export const VIDEO_FRAMES_MAX = 120;
export const VIDEO_SIDE_MAX = 1280;

/** A picture: an image URL or data URL, a Blob or File, an <img> or <canvas>, or a decoded bitmap. */
export type FrameSource = string | Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

export interface VideoOptions {
  /** Pictures a second: 1 for a slideshow, 8 to 12 for a flipbook. 2 by default. 0.2 to 60. */
  fps?: number;
  /** The video's size. By default the first picture's, at most VIDEO_SIDE_MAX on the long side. */
  width?: number;
  height?: number;
  /** "contain" (letterbox, by default) or "cover" (crop to fill). */
  fit?: "contain" | "cover";
  /** The letterbox color, black by default. */
  background?: string;
  /** Bits a second; about 4 MB a minute at 720p by default. */
  bitrate?: number;
  /** 0 to 1 as the pictures are encoded. */
  onProgress?: (done: number) => void;
  /** Force a path, for tests: "webcodecs" or "recorder". */
  method?: "webcodecs" | "recorder";
  /** Only this codec, for tests and for SAM, which takes H.264 but not VP9. */
  codec?: "avc" | "vp9";
}

export interface MadeVideo {
  blob: Blob;
  /** An object URL for <video src> and a download link. Revoke it with URL.revokeObjectURL when done. */
  url: string;
  mimeType: string;
  durationMs: number;
  width: number;
  height: number;
  frames: number;
  /** "avc" (H.264 MP4), "vp9" (VP9 MP4) or "recorder" (MediaRecorder, usually WebM). */
  codec: "avc" | "vp9" | "recorder";
}

async function toBitmap(src: FrameSource): Promise<ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas> {
  if (typeof src === "string") {
    const res = await fetch(src).catch(() => null);
    if (!res?.ok) throw new MediaError("invalid", "One of the pictures couldn't be loaded.");
    return createImageBitmap(await res.blob()).catch(() => {
      throw new MediaError("invalid", "One of the pictures isn't an image this browser can read.");
    });
  }
  if (src instanceof Blob) {
    return createImageBitmap(src).catch(() => {
      throw new MediaError("invalid", "One of the pictures isn't an image this browser can read.");
    });
  }
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement && !src.complete) await src.decode().catch(() => undefined);
  return src;
}

function sizeOf(img: ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas): [number, number] {
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return [img.naturalWidth, img.naturalHeight];
  return [img.width, img.height];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The video's size: as asked, or the first picture's, kept under VIDEO_SIDE_MAX, both sides even (encoders need it). */
export function videoSize(first: [number, number], opts: Pick<VideoOptions, "width" | "height"> = {}): [number, number] {
  let [w, h] = opts.width && opts.height ? [opts.width, opts.height] : first;
  if (!w || !h) throw new MediaError("invalid", "The first picture has no size.");
  const scale = Math.min(1, VIDEO_SIDE_MAX / Math.max(w, h));
  w *= scale;
  h *= scale;
  return [even(w), even(h)];
}

function draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, w: number, h: number, fit: "contain" | "cover", background: string) {
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  const s = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** The first encoder config this browser supports for the size: H.264 levels 3.1 to 5.1, then VP9. */
export async function pickVideoCodec(width: number, height: number, bitrate: number, fps: number, only?: "avc" | "vp9"): Promise<{ kind: "avc" | "vp9"; config: VideoEncoderConfig } | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const base = { width, height, bitrate, framerate: Math.max(1, fps), latencyMode: "quality" as const };
  // A level caps the frame size in 16-pixel blocks: 3.1 takes 1280x720, 4.0 takes 2048x1024, 5.1 more.
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const avc = [
    ["avc1.42E01F", 3600],
    ["avc1.4D0028", 8192],
    ["avc1.640028", 8192],
    ["avc1.640033", 36864],
  ] as const;
  const tries: Array<{ kind: "avc" | "vp9"; config: VideoEncoderConfig }> = [
    ...avc.filter(([, max]) => blocks <= max).map(([codec]) => ({ kind: "avc" as const, config: { ...base, codec, avc: { format: "avc" as const } } })),
    ...["vp09.00.31.08", "vp09.00.40.08"].map((codec) => ({ kind: "vp9" as const, config: { ...base, codec } })),
  ];
  for (const t of tries.filter((x) => !only || x.kind === only)) {
    const ok = await VideoEncoder.isConfigSupported(t.config).then((r) => r.supported === true, () => false);
    if (ok) return t;
  }
  return null;
}

type MediaRecord = { video?: { durationMs: number; frames: number; bytes: number; codec: MadeVideo["codec"]; at: number } };

function record(entry: NonNullable<MediaRecord["video"]>) {
  const w = window as unknown as { __musemuseMedia?: MediaRecord };
  w.__musemuseMedia = { ...(w.__musemuseMedia ?? {}), video: entry };
}

async function encodeWithWebCodecs(
  pictures: Array<ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas>,
  codec: { kind: "avc" | "vp9"; config: VideoEncoderConfig },
  w: number,
  h: number,
  fps: number,
  opts: VideoOptions,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const samples: Mp4Sample[] = [];
  let description: Uint8Array | undefined;
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? Math.round(1e6 / fps), key: chunk.type === "key" });
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
    },
    error(err) {
      failure = err;
    },
  });
  encoder.configure(codec.config);
  const frameUs = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  for (let i = 0; i < pictures.length; i++) {
    const [iw, ih] = sizeOf(pictures[i]!);
    draw(ctx, pictures[i]! as CanvasImageSource, iw, ih, w, h, opts.fit ?? "contain", opts.background ?? "#000");
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
    encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    // Keep the encoder's queue short, so a long sequence doesn't hold every frame in memory at once.
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
    opts.onProgress?.((i + 1) / pictures.length);
    if (failure) break;
  }
  await encoder.flush().catch((err) => (failure = failure ?? err));
  encoder.close();
  if (failure) throw new MediaError("failed", "The video couldn't be made in this browser.");
  samples.sort((a, b) => a.timestampUs - b.timestampUs);
  return muxMp4({ codec: codec.kind, width: w, height: h, description, vp9: { profile: 0, level: codec.config.codec.endsWith(".40.08") ? 40 : 31 }, samples });
}

async function recordCanvas(pictures: Array<ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas>, w: number, h: number, fps: number, opts: VideoOptions): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") throw new MediaError("unsupported", "This browser can't make videos. Try Chrome, Edge or Safari.");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: opts.bitrate } : undefined);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  for (let i = 0; i < pictures.length; i++) {
    const [iw, ih] = sizeOf(pictures[i]!);
    draw(ctx, pictures[i]! as CanvasImageSource, iw, ih, w, h, opts.fit ?? "contain", opts.background ?? "#000");
    track.requestFrame();
    opts.onProgress?.((i + 1) / pictures.length);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  await done;
  return new Blob(parts, { type: rec.mimeType || "video/webm" });
}

/**
 * Pictures to a video the page can play and save. Throws a MediaError with plain words for no pictures, too many, a
 * picture that won't load, or a browser that can't make video.
 */
export async function imagesToVideo(frames: readonly FrameSource[], opts: VideoOptions = {}): Promise<MadeVideo> {
  if (!frames.length) throw new MediaError("invalid", "Add at least one picture to make a video.");
  if (frames.length > VIDEO_FRAMES_MAX) throw new MediaError("too_large", `A video can have at most ${VIDEO_FRAMES_MAX} pictures.`);
  const fps = Math.min(60, Math.max(0.2, opts.fps ?? 2));
  const pictures = await Promise.all(frames.map(toBitmap));
  const [w, h] = videoSize(sizeOf(pictures[0]!), opts);
  const bitrate = opts.bitrate ?? Math.round(Math.min(8_000_000, Math.max(500_000, w * h * 0.6 * Math.min(fps, 30) / 4)));
  const codec = opts.method === "recorder" ? null : await pickVideoCodec(w, h, bitrate, fps, opts.codec);
  let blob: Blob;
  let kind: MadeVideo["codec"];
  if (codec) {
    const bytes = await encodeWithWebCodecs(pictures, codec, w, h, fps, { ...opts, bitrate });
    blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
    kind = codec.kind;
  } else {
    if (opts.codec === "avc") throw new MediaError("unsupported", "This browser can't make H.264 video, which this needs. Try Chrome, Edge or Safari.");
    if (opts.method === "webcodecs" || opts.codec) throw new MediaError("unsupported", "This browser can't encode video with WebCodecs.");
    blob = await recordCanvas(pictures, w, h, fps, { ...opts, bitrate });
    kind = "recorder";
  }
  for (const p of pictures) if (typeof ImageBitmap !== "undefined" && p instanceof ImageBitmap && !frames.includes(p)) p.close();
  const durationMs = Math.round((frames.length / fps) * 1000);
  record({ durationMs, frames: frames.length, bytes: blob.size, codec: kind, at: Date.now() });
  return { blob, url: URL.createObjectURL(blob), mimeType: blob.type, durationMs, width: w, height: h, frames: frames.length, codec: kind };
}
