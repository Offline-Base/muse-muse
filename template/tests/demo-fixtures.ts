// Platform file: don't edit. The demo video's recorder.
// The platform copies tests/smoke.spec.ts to tests/smoke.demo.spec.ts with its `@playwright/test` imports pointed here
// and runs the copy in the "studio" project. There the page fixture records the test for the platform's Demo Studio:
// JPEG frames from a CDP screencast (2560x1440, at most 30 fps), a cursor that glides to each control, text that
// appears key by key, a file chip on uploads, and a timeline of steps, actions, page activity, aria-busy changes,
// scrolls and results. Up to two new results a step are brought on screen and held a moment before the test moves
// on, and a passing test ends on its strongest result after the last model wait. An action that changes nothing (a
// fill with the value the field has, a choice already made) gets no glide. Frames are left out while the test takes a
// page screenshot. It writes test-results/demo/timeline.json (version 1) and test-results/demo/frames/*.jpg. In every
// other project this module is plain @playwright/test. The choreography never changes what an action does: an error
// in it is swallowed, the typing is only drawn (the app sees the action's own events and nothing else), and the
// original action always runs with the arguments the test gave it. The time the choreography adds is added to the
// test's timeout. In a VR product (tests/xr.ts) each scripted move in the headset is an "xr" action kept at real speed, and
// a result fills the whole view, so it gets a hold and no zoom.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  test as base,
  type CDPSession,
  type Frame,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
  type TestStepInfo,
} from "@playwright/test";

export * from "@playwright/test";

/** The Playwright project that records. "demo" is the old recorder (Playwright's own video), kept for older platforms. */
const DEMO_PROJECT = "studio";
/** The most frames a second the screencast may send. Acks are held back to keep to it. */
const MAX_FPS = 30;
/** How long a new result stays on screen, counted from when it is in view, before the test moves on. */
const RESULT_HOLD_MS = 2800;
/** A step's second result holds this long when it lands where the first one did, like a card moved along a board. */
const REPEAT_HOLD_MS = 800;
/** Past this much of the video's main part, a result that took no model wait holds at most LATE_HOLD_MS. */
const LATE_MAIN_MS = 30_000;
const LATE_HOLD_MS = 1000;
/** The most results a step holds. */
const STEP_HOLDS = 2;
/** A result the viewer waited this long for came from a model. */
const MODEL_MS = 1500;
/** How long the final state stays on screen after the last result's hold, so the video can end on it. */
const HOLD_MS = 800;
/** How long an action's choreography waits for its element when neither the action nor the test sets a timeout. */
const WAIT_MS = 120_000;
/** How long one call into the page may take before the recorder goes on without it, for a page whose clock is paused. */
const PAGE_CALL_MS = 4000;
/** The file chip's drop: the upload happens when it lands, and the next action waits for it to fade. */
const CHIP_MS = 900;
const CHIP_LAND_MS = 550;
/** Names the recorder adds to the page: the binding the page reports through and the cursor's own API. */
const BINDING = "__musemuseDemoReport";
const API = "__musemuseDemo";

interface Point {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type ActionKind = "goto" | "click" | "type" | "upload" | "select" | "check" | "press" | "hover" | "xr";
type ActionMethod = "click" | "dblclick" | "check" | "uncheck" | "selectOption" | "setInputFiles" | "fill" | "hover" | "press";

/** The Locator methods the recorder choreographs, and the timeline kind each one records. */
const ACTIONS: Record<ActionMethod, ActionKind> = {
  click: "click",
  dblclick: "click",
  check: "check",
  uncheck: "check",
  selectOption: "select",
  setInputFiles: "upload",
  fill: "type",
  hover: "hover",
  press: "press",
};
/** Methods whose options come first. The rest take a value (text, key, files, options to select) and then options. */
const OPTIONS_FIRST = new Set<ActionMethod>(["click", "dblclick", "check", "uncheck", "hover"]);

interface ActionOptions {
  force?: boolean;
  timeout?: number;
  trial?: boolean;
  position?: Point;
}
interface ActionEntry {
  kind: ActionKind;
  /** When the cursor starts moving to the element. Waiting for the element to appear comes before it. */
  t0: number;
  /** When the cursor is there and Playwright's own action starts. It may still wait, say for a button to be enabled. */
  ready: number;
  t1: number;
  label: string;
  rect?: Rect | undefined;
  fileName?: string;
  /** Characters drawn into the field key by key, for fills. */
  typed?: number;
  /** The element already had the value or state the action gives it, so the cursor stayed where it was. */
  noop?: boolean;
  /** Headings, labels and the app bar on screen when the element was measured, which a crop edge shouldn't cut. */
  heads?: Rect[];
  /** How long the choreography waited for the element, which the action itself would have waited too. */
  waited: number;
}
/** What prepareTarget measures in the page, in viewport CSS px. */
interface Target {
  /** The element's first box, where Playwright points the mouse for a click, even when it is tiny or transparent. */
  own: Rect | null;
  /** What a viewer sees of the element: itself, or for something hidden its picker button, its label or a parent. */
  seen: Rect | null;
  label: string;
  /** An enabled text field whose value the fill changes: the recorder draws the new text into it key by key. */
  typeable: boolean;
  /** A visible native file input, whose "Choose file" button sits at its left end. */
  picker: boolean;
  /** The element is <html> or <body>, so there is nothing to point at. */
  whole: boolean;
  /** The action would change nothing: the field already has the value, the option is already chosen. */
  noop: boolean;
  /** Headings, labels and the app bar on screen. */
  heads: Rect[];
  /** Where the cursor overlay last saw the mouse in this document. */
  mouse: Point | null;
}
/** A result the page brought on screen for the recorder (demoPageScript settle). Times are the page's Date.now(). */
interface Settled {
  /** When it appeared, which also says which result it is. */
  at: number;
  /** When it came on screen: when the scroll to it started, or when it appeared if it was already in view. */
  t: number;
  /** When it was all in view: when that scroll ended, or when it appeared. */
  since: number;
  /** Its box once in view, and the page's scroll position then. */
  rect: Rect;
  scrollY: number;
  /** How long the viewer waited for it: its aria-busy span, or the time since they last pressed or typed. */
  waited: number;
  /** It came from an aria-busy section, the model's own output. */
  busy: boolean;
  /** Pictures in it: images, canvases, videos and SVGs at least 64 px each way. */
  media: number;
  /** On screen while it is held: headings, labels and the app bar, empty text fields, the control pressed last. */
  heads: Rect[];
  blanks: Rect[];
  pressed: Rect | null;
  /** The content column (main's content box), when the page has one narrower than the screen. */
  column: { x: number; w: number } | null;
  /** The page scrolled to bring it on screen. */
  moved: boolean;
  /** It was held before: the final pick can be a result the test already showed. */
  again: boolean;
}
/** A held result, as the timeline keeps it. Times are epoch ms until the timeline is written. */
type HeldResult = Omit<Settled, "since" | "column" | "moved" | "again">;
/** What a page sends a few times a second. Times are the page's Date.now(). */
interface PageReport {
  activity?: Array<{ t: number; added: number; changed: number; text: number; rect: Rect }>;
  busy?: Array<{ t: number; on: boolean; rect: Rect }>;
  scrolls?: Array<{ t: number; y: number }>;
}
/** The overlay's API in the page, from demoPageScript. */
interface DemoApi {
  ripple(x: number, y: number): void;
  chip(x: number, y: number, text: string): void;
  where(): Point | null;
  scroll(to: number): Promise<boolean>;
  type(el: Element, text: string, delay: number): Promise<number>;
  settle(since: number, final: boolean): Promise<Settled | null>;
  /** Headings, labels and the app bar on screen. */
  heads(): Rect[];
  /** While on, the cursor ignores the real mouse: no move, no ripple. */
  hush(on: boolean): void;
  /** Fades the cursor out now, as it does after a rest. */
  rest(): void;
  /** Whether the cursor is on screen, fading out included. */
  showing(): boolean;
  /** Puts a hidden cursor where the mouse went while hushed, so it shows there on the next move. */
  park(x: number, y: number): void;
}
type DemoWindow = Record<string, DemoApi | undefined>;

/** Slow start, slow finish (easeInOutCubic). */
export function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

/** How long the cursor takes to glide a distance in CSS px: 450 ms for a short hop, up to 750 ms across the screen. */
export function glideMs(distance: number): number {
  return Math.round(450 + 300 * Math.min(1, Math.max(0, distance) / 900));
}

/**
 * What the recorder draws for a fill, at most about 1.6 s of keys. Text over 160 characters shows its first 60 and the
 * fill puts in the rest. The drawing stops before a line break or a tab, which a one-line field can't show.
 */
export function typingPlan(value: string): { text: string; delay: number } {
  const chars = Array.from(value);
  let typed = chars.length > 160 ? chars.slice(0, 60) : chars;
  const stop = typed.findIndex((c) => c === "\n" || c === "\r" || c === "\t");
  if (stop >= 0) typed = typed.slice(0, stop);
  return { text: typed.join(""), delay: typed.length ? Math.min(45, Math.max(8, 1600 / typed.length)) : 0 };
}

/** The file names in setInputFiles' first argument: a path, a file payload, or a list of either. */
export function uploadNames(files: unknown): string[] {
  return (Array.isArray(files) ? files : [files])
    .map((f) => (typeof f === "string" ? path.basename(f) : f && typeof f === "object" && "name" in f ? String(f.name) : ""))
    .filter(Boolean);
}

/** Width and height of a JPEG, from its start-of-frame marker. Null when the bytes don't say. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const at = (i: number) => bytes[i] ?? 0;
  const u16 = (i: number) => (at(i) << 8) | at(i + 1);
  for (let i = 2; i + 9 < bytes.length && at(i) === 0xff; i += 2 + u16(i + 2)) {
    const marker = at(i + 1);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16(i + 7), height: u16(i + 5) };
    }
  }
  return null;
}

/** A rect cut to the viewport and rounded, or undefined when none of it is on screen. */
export function clampRect(r: Rect, viewport: { width: number; height: number }): Rect | undefined {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(viewport.width, r.x + r.w);
  const y1 = Math.min(viewport.height, r.y + r.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return undefined;
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/**
 * Where the cursor aims in a box: its middle, or for a native file input its "Choose file" button at the left end.
 * The box is cut to the viewport first, so the cursor never aims off screen.
 */
export function aimPoint(box: Rect, viewport: { width: number; height: number }, picker = false): Point {
  const part = clampRect(box, viewport) ?? box;
  return { x: picker ? part.x + Math.min(part.w / 2, 48) : part.x + part.w / 2, y: part.y + part.h / 2 };
}

/** True when two boxes overlap or lie within `margin` px of each other, like two cards in one column. */
export function nearBoxes(a: Rect, b: Rect, margin = 48): boolean {
  return Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h)) <= margin;
}

/**
 * How long a result holds, in ms: the full RESULT_HOLD_MS, or REPEAT_HOLD_MS for a step's later result that lands
 * near the one before it. Past LATE_MAIN_MS of main part, a result that took no model wait holds at most LATE_HOLD_MS.
 * The final pick always holds in full.
 */
export function holdMs(o: { later: boolean; near: boolean; waited: number; mainMs: number; final?: boolean }): number {
  if (o.final) return RESULT_HOLD_MS;
  const ms = o.later && o.near ? REPEAT_HOLD_MS : RESULT_HOLD_MS;
  return o.waited < MODEL_MS && o.mainMs > LATE_MAIN_MS ? Math.min(ms, LATE_HOLD_MS) : ms;
}

/**
 * What Demo Studio will cut from a quiet stretch of `ms` with nothing on screen moving, in ms: it plays a stretch over
 * 1.6 s in min(1.4, 0.5 + 0.1 * seconds) seconds, at most 16 times faster (demo-plan.mjs idleOutputSeconds).
 */
export function idleCutMs(ms: number): number {
  if (ms <= 1600) return 0;
  return ms - Math.max(Math.min(1400, 500 + 0.1 * ms), ms / 16);
}

/** The options selectOption asks for, by value or label, when they are plain: strings, or { value } or { label }. */
export function wantedOptions(arg: unknown): string[] | null {
  const one = (v: unknown) => {
    if (typeof v === "string") return v;
    const o = v && typeof v === "object" && !Array.isArray(v) ? (v as { value?: unknown; label?: unknown }) : null;
    return o ? (o.value ?? o.label) : null;
  };
  const list = (Array.isArray(arg) ? arg : [arg]).map(one);
  return list.length && list.every((v): v is string => typeof v === "string") ? list : null;
}

type LocatorAction = (...args: unknown[]) => Promise<unknown>;

/**
 * Calls an original Locator method as a method of the locator itself. Playwright names an action in its errors from
 * the stack ("locator.click: Timeout ..."), and calling it through .apply or .call would show there instead.
 */
function callAsMethod(locator: Locator, method: ActionMethod, original: LocatorAction, args: unknown[]): Promise<unknown> {
  const own = locator as unknown as Record<ActionMethod, LocatorAction>;
  Object.defineProperty(locator, method, { value: original, configurable: true, writable: true });
  try {
    return own[method](...args);
  } finally {
    Reflect.deleteProperty(locator, method);
  }
}

/** Takes this file's lines out of an action's error stack, so Playwright points at the test's own line. */
function withoutOwnFrames(err: unknown): unknown {
  if (err instanceof Error && err.stack) err.stack = err.stack.split("\n").filter((line) => !/[\\/]demo-fixtures\.ts:\d/.test(line)).join("\n");
  return err;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const firstLine = (err: unknown) => ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").slice(0, 300);
const shortName = (s: string) => (s.length > 36 ? `${s.slice(0, 33)}...` : s);
const urlLabel = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
};

/**
 * A page call that gives up after `ms`. A page whose clock is paused (page.clock) or that is stuck in a long task
 * would otherwise hang the test. The call itself goes on in the page, and its late result or error is ignored.
 */
function within<T>(work: Promise<T>, what: string, ms = PAGE_CALL_MS): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${Math.round(ms / 100) / 10} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The recording in progress, if any. The patched Locator methods and test.step check it. */
let current: DemoRecorder | null = null;
/** Only the first test a worker runs is recorded, so a spec with more than one test gives the first test's video. */
let recordedOnce = false;

/** One test's recording: the screencast, the cursor choreography and the timeline. */
class DemoRecorder {
  readonly page: Page;
  readonly dir: string;
  readonly steps: Array<{ title: string; t0: number; t1: number; depth: number }> = [];
  // Every time below is epoch ms until the timeline is written.
  private readonly actions: ActionEntry[] = [];
  private readonly activity: Array<{ t: number; added: number; changed: number; text: number; rect: Rect }> = [];
  private readonly busy: Array<{ t: number; on: boolean; rect: Rect }> = [];
  private readonly scrolls: Array<{ t: number; y: number }> = [];
  private readonly results: HeldResult[] = [];
  /** The page's content column, from the latest result that reported one. */
  private column: { x: number; w: number } | null = null;
  private readonly viewports: Array<{ t: number; width: number; height: number }> = [];
  private readonly frames: Array<{ file: string; at: number }> = [];
  private readonly writes = new Set<Promise<void>>();
  private readonly problems: string[] = [];
  private readonly restores: Array<() => void> = [];
  private readonly testInfo: TestInfo;
  /** The test's actionTimeout, 0 when it has none. */
  private readonly actionTimeout: number;
  /** Inter for the file chip (scripts/demo-inter.woff2) as base64, when the product has it. */
  private readonly font: string | null;
  /** A VR product records at 1x on purpose (playwright.config.ts). */
  private readonly vr: boolean;
  /** A VR move ran since the last VR hold, so the view may show something new. */
  private xrUnheld = false;
  /** The summary card on the 2D page has had its hold, after leaving VR. */
  private summaryHeld = false;
  /** The viewport the recording started with, which the timeline's rects are measured in. */
  private viewport = { width: 1280, height: 720 };
  /** The viewport now, after any page.setViewportSize. */
  private screen = { width: 1280, height: 720 };
  private dpr = 1;
  private cdp: CDPSession | null = null;
  private starting: Promise<void> | null = null;
  /** Capture time of the first frame: time zero of the timeline. */
  private origin: number | null = null;
  private startedAt = 0;
  private endedAt: number | null = null;
  private stopping = false;
  private lastData = "";
  private acks: Promise<void> = Promise.resolve();
  private lastAck = 0;
  private throttled = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | null = null;
  private firstFrame: (() => void) | null = null;
  private mouse: Point | null = null;
  private acting = false;
  private navigating = 0;
  /** Page screenshots and viewport changes running now. Frames that arrive meanwhile are dropped. */
  private blackout = 0;
  /** When the running top-level step began (0 outside one), how many results it held, and where its last one was. */
  private stepStart = 0;
  private stepHolds = 0;
  private stepLast: Rect | null = null;
  /**
   * Actions and holds running now, when the last one finished, and the ms Demo Studio will cut from the quiet
   * stretches between them (idleCutMs), for the main part's length.
   */
  private activeDepth = 0;
  private busyUntil = 0;
  private idleCut = 0;

  constructor(page: Page, root: string, dpr: number, testInfo: TestInfo, actionTimeout: number) {
    this.page = page;
    this.dir = path.join(root, "test-results", "demo");
    this.dpr = dpr;
    this.testInfo = testInfo;
    this.actionTimeout = actionTimeout;
    let font: string | null = null;
    try {
      font = readFileSync(path.join(root, "scripts", "demo-inter.woff2")).toString("base64");
    } catch {
      // The chip uses the system's fonts.
    }
    this.font = font;
    let vr = false;
    try {
      const { targets } = JSON.parse(readFileSync(path.join(root, "musemuse.target.json"), "utf8")) as { targets?: unknown };
      vr = Array.isArray(targets) && targets.includes("vr");
    } catch {
      // A web product.
    }
    this.vr = vr;
  }

  /** Sets everything up before the test opens the product. The screencast starts once the app is on screen. */
  async install(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(path.join(this.dir, "frames"), { recursive: true });
    this.viewport = this.page.viewportSize() ?? this.viewport;
    this.screen = { ...this.viewport };
    this.patchLocators();
    this.patchGoto();
    this.patchScreenshot();
    this.patchViewport();
    await this.page.exposeBinding(BINDING, (_source, json: string) => this.onPageReport(json));
    await this.page.addInitScript(demoPageScript, { binding: BINDING, api: API, font: this.font, modelMs: MODEL_MS, vr: this.vr });
  }

  note(problem: string): void {
    if (this.problems.length < 100) this.problems.push(problem);
  }

  /** Gives the test back the time the recorder added, unless it runs with no timeout at all. */
  private extendTimeout(ms: number): void {
    const info = this.testInfo;
    if (ms > 0 && info.timeout > 0) info.setTimeout(info.timeout + Math.ceil(ms));
  }

  /** Starts the screencast once and waits for its first frame. The cursor appears at its resting place. */
  start(): Promise<void> {
    this.starting ??= (async () => {
      try {
        const cdp = await this.page.context().newCDPSession(this.page);
        this.cdp = cdp;
        cdp.on("Page.screencastFrame", (frame) => this.onFrame(frame));
        const first = new Promise<void>((resolve) => {
          this.firstFrame = resolve;
          setTimeout(resolve, 1500);
        });
        this.startedAt = Date.now();
        await this.screencast();
        await first;
        await this.moveTo(this.restPoint());
      } catch (err) {
        this.note(`start: ${firstLine(err)}`);
      }
    })();
    return this.starting;
  }

  /** One move in VR. ready = t1, so Demo Studio keeps all of it at real speed, and "xr" isn't a kind the camera cuts to. */
  async xrAction<T>(label: string, run: () => Promise<T>): Promise<T> {
    // The 3D preview on the landing page looks like a result to the recorder. It would get the zoom and the poster.
    if (!this.actions.some((a) => a.kind === "xr")) this.results.length = 0;
    if (!this.stepStart) this.beginStep(Date.now());
    this.active();
    await this.start();
    await this.cursor("rest");
    const entry: ActionEntry = { kind: "xr", t0: Date.now(), ready: 0, t1: 0, label, waited: 0 };
    try {
      return await run();
    } finally {
      entry.ready = entry.t1 = Date.now();
      this.actions.push(entry);
      this.xrUnheld = true;
      this.quiet();
    }
  }

  /**
   * A result that fills the whole view, held a moment. The planner doesn't zoom past 60% of the screen, and the last one
   * becomes the poster: holdSummary's card on the 2D page has no wait or pictures to outrank it.
   */
  async holdXr(): Promise<void> {
    await this.start();
    this.xrUnheld = false;
    const now = Date.now();
    const rect = { x: 0, y: 0, w: this.screen.width, h: this.screen.height };
    this.results.push({ t: now, at: now, rect, scrollY: 0, waited: 0, busy: true, media: 1, heads: [], blanks: [], pressed: null });
    this.active();
    this.extendTimeout(RESULT_HOLD_MS);
    await sleep(RESULT_HOLD_MS);
    this.quiet();
  }

  /** A top-level step that moved in VR ends on what it shows, unless the test already held it with xr.hold. */
  async endXrStep(): Promise<void> {
    if (this.xrUnheld && !this.page.isClosed() && (await this.inVrSession())) await this.holdXr();
  }

  /**
   * After leaving VR the page has one thing left to show: its summary card, marked data-result (the muse-vr skill). It comes
   * on screen and gets a hold of its own. The rest of the page's results don't count once a person has been in VR, since the
   * 3D preview would look like the strongest of them.
   */
  private async holdSummary(): Promise<number> {
    if (this.summaryHeld || (await this.inVrSession())) return 0;
    const started = Date.now();
    this.active();
    try {
      const call = this.page.evaluate(async () => {
        const el = [...document.querySelectorAll("[data-result]")].pop();
        if (!el) return null;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        await new Promise((done) => setTimeout(done, 800));
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollY: Math.round(window.scrollY) };
      });
      const card = await within(call, "bringing the summary card on screen", PAGE_CALL_MS + 3000);
      if (!card) return 0;
      this.summaryHeld = true;
      const { scrollY, ...rect } = card;
      const now = Date.now();
      this.results.push({ t: now, at: now, rect, scrollY, waited: 0, busy: false, media: 0, heads: [], blanks: [], pressed: null });
      await sleep(RESULT_HOLD_MS);
    } catch (err) {
      this.note(`summary card: ${firstLine(err)}`);
    } finally {
      this.quiet();
    }
    const took = Date.now() - started;
    this.extendTimeout(took);
    return took;
  }

  /** True when the page is in a VR session now: nothing on the 2D page is on screen. */
  private async inVrSession(): Promise<boolean> {
    if (!this.actions.some((a) => a.kind === "xr")) return false;
    const call = this.page.evaluate(() => (window as unknown as { __musemuseXR?: { inSession(): boolean } }).__musemuseXR?.inSession() === true);
    return within(call, "checking the VR session").catch(() => false);
  }

  /** Ends the recording: restores Playwright, holds the final state, stops the screencast and writes the timeline. */
  async finish(testInfo: TestInfo): Promise<void> {
    for (const restore of this.restores.splice(0)) restore();
    try {
      if (!this.page.isClosed()) {
        await this.start();
        // A passing test ends on its strongest result after the last model wait.
        if (testInfo.status === "passed") {
          await this.endXrStep();
          await this.settleResult(true);
        }
        this.extendTimeout(HOLD_MS);
        await sleep(HOLD_MS);
      }
      await this.stop();
    } catch (err) {
      this.note(`stop: ${firstLine(err)}`);
    }
    try {
      const timeline = this.timeline(testInfo.status ?? "passed");
      writeFileSync(path.join(this.dir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
      if (this.problems.length) writeFileSync(path.join(this.dir, "recorder.log"), `${this.problems.join("\n")}\n`);
      const problems = this.problems.length ? `, ${this.problems.length} problem(s) in test-results/demo/recorder.log` : "";
      console.log(
        `musemuse demo: ${timeline.frames.length} frames, ${timeline.steps.length} steps, ${timeline.actions.length} actions, ` +
          `${timeline.results.length} results, ${timeline.duration} s${problems}`,
      );
    } catch (err) {
      console.log(`musemuse demo: could not write the timeline: ${firstLine(err)}`);
    }
  }

  /** A top-level step began: results from before it are left alone, and it holds up to STEP_HOLDS of its own. */
  beginStep(t: number): void {
    this.stepStart = t;
    this.stepHolds = 0;
    this.stepLast = null;
  }

  /**
   * Holds new results on screen before the test moves on, as a person would read them: up to STEP_HOLDS a step,
   * oldest first, only ones that appeared in this step and are at least 2% of the screen (demoPageScript settle). The
   * page scrolls each into view when the test left most of it off screen, the cursor moves off it, and the recorder
   * waits until it has been in view for its hold (holdMs). The timeline gets each one with its box once in view, for
   * the camera. At the end of a passing test (`final`) the page goes back to its strongest result after the last
   * model wait and holds it, unless it is still in view from its own hold. The test gets the time back. Returns the ms
   * it took, and never throws.
   */
  async settleResult(final = false): Promise<number> {
    if (!this.starting || this.page.isClosed()) return 0;
    if (this.actions.some((a) => a.kind === "xr")) return this.holdSummary();
    const started = Date.now();
    this.active();
    try {
      for (let n = 0; n < STEP_HOLDS && (!this.stepStart || this.stepHolds < STEP_HOLDS); n++) {
        const shown = await this.bringResult(this.stepStart, false);
        if (!shown) break;
        await this.hold(shown, false);
      }
      const best = final ? await this.bringResult(0, true) : null;
      if (best && (best.moved || !best.again)) await this.hold(best, true);
    } catch (err) {
      this.note(`result: ${firstLine(err)}`);
    } finally {
      this.quiet();
    }
    const took = Date.now() - started;
    this.extendTimeout(took);
    return took;
  }

  /** Asks the page for the next result to hold, or with `final` its strongest, brought on screen. */
  private bringResult(since: number, final: boolean): Promise<Settled | null> {
    const call = this.page.evaluate(({ api, since, final }) => (window as unknown as DemoWindow)[api]?.settle(since, final) ?? null, {
      api: API,
      since,
      final,
    });
    // It may wait for pictures to decode, then scroll.
    return within(call, "bringing the result on screen", PAGE_CALL_MS + 3000);
  }

  /** Holds one result the page brought on screen, with the cursor off it, and keeps it for the timeline. */
  private async hold(shown: Settled, final: boolean): Promise<void> {
    // Page times come from the browser's own clock, which the recorder saved before a test could fake it.
    const at = (t: number) => (Math.abs(t - Date.now()) < 60_000 ? t : Date.now());
    const { rect, scrollY, waited, busy, media, heads, blanks, pressed } = shown;
    this.results.push({ t: at(shown.t), at: at(shown.at), rect, scrollY, waited, busy, media, heads, blanks, pressed });
    if (shown.column) this.column = shown.column;
    const where = { ...rect, y: rect.y + scrollY };
    const later = this.stepHolds > 0;
    const ms = holdMs({ later, near: later && !!this.stepLast && nearBoxes(where, this.stepLast), waited, mainMs: this.mainMs(), final });
    if (!final) {
      this.stepHolds++;
      this.stepLast = where;
    }
    // A result noticed after its hold would have ended needs no room made for it.
    const wait = at(shown.since) + ms - Date.now();
    if (wait <= 0) return;
    const away = this.leave(rect);
    await sleep(wait);
    await away;
  }

  /**
   * Takes the cursor off a result about to be held, as a hand leaves the mouse to read: when the mouse is on the result
   * (and its resting place outside the content column isn't), the cursor glides there, or, when it already faded during
   * a wait, the mouse moves there unseen so the cursor doesn't show again over the result. Then it fades out until the
   * next move. The hold runs meanwhile.
   */
  private async leave(rect: Rect): Promise<void> {
    const on = (p: Point) => p.x >= rect.x - 8 && p.x <= rect.x + rect.w + 8 && p.y >= rect.y - 8 && p.y <= rect.y + rect.h + 8;
    const rest = this.restPoint();
    try {
      if (this.mouse && on(this.mouse) && !on(rest)) {
        const showing = this.page.evaluate((api) => (window as unknown as DemoWindow)[api]?.showing() ?? true, API);
        if (await within(showing, "checking the cursor").catch(() => true)) {
          await this.glide(rest);
        } else {
          await this.cursor("hush", true);
          await this.moveTo(rest);
          await this.cursor("park");
          await this.cursor("hush", false);
        }
      }
    } catch (err) {
      this.note(`cursor: ${firstLine(err)}`);
    }
    await this.cursor("rest");
  }

  /** About how long the video's main part is so far, in ms: the recording less what Demo Studio will cut from waits. */
  private mainMs(): number {
    return this.origin === null ? 0 : Math.max(0, Date.now() - this.origin - this.idleCut);
  }

  /** Something starts on screen (an action, a hold). The quiet stretch before it will be sped up. */
  private active(): void {
    if (this.activeDepth++ === 0 && this.busyUntil) this.idleCut += idleCutMs(Date.now() - this.busyUntil);
  }

  private quiet(): void {
    if (--this.activeDepth === 0) this.busyUntil = Date.now();
  }

  /** Runs one patched Locator action: the choreography, then the original action, recorded in the timeline. */
  async perform(locator: Locator, method: ActionMethod, args: unknown[], run: () => Promise<unknown>): Promise<unknown> {
    const options = (args[OPTIONS_FIRST.has(method) ? 0 : 1] ?? {}) as ActionOptions;
    // A trial run doesn't act, and an action started while another one runs (Promise.all) just runs.
    if (this.acting || options.trial) return run();
    this.acting = true;
    this.active();
    const started = Date.now();
    // A test without steps is one step from its first action, so it holds no more results than a step does.
    if (!this.stepStart) this.beginStep(started);
    const entry: ActionEntry = { kind: ACTIONS[method], t0: started, ready: started, t1: 0, label: "", waited: 0 };
    // Clearing a file input (setInputFiles([])) is an upload with no file name.
    if (entry.kind === "upload") entry.fileName = uploadNames(args[0])[0] ?? "";
    let plan = { after: 0, hush: false };
    let held = 0;
    try {
      try {
        await this.start();
        // The last result gets its moment before the cursor heads somewhere else.
        held = await this.settleResult();
        plan = await this.choreograph(locator, method, args, options, entry);
      } catch (err) {
        this.note(`${method}: ${firstLine(err)}`);
      }
      entry.ready = Date.now();
      // Waiting for the element is the action's own wait, and a result's hold gave its time back already. The rest is
      // the choreography's, so the test gets it back too.
      this.extendTimeout(entry.ready - started - held - entry.waited);
      // A click that changes nothing still runs, with the cursor left where it was and no ripple.
      if (plan.hush) await this.cursor("hush", true);
      let result: unknown;
      try {
        result = await run();
      } finally {
        entry.t1 = Date.now();
        this.actions.push(entry);
        this.acting = false;
        if (plan.hush) await this.cursor("hush", false);
        // A long wait inside the action, like a button that only enables with the answer, is sped up too.
        this.idleCut += idleCutMs(entry.t1 - entry.ready);
      }
      if (plan.after > 0) {
        this.extendTimeout(plan.after);
        await sleep(plan.after);
      }
      return result;
    } finally {
      this.quiet();
    }
  }

  /**
   * What a person would do before the action: wait for the element, read a result that came with it, bring the
   * element on screen, glide the cursor to it and pause. Fields get a click ripple and their new text drawn key by
   * key, selects a ripple, uploads a ripple and the file chip. An action that would change nothing gets none of it,
   * and a click of that kind runs with the cursor hushed. Returns ms to hold after the action and whether to hush.
   * Throws on anything unexpected, and perform swallows it.
   */
  private async choreograph(
    locator: Locator,
    method: ActionMethod,
    args: unknown[],
    options: ActionOptions,
    entry: ActionEntry,
  ): Promise<{ after: number; hush: boolean }> {
    const kind = ACTIONS[method];
    // Clicks, checks and hovers move the real mouse to the center of the element's own box (the part on screen), so
    // the cursor aims there even when it is tiny or transparent. The other actions don't move the mouse, so the cursor
    // goes to what a viewer sees, like the FilePicker button for its hidden input.
    const pointer = kind === "click" || kind === "check" || kind === "hover";
    const value = kind === "type" ? String(args[0] ?? "") : null;
    const choices = method === "selectOption" ? wantedOptions(args[0]) : null;
    const aim = (t: Target): { box: Rect; at: Point } | null => {
      const box = pointer ? (t.own ?? t.seen) : (t.seen ?? t.own);
      if (!box) return null;
      if (options.position && box === t.own) return { box, at: { x: box.x + options.position.x, y: box.y + options.position.y } };
      return { box, at: aimPoint(box, this.screen, t.picker && !pointer) };
    };
    const measure = (scroll: boolean) =>
      within(locator.evaluate(prepareTarget, { scroll, pointer, value, method, choices, api: API }, { timeout: 5000 }), "measuring the element");

    // Wait the way the action would, so the cursor moves once the element is there: visible for most actions, only in
    // the page for a hidden file input, a key press and a forced action. Never longer than the action itself may wait.
    const waitFrom = Date.now();
    const attached = kind === "upload" || kind === "press" || options.force;
    await locator.waitFor({ state: attached ? "attached" : "visible", timeout: options.timeout || this.actionTimeout || WAIT_MS });
    // An element that came with a result, like a follow-up field under an answer, lets the answer be read first.
    if (Date.now() - waitFrom > 500) await this.settleResult();
    // Neither wait is the choreography's: the element's is the action's own, and settleResult gave its hold back.
    entry.waited = Date.now() - waitFrom;
    entry.t0 = Date.now();
    let target = await measure(true).catch((err: unknown) => {
      this.note(`scroll: ${firstLine(err)}`);
      return measure(false);
    });
    let aimed = aim(target);
    if (aimed && !target.noop && kind !== "upload" && !clampRect(aimed.box, this.screen)) {
      // Inside a scrolling box the page's scroll isn't enough: Playwright scrolls the box, then measure again.
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      target = await measure(false);
      aimed = aim(target);
    }
    // A press is labelled with its key, like "Enter in Search", or just "Escape" when pressed on the page.
    entry.label = kind === "press" ? (target.whole ? String(args[0]) : `${String(args[0])} in ${target.label}`) : target.label;
    // The timeline gets what a viewer sees, even when the cursor aims at a tiny or transparent input.
    if (aimed) entry.rect = clampRect(target.seen ?? aimed.box, this.screen);
    if (target.heads.length) entry.heads = target.heads;
    if (kind === "type") entry.typed = 0;
    // A fill with the value the field has, or a choice already made: the viewer would see the cursor do nothing.
    if (target.noop) {
      entry.noop = true;
      return { after: 0, hush: kind === "click" };
    }
    if (!aimed || (kind === "press" && target.whole)) return { after: 0, hush: false };

    // Start from where the overlay last saw the mouse: an action this file doesn't patch may have moved it.
    if (target.mouse && this.mouse && Math.hypot(target.mouse.x - this.mouse.x, target.mouse.y - this.mouse.y) > 2) this.mouse = target.mouse;
    let point = aimed.at;
    await this.glide(point);
    // Something still moving, like a card sliding in, gets a short second glide so the action doesn't jump the cursor.
    const settled = await measure(false).catch(() => null);
    const again = settled && aim(settled);
    if (settled && again) {
      if (Math.hypot(again.at.x - point.x, again.at.y - point.y) > 3) {
        point = again.at;
        await this.glide(point, 220);
      }
      entry.rect = clampRect(settled.seen ?? again.box, this.screen) ?? entry.rect;
    }
    await sleep(120);

    // Clicks, checks and hovers show their ripple from the real mousedown. These actions don't press the mouse.
    if (kind === "type" || kind === "select" || kind === "upload") await this.callPage("ripple", point);
    if (value !== null && target.typeable) {
      const plan = typingPlan(value);
      if (plan.text) {
        await sleep(140);
        // Drawn only: the page gets no key or input events, and the fill that runs next sets the exact value with its
        // own, as it would without the recorder.
        const draw = locator.evaluate((el, a) => (window as unknown as DemoWindow)[a.api]?.type(el, a.text, a.delay) ?? 0, {
          api: API,
          text: plan.text,
          delay: plan.delay,
        });
        entry.typed = await within(draw, "typing", PAGE_CALL_MS + plan.text.length * plan.delay * 2);
      }
    }
    const names = kind === "upload" ? uploadNames(args[0]) : [];
    const first = names[0];
    if (first) {
      await this.callPage("chip", point, names.length > 1 ? `${shortName(first)} and ${names.length - 1} more` : shortName(first));
      await sleep(CHIP_LAND_MS);
      return { after: CHIP_MS - CHIP_LAND_MS, hush: false };
    }
    return { after: 0, hush: false };
  }

  /** Eased glide with a slight arc, in small page.mouse.move steps, so the app sees real mouse moves. */
  private async glide(to: Point, ms?: number): Promise<void> {
    const from = this.mouse ?? this.restPoint();
    if (!this.mouse) await this.moveTo(from);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) return;
    const duration = ms ?? glideMs(distance);
    const bend = Math.min(36, distance * 0.08);
    const t0 = Date.now();
    for (let p = 0; p < 1; ) {
      await sleep(12);
      p = Math.min(1, (Date.now() - t0) / duration);
      const e = easeInOut(p);
      const arc = Math.sin(Math.PI * e) * bend;
      await this.moveTo({ x: from.x + dx * e - (dy / distance) * arc, y: from.y + dy * e + (dx / distance) * arc });
    }
  }

  private async moveTo(p: Point): Promise<void> {
    await this.page.mouse.move(p.x, p.y);
    this.mouse = p;
  }

  /** Where the cursor rests before the first action and off a held result: the right edge, outside the column. */
  private restPoint(): Point {
    return { x: this.screen.width - 100, y: Math.round(this.screen.height * 0.72) };
  }

  private async callPage(name: "ripple" | "chip", at: Point, text = ""): Promise<void> {
    const call = this.page.evaluate(
      ({ api, name, x, y, text }) => {
        const demo = (window as unknown as DemoWindow)[api];
        if (name === "chip") demo?.chip(x, y, text);
        else demo?.ripple(x, y);
      },
      { api: API, name, x: at.x, y: at.y, text },
    );
    await within(call, name);
  }

  /** Hushes the cursor (on or off), rests it, or parks it where the mouse is now. Never throws. */
  private async cursor(name: "hush" | "rest" | "park", on = false): Promise<void> {
    const at = this.mouse ?? this.restPoint();
    const call = this.page.evaluate(
      ({ api, name, on, at }) => {
        const demo = (window as unknown as DemoWindow)[api];
        if (name === "hush") demo?.hush(on);
        else if (name === "park") demo?.park(at.x, at.y);
        else demo?.rest();
      },
      { api: API, name, on, at },
    );
    await within(call, `cursor ${name}`).catch((err: unknown) => this.note(`cursor: ${firstLine(err)}`));
  }

  /** Patches the actions on Locator.prototype for this recording. finish puts the originals back. */
  private patchLocators(): void {
    const proto = Object.getPrototypeOf(this.page.locator("body")) as Record<ActionMethod, LocatorAction>;
    for (const method of Object.keys(ACTIONS) as ActionMethod[]) {
      const original = proto[method];
      const recorder = this;
      proto[method] = function (this: Locator, ...args: unknown[]) {
        const run = () => callAsMethod(this, method, original, args);
        const result = current === recorder && this.page() === recorder.page ? recorder.perform(this, method, args, run) : run();
        return result.catch((err: unknown) => {
          throw withoutOwnFrames(err);
        });
      };
      this.restores.push(() => {
        proto[method] = original;
      });
    }
  }

  /** page.goto records a goto action, and the first one starts the screencast once the page has loaded. */
  private patchGoto(): void {
    const page = this.page;
    const goto = page.goto.bind(page);
    page.goto = async (url: string, options?: Parameters<Page["goto"]>[1]): Promise<Response | null> => {
      // A result on the page being left gets its moment first.
      await this.settleResult();
      const t0 = Date.now();
      this.navigating++;
      try {
        return await goto(url, options);
      } finally {
        this.navigating--;
        this.actions.push({ kind: "goto", t0, ready: t0, t1: Date.now(), label: url, waited: 0 });
        await this.start();
        // A new document starts without the cursor. Show it where it was.
        if (this.mouse) await page.mouse.move(this.mouse.x, this.mouse.y).catch(() => {});
      }
    };
    // Navigations the test didn't make with goto: a link, a form, a client-side route.
    const onNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame() || this.navigating) return;
      const now = Date.now();
      this.actions.push({ kind: "goto", t0: now, ready: now, t1: now, label: urlLabel(frame.url()), waited: 0 });
    };
    page.on("framenavigated", onNavigated);
    this.restores.push(() => {
      Reflect.deleteProperty(page, "goto");
      page.off("framenavigated", onNavigated);
    });
  }

  /**
   * page.screenshot draws the page at another size while it works (fullPage makes the page as tall as its content),
   * and the screencast would show that as the whole page squeezed into the frame. Frames that arrive while any page
   * screenshot runs are dropped, so the video holds the screen as it was, then the screencast restarts to send the
   * screen as it is. The screenshot itself is taken as the test asked.
   */
  private patchScreenshot(): void {
    const page = this.page;
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options?: Parameters<Page["screenshot"]>[0]): Promise<Buffer> => {
      this.blackout++;
      try {
        return await screenshot(options);
      } finally {
        // Frames of the resized page can still be on their way.
        await sleep(250);
        if (--this.blackout === 0) await this.refresh();
      }
    };
    this.restores.push(() => {
      Reflect.deleteProperty(page, "screenshot");
    });
  }

  /**
   * page.setViewportSize changes the frames' shape. The resize itself is left out like a screenshot, and the timeline
   * notes the new size, since rects measured after it are in the new viewport (Demo Studio frames nothing after it).
   */
  private patchViewport(): void {
    const page = this.page;
    const setViewportSize = page.setViewportSize.bind(page);
    page.setViewportSize = async (size: { width: number; height: number }): Promise<void> => {
      this.blackout++;
      try {
        await setViewportSize(size);
      } finally {
        this.screen = page.viewportSize() ?? this.screen;
        this.viewports.push({ t: Date.now(), ...this.screen });
        await sleep(150);
        if (--this.blackout === 0) await this.refresh();
      }
    };
    this.restores.push(() => {
      Reflect.deleteProperty(page, "setViewportSize");
    });
  }

  private screencast(): Promise<unknown> {
    if (!this.cdp) return Promise.resolve();
    return this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
  }

  private onFrame(frame: { data: string; metadata: { timestamp?: number }; sessionId: number }): void {
    let written: Promise<void> = Promise.resolve();
    // Chrome sends a frame only when the screen changes, and an identical one after a refresh, which is dropped.
    if (this.endedAt === null && this.blackout === 0 && frame.data !== this.lastData) {
      this.lastData = frame.data;
      const received = Date.now();
      // metadata.timestamp is the browser's wall clock, the same clock as Date.now().
      const captured = (frame.metadata.timestamp ?? 0) * 1000;
      const at = Math.abs(captured - received) < 2000 ? captured : received;
      this.origin ??= at;
      const file = `frames/${String(this.frames.length + 1).padStart(6, "0")}.jpg`;
      this.frames.push({ file, at });
      const bytes = Buffer.from(frame.data, "base64");
      if (this.frames.length === 1) this.checkScale(bytes);
      written = writeFile(path.join(this.dir, file), bytes).catch((err) => this.note(`${file}: ${firstLine(err)}`));
      this.writes.add(written);
      void written.then(() => this.writes.delete(written));
      this.firstFrame?.();
      this.firstFrame = null;
    }
    // Acks pace the screencast: at most MAX_FPS a second, each after its frame is on disk or 250 ms, whichever comes
    // first, so a slow disk slows the frames down but never stops them.
    this.acks = this.acks.then(async () => {
      await Promise.race([written, sleep(250)]);
      const wait = this.lastAck + 1000 / MAX_FPS - Date.now();
      if (wait > 0) {
        this.throttled = true;
        await sleep(wait);
      }
      this.lastAck = Date.now();
      await this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    this.scheduleRefresh();
  }

  /**
   * Chrome drops frames while an ack is held back, so the last state of an animation (the last typed letter, a card
   * at full opacity) can go unsent. When frames stop coming after a throttled burst, stopping and starting the
   * screencast makes Chrome send the screen as it is now. Measured: 6 of 20 animations lost their last state without it.
   */
  private scheduleRefresh(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.throttled || this.stopping || this.refreshing) return;
      this.throttled = false;
      void this.refresh();
    }, 150);
  }

  /** Stops and starts the screencast, which makes Chrome send the screen as it is now. Joins one already running. */
  private refresh(): Promise<void> {
    if (this.stopping || !this.cdp) return Promise.resolve();
    this.refreshing ??= (async () => {
      await this.cdp?.send("Page.stopScreencast").catch(() => {});
      for (let tries = 0; !this.stopping; tries++) {
        try {
          await this.screencast();
          return;
        } catch (err) {
          if (tries >= 4) return this.note(`refresh: ${firstLine(err)}`);
          await sleep(100);
        }
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * The frames' real scale. The screencast keeps to 2560x1440, so a viewport taller than 16:9 comes smaller than 2x,
   * and Chromium sends 1x frames unless it was launched with --force-device-scale-factor=2.
   */
  private checkScale(bytes: Uint8Array): void {
    const size = jpegSize(bytes);
    if (!size) return;
    this.dpr = Math.round((size.width / this.viewport.width) * 100) / 100;
    const fits = Math.min(2560 / this.viewport.width, 1440 / this.viewport.height);
    if (!this.vr && this.dpr < Math.min(2, fits) - 0.05) {
      this.note(`frames are ${size.width}x${size.height}: launch Chromium with --force-device-scale-factor=2 for sharp text`);
    }
  }

  /** Stops the screencast and waits for the frames to reach the disk. */
  private async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.idle);
    await this.refreshing;
    if (this.cdp) await Promise.race([this.cdp.send("Page.stopScreencast").catch(() => {}), sleep(3000)]);
    this.endedAt = Date.now();
    await Promise.race([Promise.allSettled([...this.writes]), sleep(15_000)]);
    await this.cdp?.detach().catch(() => {});
  }

  private onPageReport(json: string): void {
    try {
      const report = JSON.parse(json) as PageReport;
      // Page times come from the browser's clock as it was before a test could fake it (page.clock), the same clock
      // as Date.now(). A time far off it is replaced by the arrival time.
      const now = Date.now();
      const at = (t: number) => (Math.abs(t - now) < 5000 ? t : now);
      const room = (list: unknown[]) => list.length < 5000;
      for (const a of report.activity ?? []) if (room(this.activity)) this.activity.push({ ...a, t: at(a.t) });
      for (const b of report.busy ?? []) if (room(this.busy)) this.busy.push({ ...b, t: at(b.t) });
      for (const s of report.scrolls ?? []) if (room(this.scrolls)) this.scrolls.push({ ...s, t: at(s.t) });
    } catch (err) {
      this.note(`page report: ${firstLine(err)}`);
    }
  }

  /**
   * The version 1 timeline: seconds since the first frame. Steps, actions and busy changes from before it (the first
   * page load) count as time zero; activity, scrolls and results from before it are left out. A rect that couldn't
   * be measured is the whole viewport.
   */
  private timeline(status: string) {
    const origin = this.origin ?? (this.startedAt || Date.now());
    const end = Math.max(origin, this.endedAt ?? Date.now());
    const sec = (ms: number) => Math.round(Math.min(end, Math.max(origin, ms)) - origin) / 1000;
    const recorded = (t: number) => t >= origin && t <= end;
    const whole: Rect = { x: 0, y: 0, w: this.viewport.width, h: this.viewport.height };
    return {
      version: 1,
      viewport: this.viewport,
      dpr: this.dpr,
      status,
      duration: sec(end),
      frames: this.frames.map((f) => ({ file: f.file, t: sec(f.at) })),
      steps: this.steps.map((s) => ({ title: s.title, t0: sec(s.t0), t1: sec(s.t1 || end), depth: s.depth })),
      actions: [...this.actions]
        .sort((a, b) => a.t0 - b.t0)
        .map((a) => ({
          kind: a.kind,
          t0: sec(a.t0),
          ready: sec(Math.max(a.t0, a.ready)),
          t1: sec(a.t1),
          rect: a.rect ?? whole,
          label: a.label,
          ...(a.kind === "upload" ? { fileName: a.fileName ?? "" } : {}),
          ...(a.kind === "type" && a.typed !== undefined ? { typed: a.typed } : {}),
          ...(a.noop ? { noop: true } : {}),
          ...(a.heads ? { heads: a.heads } : {}),
        })),
      activity: this.activity
        .filter((a) => recorded(a.t))
        .map((a) => ({ t: sec(a.t), added: a.added, changed: a.changed, text: a.text, rect: a.rect })),
      busy: this.busy.filter((b) => b.t <= end).map((b) => ({ t: sec(b.t), on: b.on, rect: b.rect })),
      scrolls: this.scrolls.filter((s) => recorded(s.t)).map((s) => ({ t: sec(s.t), y: s.y })),
      results: this.results
        .filter((r) => recorded(r.t))
        .map((r) => ({
          t: sec(r.t),
          at: sec(r.at),
          rect: r.rect,
          scrollY: r.scrollY,
          waited: Math.round(r.waited) / 1000,
          busy: r.busy,
          media: r.media,
          heads: r.heads,
          blanks: r.blanks,
          ...(r.pressed ? { pressed: r.pressed } : {}),
        })),
      column: this.column,
      viewports: this.viewports.filter((v) => v.t <= end).map((v) => ({ t: sec(v.t), width: v.width, height: v.height })),
    };
  }
}

/**
 * Runs in the browser on an action's element. Measures its own first box (where Playwright clicks) and what a viewer
 * sees of it: the element, or for something hidden (a file input, a styled checkbox) its picker button, its label or
 * the closest visible parent. Says whether the action would change nothing. When asked, and the action changes
 * something, first scrolls the one the cursor will aim at into view with the overlay's eased scroll. Self-contained,
 * since Playwright sends it to the page as text.
 */
async function prepareTarget(
  el: Element,
  opts: { scroll: boolean; pointer: boolean; value: string | null; method: string; choices: string[] | null; api: string },
): Promise<Target> {
  const shown = (e: Element | null | undefined): e is Element => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 6 && r.height >= 6 && e.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const rect = (r: DOMRect | undefined) => (r && r.width * r.height > 0.99 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  let visual: Element | null = shown(el) ? el : null;
  if (!visual) {
    const label = el.closest("label") ?? (el instanceof HTMLInputElement ? el.labels?.[0] : null) ?? null;
    visual = [label?.querySelector(".file-picker-button, button, [role='button']"), label].find(shown) ?? null;
    for (let up = el.parentElement; !visual && up && up !== document.body; up = up.parentElement) {
      if (shown(up)) visual = [up.querySelector(".file-picker-button")].find(shown) ?? up;
    }
  }
  // An element in a frame is measured in that frame's viewport, which the cursor can't use: no glide for it.
  const framed = window.top !== window;
  const whole = el === document.body || el === document.documentElement;
  const aimAt = opts.pointer && rect(el.getClientRects()[0]) ? el : visual;
  const demo = (
    window as unknown as Record<string, { where?: () => Point | null; scroll?: (to: number) => Promise<boolean>; heads?: () => Rect[] } | undefined>
  )[opts.api];

  // The action would change nothing: a fill with the value the field has, a check of a box that is checked, a click on
  // an option already chosen (a radio, its label, a selected tab), a select of the option already selected. A click
  // on a checkbox or a pressed toggle still changes it.
  const control = el instanceof HTMLInputElement ? el : el.closest("label")?.control;
  const tick = control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio") ? control : null;
  const checked = tick ? tick.checked : el.getAttribute("aria-checked") === "true";
  const role = el.getAttribute("role") ?? "";
  const chosen =
    (tick?.type === "radio" && tick.checked) ||
    (role === "radio" && checked) ||
    (/^(tab|option)$/.test(role) && el.getAttribute("aria-selected") === "true");
  const choice = opts.choices?.length === 1 ? opts.choices[0] : null;
  const selected = el instanceof HTMLSelectElement && !el.multiple ? [...el.selectedOptions] : [];
  const noop =
    opts.method === "fill"
      ? (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value === opts.value
      : opts.method === "check"
        ? checked
        : opts.method === "uncheck"
          ? (!!tick || el.hasAttribute("aria-checked")) && !checked
          : opts.method === "click"
            ? chosen
            : opts.method === "selectOption"
              ? choice !== null && selected.some((o) => o.value === choice || o.label === choice)
              : false;

  // The page itself (a key pressed on <body>) is already on screen.
  if (aimAt && opts.scroll && !framed && !whole && !noop) {
    const r = aimAt.getBoundingClientRect();
    const se = document.scrollingElement ?? document.documentElement;
    const vh = window.innerHeight;
    if (r.top < 8 || r.bottom > vh - 8) {
      // Center it, or show its top when it is taller than the screen.
      const want = r.height > vh * 0.8 ? r.top - vh * 0.12 : r.top + r.height / 2 - vh / 2;
      const to = Math.max(0, Math.min(se.scrollHeight - se.clientHeight, se.scrollTop + want));
      // The overlay's scroll runs on the page's own timers, saved before a test could pause them (page.clock).
      if (demo?.scroll) await demo.scroll(to);
      else se.scrollTo({ top: to, behavior: "instant" });
    }
  }

  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  const byIds = (ids: string | null) =>
    clean((ids ?? "").split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent : "")).join(" "));
  // Inputs, selects, textareas and buttons all have .labels.
  const labels = (el as Element & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  const label =
    (whole ? "page" : "") ||
    clean(el.getAttribute("aria-label")) ||
    byIds(el.getAttribute("aria-labelledby")) ||
    clean(labels?.[0]?.innerText) ||
    clean(field?.placeholder) ||
    clean(el instanceof HTMLElement ? el.innerText : el.textContent) ||
    clean(el.getAttribute("title")) ||
    (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type) ? clean(el.value) : "") ||
    el.tagName.toLowerCase();
  const textField =
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|url|tel|password)$/.test(el.type));
  return {
    own: framed ? null : rect(el.getClientRects()[0]),
    seen: framed || !visual ? null : rect(visual.getBoundingClientRect()),
    label: label.slice(0, 80),
    typeable: visual === el && textField && !!field && !field.disabled && !field.readOnly && opts.value !== null && field.value !== opts.value,
    picker: visual === el && el instanceof HTMLInputElement && el.type === "file",
    whole,
    noop,
    heads: framed ? [] : (demo?.heads?.() ?? []),
    mouse: demo?.where?.() ?? null,
  };
}

/**
 * Runs in every document of the recorded page, main frame only. Draws the cursor, click ripples and the file chip in a
 * closed shadow root on <html>, shown in the top layer so modals don't cover it, with no text in the DOM, so app CSS
 * and the test's locators never see them. The cursor fades out while the mouse rests. Scrolls the page smoothly, so a
 * product's own jump to its result reads as a move. Reports page activity, aria-busy changes and scrolls to the
 * recorder a few times a second, and keeps the results for settle. Its timers and clocks are the page's own, saved
 * before a test could fake them (page.clock). Self-contained, since Playwright sends it to the page as text, and it
 * never throws into the page.
 */
function demoPageScript({ binding, api, font, modelMs, vr }: { binding: string; api: string; font: string | null; modelMs: number; vr: boolean }): void {
  if (window.top !== window) return;
  type Box = { x: number; y: number; w: number; h: number };
  const now = Date.now.bind(Date);
  const clock = performance.now.bind(performance);
  const every = window.setInterval.bind(window);
  const later = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const frame = window.requestAnimationFrame.bind(window);
  const NS = "http://www.w3.org/2000/svg";
  const svg = (tag: string, attrs: Record<string, string | number>, ...children: Element[]) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    node.append(...children);
    return node;
  };
  const viewport = (): Box => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  // Boxes are reported whole, even where they run past the screen, so Demo Studio knows how much of them it shows.
  const box = (el: Element): Box | null => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };

  // A product that jumps to its result (scrollIntoView, scrollTo) glides there instead. The selector has no weight,
  // so a product's own scroll-behavior wins, and the recorder's scrolls say "instant".
  try {
    const smooth = new CSSStyleSheet();
    smooth.replaceSync(":where(:root) { scroll-behavior: smooth; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, smooth];
  } catch {
    // An older document API: the page keeps its own scrolling.
  }

  // Inter for the file chip, under a name of its own, so the product's own text never picks it up.
  if (font) {
    try {
      const face = new FontFace("musemuse-demo-inter", Uint8Array.from(atob(font), (c) => c.charCodeAt(0)), { weight: "100 900" });
      document.fonts.add(face);
      face.load().catch(() => {});
    } catch {
      // The chip uses the system's fonts.
    }
  }

  // The overlay. Its styles go through the CSSOM, which a page's content security policy doesn't block.
  const host = document.createElement("musemuse-demo");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("popover", "manual");
  const hostStyle: Record<string, string> = {
    position: "fixed", inset: "0 auto auto 0", width: "0", height: "0", margin: "0", padding: "0", border: "0",
    background: "transparent", overflow: "visible", "z-index": "2147483647", "pointer-events": "none", display: "block",
    visibility: "visible", opacity: "1", transform: "none", filter: "none", "clip-path": "none", contain: "none",
  };
  for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    * { pointer-events: none; }
    .cursor { position: fixed; left: 0; top: 0; width: 24px; height: 30px; opacity: 0; transition: opacity .45s ease-in;
      transform-origin: 3px 2.5px; filter: drop-shadow(0 2px 2.5px rgba(0,0,0,.32)); will-change: translate, scale; }
    .cursor.on { opacity: 1; transition: opacity .15s ease-out; }
    .cursor svg, .chip svg { display: block; flex: none; }
    .ripple { position: fixed; width: 56px; height: 56px; margin: -28px 0 0 -28px; box-sizing: border-box; border-radius: 50%;
      border: 3px solid #0064E0; background: rgba(0,130,251,.22); box-shadow: 0 0 0 2px rgba(255,255,255,.75); }
    .chip { position: fixed; display: flex; align-items: center; gap: 8px; padding: 8px 14px 8px 10px; background: #fff;
      color: #1C2B33; border-radius: 14px; white-space: nowrap; font: 600 14px/1.25 "musemuse-demo-inter", "Inter", "Noto Sans",
      "Liberation Sans", "DejaVu Sans", system-ui, sans-serif; box-shadow: 0 12px 28px rgba(28,43,51,.24), 0 2px 6px rgba(28,43,51,.16); }
    .name::after { content: attr(data-name); }
  `);
  shadow.adoptedStyleSheets = [sheet];
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.append(
    svg(
      "svg",
      { width: 24, height: 30, viewBox: "0 0 24 30" },
      svg("path", {
        d: "M3 2.5V23.7L8.3 18.8L11.9 27.2L15.8 25.5L12.2 17.3H19.6Z",
        fill: "#FFFFFF",
        stroke: "#1C2B33",
        "stroke-width": 1.6,
        "stroke-linejoin": "round",
      }),
    ),
  );
  shadow.append(cursor);

  // <html> rather than <body>, so app CSS on the body can't hide it. Raised again when a modal opens above it.
  let layers = -1;
  const mount = () => {
    if (!host.isConnected) {
      if (!document.documentElement) return false;
      document.documentElement.appendChild(host);
      layers = -1;
    }
    try {
      const open = document.querySelectorAll(":modal, :popover-open").length;
      if (open !== layers || !host.matches(":popover-open")) {
        if (host.matches(":popover-open")) host.hidePopover();
        host.showPopover();
        layers = document.querySelectorAll(":modal, :popover-open").length;
      }
    } catch {
      // No top layer here: the fixed overlay at the highest z-index still draws over the app.
    }
    return true;
  };

  // The cursor shows while the mouse moves and fades out after it rests 2.4 s, like a person's hand leaving the mouse
  // during a wait, so results and the last frame are clean. While hushed it ignores the real mouse: the recorder hushes
  // it for a click that changes nothing, which the viewer shouldn't see, and to move the mouse off a held result once
  // the cursor has faded, then parks the hidden cursor where the mouse went.
  let shown = false;
  let px = 0;
  let py = 0;
  let resting = 0;
  let hushed = false;
  const wake = () => {
    cursor.classList.add("on");
    cancel(resting);
    resting = later(() => cursor.classList.remove("on"), 2400);
  };
  const rest = () => {
    cancel(resting);
    cursor.classList.remove("on");
  };
  const park = (x: number, y: number) => {
    px = x;
    py = y;
    cursor.style.translate = `${px - 3}px ${py - 2.5}px`;
    shown = true;
  };
  addEventListener(
    "pointermove",
    (e) => {
      try {
        if (e.pointerType !== "mouse" || hushed || !mount()) return;
        px = e.clientX;
        py = e.clientY;
        // The translate property, not transform: the press animation's scale must not scale the position too.
        cursor.style.translate = `${px - 3}px ${py - 2.5}px`;
        shown = true;
        wake();
      } catch {
        // never break the page
      }
    },
    { capture: true, passive: true },
  );

  const ripple = (x: number, y: number) => {
    if (!mount()) return;
    const ring = document.createElement("div");
    ring.className = "ripple";
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    shadow.insertBefore(ring, cursor);
    ring.animate([{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(1)", opacity: 0 }], {
      duration: 600,
      easing: "cubic-bezier(.2,.7,.3,1)",
      fill: "forwards",
    });
    later(() => ring.remove(), 800);
  };
  addEventListener(
    "pointerdown",
    (e) => {
      try {
        if (e.pointerType !== "mouse" || hushed) return;
        ripple(e.clientX, e.clientY);
        wake();
        cursor.animate([{ scale: "1" }, { scale: "0.86" }, { scale: "1" }], { duration: 240, easing: "ease-out" });
      } catch {
        // never break the page
      }
    },
    { capture: true, passive: true },
  );

  // The file chip drops onto the picker, settles, then shrinks away as the picker takes the file.
  const chip = (x: number, y: number, text: string) => {
    if (!mount()) return;
    const card = document.createElement("div");
    card.className = "chip";
    const image = /\.(png|jpe?g|webp|gif|heic|avif|bmp)\b/i.test(text);
    card.append(
      svg(
        "svg",
        { width: 22, height: 26, viewBox: "0 0 22 26" },
        svg("path", {
          d: "M4 1.5H13.5L19.5 7.5V23A1.5 1.5 0 0 1 18 24.5H4A1.5 1.5 0 0 1 2.5 23V3A1.5 1.5 0 0 1 4 1.5Z",
          fill: "#E7F0FD",
          stroke: "#0064E0",
          "stroke-width": 1.5,
        }),
        svg("path", { d: "M13.5 1.6V6A1.5 1.5 0 0 0 15 7.5H19.4", fill: "none", stroke: "#0064E0", "stroke-width": 1.5 }),
        image
          ? svg("path", { d: "M5.5 21L9.5 15.5L12.5 19L14.5 16.5L17 21Z", fill: "#0064E0" })
          : svg("path", { d: "M6 12.5H16M6 16H16M6 19.5H12.5", fill: "none", stroke: "#0064E0", "stroke-width": 1.4, "stroke-linecap": "round" }),
        ...(image ? [svg("circle", { cx: 8.5, cy: 11.5, r: 1.7, fill: "#0082FB" })] : []),
      ),
    );
    const name = document.createElement("span");
    name.className = "name";
    name.setAttribute("data-name", text);
    card.append(name);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    shadow.insertBefore(card, cursor);
    const at = (dy: number, scale: number) => `translate(-50%, -50%) translateY(${dy}px) scale(${scale})`;
    card.animate(
      [
        { transform: at(-76, 0.92), opacity: 0, offset: 0, easing: "ease-out" },
        { transform: at(-76, 1), opacity: 1, offset: 0.14, easing: "cubic-bezier(.3,1.35,.55,1)" },
        { transform: at(0, 1), opacity: 1, offset: 0.6 },
        { transform: at(0, 1), opacity: 1, offset: 0.78, easing: "ease-in" },
        { transform: at(0, 0.84), opacity: 0, offset: 1 },
      ],
      { duration: 900, fill: "forwards" },
    );
    later(() => card.remove(), 1000);
  };

  // An eased scroll of the page to `to`, on the page's own timers. Resolves true when the page moved.
  const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const scroll = (to: number) =>
    new Promise<boolean>((resolve) => {
      const se = document.scrollingElement ?? document.documentElement;
      const from = se.scrollTop;
      if (Math.abs(to - from) < 2) return resolve(false);
      const ms = Math.min(900, Math.max(350, Math.abs(to - from) * 0.7));
      const t0 = clock();
      // rAF stops in a hidden page, so a timer finishes the scroll if frames don't.
      const done = later(() => {
        se.scrollTo({ top: to, behavior: "instant" });
        resolve(true);
      }, ms + 400);
      const step = () => {
        const p = Math.min(1, (clock() - t0) / ms);
        se.scrollTo({ top: from + (to - from) * ease(p), behavior: "instant" });
        if (p < 1) frame(step);
        else {
          cancel(done);
          resolve(true);
        }
      };
      frame(step);
    });

  // The new text of a fill, drawn into the field a character at a time with the value setter the browser itself has,
  // which fires no events: the page gets only the fill's own change after it. Stops when anything else sets the value.
  const type = async (el: Element, text: string, delay: number) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return 0;
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!set) return 0;
    el.focus({ preventScroll: true });
    const chars = Array.from(text);
    let last = el.value;
    let drawn = 0;
    for (let i = 1; i <= chars.length; i++) {
      if (el.value !== last) break;
      last = chars.slice(0, i).join("");
      set.call(el, last);
      drawn = i;
      await new Promise((r) => later(r, delay));
    }
    return drawn;
  };

  // Results, in the order they appeared. A result is a section that stopped being busy, or, when its aria-busy element
  // (like a Skeleton) is removed, the section or card it was in, unless that is the form the viewer typed in; or the
  // biggest element of a burst that added content, for products that show a result without aria-busy. A busy button
  // only says a wait is over: its result is elsewhere. The same result reported both ways within half a second is one.
  // Each knows how long the viewer waited for it: its aria-busy span, or the time since they last pressed, typed or
  // chose something.
  type Result = { el: Element; at: number; waited: number; busy: boolean; held: boolean };
  const results: Result[] = [];
  const SECTION = "section, article, .card, [role='region'], [role='log']";
  const CONTROL = [
    "button, a[href], input, select, textarea, label, summary",
    "[role='button'], [role='radio'], [role='checkbox'], [role='switch'], [role='tab'], [role='option'], [role='menuitem']",
  ].join(", ");
  let lastInput = 0;
  let lastControl: Element | null = null;
  // The text field the viewer last typed into.
  let lastTyped: Element | null = null;
  // When the last wait of modelMs or more ended. The final pick comes from what appeared from then on.
  let lastWait = 0;
  let decoding = 0;
  const area = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const onScreen = (b: Box | null): b is Box => !!b && b.y + b.h > 0 && b.y < window.innerHeight && b.x + b.w > 0 && b.x < window.innerWidth;
  const pause = (ms: number) => new Promise<void>((resolve) => later(resolve, ms));
  // The section or card around an element, unless that is the whole page.
  const homeOf = (el: Element) => {
    const home = el.parentElement?.closest(SECTION) ?? null;
    return home && !home.querySelector("main") ? home : null;
  };
  const pictures = (el: Element) => [...(el instanceof HTMLImageElement ? [el] : []), ...el.querySelectorAll("img")];
  // A picture's box is empty until it loads, so pictures decode before they are measured, for at most 1.5 s.
  const decoded = (imgs: HTMLImageElement[]) => {
    const pending = imgs.filter((img) => !img.complete || !img.naturalWidth);
    return pending.length ? Promise.race([Promise.all(pending.map((img) => img.decode().catch(() => {}))), pause(1500)]) : Promise.resolve();
  };
  for (const type of ["pointerdown", "keydown", "input", "change"]) {
    addEventListener(
      type,
      (e) => {
        try {
          lastInput = now();
          const el = e.target instanceof Element ? e.target : null;
          lastControl = el?.closest(CONTROL) ?? el;
          const field =
            el instanceof HTMLTextAreaElement ||
            (el instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(el.type)) ||
            (el instanceof HTMLElement && el.isContentEditable);
          if (e.type === "input" && field) lastTyped = el;
        } catch {
          // never break the page
        }
      },
      { capture: true, passive: true },
    );
  }
  const note = (el: Element, t: number, waited: number, busy: boolean) => {
    if (waited >= modelMs) lastWait = Math.max(lastWait, t);
    // A section noted again before it was held is one result, done at the later time.
    const again = results.find((r) => r.el === el && !r.held);
    if (again) {
      Object.assign(again, { at: Math.max(again.at, t), waited: Math.max(again.waited, waited), busy: again.busy || busy });
      return;
    }
    const twin = results.find((r) => Math.abs(r.at - t) <= 500 && (r.el.contains(el) || el.contains(r.el)));
    if (twin) {
      if (el.contains(twin.el)) twin.el = el;
      twin.waited = Math.max(twin.waited, waited);
      twin.busy ||= busy;
      return;
    }
    results.push({ el, at: t, waited, busy, held: false });
    if (results.length > 60) results.shift();
  };
  // An aria-busy element turned off or was removed at t, after being busy since `on`. A removed one, like a Skeleton,
  // credits the section or card it was in, unless that holds the field the viewer typed into: that is the form, and
  // the burst that replaced the busy part stands for the result.
  const noteDone = (el: Element, home: Element | null, on: number, t: number) => {
    const form = !!home && !!lastTyped?.isConnected && home.contains(lastTyped);
    const done = el.matches(CONTROL) ? null : el.isConnected && area(el) > 0 ? el : home?.isConnected && !form ? home : null;
    if (done) note(done, t, t - on, true);
    else if (t - on >= modelMs) lastWait = Math.max(lastWait, t);
  };
  // Something busy, or something holding a busy part like a Skeleton, is a loading state, not a result yet.
  const loading = (el: Element) => !!(el.closest('[aria-busy="true"]') || el.querySelector('[aria-busy="true"]'));
  // A burst that is a loading state counts once its section is done.
  const noteAdded = (els: Element[], t: number) => {
    const pick = () => {
      let biggest: Element | null = null;
      for (const el of els) if (el.isConnected && (!biggest || area(el) > area(biggest))) biggest = el;
      if (!biggest || area(biggest) <= 0 || loading(biggest)) return;
      note(biggest, t, lastInput && lastInput < t ? t - lastInput : 0, false);
    };
    const imgs = els.flatMap((el) => (el.isConnected ? pictures(el) : []));
    if (!imgs.some((img) => !img.complete || !img.naturalWidth)) return pick();
    decoding++;
    void decoded(imgs).then(() => {
      decoding--;
      try {
        pick();
      } catch {
        // never break the page
      }
    });
  };
  const media = (el: Element) =>
    [el, ...el.querySelectorAll("img, canvas, video, svg")].filter((m) => {
      const r = m.getBoundingClientRect();
      return m.matches("img, canvas, video, svg") && r.width >= 64 && r.height >= 64;
    }).length;
  // Headings, labels and the app bar on screen, which a crop edge shouldn't cut. Ones pinned to the screen are left
  // out, since the page's scroll doesn't move them.
  const heads = () => {
    const out: Box[] = [];
    for (const el of document.querySelectorAll("h1, h2, h3, .card-head, .appbar, label, legend")) {
      const b = box(el);
      if (out.length >= 24 || !onScreen(b) || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let pinned = false;
      for (let up: Element | null = el; up && up !== document.body && !pinned; up = up.parentElement) {
        pinned = /^(fixed|sticky)$/.test(getComputedStyle(up).position);
      }
      if (!pinned) out.push(b);
    }
    return out;
  };
  // Empty text fields on screen. A frame with one looks unfinished.
  const blanks = () => {
    const out: Box[] = [];
    for (const el of document.querySelectorAll("input, textarea")) {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (out.length >= 8 || field.value || field.readOnly) continue;
      if (field instanceof HTMLInputElement && !/^(text|search|email|url|tel|password|number)$/.test(field.type)) continue;
      const b = box(field);
      if (onScreen(b) && field.checkVisibility({ visibilityProperty: true, opacityProperty: true })) out.push(b);
    }
    return out;
  };
  // The content column: main's content box, when it is narrower than the screen.
  const column = () => {
    const main = document.querySelector("main");
    if (!main) return null;
    const r = main.getBoundingClientRect();
    const s = getComputedStyle(main);
    const left = parseFloat(s.paddingLeft) || 0;
    const w = r.width - left - (parseFloat(s.paddingRight) || 0);
    return w >= 200 && w < 0.95 * window.innerWidth ? { x: Math.round(r.left + left), w: Math.round(w) } : null;
  };
  // A result to hold: still in the page, with nothing around it busy, and not the form the viewer just used, though
  // a model's answer that holds its own "Write it again" counts.
  const usable = (r: Result) => {
    const el = r.el;
    if (!el.isConnected || loading(el)) return null;
    // A VR product's 3D preview is always there and always moving. The result is inside VR.
    if (vr && (el.matches("canvas") || el.querySelector("canvas"))) return null;
    return !r.busy && lastControl?.isConnected && el.contains(lastControl) ? null : el;
  };
  // The strongest result: one the viewer waited at least 3/4 as long for as the longest, then one from an aria-busy
  // section, then one with pictures, then the biggest. The later one wins a tie.
  const strongest = (pool: Array<{ r: Result; el: Element }>) => {
    const most = Math.max(0, ...pool.map((p) => p.r.waited));
    const score = (p: { r: Result; el: Element }) => [
      most < modelMs || p.r.waited >= 0.75 * most ? 1 : 0,
      p.r.busy ? 1 : 0,
      media(p.el) ? 1 : 0,
      area(p.el),
    ];
    const beats = (a: number[], b: number[]) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return (a[k] ?? 0) > (b[k] ?? 0);
      return true;
    };
    let best: { r: Result; el: Element; s: number[] } | null = null;
    for (const p of pool) {
      const s = score(p);
      if (!best || beats(s, best.s)) best = { ...p, s };
    }
    return best;
  };
  // For the recorder: the oldest result not held yet that appeared since `since` and is at least 2% of the screen,
  // or with `final` the strongest from the last wait on, of any size, held or not. Its pictures decode first. It is
  // brought on screen with an eased scroll when most of it is off screen (centered, or its top shown when it is taller
  // than the screen), and reported with what else is on screen then.
  const settle = async (since: number, final: boolean) => {
    // New content still coming in becomes a result once its burst is reported, 200 ms or more after it started, so
    // the result of the action just done is waited for, up to 0.6 s, instead of being held one action late.
    const until = clock() + 600;
    while (firstAt && (added >= 3 || text >= 20) && clock() < until) await pause(50);
    for (let i = 0; decoding && i < 15; i++) await pause(100);
    const vh = window.innerHeight;
    let pick: { r: Result; el: Element } | null = null;
    if (final) {
      const pool = (from: number) =>
        results.flatMap((r) => {
          const el = r.at >= from ? usable(r) : null;
          return el && area(el) > 0 ? [{ r, el }] : [];
        });
      const recent = pool(lastWait - 500);
      pick = strongest(recent.length ? recent : pool(0));
    } else {
      for (const r of results) {
        const el = !r.held && r.at >= since ? usable(r) : null;
        if (!el) continue;
        await decoded(pictures(el));
        if (area(el) < 0.02 * window.innerWidth * vh) continue;
        pick = { r, el };
        break;
      }
    }
    if (!pick) return null;
    const { r: found, el } = pick;
    const again = found.held;
    found.held = true;
    await decoded(pictures(el));
    const start = now();
    let moved = false;
    const r = el.getBoundingClientRect();
    if (Math.min(r.bottom, vh) - Math.max(r.top, 0) < 0.9 * Math.min(r.height, vh * 0.8)) {
      const se = document.scrollingElement ?? document.documentElement;
      const want = r.height > vh * 0.8 ? r.top - vh * 0.12 : r.top + r.height / 2 - vh / 2;
      moved = await scroll(Math.max(0, Math.min(se.scrollHeight - se.clientHeight, se.scrollTop + want)));
    }
    const pressed = lastControl?.isConnected ? box(lastControl) : null;
    return {
      at: found.at,
      t: moved ? start : found.at,
      since: moved ? now() : found.at,
      rect: box(el) ?? viewport(),
      scrollY: Math.round(window.scrollY),
      waited: found.waited,
      busy: found.busy,
      media: media(el),
      heads: heads(),
      blanks: blanks(),
      pressed: onScreen(pressed) ? pressed : null,
      column: column(),
      moved,
      again,
    };
  };
  Object.defineProperty(window, api, {
    configurable: true,
    value: {
      ripple,
      chip,
      where: () => (shown ? { x: px, y: py } : null),
      scroll,
      type,
      settle,
      heads,
      hush: (on: boolean) => {
        hushed = on;
      },
      rest,
      showing: () => parseFloat(getComputedStyle(cursor).opacity) > 0.01,
      park,
    },
  });

  // Activity: elements added and text or attributes changed, summed over windows of at least 200 ms, with how much
  // text was added and the box of what appeared. Boxes are measured once the page stops scrolling (within 1.2 s),
  // since a product often scrolls a new result into view right after it renders, and the box should be where the
  // result ends up.
  type BusyChange = { t: number; on: boolean; el: Element; rect: Box };
  const queue: {
    activity: Array<{ t: number; added: number; changed: number; text: number; rect: Box }>;
    busy: Array<{ t: number; on: boolean; rect: Box }>;
    scrolls: Array<{ t: number; y: number }>;
  } = { activity: [], busy: [], scrolls: [] };
  let firstAt = 0;
  let added = 0;
  let changed = 0;
  let text = 0;
  let scrolledAt = 0;
  const addedEls = new Set<Element>();
  const changedEls = new Set<Element>();
  // Each busy element's latest box, the section or card it is in, and when it turned busy.
  const busyEls = new Map<Element, { rect: Box; home: Element | null; on: number }>();
  let busyChanges: BusyChange[] = [];
  const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);
  // Keystrokes in the focused field change it on every key. That is the typing, not something appearing.
  const inFocus = (n: Node | null) => {
    const a = document.activeElement;
    return !!n && !!a && a !== document.body && a.contains(n);
  };
  const count = (t: number, kind: "added" | "changed", n: number, el: Element | null, chars = 0) => {
    firstAt ||= t;
    if (kind === "added") added += n;
    else changed += n;
    text = Math.min(100_000, text + chars);
    const set = kind === "added" ? addedEls : changedEls;
    if (el && set.size < 200) set.add(el);
  };
  const chars = (n: Node) => Math.min(2000, (n.textContent ?? "").trim().length);
  const union = (els: Set<Element>): Box | null => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const el of els) {
      if (!el.isConnected || !el.checkVisibility({ visibilityProperty: true })) continue;
      const b = box(el);
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  // The time of a busy change is exact. Its box, like activity's, is measured again when it is sent.
  const checkBusy = (t: number) => {
    const live = new Set(document.querySelectorAll('[aria-busy="true"]'));
    for (const el of live) {
      if (busyEls.has(el)) continue;
      const rect = box(el) ?? viewport();
      busyEls.set(el, { rect, home: homeOf(el), on: t });
      busyChanges.push({ t, on: true, el, rect });
    }
    for (const [el, was] of busyEls) {
      if (live.has(el)) continue;
      busyEls.delete(el);
      busyChanges.push({ t, on: false, el, rect: (el.isConnected && box(el)) || was.rect });
      noteDone(el, was.home, was.on, t);
    }
  };
  const observer = new MutationObserver((records) => {
    try {
      const t = now();
      let structure = false;
      for (const r of records) {
        if (r.type === "childList") {
          structure = true;
          for (const n of r.addedNodes) {
            if (n === host) continue;
            if (n instanceof Element) {
              if (!skip.has(n.tagName)) count(t, "added", 1 + Math.min(500, n.getElementsByTagName("*").length), n, chars(n));
            } else if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim() && !inFocus(n)) {
              count(t, "changed", 1, n.parentElement, chars(n));
            }
          }
        } else if (r.type === "characterData") {
          if (!inFocus(r.target)) count(t, "changed", 1, r.target.parentElement);
        } else if (r.attributeName === "aria-busy") {
          structure = true;
        } else if (r.attributeName !== "style" && r.target !== host && !inFocus(r.target)) {
          count(t, "changed", 1, r.target instanceof Element ? r.target : null);
        }
      }
      if (structure) checkBusy(t);
    } catch {
      // never break the page
    }
  });
  // From DOMContentLoaded on, so the parser building the first screen isn't counted as activity.
  const watch = () => {
    try {
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      checkBusy(now());
    } catch {
      // never break the page
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();

  let lastY = -1;
  let lastScrollAt = 0;
  let scrollEnd = 0;
  const recordScroll = () => {
    const y = Math.round(window.scrollY);
    if (y === lastY) return;
    lastY = y;
    lastScrollAt = now();
    queue.scrolls.push({ t: lastScrollAt, y });
  };
  addEventListener(
    "scroll",
    () => {
      try {
        scrolledAt = now();
        if (scrolledAt - lastScrollAt >= 100) recordScroll();
        cancel(scrollEnd);
        scrollEnd = later(recordScroll, 120);
      } catch {
        // never break the page
      }
    },
    { passive: true },
  );

  every(() => {
    try {
      const t = now();
      const due = (since: number) => (t - scrolledAt > 150 && t - since >= 200) || t - since >= 1200;
      if ((added || changed) && due(firstAt)) {
        // During a VR session the 2D page is behind the view, so what changes there isn't on screen for the camera to go to.
        if (!vr || (window as unknown as { __musemuseXR?: { inSession(): boolean } }).__musemuseXR?.inSession() !== true) {
          queue.activity.push({ t: firstAt, added, changed, text, rect: union(addedEls) ?? union(changedEls) ?? viewport() });
          if (added >= 3 || text >= 20) noteAdded([...addedEls], firstAt);
        }
        firstAt = 0;
        added = 0;
        changed = 0;
        text = 0;
        addedEls.clear();
        changedEls.clear();
      }
      const firstChange = busyChanges[0];
      if (firstChange && due(firstChange.t)) {
        for (const c of busyChanges) queue.busy.push({ t: c.t, on: c.on, rect: (c.el.isConnected && box(c.el)) || c.rect });
        busyChanges = [];
      }
      // A busy section grows as its content arrives. Keep its latest box for when it is removed while busy.
      for (const [el, was] of busyEls) {
        const b = el.isConnected ? box(el) : null;
        if (b) was.rect = b;
      }
      const send = (window as unknown as Record<string, unknown>)[binding];
      if (typeof send !== "function" || !(queue.activity.length || queue.busy.length || queue.scrolls.length)) return;
      const payload = JSON.stringify(queue);
      queue.activity = [];
      queue.busy = [];
      queue.scrolls = [];
      Promise.resolve(send(payload)).catch(() => {});
    } catch {
      // never break the page
    }
  }, 100);
}

/** Records one move in VR on the demo's timeline. Outside the studio project it only runs it. */
export function recordXrAction<T>(page: Page, label: string, run: () => Promise<T>): Promise<T> {
  return current?.page === page ? current.xrAction(label, run) : run();
}

/** Holds a result that fills the view in the demo. Outside the studio project it does nothing. */
export async function holdXrResult(page: Page): Promise<void> {
  if (current?.page === page) await current.holdXr();
}

/** Holds what the VR view shows, if a move changed it since the last hold, before the session ends. */
export async function holdUnheldXr(page: Page): Promise<void> {
  if (current?.page === page) await current.endXrStep();
}

/** The recording runs only in the studio project, and only for the first test a worker runs. */
export const test = base.extend({
  // The recorder hangs off the page fixture instead of an auto fixture of its own, so a test that never opens a page
  // never launches a browser for it. Outside the studio project the page is handed on untouched.
  page: async ({ page, actionTimeout }, use, testInfo) => {
    if (testInfo.project.name !== DEMO_PROJECT || recordedOnce) return use(page);
    recordedOnce = true;
    const root = testInfo.config.configFile ? path.dirname(testInfo.config.configFile) : process.cwd();
    const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
    const recorder = new DemoRecorder(page, root, dpr, testInfo, actionTimeout || 0);
    try {
      await recorder.install();
      current = recorder;
    } catch (err) {
      recorder.note(`install: ${firstLine(err)}`);
    }
    try {
      await use(page);
    } finally {
      current = null;
      await recorder.finish(testInfo);
    }
  },
});

// test.step as usual. While recording, each step's title and times also go in the timeline, for the captions, and a
// step that passes holds its new result on screen before it ends, so the result plays under its own caption.
const stepDepth = new AsyncLocalStorage<number>();
const plainStep = test.step;
function recordedStep(title: string, body: (step: TestStepInfo) => unknown, options?: Parameters<typeof plainStep>[2]) {
  const recorder = current;
  if (!recorder) return plainStep(title, body, options);
  const depth = stepDepth.getStore() ?? 0;
  return plainStep(
    title,
    (step) =>
      stepDepth.run(depth + 1, async () => {
        const entry = { title, t0: Date.now(), t1: 0, depth };
        recorder.steps.push(entry);
        if (depth === 0) recorder.beginStep(entry.t0);
        try {
          const result = await body(step);
          if (current === recorder) {
            if (depth === 0) await recorder.endXrStep();
            await recorder.settleResult();
          }
          return result;
        } finally {
          entry.t1 = Date.now();
        }
      }),
    options,
  );
}
test.step = Object.assign(recordedStep, { skip: plainStep.skip }) as unknown as typeof test.step;

export default test;
