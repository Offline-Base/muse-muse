// Platform file (Muse Muse platform services). Don't edit: products call toMidi, playNotes and notesFromAudio.
//
// Music as notes. toMidi writes a standard MIDI file (format 0, one track, 480 ticks a beat) that any music app opens;
// playNotes plays notes in the page with simple built-in tones (Web Audio oscillators, no sound files); notesFromAudio
// turns a hummed or sung recording into notes by finding its pitch every 20 ms. Written for Muse Muse, no packages.
// toMidi, parseMidi and notesFromAudio run in Node too.
import { MediaError } from "./media-assets";

/** A note: `pitch` is a MIDI number (60 is middle C, 69 is A 440 Hz), times in beats. */
export interface Note {
  pitch: number;
  startBeat: number;
  beats: number;
  /** 1 to 127, 96 by default. */
  velocity?: number;
}

export const NOTES_MAX = 2000;
export const TICKS_PER_BEAT = 480;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** "C4" for 60, "A4" for 69. */
export function noteName(pitch: number): string {
  const p = Math.round(pitch);
  return `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
}

/** The frequency of a MIDI pitch, in Hz. */
export function pitchHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/** The nearest MIDI pitch for a frequency. */
export function hzPitch(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

function checkNotes(notes: readonly Note[]): Note[] {
  if (!Array.isArray(notes)) throw new MediaError("invalid", "The tune has no notes.");
  if (notes.length > NOTES_MAX) throw new MediaError("too_large", `That tune is too long: at most ${NOTES_MAX} notes.`);
  return notes
    .filter((n) => Number.isFinite(n?.pitch) && Number.isFinite(n?.startBeat) && Number.isFinite(n?.beats) && n.beats > 0 && n.startBeat >= 0)
    .map((n) => ({ pitch: Math.min(127, Math.max(0, Math.round(n.pitch))), startBeat: n.startBeat, beats: n.beats, velocity: Math.min(127, Math.max(1, Math.round(n.velocity ?? 96))) }));
}

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  for (let v = n >>> 7; v > 0; v >>>= 7) out.unshift((v & 0x7f) | 0x80);
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export interface MidiOptions {
  /** Beats a minute, 120 by default. */
  bpm?: number;
  /** A General MIDI program (0 is a piano), 0 by default. */
  program?: number;
  /** The track's name. */
  name?: string;
}

/** A standard MIDI file for the notes. Notes that overlap on the same pitch are kept apart. */
export function toMidi(notes: readonly Note[], opts: MidiOptions = {}): Uint8Array {
  const clean = checkNotes(notes);
  const bpm = Math.min(300, Math.max(20, opts.bpm ?? 120));
  const tempo = Math.round(60_000_000 / bpm);
  const events: Array<{ tick: number; order: number; bytes: number[] }> = [];
  for (const n of clean) {
    const on = Math.round(n.startBeat * TICKS_PER_BEAT);
    const off = Math.max(on + 1, Math.round((n.startBeat + n.beats) * TICKS_PER_BEAT));
    events.push({ tick: on, order: 1, bytes: [0x90, n.pitch, n.velocity!] });
    events.push({ tick: off, order: 0, bytes: [0x80, n.pitch, 0] });
  }
  // Note offs before note ons at the same tick, so a repeated note sounds twice.
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const name = ascii((opts.name ?? "Tune").replace(/[^\x20-\x7e]/g, "").slice(0, 60));
  const track: number[] = [
    0x00, 0xff, 0x03, ...varLen(name.length), ...name,
    0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff,
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xc0, Math.min(127, Math.max(0, Math.round(opts.program ?? 0))),
  ];
  let last = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  return Uint8Array.from([...ascii("MThd"), ...u32(6), 0x00, 0x00, 0x00, 0x01, (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff, ...ascii("MTrk"), ...u32(track.length), ...track]);
}

/** The MIDI file as a Blob, for a download link. */
export function midiBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/midi" });
}

/** What a MIDI file holds: its format, ticks a beat, tempo and notes. Throws a MediaError for a file that isn't MIDI. */
export function parseMidi(bytes: Uint8Array): { format: number; ticksPerBeat: number; bpm: number | null; notes: Note[] } {
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const num = (at: number, len: number) => [...bytes.subarray(at, at + len)].reduce((n, b) => n * 256 + b, 0);
  if (bytes.length < 14 || text(0) !== "MThd") throw new MediaError("invalid", "That isn't a MIDI file.");
  const format = num(8, 2);
  const tracks = num(10, 2);
  const ticksPerBeat = num(12, 2);
  if (ticksPerBeat & 0x8000) throw new MediaError("invalid", "MIDI files timed in frames aren't read here.");
  let at = 8 + num(4, 4);
  let bpm: number | null = null;
  const notes: Note[] = [];
  for (let t = 0; t < tracks && at + 8 <= bytes.length; t++) {
    if (text(at) !== "MTrk") throw new MediaError("invalid", "That MIDI file is damaged.");
    const end = at + 8 + num(at + 4, 4);
    let p = at + 8;
    let tick = 0;
    let status = 0;
    const open = new Map<number, { tick: number; velocity: number }>();
    const readVar = () => {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const b = bytes[p++]!;
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      tick += readVar();
      let b = bytes[p]!;
      if (b & 0x80) {
        status = b;
        p++;
      } else if (!status) throw new MediaError("invalid", "That MIDI file is damaged.");
      b = status;
      if (b === 0xff) {
        const type = bytes[p++]!;
        const len = readVar();
        if (type === 0x51 && len === 3) bpm = Math.round(60_000_000 / num(p, 3));
        p += len;
        status = 0;
      } else if (b === 0xf0 || b === 0xf7) {
        const len = readVar();
        p += len;
        status = 0;
      } else {
        const kind = b & 0xf0;
        const d1 = bytes[p++]!;
        const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p++]!;
        if (kind === 0x90 && d2 > 0) open.set(d1, { tick, velocity: d2 });
        else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
          const o = open.get(d1);
          if (o) {
            notes.push({ pitch: d1, startBeat: o.tick / ticksPerBeat, beats: (tick - o.tick) / ticksPerBeat, velocity: o.velocity });
            open.delete(d1);
          }
        }
      }
    }
    at = end;
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  return { format, ticksPerBeat, bpm, notes };
}

export interface PlayOptions {
  bpm?: number;
  /** "triangle" by default: soft, like a toy piano. */
  wave?: OscillatorType;
  /** 0 to 1, 0.25 by default. */
  volume?: number;
  context?: AudioContext;
  /** Called once when the last note has finished. */
  onEnd?: () => void;
}

/** Plays notes in the page with built-in tones. Returns stop() and how long the tune lasts. Browser only. */
export function playNotes(notes: readonly Note[], opts: PlayOptions = {}): { stop(): void; durationMs: number } {
  const clean = checkNotes(notes);
  const ctx = opts.context ?? new AudioContext();
  void ctx.resume().catch(() => undefined);
  const secondsPerBeat = 60 / Math.min(300, Math.max(20, opts.bpm ?? 120));
  const start = ctx.currentTime + 0.05;
  const volume = Math.min(1, Math.max(0, opts.volume ?? 0.25));
  const oscillators: OscillatorNode[] = [];
  let endAt = start;
  for (const n of clean) {
    const t0 = start + n.startBeat * secondsPerBeat;
    const t1 = t0 + n.beats * secondsPerBeat;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = opts.wave ?? "triangle";
    osc.frequency.value = pitchHz(n.pitch);
    const peak = volume * (n.velocity! / 127);
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    amp.gain.setValueAtTime(peak, Math.max(t0 + 0.01, t1 - 0.03));
    amp.gain.linearRampToValueAtTime(0, t1);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
    oscillators.push(osc);
    endAt = Math.max(endAt, t1);
  }
  const durationMs = Math.round((endAt - start) * 1000);
  const timer = setTimeout(() => opts.onEnd?.(), durationMs + 80);
  return {
    durationMs,
    stop() {
      clearTimeout(timer);
      for (const o of oscillators) {
        try {
          o.stop();
        } catch {
          // already stopped
        }
      }
      opts.onEnd?.();
    },
  };
}

/** One pitch estimate for a frame, by the YIN method: the period whose difference is lowest. Null when unvoiced. */
export function framePitchHz(frame: Float32Array, sampleRate: number, opts: { minHz?: number; maxHz?: number; threshold?: number } = {}): number | null {
  const minLag = Math.floor(sampleRate / (opts.maxHz ?? 1000));
  const maxLag = Math.min(Math.floor(sampleRate / (opts.minHz ?? 70)), Math.floor(frame.length / 2));
  if (maxLag <= minLag + 2) return null;
  let energy = 0;
  for (const v of frame) energy += v * v;
  if (Math.sqrt(energy / frame.length) < 0.01) return null;
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < maxLag; i++) {
      const diff = frame[i]! - frame[i + lag]!;
      sum += diff * diff;
    }
    d[lag] = sum;
  }
  // The cumulative mean normalized difference.
  let running = 0;
  const cm = new Float32Array(maxLag + 1);
  cm[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    running += d[lag]!;
    cm[lag] = running ? (d[lag]! * lag) / running : 1;
  }
  const threshold = opts.threshold ?? 0.15;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cm[lag]! < threshold) {
      while (lag + 1 <= maxLag && cm[lag + 1]! < cm[lag]!) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) return null;
  // A parabola through the three points around the dip gives a lag between samples.
  const a = cm[best - 1] ?? cm[best]!;
  const b = cm[best]!;
  const c = cm[best + 1] ?? cm[best]!;
  const shift = a + c - 2 * b ? (a - c) / (2 * (a + c - 2 * b)) : 0;
  return sampleRate / (best + shift);
}

export interface FromAudioOptions {
  /** Beats a minute for the notes' times, 120 by default. */
  bpm?: number;
  /** Shortest note kept, in ms, 120 by default. */
  minNoteMs?: number;
  /** Lowest and highest pitch heard, in Hz: 70 to 1000 by default, a voice's range. */
  minHz?: number;
  maxHz?: number;
}

/**
 * A hummed, sung or whistled tune to notes: a pitch every 20 ms, rounded to the nearest semitone, steady runs of one
 * pitch joined into a note, and notes shorter than minNoteMs dropped. `samples` is mono, like a decoded recording's
 * first channel.
 */
export function notesFromAudio(samples: Float32Array, sampleRate: number, opts: FromAudioOptions = {}): Note[] {
  const hop = Math.round(sampleRate * 0.02);
  const size = Math.round(sampleRate * 0.04);
  const pitches: Array<number | null> = [];
  for (let at = 0; at + size <= samples.length; at += hop) {
    const hz = framePitchHz(samples.subarray(at, at + size), sampleRate, { minHz: opts.minHz, maxHz: opts.maxHz });
    pitches.push(hz ? Math.round(hzPitch(hz)) : null);
  }
  // A 3-frame median smooths out single-frame octave slips.
  const smooth = pitches.map((p, i) => {
    const w = [pitches[i - 1], p, pitches[i + 1]].filter((x): x is number => x !== null && x !== undefined);
    if (p === null || w.length < 2) return p;
    return w.sort((a, b) => a - b)[Math.floor(w.length / 2)]!;
  });
  const secondsPerBeat = 60 / Math.min(300, Math.max(20, opts.bpm ?? 120));
  const minFrames = Math.max(1, Math.round((opts.minNoteMs ?? 120) / 20));
  const notes: Note[] = [];
  let runPitch: number | null = null;
  let runStart = 0;
  const close = (end: number) => {
    if (runPitch !== null && end - runStart >= minFrames) {
      notes.push({ pitch: runPitch, startBeat: (runStart * 0.02) / secondsPerBeat, beats: ((end - runStart) * 0.02) / secondsPerBeat, velocity: 96 });
    }
  };
  for (let i = 0; i <= smooth.length; i++) {
    const p = i < smooth.length ? smooth[i]! : null;
    if (p !== runPitch) {
      close(i);
      runPitch = p;
      runStart = i;
    }
  }
  return notes.slice(0, NOTES_MAX);
}
