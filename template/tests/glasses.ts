// Platform file: don't edit. Stands in for Meta glasses in tests, the way the gateway's simulated board stands in for
// a gadget: the product runs the same code it runs in the Muse Muse iPhone app, and only the glasses are pretend. Model
// calls stay real. Call installGlasses(page, { photos: ["fixtures/pov-1.jpg"], question: "fixtures/question.wav" })
// before page.goto. The fake goes through not-registered, registering and connecting to ready, and every call to it
// lands in test-results/glasses/calls.jsonl, which verify reads (glassesProblems in scripts/smoke-report.mjs). It
// refuses what the real app refuses (too long a recording, too big a photo, too much to speak, a second recording), so
// a product that passes here doesn't fail in the app.
//
// It imports nothing from lib/glasses, so this file also typechecks in products without the glasses target. The types
// below repeat lib/glasses/bridge.ts, and scripts/__tests__/glasses.test.mjs keeps the two the same.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";

const CALLS_FILE = "test-results/glasses/calls.jsonl";
const BINDING = "__museGlassesCall";

export type FakeGlassesState =
  | "unavailable"
  | "needs-meta-ai"
  | "not-registered"
  | "registering"
  | "no-glasses"
  | "connecting"
  | "ready"
  | "paused"
  | "error";

export type FakeGlassesErrorCode =
  | "meta_ai_missing"
  | "permission_denied"
  | "no_eligible_device"
  | "glasses_app_update_required"
  | "hinges_closed"
  | "thermal"
  | "battery_low"
  | "capture_failed"
  | "session_ended"
  | "timeout";

/** What a call can fail with: the glasses' own codes, and the three the app's bridge adds for a call it refuses. */
export type FakeBridgeErrorCode = FakeGlassesErrorCode | "bad_request" | "busy" | "denied";

export type FakeGlassesMethod = "status" | "connect" | "capturePhoto" | "preview" | "startRecording" | "stopRecording" | "speak";

export interface InstallGlassesOptions {
  /** Paths of the photos the glasses "see", usually fixtures taken at eye level. Captures go through them in order. */
  photos?: string[];
  /** Path of a 16 kHz mono WAV, what the wearer "says". Without one, recordings are a second of silence. */
  question?: string;
  /** Where the glasses start. "not-registered" by default, the way they are the first time someone opens the app. */
  state?: FakeGlassesState;
  /** What the glasses report once connected. By default a pair of Ray-Ban Meta at 80%, being worn. */
  device?: { name?: string; battery?: number | null; worn?: boolean | null };
}

export interface GlassesPatch {
  /** Moves the glasses to this state and tells the page, like folding them ("paused") or losing them ("no-glasses"). */
  state?: FakeGlassesState;
  battery?: number | null;
  worn?: boolean | null;
  /** What status.error says from now on. null clears it. */
  error?: { code: FakeGlassesErrorCode; message: string } | null;
  /** The next call of this method fails with this code. null cancels it. */
  fail?: { method: FakeGlassesMethod; code: FakeBridgeErrorCode; message?: string } | null;
  /** Paths of photos to use from now on. */
  photos?: string[];
}

/** One line of calls.jsonl. Photos and recordings aren't logged, only their sizes. */
export interface GlassesCall {
  t: number;
  project: string;
  test: string;
  method: FakeGlassesMethod;
  params?: Record<string, unknown>;
  ok: boolean;
  ms: number;
  error?: string;
  result?: Record<string, unknown>;
}

const IMAGE_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function photoDataUrl(file: string): string {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`installGlasses: ${file} isn't a photo. Use a JPG, PNG or WebP.`);
  try {
    return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    throw new Error(`installGlasses: can't read ${file}. Add the photo to fixtures/.`);
  }
}

/** Length of a 16 kHz mono 16-bit WAV in seconds. Throws for anything else, since the real app only ever returns that. */
export function wavSecondsOf(wav: Buffer, name = "the question"): number {
  const wrong = `installGlasses: ${name} must be a 16 kHz mono WAV. Make it with: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav`;
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") throw new Error(wrong);
  let format = false;
  // ffmpeg puts a LIST chunk before the data, so walk the chunks.
  for (let at = 12; at + 8 <= wav.length; at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2)) {
    const id = wav.toString("latin1", at, at + 4);
    if (id === "fmt ") {
      format = wav.readUInt16LE(at + 8) === 1 && wav.readUInt16LE(at + 10) === 1 && wav.readUInt32LE(at + 12) === 16000 && wav.readUInt16LE(at + 22) === 16;
      if (!format) throw new Error(wrong);
    } else if (id === "data") {
      if (!format) throw new Error(wrong);
      return Math.round((Math.min(wav.readUInt32LE(at + 4), wav.length - at - 8) / 32000) * 10) / 10;
    }
  }
  throw new Error(wrong);
}

/** A second of silence, so a test that gives no question still gets the shape of a real recording. */
function silentWav(): Buffer {
  const data = 32000;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(data, 40);
  return wav;
}

interface FakeConfig {
  binding: string;
  photos: string[];
  question: { wavDataUrl: string; seconds: number };
  state: FakeGlassesState;
  device: { name: string; battery: number | null; worn: boolean | null };
}

/** Runs in the browser, before the page's own code. Serialized, so it can use nothing from this file. */
function fakeBridge(config: FakeConfig): void {
  // The app gives the bridge to the top page only.
  if (window.top !== window) return;
  const SAVED = "__museGlassesFakeState";
  // Saved first, since a test may pause the page's own timers (page.clock).
  const later = window.setTimeout.bind(window);
  const wait = (ms: number) => new Promise<void>((resolve) => later(resolve, ms));
  const failure = (code: FakeBridgeErrorCode, message: string) => Object.assign(new Error(message), { code });
  const inRange = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

  type Status = {
    state: FakeGlassesState;
    mode: "mock";
    device: FakeConfig["device"] | null;
    error: { code: FakeGlassesErrorCode; message: string } | null;
  };
  let state = config.state;
  try {
    state = (sessionStorage.getItem(SAVED) as FakeGlassesState | null) ?? state;
  } catch {
    // No storage on this page, so a reload starts over.
  }
  let error: Status["error"] = null;
  let photos = config.photos;
  let nextPhoto = 0;
  let recording = false;
  // Like the real recorder: it stops by itself at its limit, and stopRecording still returns what it heard.
  let recordingEnds = 0;
  let failNext: { method: FakeGlassesMethod; code: FakeBridgeErrorCode; message?: string } | null = null;
  const device = { ...config.device };
  const listeners = new Set<(s: Status) => void>();

  const snapshot = (): Status => ({
    state,
    mode: "mock",
    device: state === "ready" || state === "paused" ? { ...device } : null,
    error: error ? { ...error } : null,
  });
  const emit = () => {
    for (const listener of listeners) listener(snapshot());
  };
  const moveTo = (next: FakeGlassesState) => {
    state = next;
    try {
      sessionStorage.setItem(SAVED, next);
    } catch {
      // As above.
    }
    emit();
  };
  const notReady = () => {
    if (state === "no-glasses") return failure("no_eligible_device", "No glasses are paired.");
    if (state === "needs-meta-ai") return failure("meta_ai_missing", "The Meta AI app isn't installed.");
    if (state === "paused") return failure("hinges_closed", "The glasses are folded.");
    return failure("session_ended", "The glasses aren't connected.");
  };

  const report = (line: Record<string, unknown>) => {
    const send = (window as unknown as Record<string, ((l: unknown) => Promise<unknown>) | undefined>)[config.binding];
    send?.(line)?.catch?.(() => {});
  };

  /** Runs one bridge method and logs it once: when it settles, or for speak when it starts, since speech takes a while. */
  async function call<T>(
    method: FakeGlassesMethod,
    params: Record<string, unknown> | undefined,
    run: () => Promise<T>,
    summary?: (value: T) => Record<string, unknown>,
  ): Promise<T> {
    const started = Date.now();
    const line = { method, params };
    let logged = false;
    try {
      if (failNext?.method === method) {
        const { code, message } = failNext;
        failNext = null;
        await wait(150);
        throw failure(code, message ?? "The glasses couldn't do that.");
      }
      // Text the real app would refuse isn't speech, so it logs as a failure below.
      if (method === "speak" && typeof params?.text === "string" && params.text && params.text.length <= 1000) {
        logged = true;
        report({ ...line, ok: true, ms: 0 });
      }
      const value = await run();
      if (!logged) report({ ...line, ok: true, ms: Date.now() - started, result: summary?.(value) });
      return value;
    } catch (err) {
      report({ ...line, ok: false, ms: Date.now() - started, error: (err as { code?: string }).code ?? String(err) });
      throw err;
    }
  }

  /** A JPEG of at most the size asked for, like the real app sends. */
  async function encode(src: string, maxSize?: number) {
    const image = new Image();
    image.src = src;
    await image.decode();
    const limit = Math.min(1600, maxSize ?? 1600);
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (scale === 1 && src.startsWith("data:image/jpeg")) return { dataUrl: src, width, height };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width, height };
  }

  const glasses = {
    status: () => call("status", undefined, async () => snapshot(), (s) => ({ state: s.state })),
    onStatus(cb: (s: Status) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    connect: () =>
      call(
        "connect",
        undefined,
        async () => {
          if (state === "ready") return snapshot();
          if (state === "needs-meta-ai" || state === "no-glasses" || state === "unavailable") throw notReady();
          error = null;
          moveTo("registering");
          await wait(350);
          moveTo("connecting");
          await wait(450);
          moveTo("ready");
          return snapshot();
        },
        (s) => ({ state: s.state }),
      ),
    capturePhoto: (o?: { maxSize?: number }) =>
      call(
        "capturePhoto",
        o,
        async () => {
          if (o?.maxSize !== undefined && !inRange(o.maxSize, 64, 1600)) throw failure("bad_request", "maxSize must be between 64 and 1600.");
          if (state !== "ready") throw notReady();
          if (!photos.length) throw failure("capture_failed", "installGlasses got no photos.");
          await wait(500);
          return encode(photos[nextPhoto++ % photos.length], o?.maxSize);
        },
        (p) => ({ width: p.width, height: p.height }),
      ),
    preview: (o: { show: boolean }) =>
      call("preview", o, async () => {
        if (typeof o?.show !== "boolean") throw failure("bad_request", "preview needs show to be true or false.");
        if (o.show && state !== "ready") throw failure("no_eligible_device", "Connect your glasses first.");
        await wait(100);
      }),
    startRecording: (o: { maxSeconds: number }) =>
      call("startRecording", o, async () => {
        if (!inRange(o?.maxSeconds, 1, 60)) throw failure("bad_request", "maxSeconds must be between 1 and 60.");
        if (recording && Date.now() < recordingEnds) throw failure("busy", "A recording is already running.");
        if (state !== "ready") throw notReady();
        recording = true;
        recordingEnds = Date.now() + o.maxSeconds * 1000;
        await wait(100);
      }),
    stopRecording: () =>
      call(
        "stopRecording",
        undefined,
        async () => {
          if (!recording) throw failure("bad_request", "Nothing is recording.");
          recording = false;
          await wait(200);
          return { ...config.question, source: "glasses" as const };
        },
        (r) => ({ seconds: r.seconds, source: r.source }),
      ),
    speak: (text: string) =>
      call("speak", { text }, async () => {
        if (typeof text !== "string" || !text || text.length > 1000) throw failure("bad_request", "speak needs text of 1000 characters or fewer.");
        await wait(Math.min(1500, 200 + text.length * 12));
      }),
  };

  const page = window as unknown as Record<string, unknown>;
  page.MuseNative = { version: 1, platform: "ios", capabilities: { glasses: true, frames: true }, glasses };
  page.__museGlassesFake = {
    set(patch: Omit<GlassesPatch, "photos"> & { photoUrls?: string[] }) {
      if (patch.battery !== undefined) device.battery = patch.battery;
      if (patch.worn !== undefined) device.worn = patch.worn;
      if (patch.error !== undefined) error = patch.error;
      if (patch.fail !== undefined) failNext = patch.fail;
      if (patch.photoUrls) {
        photos = patch.photoUrls;
        nextPhoto = 0;
      }
      if (patch.state) moveTo(patch.state);
      else emit();
    },
  };
}

/** Each page's calls, kept here so they survive the page reloading. */
const logs = new WeakMap<Page, GlassesCall[]>();

/** Gives the page a pair of fake glasses. Call it once per page, before page.goto. */
export async function installGlasses(page: Page, opts: InstallGlassesOptions = {}): Promise<void> {
  if (logs.has(page)) throw new Error("installGlasses is already on this page. Call it once, before page.goto.");
  if (page.url() !== "about:blank") throw new Error("Call installGlasses before page.goto, so the page finds the glasses as it loads.");

  const wav = opts.question ? readWav(opts.question) : silentWav();
  const config: FakeConfig = {
    binding: BINDING,
    photos: (opts.photos ?? []).map(photoDataUrl),
    question: {
      wavDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
      seconds: wavSecondsOf(wav, opts.question),
    },
    state: opts.state ?? "not-registered",
    device: { name: "Ray-Ban Meta", battery: 80, worn: true, ...opts.device },
  };

  // Outside a test (the platform's own checks) there is no test.info().
  let about = { project: "", test: "" };
  try {
    const info = test.info();
    about = { project: info.project.name, test: info.title };
  } catch {
    // Nothing to add to the log.
  }
  const calls: GlassesCall[] = [];
  logs.set(page, calls);
  mkdirSync(path.dirname(CALLS_FILE), { recursive: true });
  await page.exposeBinding(BINDING, (_source, line: Omit<GlassesCall, "t" | "project" | "test">) => {
    const entry: GlassesCall = { t: Date.now(), ...about, ...line };
    calls.push(entry);
    appendFileSync(CALLS_FILE, `${JSON.stringify(entry)}\n`);
  });
  await page.addInitScript(fakeBridge, config);
}

function readWav(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new Error(`installGlasses: can't read ${file}. Add the recording to fixtures/.`);
  }
}

function logOf(page: Page): GlassesCall[] {
  const calls = logs.get(page);
  if (!calls) throw new Error("Call installGlasses(page) first.");
  return calls;
}

export const glasses = {
  /**
   * What the glasses said, in order. Speech lands here a moment after the page asks for it, so wait for it with
   * await expect.poll(() => glasses.spoken(page)).toHaveLength(1).
   */
  async spoken(page: Page): Promise<string[]> {
    return logOf(page)
      .filter((c) => c.method === "speak" && c.ok)
      .map((c) => String(c.params?.text ?? ""));
  },
  /** Every call the page made to the glasses, in the order they finished. */
  async calls(page: Page): Promise<GlassesCall[]> {
    return [...logOf(page)];
  },
  /** Changes the glasses mid-test: await glasses.set(page, { state: "paused" }). */
  async set(page: Page, patch: GlassesPatch): Promise<void> {
    logOf(page);
    const { photos, ...rest } = patch;
    const change = { ...rest, ...(photos ? { photoUrls: photos.map(photoDataUrl) } : {}) };
    await page.evaluate((p) => {
      (window as unknown as { __museGlassesFake: { set(patch: unknown): void } }).__museGlassesFake.set(p);
    }, change);
  },
};
