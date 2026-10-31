import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { blobToDataUrl } from "@/lib/client/resize";
import { toWav16k } from "@/lib/client/wav";
import { BRIDGE_LIMITS, BRIDGE_TIMEOUTS, glassesBridge, type GlassesErrorCode, type GlassesStatus } from "@/lib/glasses/bridge";
import { photoFromBlob, samplePhoto, sampleQuestion, wavSeconds, type GlassesSamples, type PhotoData } from "@/lib/glasses/samples";

/**
 * Platform file: don't edit. useGlasses gives a product one way to see and hear, wherever it runs: the wearer's glasses
 * inside the Muse Muse iPhone app, this device's camera and microphone in a browser, or the product's sample view. It
 * starts on the first of those this device has, and setSource changes it. Answers are spoken in the glasses when
 * they're in use, and otherwise by the browser. Client components only.
 */

export type GlassesSource = "glasses" | "phone" | "sample";

export interface GlassesPhoto extends PhotoData {
  source: GlassesSource;
}

export interface GlassesRecording {
  /** 16 kHz mono WAV as a data URL, ready for transcribeFile on the server. */
  wavDataUrl: string;
  seconds: number;
  source: GlassesSource;
}

export type GlassesClientErrorCode =
  | GlassesErrorCode
  | "not_connected"
  | "unavailable"
  | "no_camera"
  | "camera_blocked"
  | "no_microphone"
  | "mic_blocked"
  | "denied"
  | "no_audio"
  | "not_listening"
  | "no_sample";

const MESSAGES: Record<GlassesClientErrorCode, string> = {
  meta_ai_missing: "Install the Meta AI app on this phone, then try again.",
  permission_denied: "Allow camera access for your glasses in the Meta AI app, then try again.",
  no_eligible_device: "We can't find your glasses. Pair them in the Meta AI app, put them on, then try again.",
  glasses_app_update_required: "Your glasses need an update. Install it in the Meta AI app, then try again.",
  hinges_closed: "Open your glasses and put them on, then try again.",
  thermal: "Your glasses are too warm. Let them cool down, then try again.",
  battery_low: "Your glasses are low on battery. Charge them, then try again.",
  capture_failed: "That photo didn't work. Try again.",
  session_ended: "Your glasses disconnected. Connect them again.",
  timeout: "Your glasses took too long to answer. Try again.",
  not_connected: "Connect your glasses first.",
  unavailable: "Your glasses connect through the Muse Muse app on iPhone. Here, use this device's camera or the sample.",
  no_camera: "This device has no camera we can use. Try the sample.",
  camera_blocked: "Allow the camera for this page in your browser settings, then try again.",
  no_microphone: "This device has no microphone we can use. Try the sample.",
  mic_blocked: "Allow the microphone for this page in your browser settings, then try again.",
  denied: "Turn on the microphone for this app in Settings, then try again.",
  no_audio: "Couldn't hear that. Hold the button while you speak.",
  not_listening: "Hold the button while you speak.",
  no_sample: "There's no sample to show here. Try this device's camera.",
};

export class GlassesClientError extends Error {
  constructor(readonly code: GlassesClientErrorCode) {
    super(MESSAGES[code]);
    this.name = "GlassesClientError";
  }
}

/** One plain sentence to show for anything useGlasses or the bridge threw. */
export function glassesMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in MESSAGES) return MESSAGES[code as GlassesClientErrorCode];
  const message = err instanceof Error ? err.message.trim() : "";
  return message || "That didn't work. Try again.";
}

function toClientError(err: unknown, fallback: GlassesClientErrorCode): GlassesClientError {
  if (err instanceof GlassesClientError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return new GlassesClientError(typeof code === "string" && code in MESSAGES ? (code as GlassesClientErrorCode) : fallback);
}

/** The status chip's words, like "Ready · Ray-Ban Meta 80%". */
export function statusLabel(status: GlassesStatus): string {
  switch (status.state) {
    case "ready": {
      const battery = status.device?.battery;
      const about = [status.device?.name, typeof battery === "number" ? `${Math.round(battery)}%` : null].filter(Boolean).join(" ");
      return about ? `Ready · ${about}` : "Ready";
    }
    case "registering":
    case "connecting":
      return "Connecting";
    case "not-registered":
      return "Not connected";
    case "no-glasses":
      return "No glasses found";
    case "needs-meta-ai":
      return "Needs the Meta AI app";
    case "paused":
      return "Paused";
    case "error":
      return "Couldn't connect";
    case "unavailable":
      return "Needs the Muse Muse app";
  }
}

/** Which source a device starts on: glasses, then its own camera, then the sample view. */
export function firstSource(has: { glasses: boolean; camera: boolean }): GlassesSource {
  if (has.glasses) return "glasses";
  return has.camera ? "phone" : "sample";
}

export interface UseGlasses {
  /** Where photos and questions come from right now. */
  source: GlassesSource;
  /** The glasses' status. In a browser without the app its state is "unavailable". */
  status: GlassesStatus;
  /** True inside the Muse Muse iPhone app, when glasses can be connected. */
  inApp: boolean;
  /** True when the current source can take a photo right now. */
  ready: boolean;
  /** The last photo taken. Show it next to the answer. */
  photo: GlassesPhoto | null;
  recording: boolean;
  /** True while the live view is on. */
  previewing: boolean;
  /** The phone camera's live stream while the live view is on, for a <video>. Glasses draw their own, above the page. */
  stream: MediaStream | null;
  /** Connects the glasses. The first time, Meta AI opens to ask for permission. */
  connect(): Promise<GlassesStatus>;
  /** Takes a photo with the current source. maxSize is 64 to 1600 px, and anything outside that moves to the nearest. */
  capture(o?: { maxSize?: number }): Promise<GlassesPhoto>;
  /** Starts listening, for at most maxSeconds (20 by default, 60 at the most). */
  listen(o?: { maxSeconds?: number }): Promise<void>;
  /** Stops listening and returns the recording. */
  stop(): Promise<GlassesRecording>;
  /** Speaks an answer, up to its first 1000 characters. Don't wait for it before showing the answer. */
  say(text: string): Promise<void>;
  /** Turns the live view on or off. */
  preview(show: boolean): Promise<void>;
  setSource(source: GlassesSource): void;
}

const NO_BRIDGE: GlassesStatus = { state: "unavailable", mode: "real", device: null, error: null };
const noSubscribe = () => () => {};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GlassesClientError("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function stopTracks(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** How long a question can last: 20 seconds unless asked otherwise, and never past what the shell accepts. */
export function listenSeconds(maxSeconds?: number): number {
  return Number.isFinite(maxSeconds) ? Math.min(BRIDGE_LIMITS.maxSeconds, Math.max(1, maxSeconds as number)) : 20;
}

function photoSize(maxSize?: number): number | undefined {
  return Number.isFinite(maxSize) ? Math.min(BRIDGE_LIMITS.maxPhotoSize, Math.max(BRIDGE_LIMITS.minPhotoSize, maxSize as number)) : undefined;
}

/** True when the page embedding this one keeps a feature from it. No browser setting can change that. */
function blockedByEmbedder(feature: "camera" | "microphone"): boolean {
  if (typeof document === "undefined") return false;
  type Policy = { allowsFeature(feature: string): boolean };
  const { permissionsPolicy, featurePolicy } = document as unknown as { permissionsPolicy?: Policy; featurePolicy?: Policy };
  return (permissionsPolicy ?? featurePolicy)?.allowsFeature(feature) === false;
}

/** True when this browser can ask for a camera and has one. The phone source needs the microphone too. */
async function hasCamera(): Promise<boolean> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media?.getUserMedia) return false;
  if (blockedByEmbedder("camera") || blockedByEmbedder("microphone")) return false;
  try {
    return (await media.enumerateDevices()).some((device) => device.kind === "videoinput");
  } catch {
    return true;
  }
}

async function openMedia(constraints: MediaStreamConstraints, blocked: GlassesClientErrorCode, missing: GlassesClientErrorCode): Promise<MediaStream> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media?.getUserMedia) throw new GlassesClientError(missing);
  try {
    return await media.getUserMedia(constraints);
  } catch (err) {
    const denied = (err as { name?: string } | null)?.name === "NotAllowedError";
    // "Allow it in your browser settings" would be no help when the embedding page is what said no.
    throw new GlassesClientError(denied && !blockedByEmbedder(constraints.video ? "camera" : "microphone") ? blocked : missing);
  }
}

function openCamera(): Promise<MediaStream> {
  return openMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } } }, "camera_blocked", "no_camera");
}

/** One frame of a camera stream. A stream that just opened gets a moment to settle its exposure. */
async function grabFrame(stream: MediaStream, fresh: boolean, maxSize?: number): Promise<PhotoData> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // iPhones only play a video that's in the page.
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);
  try {
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, fresh ? 500 : 50));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width) throw new GlassesClientError("capture_failed");
    ctx.drawImage(video, 0, 0);
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!frame) throw new GlassesClientError("capture_failed");
    return await photoFromBlob(frame, maxSize);
  } finally {
    video.remove();
  }
}

type Recording =
  | { kind: "glasses" }
  | { kind: "sample"; url: string }
  | { kind: "phone"; finish: () => Promise<Blob>; cancel: () => void };

async function recordPhone(maxSeconds: number): Promise<Extract<Recording, { kind: "phone" }>> {
  // Inside the app, what said no is the phone's Settings, not a browser's.
  const stream = await openMedia({ audio: true }, glassesBridge() ? "denied" : "mic_blocked", "no_microphone");
  if (typeof MediaRecorder === "undefined") {
    stopTracks(stream);
    throw new GlassesClientError("no_microphone");
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      stopTracks(stream);
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };
  });
  const halt = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  recorder.start();
  const timer = setTimeout(halt, maxSeconds * 1000);
  return {
    kind: "phone",
    finish: () => {
      clearTimeout(timer);
      halt();
      return stopped;
    },
    cancel: () => {
      clearTimeout(timer);
      halt();
    },
  };
}

/** Ends a recording nobody will read. */
function dropRecording(active: Recording | null): void {
  if (active?.kind === "phone") active.cancel();
  if (active?.kind === "glasses") void glassesBridge()?.stopRecording().catch(() => {});
}

/** iPhones only let a page speak after a tap, so each press opens the way for the answer that comes later. */
function primeSpeech(): void {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return;
  if (!speechSynthesis.speaking) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

/** Speaks in the browser. Always resolves: some browsers never say that speech ended, and some can't speak at all. */
function speakInBrowser(text: string): Promise<void> {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000 + text.length * 120);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = done;
    utterance.onerror = done;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
}

export function useGlasses(options: { samples?: GlassesSamples } = {}): UseGlasses {
  // The server has no bridge, so the first render matches its HTML, and React re-renders with the bridge right after.
  const bridge = useSyncExternalStore(noSubscribe, glassesBridge, () => null);
  const [status, setStatus] = useState<GlassesStatus>(NO_BRIDGE);
  const [camera, setCamera] = useState(false);
  const [chosen, setChosen] = useState<GlassesSource | null>(null);
  const [photo, setPhoto] = useState<GlassesPhoto | null>(null);
  const [recording, setRecording] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const source = chosen ?? firstSource({ glasses: !!bridge, camera });
  const samples = options.samples;
  const ready = source === "glasses" ? status.state === "ready" : source === "phone" ? true : !!samples?.photos.length;

  // Everything an action reads goes through a ref, so a flow like `await connect(); await capture()` sees what's true
  // now, not what was true when the flow started.
  const statusRef = useRef(status);
  const sourceRef = useRef(source);
  const samplesRef = useRef(samples);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const sampleIndex = useRef(0);
  // What the glasses' live view was last told to be, set as the call goes out so hiding it never misses one on its way.
  const glassesPreviewing = useRef(false);
  // Only the newest live view call may change anything. Leaving or switching source counts as newer.
  const previewToken = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    sourceRef.current = source;
    samplesRef.current = samples;
  });

  const update = useCallback((next: GlassesStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    let live = true;
    void hasCamera().then((has) => {
      if (live) setCamera(has);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.status().then(
      (next) => {
        if (live) update(next);
      },
      () => {},
    );
    const off = bridge.onStatus(update);
    return () => {
      live = false;
      off();
    };
  }, [bridge, update]);

  const closeStream = useCallback(() => {
    stopTracks(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }, []);

  const hideGlassesPreview = useCallback(() => {
    if (!glassesPreviewing.current) return;
    glassesPreviewing.current = false;
    void glassesBridge()?.preview({ show: false }).catch(() => {});
  }, []);

  // Leaving the page turns the camera and microphone off, including the glasses'. A reload or a full navigation runs no
  // React cleanup, so pagehide does the same.
  useEffect(() => {
    mounted.current = true;
    const turnOff = () => {
      previewToken.current += 1;
      stopTracks(streamRef.current);
      streamRef.current = null;
      hideGlassesPreview();
      dropRecording(recordingRef.current);
      recordingRef.current = null;
    };
    const pageHidden = () => {
      turnOff();
      // A page the browser restores from its back button cache comes back as it was, so it must not say these are on.
      setStream(null);
      setPreviewing(false);
      setRecording(false);
    };
    window.addEventListener("pagehide", pageHidden);
    return () => {
      window.removeEventListener("pagehide", pageHidden);
      mounted.current = false;
      turnOff();
    };
  }, [hideGlassesPreview]);

  const connect = useCallback(async () => {
    const glasses = glassesBridge();
    if (!glasses) throw new GlassesClientError("unavailable");
    try {
      const next = await withTimeout(glasses.connect(), BRIDGE_TIMEOUTS.connect);
      update(next);
      return next;
    } catch (err) {
      throw toClientError(err, "session_ended");
    }
  }, [update]);

  const capture = useCallback(async (o: { maxSize?: number } = {}) => {
    const maxSize = photoSize(o.maxSize);
    const from = sourceRef.current;
    if (from !== "glasses") primeSpeech();
    let data: PhotoData;
    if (from === "glasses") {
      const glasses = glassesBridge();
      if (!glasses) throw new GlassesClientError("unavailable");
      if (statusRef.current.state !== "ready") throw new GlassesClientError("not_connected");
      try {
        data = await withTimeout(glasses.capturePhoto({ maxSize }), BRIDGE_TIMEOUTS.capture);
      } catch (err) {
        throw toClientError(err, "capture_failed");
      }
    } else if (from === "phone") {
      const open = streamRef.current;
      const live = open ?? (await openCamera());
      try {
        data = await grabFrame(live, !open, maxSize);
      } catch (err) {
        throw toClientError(err, "capture_failed");
      } finally {
        if (!open) stopTracks(live);
      }
    } else {
      const photos = samplesRef.current?.photos ?? [];
      if (!photos.length) throw new GlassesClientError("no_sample");
      const url = photos[sampleIndex.current++ % photos.length];
      try {
        data = await samplePhoto(url, maxSize);
      } catch {
        throw new GlassesClientError("no_sample");
      }
    }
    const taken: GlassesPhoto = { ...data, source: from };
    setPhoto(taken);
    return taken;
  }, []);

  const listen = useCallback(async (o: { maxSeconds?: number } = {}) => {
    if (recordingRef.current) return;
    const maxSeconds = listenSeconds(o.maxSeconds);
    const from = sourceRef.current;
    if (from !== "glasses") primeSpeech();
    let active: Recording;
    if (from === "glasses") {
      const glasses = glassesBridge();
      if (!glasses) throw new GlassesClientError("unavailable");
      if (statusRef.current.state !== "ready") throw new GlassesClientError("not_connected");
      try {
        await withTimeout(glasses.startRecording({ maxSeconds }), BRIDGE_TIMEOUTS.other);
      } catch (err) {
        throw toClientError(err, "no_audio");
      }
      active = { kind: "glasses" };
    } else {
      const question = from === "sample" ? samplesRef.current?.question : undefined;
      active = question ? { kind: "sample", url: question } : await recordPhone(maxSeconds);
    }
    // They left while it was starting, so nobody is left to stop it.
    if (!mounted.current) {
      dropRecording(active);
      return;
    }
    recordingRef.current = active;
    setRecording(true);
  }, []);

  const stop = useCallback(async () => {
    const active = recordingRef.current;
    if (!active) throw new GlassesClientError("not_listening");
    if (active.kind !== "glasses") primeSpeech();
    recordingRef.current = null;
    setRecording(false);
    try {
      if (active.kind === "glasses") {
        const glasses = glassesBridge();
        if (!glasses) throw new GlassesClientError("unavailable");
        return await withTimeout(glasses.stopRecording(), BRIDGE_TIMEOUTS.other);
      }
      if (active.kind === "sample") return { ...(await sampleQuestion(active.url)), source: "sample" as const };
      const wav = await toWav16k(await active.finish());
      return { wavDataUrl: await blobToDataUrl(wav), seconds: wavSeconds(wav), source: "phone" as const };
    } catch (err) {
      throw toClientError(err, "no_audio");
    }
  }, []);

  const say = useCallback(async (text: string) => {
    const words = text.trim().slice(0, BRIDGE_LIMITS.speechChars);
    if (!words) return;
    const glasses = glassesBridge();
    if (glasses && sourceRef.current === "glasses" && statusRef.current.state === "ready") {
      try {
        await withTimeout(glasses.speak(words), BRIDGE_TIMEOUTS.speak);
        return;
      } catch (err) {
        // A timeout may still be speaking, and a second voice on top of it is worse than none.
        if ((err as { code?: unknown } | null)?.code === "timeout") return;
      }
    }
    await speakInBrowser(words);
  }, []);

  const preview = useCallback(
    async (show: boolean) => {
      const token = ++previewToken.current;
      const from = sourceRef.current;
      if (from === "glasses") {
        const glasses = glassesBridge();
        if (!glasses) throw new GlassesClientError("unavailable");
        const before = glassesPreviewing.current;
        glassesPreviewing.current = show;
        try {
          await withTimeout(glasses.preview({ show }), BRIDGE_TIMEOUTS.other);
        } catch (err) {
          if (token !== previewToken.current) return;
          glassesPreviewing.current = before;
          throw toClientError(err, "session_ended");
        }
        // The shell runs calls in order, so whatever replaced this one has already sent what it wants.
        if (token !== previewToken.current) return;
      } else if (from === "phone") {
        closeStream();
        if (show) {
          let opened: MediaStream;
          try {
            opened = await openCamera();
          } catch (err) {
            if (token !== previewToken.current) return;
            throw err;
          }
          // Nothing else holds this stream, so unless it's kept here its camera stays on until the tab closes.
          if (token !== previewToken.current) {
            stopTracks(opened);
            return;
          }
          streamRef.current = opened;
          setStream(opened);
        }
      } else {
        return;
      }
      setPreviewing(show);
    },
    [closeStream],
  );

  const setSource = useCallback(
    (next: GlassesSource) => {
      if (recordingRef.current) return;
      // Whichever source is on now gets its live view turned off first, even one still opening.
      previewToken.current += 1;
      hideGlassesPreview();
      closeStream();
      setPreviewing(false);
      sourceRef.current = next;
      setChosen(next);
    },
    [closeStream, hideGlassesPreview],
  );

  return { source, status, inApp: !!bridge, ready, photo, recording, previewing, stream, connect, capture, listen, stop, say, preview, setSource };
}
