import { decodeAudio } from "@/lib/docs/media/audio";
import { TRANSCRIBE_SAMPLE_RATE, resample, toTranscribeSamples } from "@/lib/docs/media/resample";
import { encodeWav } from "@/lib/docs/media/wav";

/**
 * Microphone recording for the voice demos. Raw samples come from an AudioWorklet (a ScriptProcessor where worklets
 * are missing, MediaRecorder as the last resort), then lib/docs/media/resample.ts turns them into 16 kHz mono and
 * lib/docs/media/wav.ts writes the WAV Muse Voice Transcribe takes. Recording stops by itself at the cap.
 */

export interface RecordedAudio {
  wav: Blob;
  durationMs: number;
  sampleRate: number;
}

export interface MicRecorderOptions {
  /** Stops by itself after this long. Defaults to 60 s, the realtime relay's limit. */
  maxMs?: number;
  /** Input level from 0 to 1, about 30 times a second, for a meter. */
  onLevel?(level: number): void;
  /** Called with the recording when the cap stopped it. */
  onAutoStop?(audio: RecordedAudio): void;
  /** Called if recording fails after it started (the device went away). */
  onError?(error: Error): void;
}

export interface MicRecording {
  readonly startedAt: number;
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}

const WORKLET = `
class DocsCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.port.postMessage(this.buf.slice(0, this.n));
        this.n = 0;
        this.port.postMessage("flushed");
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const len = input[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        this.buf[this.n++] = s / input.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice());
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("docs-capture", DocsCapture);
`;

function micError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("Microphone access was blocked. Allow it in the address bar, or pick a sample instead.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No microphone was found.");
  if (name === "NotReadableError") return new Error("The microphone is busy in another app.");
  return new Error("Couldn't start the microphone.");
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function toWav(samples: Float32Array, rate: number): RecordedAudio {
  const pcm = resample(samples, rate, TRANSCRIBE_SAMPLE_RATE);
  return {
    wav: new Blob([encodeWav(pcm, TRANSCRIBE_SAMPLE_RATE)], { type: "audio/wav" }),
    durationMs: Math.round((pcm.length / TRANSCRIBE_SAMPLE_RATE) * 1000),
    sampleRate: TRANSCRIBE_SAMPLE_RATE,
  };
}

/** Asks for the microphone and starts recording. Call it from a click so the browser allows audio. */
export async function startMicRecording(opts: MicRecorderOptions = {}): Promise<MicRecording> {
  const maxMs = opts.maxMs ?? 60_000;
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Recording needs a secure page (https or localhost) in a browser with microphone support.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw micError(err);
  }

  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("This browser can't record audio.");
  }
  const ctx = new Ctor();
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  const chunks: Float32Array[] = [];
  let flush: () => Promise<void> = async () => {};
  let detach: () => void = () => {};
  let recorder: MediaRecorder | null = null;
  const recorded: Blob[] = [];

  if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, "docs-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    let flushed: (() => void) | null = null;
    node.port.onmessage = (e: MessageEvent<Float32Array | string>) => {
      if (e.data === "flushed") flushed?.();
      else if (e.data instanceof Float32Array && e.data.length) chunks.push(e.data);
    };
    source.connect(node);
    node.connect(mute);
    flush = () =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 400);
        flushed = () => {
          window.clearTimeout(timer);
          resolve();
        };
        node.port.postMessage("flush");
      });
    detach = () => {
      node.port.onmessage = null;
      node.disconnect();
    };
  } else if (typeof ctx.createScriptProcessor === "function") {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
    source.connect(node);
    node.connect(mute);
    detach = () => {
      node.onaudioprocess = null;
      node.disconnect();
    };
  } else if (typeof MediaRecorder !== "undefined") {
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && recorded.push(e.data);
    recorder.start(250);
  } else {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw new Error("This browser can't record audio.");
  }

  const levels = new Float32Array(analyser.fftSize);
  let raf = 0;
  const meter = () => {
    analyser.getFloatTimeDomainData(levels);
    let sum = 0;
    for (let i = 0; i < levels.length; i++) sum += levels[i] * levels[i];
    // Speech sits around 0.05 to 0.2 RMS, so scale it up and soften the curve for a readable meter.
    opts.onLevel?.(Math.min(1, Math.sqrt(Math.sqrt(sum / levels.length)) * 1.6));
    raf = window.requestAnimationFrame(meter);
  };
  if (opts.onLevel) raf = window.requestAnimationFrame(meter);

  const startedAt = performance.now();
  let finished: Promise<RecordedAudio> | null = null;

  const teardown = async () => {
    window.cancelAnimationFrame(raf);
    window.clearTimeout(cap);
    detach();
    source.disconnect();
    analyser.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
  };

  const finish = async (): Promise<RecordedAudio> => {
    await flush();
    if (recorder && recorder.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => (recorder!.onstop = () => resolve()));
      recorder.stop();
      await stopped;
    }
    const rate = ctx.sampleRate;
    await teardown();
    if (recorder) {
      const decoded = await decodeAudio(new Blob(recorded, { type: recorder.mimeType }));
      const pcm = toTranscribeSamples(decoded.channels, decoded.sampleRate);
      return {
        wav: new Blob([encodeWav(pcm, TRANSCRIBE_SAMPLE_RATE)], { type: "audio/wav" }),
        durationMs: Math.round((pcm.length / TRANSCRIBE_SAMPLE_RATE) * 1000),
        sampleRate: TRANSCRIBE_SAMPLE_RATE,
      };
    }
    return toWav(concat(chunks), rate);
  };

  const stop = () => (finished ??= finish());
  const cap = window.setTimeout(() => {
    stop().then(
      (audio) => opts.onAutoStop?.(audio),
      (err: unknown) => opts.onError?.(err instanceof Error ? err : new Error("Recording failed.")),
    );
  }, maxMs);
  stream.getTracks()[0]?.addEventListener("ended", () => {
    if (!finished) opts.onError?.(new Error("The microphone stopped."));
  });

  return {
    startedAt,
    stop,
    cancel: () => {
      finished ??= Promise.reject(new Error("Recording canceled."));
      finished.catch(() => {});
      void teardown();
    },
  };
}
