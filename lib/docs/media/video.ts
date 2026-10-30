import { formatBytes } from "@/lib/docs/media/base64";
import { codecLabel, parseMp4, samAcceptsCodec, type Mp4Info } from "@/lib/docs/media/mp4";

/**
 * Size and length checks for video demos. Demos send a clip inline as a data URL (or upload it through the Files API
 * proxy), and the docs proxy refuses bodies over 4.5 MB, so a clip stays under 3 MB: its base64 is about 4 MB.
 */

export const MAX_INLINE_VIDEO_BYTES = 3 * 1024 * 1024;
/** Longer clips cost more to segment (SAM bills per frame) and take longer to read; demos keep to short ones. */
export const MAX_DEMO_VIDEO_SECONDS = 30;

export interface VideoFacts {
  bytes: number;
  mime: string;
  name?: string;
  /** From the MP4 header or the browser, when known. */
  durationSec?: number;
  codec?: string | null;
}

/** What's wrong with a clip for an inline demo, as sentences for the reader. Empty when it's fine. */
export function videoProblems(
  v: VideoFacts,
  limits: { maxBytes?: number; maxSeconds?: number; forSam?: boolean } = {},
): string[] {
  const maxBytes = limits.maxBytes ?? MAX_INLINE_VIDEO_BYTES;
  const maxSeconds = limits.maxSeconds ?? MAX_DEMO_VIDEO_SECONDS;
  const problems: string[] = [];
  const type = v.mime.toLowerCase();
  if (type === "video/webm" || /\.webm$/i.test(v.name ?? "")) {
    problems.push("WebM isn't accepted. Use an MP4 with H.264 video.");
  } else if (type && type !== "video/mp4" && type !== "video/quicktime") {
    problems.push(`${v.mime} isn't a video type these demos send. Use an MP4.`);
  }
  if (v.bytes > maxBytes) {
    problems.push(
      `This clip is ${formatBytes(v.bytes)}. Demos send video inline up to ${formatBytes(maxBytes)}, so trim it or lower its resolution.`,
    );
  }
  if (v.durationSec !== undefined && v.durationSec > maxSeconds) {
    problems.push(`This clip runs ${Math.round(v.durationSec)} s. Keep demo clips to ${maxSeconds} s or less.`);
  }
  if (limits.forSam && v.codec !== undefined && !samAcceptsCodec(v.codec)) {
    problems.push(`SAM 3.1 takes H.264, H.265 or MPEG-4 video, and this clip is ${codecLabel(v.codec)}.`);
  }
  return problems;
}

/** Estimated SAM 3.1 cost for `frames` video frames: $0.20 per 1,000 frames, at least 50 per request. */
export function samVideoCost(frames: number): number {
  return (Math.max(50, Math.max(0, frames)) * 0.2) / 1000;
}

export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
  mp4: Mp4Info | null;
}

/**
 * Reads a clip's length, size and (for MP4/MOV) frame facts in the browser: the header first, then a hidden video
 * element for files whose header we can't read.
 */
export async function probeVideo(blob: Blob): Promise<VideoProbe> {
  const mp4 = parseMp4(new Uint8Array(await blob.arrayBuffer()));
  if (mp4 && mp4.durationSec > 0 && mp4.width > 0) {
    return { durationSec: mp4.durationSec, width: mp4.width, height: mp4.height, mp4 };
  }
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Timed out reading the video.")), 8000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("This browser can't read that video."));
      };
    });
    video.src = url;
    await ready;
    return { durationSec: video.duration, width: video.videoWidth, height: video.videoHeight, mp4 };
  } finally {
    URL.revokeObjectURL(url);
  }
}
