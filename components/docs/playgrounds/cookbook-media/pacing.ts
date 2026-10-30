/**
 * The realtime endpoint's cutoff rules (cookbook/voice-api-fundamentals, "Cutoff behaviour") as a simulation: a client
 * streams a recording's frames on one of three schedules, and the server closes the session the moment a rule trips.
 * More than 5 s of audio ahead of real time, or 10 s of accumulated lateness, closes with 1008; a session past 60
 * minutes closes with 1011. A flat sleep after every send drifts; an absolute schedule (frame i is due at start + i x
 * frame) doesn't, which is why the recipe's client paces that way. Skipping silence instead of padding it makes the
 * server wait for audio that never comes. Pure and seeded, so the same settings give the same run.
 */

export type PacingStrategy = "absolute" | "fixed" | "blast";

export interface PacingInput {
  strategy: PacingStrategy;
  /** Audio per frame, ms (the docs relay sends 80 ms). */
  frameMs: number;
  /** Work per send (reading the file, the socket write), ms. */
  sendMs: number;
  /** Extra random delay per send, up to this many ms. */
  jitterMs: number;
  /** How long the recording is, ms. */
  audioMs: number;
  /** A silent stretch in the recording, and whether the client sends it (pads) or skips it. */
  silence?: { atMs: number; lengthMs: number; pad: boolean } | null;
  seed?: number;
}

export interface PacingPoint {
  /** Wall time since the stream started, ms. */
  t: number;
  /** Positive: behind real time; negative: ahead of it. */
  lateMs: number;
}

export interface PacingClose {
  atMs: number;
  code: 1008 | 1011;
  rule: "backlog" | "lateness" | "duration";
  reason: string;
}

export interface PacingResult {
  points: PacingPoint[];
  close: PacingClose | null;
  /** Audio delivered before the end or the close, ms. */
  sentMs: number;
  /** Wall time the run took (to the close, if there was one), ms. */
  wallMs: number;
  maxLateMs: number;
  maxAheadMs: number;
}

/** The limits from the page's cutoff table. */
export const CUTOFF = { backlogMs: 5_000, latenessMs: 10_000, sessionMs: 60 * 60_000, handshakeMs: 10_000 } as const;

/** A small seeded generator (mulberry32), so jitter is repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs the stream. Lateness is wall time since the start minus the audio delivered, checked just before each frame
 * lands (the most it gets) and after (the most audio runs ahead).
 */
export function simulatePacing(input: PacingInput): PacingResult {
  const frame = Math.max(1, input.frameMs);
  const frames = Math.ceil(input.audioMs / frame);
  const rand = rng(input.seed ?? 7);
  const every = Math.max(1, Math.floor(frames / 500));
  const points: PacingPoint[] = [{ t: 0, lateMs: 0 }];
  const silence = input.silence && input.silence.lengthMs > 0 ? input.silence : null;
  let t = 0;
  let sent = 0;
  let maxLate = 0;
  let maxAhead = 0;
  let close: PacingClose | null = null;

  for (let i = 0; i < frames; i++) {
    const at = i * frame;
    const skip = !!silence && !silence.pad && at >= silence.atMs && at < silence.atMs + silence.lengthMs;
    // An absolute schedule waits for frame i's own due time; a late send doesn't push the frames after it.
    if (input.strategy === "absolute") t = Math.max(t, at);
    if (!skip) t += input.sendMs + rand() * input.jitterMs;
    const late = t - sent;
    maxLate = Math.max(maxLate, late);
    if (late >= CUTOFF.latenessMs) {
      const atMs = sent + CUTOFF.latenessMs;
      points.push({ t: atMs, lateMs: CUTOFF.latenessMs });
      close = {
        atMs,
        code: 1008,
        rule: "lateness",
        reason: skip ? "Ingress fell 10 seconds behind real time while silence went unsent: pad silence during gaps." : "Ingress fell 10 seconds behind real time: every slow send added drift.",
      };
      break;
    }
    if (!skip) sent += frame;
    maxAhead = Math.max(maxAhead, sent - t);
    if (sent - t > CUTOFF.backlogMs) {
      points.push({ t, lateMs: t - sent });
      close = { atMs: t, code: 1008, rule: "backlog", reason: "More than 5 seconds of audio backlog: the client sent faster than real time." };
      break;
    }
    if (t >= CUTOFF.sessionMs) {
      points.push({ t: CUTOFF.sessionMs, lateMs: t - sent });
      close = { atMs: CUTOFF.sessionMs, code: 1011, rule: "duration", reason: "The session ran past 60 minutes." };
      break;
    }
    // A flat sleep after each send: the send's own cost is never paid back.
    if (input.strategy === "fixed") t += frame;
    if (i % every === 0) points.push({ t, lateMs: t - sent });
  }
  if (!close) points.push({ t, lateMs: t - sent });
  return {
    points,
    close,
    sentMs: Math.min(sent, input.audioMs),
    wallMs: close ? close.atMs : t,
    maxLateMs: Math.max(0, maxLate),
    maxAheadMs: Math.max(0, maxAhead),
  };
}

/** "1:05", "60:00" for the chart's axis and the verdict. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
