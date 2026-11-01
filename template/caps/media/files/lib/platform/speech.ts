// Platform file (Muse Muse platform services). Don't edit: products call speak(), prepareSpeech() and stopSpeech().
//
// Text read aloud in the page by an open-weights model: Microsoft's SpeechT5 text to speech with its HiFi-GAN vocoder
// (both MIT), as 8-bit ONNX conversions, run by onnxruntime-web (MIT) on WebAssembly, one thread, so the page
// needs no special headers. The voice is CMU ARCTIC's "slt" speaker (an x-vector from the MIT-licensed
// cmu-arctic-xvectors set). English only. The model files (about 190 MB) come from the Muse Muse gateway, checked by
// sha256, and stay in the browser for the next visit. When the model can't run (no WebAssembly, no gateway, a failed
// download), speak() uses the browser's own voice instead, and says so in its answer. Browser only.
//
// synthesizeSpeech is the model alone, with the runtime and model bytes passed in, so it runs in Node for tests too.
import { MediaError, SPEECH_ASSETS, fetchAsset, type MediaAsset } from "./media-assets";

/** Characters one speak() call reads. Longer text is refused, so a page can't start a minutes-long read by mistake. */
export const SPEECH_CHARS_MAX = 600;
/** The model's sample rate. */
export const SPEECH_SAMPLE_RATE = 16000;

// The SpeechT5 tokenizer: one id per character from 4 on, each word starts with U+2581, and the text ends with </s> (2).
const VOCAB = "\u2581etaonihsrdlucmfwgy,pb.vk\"I'TASH;xW-B?CM!qjENPODLGRFYzJ:KUV)(QZ][X\u2014/\u00e6\u00e9{}\u00ea\u0153";
const UNK = 3;
const EOS = 2;
const ID = new Map([...VOCAB].map((c, i) => [c, i + 4]));

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`;
  return h ? `${ONES[h]} hundred${r ? ` ${rest}` : ""}` : rest;
}

/** A whole number in words, up to 999,999,999; longer numbers are read digit by digit. */
export function numberWords(digits: string): string {
  const n = Number(digits);
  if (digits.length > 9 || !Number.isFinite(n)) return [...digits].map((d) => ONES[Number(d)]).join(" ");
  if (n === 0) return "zero";
  const parts: string[] = [];
  const m = Math.floor(n / 1_000_000);
  const k = Math.floor((n % 1_000_000) / 1000);
  const r = n % 1000;
  if (m) parts.push(`${under1000(m)} million`);
  if (k) parts.push(`${under1000(k)} thousand`);
  if (r) parts.push(under1000(r));
  return parts.join(" ");
}

/** Text the model can read: numbers in words, plain quotes and dashes, and nothing outside its alphabet. */
export function speechText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, ", ")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent")
    .replace(/(\d+)\.(\d+)/g, (_m, a: string, b: string) => `${numberWords(a)} point ${[...b].map((d) => ONES[Number(d)]).join(" ")}`)
    .replace(/\d+/g, (d) => ` ${numberWords(d.replace(/^0+(?=\d)/, ""))} `)
    .replace(/\s+/g, " ")
    .replace(/ ([,.!?;:])/g, "$1")
    .trim();
}

/** Token ids for one piece of text, as the model's tokenizer makes them. */
export function speechTokens(text: string): number[] {
  const words = speechText(text).split(" ").filter(Boolean);
  const ids: number[] = [];
  for (const w of words) for (const c of `\u2581${w}`) ids.push(ID.get(c) ?? UNK);
  ids.push(EOS);
  return ids;
}

/** Text split into pieces of about a sentence, each short enough for the model. */
export function speechPieces(text: string, max = 200): string[] {
  const sentences = speechText(text).match(/[^.!?;]+[.!?;]*\s*/g) ?? [];
  const out: string[] = [];
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (s.length <= max) {
      out.push(s);
      continue;
    }
    let cur = "";
    for (const w of s.split(" ")) {
      if ((cur ? cur.length + 1 : 0) + w.length > max && cur) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur} ${w}` : w.slice(0, max);
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** The voice: CMU ARCTIC slt, x-vector arctic_a0508 (512 float32, little-endian). */
const SPEAKER_B64 = "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";

export function speakerEmbedding(): Float32Array {
  const bin = atob(SPEAKER_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** The few onnxruntime-web pieces this file uses, so tests can pass the real runtime in Node. */
export interface OrtLike {
  env: { wasm: { numThreads?: number; wasmBinary?: ArrayBuffer | Uint8Array; proxy?: boolean } };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => OrtTensor;
  InferenceSession: { create(model: ArrayBuffer | Uint8Array, opts?: Record<string, unknown>): Promise<OrtSession> };
}
interface OrtTensor {
  data: unknown;
  dims: readonly number[];
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export interface SpeechModel {
  ort: OrtLike;
  encoder: OrtSession;
  decoder: OrtSession;
  vocoder: OrtSession;
}

/** Opens the three model parts on the runtime, from their bytes. */
export async function openSpeechModel(ort: OrtLike, bytes: { wasm: ArrayBuffer | Uint8Array; encoder: ArrayBuffer | Uint8Array; decoder: ArrayBuffer | Uint8Array; vocoder: ArrayBuffer | Uint8Array }): Promise<SpeechModel> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = bytes.wasm;
  const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const encoder = await ort.InferenceSession.create(bytes.encoder, opts);
  const decoder = await ort.InferenceSession.create(bytes.decoder, opts);
  const vocoder = await ort.InferenceSession.create(bytes.vocoder, opts);
  return { ort, encoder, decoder, vocoder };
}

const MEL_BINS = 80;
const STOP_THRESHOLD = 0.5;
const MAX_STEPS_PER_TOKEN = 10;

/**
 * One piece of text to 16 kHz samples. The decoder runs one step per two spectrogram frames, keeping its attention
 * cache between steps, until it says the speech has ended. `signal` stops it between steps.
 */
export async function synthesizeSpeech(model: SpeechModel, text: string, opts: { signal?: AbortSignal } = {}): Promise<Float32Array> {
  const { ort, encoder, decoder, vocoder } = model;
  const ids = speechTokens(text);
  if (ids.length <= 1) return new Float32Array(0);
  const enc = await encoder.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) });
  const hidden = enc.encoder_outputs!;
  const mask = enc.encoder_attention_mask!;
  const speaker = new ort.Tensor("float32", speakerEmbedding(), [1, 512]);
  const pastNames = decoder.inputNames.filter((n) => n.startsWith("past_key_values."));
  let past: Record<string, OrtTensor> = Object.fromEntries(pastNames.map((n) => [n, new ort.Tensor("float32", new Float32Array(0), [1, 12, 0, 64])]));
  let sequence: OrtTensor = new ort.Tensor("float32", new Float32Array(MEL_BINS), [1, 1, MEL_BINS]);
  const frames: Float32Array[] = [];
  const maxSteps = Math.max(8, ids.length * MAX_STEPS_PER_TOKEN);
  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) throw new MediaError("stopped", "Reading aloud was stopped.");
    const out = await decoder.run({
      use_cache_branch: new ort.Tensor("bool", [step > 0], [1]),
      output_sequence: sequence,
      encoder_attention_mask: mask,
      speaker_embeddings: speaker,
      encoder_hidden_states: hidden,
      ...past,
    });
    frames.push(out.spectrum!.data as Float32Array);
    const prob = out.prob!.data as Float32Array;
    sequence = out.output_sequence_out!;
    const next: Record<string, OrtTensor> = {};
    for (const n of pastNames) {
      const present = out[n.replace("past_key_values.", "present.")]!;
      // In the cached branch the encoder's keys and values come back empty: keep the first step's.
      next[n] = step > 0 && n.includes(".encoder.") ? past[n]! : present;
    }
    past = next;
    if ([...prob].some((p) => p >= STOP_THRESHOLD)) break;
  }
  const total = frames.reduce((n, f) => n + f.length, 0);
  const spectrogram = new Float32Array(total);
  let at = 0;
  for (const f of frames) {
    spectrogram.set(f, at);
    at += f.length;
  }
  const wave = await vocoder.run({ spectrogram: new ort.Tensor("float32", spectrogram, [total / MEL_BINS, MEL_BINS]) });
  return Float32Array.from(wave.waveform!.data as Float32Array);
}

// ---------------------------------------------------------------------------------------------------------------
// In the page

export interface SpeechProgress {
  /** "download" while the model's files arrive, then "start" once, as the model opens. */
  stage: "download" | "start";
  /** 0 to 1 over the whole download. */
  done: number;
}

export interface SpeakOptions {
  onProgress?: (p: SpeechProgress) => void;
  /** Use the browser's voice even when the model could run. */
  browserOnly?: boolean;
  /** For the browser's voice. */
  lang?: string;
}

export interface SpeakResult {
  /** Who read it: the open model, the browser's own voice, or nobody (the browser has neither). */
  by: "model" | "browser" | "none";
  durationMs: number;
  /** Why it fell back to the browser's voice, in plain words. */
  note?: string;
}

type MediaRecord = { speech?: { by: SpeakResult["by"]; durationMs: number; samples: number; at: number } };

function record(entry: NonNullable<MediaRecord["speech"]>) {
  const w = window as unknown as { __musemuseMedia?: MediaRecord };
  w.__musemuseMedia = { ...(w.__musemuseMedia ?? {}), speech: entry };
}

let loading: Promise<SpeechModel> | null = null;
let playing: { stop(): void } | null = null;
let audio: AudioContext | null = null;

/** How long playback waits for the browser to let the page make sound before using the browser's voice instead. */
export const AUDIO_START_MS = 1500;

/**
 * The page's one AudioContext, made and unlocked during the tap that asked for speech: Safari and iOS let a page start
 * sound only inside the user's gesture, and that is over once the first await (the model's download) has run. So
 * speak() and prepareSpeech() call this first, before anything else, and playback reuses it.
 */
export function unlockAudio(): AudioContext | null {
  const Ctor = typeof AudioContext !== "undefined" ? AudioContext : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audio || audio.state === "closed") {
    try {
      audio = new Ctor({ sampleRate: SPEECH_SAMPLE_RATE });
    } catch {
      // Older Safari takes no sample rate; the pieces are resampled to the context's own rate.
      try {
        audio = new Ctor();
      } catch {
        return null;
      }
    }
  }
  if (audio.state !== "running") {
    void audio.resume().catch(() => undefined);
    // iOS also wants a sound started inside the gesture: one silent sample.
    try {
      const src = audio.createBufferSource();
      src.buffer = audio.createBuffer(1, 1, audio.sampleRate);
      src.connect(audio.destination);
      src.start(0);
    } catch {
      // Nothing to unlock with.
    }
  }
  return audio;
}

/** Resolves once the context is running, or throws when the browser hasn't let it start within AUDIO_START_MS. */
async function audioRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state === "running") return;
  // resume() can stay pending for good outside a gesture (Safari), so it gets a deadline.
  await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, AUDIO_START_MS))]);
  if ((ctx.state as string) !== "running") throw new MediaError("unsupported", "This browser didn't let the page play sound.");
}

async function loadModel(onProgress?: (p: SpeechProgress) => void): Promise<SpeechModel> {
  if (typeof WebAssembly === "undefined") throw new MediaError("unsupported", "This browser can't run the reading voice.");
  const assets: MediaAsset[] = [SPEECH_ASSETS.runtime, SPEECH_ASSETS.wasm, SPEECH_ASSETS.encoder, SPEECH_ASSETS.decoder, SPEECH_ASSETS.vocoder];
  const total = assets.reduce((n, a) => n + a.bytes, 0);
  const got = new Map<string, number>();
  const tick = () => onProgress?.({ stage: "download", done: Math.min(1, [...got.values()].reduce((a, b) => a + b, 0) / total) });
  const [runtime, wasm, encoder, decoder, vocoder] = await Promise.all(
    assets.map((a) => fetchAsset(a, { onBytes: (n) => (got.set(a.sha256, n), tick()) })),
  );
  onProgress?.({ stage: "start", done: 1 });
  // The runtime was checked by sha256 above, so it runs from its own bytes, never from a URL that could change.
  const url = URL.createObjectURL(new Blob([runtime!], { type: "text/javascript" }));
  try {
    const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as OrtLike;
    return await openSpeechModel(ort, { wasm: wasm!, encoder: encoder!, decoder: decoder!, vocoder: vocoder! });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downloads and opens the model, once per page. Call it on the first tap so the download shows progress; speak() calls
 * it too. It throws a MediaError when the model can't run here.
 */
export function prepareSpeech(opts: { onProgress?: (p: SpeechProgress) => void } = {}): Promise<SpeechModel> {
  unlockAudio();
  if (!loading) {
    loading = loadModel(opts.onProgress);
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Stops whatever is being read aloud. */
export function stopSpeech(): void {
  playing?.stop();
  playing = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/**
 * Plays the pieces as they arrive, one after another, on `ctx` (unlockAudio's). Throws a MediaError when the browser
 * won't let the page play sound, so speak() can use the browser's voice instead. Exported for tests.
 */
export async function playSamples(pieces: AsyncIterable<Float32Array>, ctrl: AbortController, ctx: AudioContext | null = unlockAudio()): Promise<{ durationMs: number; samples: number }> {
  if (!ctx) throw new MediaError("unsupported", "This browser can't play sound from the page.");
  await audioRunning(ctx);
  let at = ctx.currentTime + 0.05;
  let samples = 0;
  const sources: AudioBufferSourceNode[] = [];
  playing = {
    stop: () => {
      ctrl.abort();
      for (const s of sources) s.stop();
    },
  };
  try {
    for await (const wave of pieces) {
      if (ctrl.signal.aborted) break;
      if (!wave.length) continue;
      const buf = ctx.createBuffer(1, wave.length, SPEECH_SAMPLE_RATE);
      // The model speaks quietly: raise each piece to a steady level, never past full scale.
      let peak = 0;
      for (const v of wave) peak = Math.max(peak, Math.abs(v));
      const gain = peak > 0 ? Math.min(6, 0.8 / peak) : 1;
      const channel = buf.getChannelData(0);
      for (let i = 0; i < wave.length; i++) channel[i] = wave[i]! * gain;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(Math.max(at, ctx.currentTime));
      sources.push(src);
      at = Math.max(at, ctx.currentTime) + buf.duration + 0.15;
      samples += wave.length;
    }
    const left = Math.max(0, at - ctx.currentTime);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, left * 1000);
      ctrl.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
    return { durationMs: Math.round((samples / SPEECH_SAMPLE_RATE) * 1000), samples };
  } finally {
    // The context stays open: it is the one the user's tap unlocked, and the next speak() needs it.
    for (const s of sources) s.disconnect();
  }
}

function speakWithBrowser(text: string, lang: string): Promise<SpeakResult> {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
    return Promise.resolve({ by: "none", durationMs: 0, note: "This browser has no reading voice." });
  }
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    let started = 0;
    const done = (by: SpeakResult["by"], note?: string) => resolve({ by, durationMs: started ? Math.round(performance.now() - started) : 0, ...(note ? { note } : {}) });
    u.onstart = () => (started = performance.now());
    u.onend = () => done(started ? "browser" : "none", started ? undefined : "This browser has no reading voice.");
    u.onerror = () => done("none", "This browser's reading voice didn't start.");
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    // Some browsers never fire an event when they have no voice at all.
    setTimeout(() => !started && (speechSynthesis.cancel(), done("none", "This browser has no reading voice.")), 4000);
  });
}

/**
 * Reads text aloud with the open model, falling back to the browser's own voice. Resolves when it has finished (or was
 * stopped with stopSpeech). Throws a MediaError only for text it won't read: empty, or over SPEECH_CHARS_MAX.
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const clean = text.trim();
  if (!clean) throw new MediaError("invalid", "There's nothing to read aloud.");
  if (clean.length > SPEECH_CHARS_MAX) throw new MediaError("too_large", `That's too long to read aloud at once: at most ${SPEECH_CHARS_MAX} characters.`);
  // Before any await, while the tap that asked for speech still counts as the user's gesture.
  const ctx = opts.browserOnly ? null : unlockAudio();
  stopSpeech();
  const lang = opts.lang ?? "en-US";
  let note: string | undefined;
  if (!opts.browserOnly) {
    try {
      const model = await prepareSpeech({ onProgress: opts.onProgress });
      const ctrl = new AbortController();
      const pieces = speechPieces(clean);
      async function* waves() {
        for (const p of pieces) yield await synthesizeSpeech(model, p, { signal: ctrl.signal });
      }
      const played = await playSamples(waves(), ctrl, ctx);
      record({ by: "model", durationMs: played.durationMs, samples: played.samples, at: Date.now() });
      return { by: "model", durationMs: played.durationMs };
    } catch (err) {
      if (err instanceof MediaError && err.code === "stopped") return { by: "model", durationMs: 0 };
      note = err instanceof MediaError ? err.message : "The reading voice couldn't start here.";
      note = `${note} The browser's own voice read it instead.`;
    }
  }
  const res = await speakWithBrowser(clean, lang);
  record({ by: res.by, durationMs: res.durationMs, samples: 0, at: Date.now() });
  return note && res.by === "browser" ? { ...res, note } : res;
}
